/**
 * Always-on event dispatcher.
 *
 * Turns newly observed GitHub inbox events into new agent work without a human
 * asking: for every dispatch batch it creates one local storyboard task per
 * event and delivers a prompt to a single persistent "watcher" DSH session
 * (creating or resuming that session as needed).
 *
 * The module is deliberately free of DSH imports: the agents service is
 * injected by index.js, and the TaskStore comes from lib/tasks.js. All state is
 * persisted to `<stateDir>/dispatch.json` through atomic writes.
 */
import { randomUUID } from 'node:crypto';

import { readJson, writeJsonAtomic } from './util.js';

const STATE_VERSION = 1;
const MAX_SEEN = 1000;
const DEFAULT_MIN_INTERVAL_SEC = 120;
const DEFAULT_MAX_EVENTS = 5;
const DEFAULT_KINDS = ['issue', 'pr', 'review'];
const DEFAULT_TASK_STATUS = 'ready';
const TASK_STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done'];

/** Higher number wins when a batch is capped by `autoDispatchMaxEvents`. */
const KIND_PRIORITY = { review: 4, pr: 3, issue: 2, push: 1 };

const SILENT_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeKinds(value) {
  if (!Array.isArray(value)) return [...DEFAULT_KINDS];
  const kinds = [...new Set(value.map((kind) => toText(kind).trim()).filter((kind) => kind.length > 0))];
  return kinds.length > 0 ? kinds : [...DEFAULT_KINDS];
}

function normalizeMaxEvents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_EVENTS;
  return Math.min(50, Math.max(1, Math.round(parsed)));
}

function normalizeMinIntervalSec(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MIN_INTERVAL_SEC;
  return parsed;
}

function normalizeTaskStatus(value) {
  return TASK_STATUSES.includes(value) ? value : DEFAULT_TASK_STATUS;
}

function normalizeSessionId(value) {
  return toText(value).trim();
}

/** Name of a watched repository from a resolved config entry (or raw string). */
function repoNameOf(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (!isPlainObject(entry)) return '';
  if (typeof entry.repo === 'string' && entry.repo.trim()) return entry.repo.trim();
  if (entry.owner && entry.name) return `${entry.owner}/${entry.name}`;
  return '';
}

function watchedRepoSet(config) {
  const input = Array.isArray(config?.repos) ? config.repos : [];
  const repos = new Set();
  for (const entry of input) {
    const repo = repoNameOf(entry);
    if (repo) repos.add(repo);
  }
  return repos;
}

function eventTarget(event) {
  const repo = toText(event?.repo);
  const number = Number(event?.number);
  if (Number.isFinite(number) && number > 0) return `${repo}#${number}`;
  if (toText(event?.kind) === 'push') {
    const branch = toText(event?.branch);
    return branch ? `${repo} push ${branch}` : `${repo} push`;
  }
  return repo;
}

function uniqueRepos(events) {
  const repos = [];
  for (const event of events) {
    const repo = toText(event?.repo);
    if (repo && !repos.includes(repo)) repos.push(repo);
  }
  return repos;
}

function eventTime(event) {
  const time = Date.parse(toText(event?.at));
  return Number.isFinite(time) ? time : 0;
}

/**
 * Build the user message object handed to `agent.followup`.
 * @param {string} text
 * @param {string} [id] defaults to a fresh `randomUUID()` string
 * @returns {{ id: string, role: 'user', source: { kind: 'user' }, content: Array<{ type: 'text', text: string }> }}
 */
export function createUserMessage(text, id) {
  return {
    id: typeof id === 'string' && id.length > 0 ? id : randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: toText(text) }],
  };
}

/**
 * Prompt delivered to the watcher session for one dispatch batch. It names the
 * repository/number for every event, the task ids that were created for them,
 * and the standing instructions that make the watcher act without being asked.
 * @param {{ repo?: string, events?: object[], taskIds?: string[],
 *   workspaceRoot?: string, config?: object }} opts
 * @returns {string}
 */
export function buildDispatchPrompt(opts = {}) {
  const events = Array.isArray(opts.events) ? opts.events.filter(isPlainObject) : [];
  const taskIds = Array.isArray(opts.taskIds) ? opts.taskIds.map((id) => toText(id).trim()).filter(Boolean) : [];
  const workspaceRoot = toText(opts.workspaceRoot) || toText(opts.config?.workspaceRoot);
  const repoText = toText(opts.repo).trim() || uniqueRepos(events).join(', ');
  const count = events.length;
  const lines = [];

  lines.push('## GitHub auto-dispatch — always-on watcher');
  lines.push('');
  if (repoText) lines.push(`Repository: ${repoText}`);
  if (workspaceRoot) lines.push(`Workspace root: ${workspaceRoot}`);
  lines.push('');
  lines.push(`New GitHub activity observed (${count} event${count === 1 ? '' : 's'}):`);
  for (const event of events) {
    const kind = toText(event.kind) || 'event';
    const action = toText(event.action);
    const target = eventTarget(event);
    const summary = toText(event.summary).trim();
    const url = toText(event.url).trim();
    let line = `- [${kind}]${target ? ` ${target}` : ''}${action ? ` ${action}` : ''}`;
    if (summary) line += ` — ${summary}`;
    if (url) line += ` (${url})`;
    lines.push(line);
  }
  lines.push('');

  if (taskIds.length > 0) {
    lines.push(
      `Storyboard task${taskIds.length === 1 ? '' : 's'} created for this batch: ${taskIds.join(', ')}`,
    );
    taskIds.forEach((taskId, index) => {
      const event = events[index];
      const target = event ? eventTarget(event) : '';
      lines.push(`  - ${taskId}${target ? ` → ${target}` : ''}`);
    });
  } else {
    lines.push('No local storyboard tasks were created for this batch; handle the events directly.');
  }
  lines.push('');

  lines.push('Instructions:');
  lines.push(
    '- You are the persistent watcher session for this plugin. Act now on the activity above; do not wait for the human to ask.',
  );
  lines.push(
    '- Read the full details with the `github_events`/`github_issues`/`github_tasks` tools before changing code.',
  );
  lines.push(
    '- For every task that needs code changes, create or reuse its worktree with `github_worktrees` and do the work there.',
  );
  lines.push(
    '- Keep the storyboard current as you go: update task status, append notes, and report blockers instead of guessing.',
  );
  lines.push(
    '- When you finish, summarize what changed, which checks/tests ran, and which tasks moved to review.',
  );
  return lines.join('\n');
}

function emptyState() {
  return {
    version: STATE_VERSION,
    seen: [],
    lastDispatchAt: null,
    lastEventAt: null,
    sessionId: null,
    count: 0,
    lastError: null,
  };
}

function normalizeIsoOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeSeen(value) {
  if (!Array.isArray(value)) return [];
  const seen = [];
  const known = new Set();
  for (const entry of value) {
    const id = toText(entry).trim();
    if (!id || known.has(id)) continue;
    known.add(id);
    seen.push(id);
  }
  return seen.slice(-MAX_SEEN);
}

/** Load dispatch state defensively; any bad shape falls back to an empty state. */
function loadState(filePath) {
  const raw = readJson(filePath, null);
  if (!isPlainObject(raw)) return emptyState();
  const count = Number.isInteger(raw.count) && raw.count >= 0 ? raw.count : 0;
  return {
    version: STATE_VERSION,
    seen: normalizeSeen(raw.seen),
    lastDispatchAt: normalizeIsoOrNull(raw.lastDispatchAt),
    lastEventAt: normalizeIsoOrNull(raw.lastEventAt),
    sessionId: normalizeIsoOrNull(raw.sessionId),
    count,
    lastError: normalizeIsoOrNull(raw.lastError),
  };
}

/**
 * The always-on dispatcher. One instance lives for the whole plugin lifetime;
 * it is safe to construct again against the same state file (state is reloaded
 * and the watcher session is reused).
 */
export class AutoDispatcher {
  /**
   * @param {{ config?: object, tasks: object, agents: object, statePath: string,
   *   logger?: object, now?: () => number }} opts
   */
  constructor(opts = {}) {
    if (!opts.tasks || typeof opts.tasks.create !== 'function') {
      throw new Error('AutoDispatcher requires a TaskStore');
    }
    if (!opts.agents || typeof opts.agents !== 'object') {
      throw new Error('AutoDispatcher requires an agents service');
    }
    if (typeof opts.statePath !== 'string' || opts.statePath.length === 0) {
      throw new Error('AutoDispatcher requires a statePath');
    }
    this.tasks = opts.tasks;
    this.agents = opts.agents;
    this.statePath = opts.statePath;
    this.logger = opts.logger ?? SILENT_LOGGER;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this._skipped = 0;
    this._state = loadState(this.statePath);
    this.config = opts.config ?? {};
    this._settings = this._resolveSettings(this.config);
  }

  _resolveSettings(config) {
    const input = isPlainObject(config) ? config : {};
    return {
      autoDispatch: input.autoDispatch === true,
      kinds: normalizeKinds(input.autoDispatchKinds),
      minIntervalMs: normalizeMinIntervalSec(input.autoDispatchMinIntervalSec) * 1000,
      maxEvents: normalizeMaxEvents(input.autoDispatchMaxEvents),
      sessionId: normalizeSessionId(input.autoDispatchSessionId),
      createTasks: input.autoDispatchCreateTasks !== false,
      taskStatus: normalizeTaskStatus(input.autoDispatchTaskStatus),
      workspaceRoot: toText(input.workspaceRoot),
    };
  }

  /** Replace the resolved config (the Lead calls this after github_config set). */
  updateConfig(config) {
    if (!isPlainObject(config)) return;
    this.config = config;
    this._settings = this._resolveSettings(config);
  }

  _persist() {
    try {
      writeJsonAtomic(this.statePath, {
        version: STATE_VERSION,
        seen: this._state.seen,
        lastDispatchAt: this._state.lastDispatchAt,
        lastEventAt: this._state.lastEventAt,
        sessionId: this._state.sessionId,
        count: this._state.count,
        lastError: this._state.lastError,
      });
    } catch (error) {
      this.logger?.warn?.(`Failed to persist dispatch state: ${errorMessage(error)}`);
    }
  }

  /** @returns {{ enabled:boolean, sessionId:string|null, lastDispatchAt:string|null,
   *   count:number, lastError:string|null, lastEventAt:string|null,
   *   seen:number, skipped:number }} */
  status() {
    return {
      enabled: this._settings.autoDispatch,
      sessionId: this._settings.sessionId || this._state.sessionId || null,
      lastDispatchAt: this._state.lastDispatchAt,
      count: this._state.count,
      lastError: this._state.lastError,
      lastEventAt: this._state.lastEventAt,
      seen: this._state.seen.length,
      skipped: this._skipped,
    };
  }

  _watchedRepos() {
    return watchedRepoSet(this.config);
  }

  _isCandidate(event, seen, kinds, watchedRepos) {
    if (!isPlainObject(event)) return false;
    if (event.baseline === true || event.read === true) return false;
    const id = toText(event.id);
    if (!id || seen.has(id)) return false;
    if (!kinds.has(toText(event.kind))) return false;
    if (!watchedRepos.has(toText(event.repo))) return false;
    // Never let the plugin's own storyboard memory drive new work: epic and
    // task issues are written by github_tasks itself.
    const title = toText(event.title);
    if (/^\[(Storyboard|T\d+)\]/i.test(title)) return false;
    return true;
  }

  _throttled() {
    const last = Date.parse(this._state.lastDispatchAt ?? '');
    if (!Number.isFinite(last)) return false;
    return this.now() - last < this._settings.minIntervalMs;
  }

  _latestObservedAt(events) {
    let latest = null;
    let latestMs = -Infinity;
    for (const event of events) {
      const ms = eventTime(event);
      if (ms > latestMs) {
        latestMs = ms;
        latest = toText(event.at);
      }
    }
    return latest;
  }

  _taskInput(event) {
    const kind = toText(event.kind) || 'issue';
    const repo = toText(event.repo);
    const rawNumber = Number(event.number);
    const number = Number.isFinite(rawNumber) && rawNumber > 0 ? rawNumber : undefined;
    const titleText = toText(event.title).trim();
    let title;
    if (kind === 'push') {
      const branch = toText(event.branch).trim();
      title = `[GitHub] ${repo} push${branch ? ` ${branch}` : ''}`;
    } else {
      const head = `[GitHub] ${repo}${number !== undefined ? `#${number}` : ''}`;
      title = titleText ? `${head} ${titleText}` : head;
    }
    const input = {
      repo,
      title,
      description: toText(event.summary),
      status: this._settings.taskStatus,
      tags: ['auto-dispatch', kind],
    };
    if (kind === 'pr' && number !== undefined) input.prNumber = number;
    if (kind === 'issue' && number !== undefined) input.issueNumber = number;
    return input;
  }

  _rememberSeen(ids) {
    const known = new Set(this._state.seen);
    for (const id of ids) {
      const text = toText(id);
      if (text && !known.has(text)) {
        known.add(text);
        this._state.seen.push(text);
      }
    }
    if (this._state.seen.length > MAX_SEEN) this._state.seen = this._state.seen.slice(-MAX_SEEN);
  }

  /**
   * Ensure a watcher agent exists: live session first, then resume, then create.
   * @returns {Promise<{ sessionId: string, agent: object }>}
   */
  async _ensureSession() {
    const configured = this._settings.sessionId;
    let sessionId = configured || this._state.sessionId || `session-${randomUUID()}`;
    let agent = null;

    try {
      agent = await this.agents.get?.(sessionId);
    } catch (error) {
      this.logger?.debug?.(`Dispatch watcher lookup failed for ${sessionId}: ${errorMessage(error)}`);
      agent = null;
    }

    if (!agent && typeof this.agents.resume === 'function') {
      try {
        agent = await this.agents.resume({ resumeSessionId: sessionId });
      } catch (error) {
        this.logger?.debug?.(`Dispatch watcher resume failed for ${sessionId}: ${errorMessage(error)}`);
        agent = null;
      }
    }

    if (!agent) {
      if (typeof this.agents.create !== 'function') {
        throw new Error(`Watcher session "${sessionId}" is unavailable and the agents service cannot create sessions`);
      }
      agent = await this.agents.create({
        sessionId,
        meta: { cwd: this._settings.workspaceRoot },
      });
    }

    if (!agent || typeof agent.followup !== 'function') {
      throw new Error(`Watcher session "${sessionId}" is unavailable`);
    }
    if (typeof agent.id === 'string' && agent.id.length > 0) sessionId = agent.id;
    this._state.sessionId = sessionId;
    return { sessionId, agent };
  }

  /**
   * Process freshly observed inbox events.
   * @param {object[]} events events from `EventStore.list(...)` (normally unread)
   * @returns {Promise<{ dispatched:boolean, reason?:string, sessionId?:string,
   *   taskIds?:string[], eventIds?:string[] }>}
   */
  async handleEvents(events) {
    if (!this._settings.autoDispatch) return { dispatched: false, reason: 'disabled' };

    const input = Array.isArray(events) ? events.filter(isPlainObject) : [];
    let stateChanged = false;
    const observedAt = this._latestObservedAt(input);
    if (observedAt && (!this._state.lastEventAt || observedAt > this._state.lastEventAt)) {
      this._state.lastEventAt = observedAt;
      stateChanged = true;
    }

    if (input.length === 0) {
      if (stateChanged) this._persist();
      return { dispatched: false, reason: 'no-events' };
    }

    const seen = new Set(this._state.seen);
    const kinds = new Set(this._settings.kinds);
    const watchedRepos = this._watchedRepos();
    const candidates = [];
    for (const event of input) {
      if (!this._isCandidate(event, seen, kinds, watchedRepos)) {
        this._skipped += 1;
        continue;
      }
      candidates.push(event);
    }

    if (candidates.length === 0) {
      if (stateChanged) this._persist();
      return { dispatched: false, reason: 'no-events' };
    }

    // Throttled batches are not marked seen, so a later tick retries them.
    if (this._throttled()) {
      if (stateChanged) this._persist();
      return { dispatched: false, reason: 'throttled' };
    }

    candidates.sort(
      (left, right) =>
        (KIND_PRIORITY[toText(right.kind)] ?? 0) - (KIND_PRIORITY[toText(left.kind)] ?? 0) ||
        eventTime(right) - eventTime(left) ||
        toText(left.id).localeCompare(toText(right.id)),
    );
    const chosen = candidates.slice(0, this._settings.maxEvents);

    const taskIds = [];
    if (this._settings.createTasks) {
      try {
        for (const event of chosen) {
          taskIds.push(this.tasks.create(this._taskInput(event)).id);
        }
      } catch (error) {
        this._state.lastError = errorMessage(error);
        this._persist();
        this.logger?.warn?.(`Auto-dispatch task creation failed: ${errorMessage(error)}`);
        return { dispatched: false, reason: 'task-create-failed' };
      }
    }

    let session;
    try {
      session = await this._ensureSession();
    } catch (error) {
      this._state.lastError = errorMessage(error);
      this._persist();
      this.logger?.warn?.(`Auto-dispatch watcher session unavailable: ${errorMessage(error)}`);
      return { dispatched: false, reason: 'session-unavailable' };
    }

    const eventIds = chosen.map((event) => toText(event.id));
    const prompt = buildDispatchPrompt({
      repo: uniqueRepos(chosen).join(', '),
      events: chosen,
      taskIds,
      workspaceRoot: this._settings.workspaceRoot,
      config: this.config,
    });

    try {
      await session.agent.followup(createUserMessage(prompt));
    } catch (error) {
      this._state.lastError = errorMessage(error);
      this._persist();
      this.logger?.warn?.(`Auto-dispatch followup failed: ${errorMessage(error)}`);
      return {
        dispatched: false,
        reason: 'followup-failed',
        sessionId: session.sessionId,
        taskIds,
        eventIds,
      };
    }

    this._rememberSeen(eventIds);
    this._state.lastDispatchAt = new Date(this.now()).toISOString();
    this._state.count += 1;
    this._state.sessionId = session.sessionId;
    this._state.lastError = null;
    for (const taskId of taskIds) {
      try {
        this.tasks.update(taskId, { note: `Auto-dispatched to session ${session.sessionId}` });
      } catch (error) {
        this.logger?.warn?.(`Failed to note auto-dispatch on ${taskId}: ${errorMessage(error)}`);
      }
    }
    this._persist();
    return {
      dispatched: true,
      sessionId: session.sessionId,
      taskIds,
      eventIds,
    };
  }

  /**
   * Deliver arbitrary text to the watcher session (panel / chat trigger).
   * Works regardless of the `autoDispatch` toggle.
   * @param {string} text
   * @returns {Promise<{ sessionId: string, sent: true }>}
   */
  async sendToWatcher(text) {
    let session;
    try {
      session = await this._ensureSession();
    } catch (error) {
      this._state.lastError = errorMessage(error);
      this._persist();
      throw error;
    }
    try {
      await session.agent.followup(createUserMessage(text));
    } catch (error) {
      this._state.lastError = errorMessage(error);
      this._persist();
      throw error;
    }
    this._persist();
    return { sessionId: session.sessionId, sent: true };
  }

  /**
   * Convenience hook kept for the runtime API. The Lead feeds events to
   * `handleEvents` after each poll, so a tick has no work of its own here.
   * @returns {Promise<{ dispatched: false, reason: 'no-events' }>}
   */
  async tick() {
    return { dispatched: false, reason: 'no-events' };
  }
}
