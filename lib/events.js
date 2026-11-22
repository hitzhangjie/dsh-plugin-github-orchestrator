/**
 * Event inbox: deterministic event creation, an atomically persisted event
 * store, and the GitHub poller that turns API deltas into inbox events.
 *
 * The poller keeps watermarks in `<stateDir>/events-watermarks.json`, primes
 * itself on the first poll (optionally emitting a bounded baseline of open
 * issues/PRs) and only ever emits events when a watched watermark changes.
 */
import os from 'node:os';
import path from 'node:path';

import { parseRepoSpec } from './config.js';
import { nowIso, readJson, shortHash, toErrorMessage, truncate, writeJsonAtomic } from './util.js';

const DEFAULT_MAX_EVENTS = 2000;
const DEFAULT_BASELINE_DAYS = 14;
const DEFAULT_POLL_INTERVAL_SEC = 120;
const MAX_BASELINE_EVENTS_PER_REPO = 25;
const MAX_REVIEW_PRS = 10;
const MAX_BRANCH_PAGES = 2;
const BASELINE_PAGE_SIZE = 50;
const BRANCH_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const SILENT_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

function cloneReviewState(input) {
  const result = {};
  for (const [prNumber, reviews] of Object.entries(input ?? {})) {
    result[prNumber] = { ...(reviews ?? {}) };
  }
  return result;
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toIsoOrNow(value, nowMs) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(nowMs).toISOString();
}

function issueAction(item, previousUpdatedAt) {
  if (String(item?.state ?? 'open') === 'closed') return 'closed';
  return previousUpdatedAt ? 'updated' : 'opened';
}

function pullAction(item, previousUpdatedAt) {
  if (item?.merged_at) return 'merged';
  if (String(item?.state ?? 'open') === 'closed') return 'closed';
  return previousUpdatedAt ? 'updated' : 'opened';
}

function eventLabel(kind) {
  if (kind === 'pr') return 'PR';
  if (kind === 'review') return 'Review';
  if (kind === 'push') return 'Push';
  return 'Issue';
}

/** Human-readable summary used when the caller does not provide one. */
function defaultSummary(partial) {
  const kind = String(partial?.kind ?? 'event');
  const action = String(partial?.action ?? 'updated');
  const title = cleanText(partial?.title);
  if (kind === 'push') {
    const branch = partial?.branch ? ` to ${partial.branch}` : '';
    const sha = partial?.sha ? ` (${String(partial.sha).slice(0, 7)})` : '';
    return truncate(`Push${branch}${sha}`, 300);
  }
  const number = partial?.number !== undefined && partial?.number !== null ? `#${partial.number}` : '';
  const head = `${eventLabel(kind)} ${number} ${action}`.replace(/\s+/g, ' ').trim();
  return truncate(title ? `${head}: ${title}` : head, 300);
}

/**
 * Build a normalized inbox event. When `partial.id` is omitted the id is a
 * deterministic hash of repo/kind/target/action/key, so re-deriving the same
 * event never produces a second id.
 */
export function createEvent(partial = {}) {
  const repo = String(partial.repo ?? '');
  const kind = String(partial.kind ?? 'issue');
  const action = String(partial.action ?? 'updated');
  const at = typeof partial.at === 'string' && partial.at ? partial.at : toIsoOrNow(partial.at, Date.now());
  const hasNumber = partial.number !== undefined && partial.number !== null && Number.isFinite(Number(partial.number));
  const number = hasNumber ? Number(partial.number) : undefined;
  const key = partial.key ?? partial.sha ?? at;
  const identity = [repo, kind, number ?? '', partial.branch ?? '', partial.sha ?? '', action, key].join('|');

  const event = {
    id: typeof partial.id === 'string' && partial.id ? partial.id : `evt_${shortHash(identity, 16)}`,
    repo,
    kind,
    action,
    at,
    summary: partial.summary ? truncate(String(partial.summary), 300) : defaultSummary({ ...partial, kind, action }),
    read: Boolean(partial.read),
  };
  if (number !== undefined) event.number = number;
  if (partial.title) event.title = String(partial.title);
  if (partial.url) event.url = String(partial.url);
  if (partial.actor) event.actor = String(partial.actor);
  if (partial.branch) event.branch = String(partial.branch);
  if (partial.sha) event.sha = String(partial.sha);
  if (partial.taskId) event.taskId = String(partial.taskId);
  if (partial.baseline !== undefined) event.baseline = Boolean(partial.baseline);
  return event;
}

function normalizeStoredEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const base = typeof raw.id === 'string' && raw.id ? raw : createEvent(raw);
  return {
    ...base,
    id: String(base.id),
    repo: String(base.repo ?? ''),
    kind: String(base.kind ?? 'issue'),
    action: String(base.action ?? 'updated'),
    at: typeof base.at === 'string' && base.at ? base.at : nowIso(),
    summary: String(base.summary ?? ''),
    read: Boolean(base.read),
  };
}

function parseSince(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (Number.isFinite(value)) return Number(value);
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : null;
}

/** Atomically persisted, deduplicating inbox event store. */
export class EventStore {
  /**
   * @param {string} filePath JSON file that holds events
   * @param {{ maxEvents?: number }} [opts] maxEvents caps the file (oldest dropped)
   */
  constructor(filePath, opts = {}) {
    if (!filePath) throw new Error('EventStore requires a file path');
    this.filePath = path.resolve(String(filePath));
    this.maxEvents = Number.isFinite(opts.maxEvents) && opts.maxEvents > 0 ? Math.floor(opts.maxEvents) : DEFAULT_MAX_EVENTS;
  }

  /** Read all stored events in insertion order (oldest first). */
  _readAll() {
    const value = readJson(this.filePath, null);
    const events = Array.isArray(value) ? value : Array.isArray(value?.events) ? value.events : [];
    return events.map(normalizeStoredEvent).filter(Boolean);
  }

  _write(events) {
    writeJsonAtomic(this.filePath, { version: 1, updatedAt: nowIso(), events });
  }

  /**
   * List events, newest first.
   * @param {{ repo?: string, kinds?: string[]|string, unreadOnly?: boolean, since?: string|Date|number, limit?: number }} [filter]
   * @returns {Array<object>}
   */
  list(filter = {}) {
    const kinds = filter.kinds === undefined || filter.kinds === null
      ? null
      : new Set(Array.isArray(filter.kinds) ? filter.kinds.map(String) : [String(filter.kinds)]);
    const repo = filter.repo ? String(filter.repo) : null;
    const unreadOnly = Boolean(filter.unreadOnly);
    const since = parseSince(filter.since);
    const limit = Number.isFinite(filter.limit) && filter.limit >= 0 ? Math.floor(filter.limit) : null;

    let events = this._readAll().filter((event) => {
      if (repo && event.repo !== repo) return false;
      if (kinds && !kinds.has(event.kind)) return false;
      if (unreadOnly && event.read) return false;
      if (since !== null) {
        const time = Date.parse(event.at);
        if (!Number.isFinite(time) || time < since) return false;
      }
      return true;
    });
    events.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
    if (limit !== null) events = events.slice(0, limit);
    return events;
  }

  /** Count unread events, optionally scoped to one repository. */
  unreadCount(filter = {}) {
    const repo = filter.repo ? String(filter.repo) : null;
    return this._readAll().filter((event) => !event.read && (!repo || event.repo === repo)).length;
  }

  /**
   * Append events, deduplicating by id, then cap the store (oldest dropped).
   * @returns {{ added: number, duplicates: number }}
   */
  add(events) {
    const incoming = Array.isArray(events) ? events : events ? [events] : [];
    const current = this._readAll();
    const seen = new Set(current.map((event) => event.id));
    let added = 0;
    let duplicates = 0;
    for (const raw of incoming) {
      const event = normalizeStoredEvent(raw);
      if (!event) continue;
      if (seen.has(event.id)) {
        duplicates += 1;
        continue;
      }
      seen.add(event.id);
      current.push(event);
      added += 1;
    }
    let trimmed = 0;
    if (current.length > this.maxEvents) {
      trimmed = current.length - this.maxEvents;
      current.splice(0, trimmed);
    }
    if (added > 0 || trimmed > 0) this._write(current);
    return { added, duplicates };
  }

  /**
   * Mark events read. Without ids and without `all`, nothing happens.
   * @param {string[]} [ids]
   * @param {{ all?: boolean, repo?: string }} [opts]
   * @returns {number} number of events whose read flag changed
   */
  markRead(ids, opts = {}) {
    const all = opts.all === true;
    const idSet = new Set(Array.isArray(ids) ? ids.map(String) : ids ? [String(ids)] : []);
    if (!all && idSet.size === 0) return 0;
    const repo = opts.repo ? String(opts.repo) : null;
    const events = this._readAll();
    let changed = 0;
    for (const event of events) {
      if (event.read) continue;
      if (repo && event.repo !== repo) continue;
      const matches = all ? true : idSet.has(event.id);
      if (!matches) continue;
      event.read = true;
      changed += 1;
    }
    if (changed > 0) this._write(events);
    return changed;
  }

  /** Drop oldest events until at most `max` remain (default: constructor cap). */
  prune(opts = {}) {
    const max = Number.isFinite(opts.max) && opts.max >= 0 ? Math.floor(opts.max) : this.maxEvents;
    const events = this._readAll();
    if (events.length <= max) return;
    events.splice(0, events.length - max);
    this._write(events);
  }

  /** Aggregate counts for the inbox UI. */
  stats() {
    const events = this._readAll();
    const byRepo = {};
    const byKind = {};
    let unread = 0;
    let lastEventAt = null;
    for (const event of events) {
      if (!event.read) unread += 1;
      byRepo[event.repo] = (byRepo[event.repo] ?? 0) + 1;
      byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
      if (!lastEventAt || String(event.at) > lastEventAt) lastEventAt = event.at;
    }
    return { total: events.length, unread, byRepo, byKind, lastEventAt };
  }
}

/**
 * Polls GitHub for issues, pull requests, reviews and branch tips, converting
 * deltas into deduplicated inbox events.
 */
export class EventPoller {
  /**
   * @param {{ client: object, store: EventStore, config: object, logger?: object,
   *   now?: () => number, pollIntervalSec?: number, watermarksPath?: string }} opts
   */
  constructor(opts = {}) {
    if (!opts.client) throw new Error('EventPoller requires a GitHubClient');
    if (!opts.store) throw new Error('EventPoller requires an EventStore');
    this.client = opts.client;
    this.store = opts.store;
    this.config = opts.config ?? {};
    this.logger = opts.logger ?? SILENT_LOGGER;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.pollIntervalSec = Number.isFinite(opts.pollIntervalSec)
      ? opts.pollIntervalSec
      : this.config.pollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC;
    this._explicitWatermarksPath = opts.watermarksPath ? path.resolve(String(opts.watermarksPath)) : null;
    this.watermarksPath = this._explicitWatermarksPath ?? this._defaultWatermarksPath();
    this._timer = null;
    this._watermarks = this._loadWatermarks();
  }

  _defaultWatermarksPath() {
    const stateDir = this.config.stateDir
      ? path.resolve(String(this.config.stateDir))
      : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'github-orchestrator');
    return path.join(stateDir, 'events-watermarks.json');
  }

  _loadWatermarks() {
    const value = readJson(this.watermarksPath, null);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        version: 1,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        repos: value.repos && typeof value.repos === 'object' && !Array.isArray(value.repos) ? value.repos : {},
      };
    }
    return { version: 1, updatedAt: null, repos: {} };
  }

  _saveWatermarks() {
    writeJsonAtomic(this.watermarksPath, {
      version: 1,
      updatedAt: new Date(this.now()).toISOString(),
      repos: this._watermarks.repos,
    });
  }

  _repoState(repo) {
    let state = this._watermarks.repos[repo];
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      state = { primed: false, lastPollAt: null, issues: {}, pulls: {}, branches: {}, reviews: {} };
      this._watermarks.repos[repo] = state;
    }
    if (!state.issues || typeof state.issues !== 'object') state.issues = {};
    if (!state.pulls || typeof state.pulls !== 'object') state.pulls = {};
    if (!state.branches || typeof state.branches !== 'object') state.branches = {};
    if (!state.reviews || typeof state.reviews !== 'object') state.reviews = {};
    return state;
  }

  _repoSpecs() {
    const input = Array.isArray(this.config?.repos) ? this.config.repos : [];
    const specs = [];
    for (const entry of input) {
      try {
        specs.push(parseRepoSpec(entry));
      } catch (error) {
        this.logger?.warn?.(`Skipping invalid repository config: ${toErrorMessage(error)}`);
      }
    }
    return specs;
  }

  /** Replace the config; restarts the timer when it is running. */
  updateConfig(config) {
    this.config = config ?? this.config;
    this.pollIntervalSec = Number.isFinite(this.config?.pollIntervalSec)
      ? this.config.pollIntervalSec
      : this.pollIntervalSec;
    if (!this._explicitWatermarksPath) {
      const nextPath = this._defaultWatermarksPath();
      if (nextPath !== this.watermarksPath) {
        this.watermarksPath = nextPath;
        this._watermarks = this._loadWatermarks();
      }
    }
    if (this._timer) {
      this.stop();
      this.start();
    }
  }

  /** Start periodic polling. Idempotent; the timer is unref'd. */
  start() {
    if (this._timer) return;
    const intervalMs = Math.max(1000, Math.round((Number(this.pollIntervalSec) || DEFAULT_POLL_INTERVAL_SEC) * 1000));
    this._timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.logger?.error?.(`GitHub event poll failed: ${toErrorMessage(error)}`);
      });
    }, intervalMs);
    this._timer.unref?.();
    this.logger?.debug?.(`GitHub event poller started (every ${intervalMs}ms)`);
  }

  /** Stop periodic polling. Safe to call when not running. */
  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
    this.logger?.debug?.('GitHub event poller stopped');
  }

  /**
   * Poll every configured repository once. A failure in one repository is
   * recorded and does not prevent the others from being polled.
   * @param {{ repo?: string, baseline?: boolean }} [opts]
   * @returns {Promise<{ repos: number, added: number, errors: Array<{ repo: string, error: string }> }>}
   */
  async pollOnce(opts = {}) {
    const wanted = opts.repo ? String(opts.repo) : null;
    const specs = this._repoSpecs().filter((spec) => !wanted || spec.repo === wanted);
    let added = 0;
    const errors = [];
    for (const spec of specs) {
      try {
        const result = await this.pollRepo(spec, { baseline: opts.baseline });
        added += result.added;
      } catch (error) {
        const message = toErrorMessage(error);
        errors.push({ repo: spec.repo, error: message });
        this.logger?.warn?.(`GitHub poll failed for ${spec.repo}: ${message}`);
      }
    }
    this._saveWatermarks();
    return { repos: specs.length, added, errors };
  }

  /**
   * Poll one repository: issues, pull requests, reviews for changed open PRs
   * and branch tips. Persists watermarks and appends new events to the store.
   * @returns {Promise<{ added: number, events: Array<object> }>}
   */
  async pollRepo(spec, opts = {}) {
    const repoSpec = parseRepoSpec(typeof spec === 'string' ? spec : spec);
    const repo = repoSpec.repo;
    const config = this.config ?? {};
    const baselineDays = Number.isFinite(config.baselineDays) ? config.baselineDays : DEFAULT_BASELINE_DAYS;
    const nowMs = this.now();
    const nowAt = new Date(nowMs).toISOString();
    const current = this._repoState(repo);
    const firstPoll = !current.primed;
    const wantBaseline = opts.baseline !== false;
    const next = {
      primed: true,
      lastPollAt: nowAt,
      issues: { ...(current.issues ?? {}) },
      pulls: { ...(current.pulls ?? {}) },
      branches: { ...(current.branches ?? {}) },
      reviews: cloneReviewState(current.reviews),
    };
    const events = [];
    const baselineCandidates = [];
    const withinBaseline = (iso) => {
      if (!(baselineDays > 0)) return false;
      const time = Date.parse(String(iso ?? ''));
      return Number.isFinite(time) && time >= nowMs - baselineDays * DAY_MS;
    };

    // --- issues (the issues endpoint also returns PRs; those are handled below)
    const issueResponse = await this.client.get(`/repos/${repo}/issues`, {
      query: { state: 'all', sort: 'updated', direction: 'desc', per_page: BASELINE_PAGE_SIZE },
    });
    const issueItems = Array.isArray(issueResponse.data)
      ? issueResponse.data.filter((item) => item && !item.pull_request)
      : [];
    for (const item of issueItems) {
      const number = Number(item.number);
      if (!Number.isFinite(number)) continue;
      const updatedAt = toIsoOrNow(item.updated_at ?? item.created_at, nowMs);
      const previous = next.issues[number];
      next.issues[number] = updatedAt;
      if (firstPoll) {
        if (String(item.state ?? 'open') === 'open' && withinBaseline(updatedAt)) {
          baselineCandidates.push({ kind: 'issue', item, number, at: updatedAt });
        }
        continue;
      }
      if (previous === updatedAt) continue;
      const action = issueAction(item, previous);
      events.push(
        createEvent({
          repo,
          kind: 'issue',
          action,
          number,
          title: item.title,
          url: item.html_url,
          actor: item.user?.login,
          at: updatedAt,
          summary: `Issue #${number} ${action}${item.title ? `: ${item.title}` : ''}`,
          key: `issue:${number}:${updatedAt}`,
        }),
      );
    }

    // --- pull requests
    const pullResponse = await this.client.get(`/repos/${repo}/pulls`, {
      query: { state: 'all', sort: 'updated', direction: 'desc', per_page: BASELINE_PAGE_SIZE },
    });
    const pullItems = Array.isArray(pullResponse.data) ? pullResponse.data.filter(Boolean) : [];
    const reviewTargets = [];
    for (const item of pullItems) {
      const number = Number(item.number);
      if (!Number.isFinite(number)) continue;
      const updatedAt = toIsoOrNow(item.updated_at ?? item.created_at, nowMs);
      const previous = next.pulls[number];
      next.pulls[number] = updatedAt;
      const isOpen = String(item.state ?? 'open') === 'open';
      if (firstPoll) {
        if (isOpen && withinBaseline(updatedAt)) baselineCandidates.push({ kind: 'pr', item, number, at: updatedAt });
        if (isOpen) reviewTargets.push(number);
        continue;
      }
      if (previous === updatedAt) continue;
      const action = pullAction(item, previous);
      events.push(
        createEvent({
          repo,
          kind: 'pr',
          action,
          number,
          title: item.title,
          url: item.html_url,
          actor: item.user?.login,
          at: updatedAt,
          summary: `PR #${number} ${action}${item.title ? `: ${item.title}` : ''}`,
          key: `pr:${number}:${updatedAt}`,
        }),
      );
      if (isOpen) reviewTargets.push(number);
    }

    // --- reviews for changed open PRs (max 10); first poll only primes state
    for (const prNumber of reviewTargets.slice(0, MAX_REVIEW_PRS)) {
      const reviewResponse = await this.client.get(`/repos/${repo}/pulls/${prNumber}/reviews`, {
        query: { per_page: 100 },
      });
      const reviews = Array.isArray(reviewResponse.data) ? reviewResponse.data : [];
      const known = { ...(next.reviews[prNumber] ?? {}) };
      for (const review of reviews) {
        if (!review || review.id === undefined || review.id === null) continue;
        const reviewId = String(review.id);
        const submittedAt = toIsoOrNow(review.submitted_at, nowMs);
        const previousSubmitted = known[reviewId];
        known[reviewId] = submittedAt;
        if (firstPoll || previousSubmitted === submittedAt) continue;
        const stateName = String(review.state ?? 'COMMENTED').toLowerCase();
        events.push(
          createEvent({
            repo,
            kind: 'review',
            action: stateName,
            number: prNumber,
            url: review.html_url,
            actor: review.user?.login,
            at: submittedAt,
            summary: `Review ${stateName} on PR #${prNumber}${review.user?.login ? ` by ${review.user.login}` : ''}`,
            key: `review:${reviewId}:${submittedAt}`,
          }),
        );
      }
      next.reviews[prNumber] = known;
    }

    // --- branch tips (max 2 pages) for push detection
    const branchItems = [];
    for (let page = 1; page <= MAX_BRANCH_PAGES; page += 1) {
      const branchResponse = await this.client.get(`/repos/${repo}/branches`, {
        query: { per_page: BRANCH_PAGE_SIZE, page },
      });
      const pageItems = Array.isArray(branchResponse.data) ? branchResponse.data : [];
      branchItems.push(...pageItems);
      if (pageItems.length < BRANCH_PAGE_SIZE) break;
    }
    for (const item of branchItems) {
      const branchName = String(item?.name ?? '');
      const sha = String(item?.commit?.sha ?? '');
      if (!branchName || !sha) continue;
      const previousSha = next.branches[branchName];
      next.branches[branchName] = sha;
      if (firstPoll || !previousSha || previousSha === sha) continue;
      events.push(
        createEvent({
          repo,
          kind: 'push',
          action: 'pushed',
          branch: branchName,
          sha,
          at: nowAt,
          summary: `Push to ${branchName} (${sha.slice(0, 7)})`,
          key: `push:${branchName}:${sha}`,
        }),
      );
    }

    // --- first-poll baseline: at most 25 recently updated open issues/PRs
    if (firstPoll && wantBaseline) {
      baselineCandidates
        .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || b.number - a.number)
        .slice(0, MAX_BASELINE_EVENTS_PER_REPO)
        .forEach((candidate) => {
          const item = candidate.item;
          const label = candidate.kind === 'pr' ? 'PR' : 'Issue';
          events.push(
            createEvent({
              repo,
              kind: candidate.kind,
              action: 'opened',
              number: candidate.number,
              title: item.title,
              url: item.html_url,
              actor: item.user?.login,
              at: candidate.at,
              baseline: true,
              summary: `${label} #${candidate.number} opened${item.title ? `: ${item.title}` : ''}`,
              key: `baseline:${candidate.kind}:${candidate.number}:${candidate.at}`,
            }),
          );
        });
    }

    this._watermarks.repos[repo] = next;
    this._watermarks.updatedAt = nowAt;
    this._saveWatermarks();
    const result = this.store.add(events);
    return { added: result.added, events };
  }

  /** Snapshot of all persisted watermarks (safe to serialize). */
  watermarks() {
    return JSON.parse(JSON.stringify(this._watermarks));
  }
}
