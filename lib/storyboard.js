/**
 * GitHub-issue storyboard: renders tasks and the epic issue, parses the hidden
 * metadata block back into task fields, and keeps issues in sync through a
 * GitHubClient (see CONTRACT.md). Markdown output is deterministic apart from
 * the timestamps it embeds.
 */
import { nowIso } from './util.js';

/** Opening sentinel of the hidden task metadata block. */
export const TASK_META_START = '<!-- github-orchestrator:task';
/** Closing sentinel shared by the task metadata block. */
export const TASK_META_END = '-->';
/** Marks an issue body as the storyboard epic. */
export const EPIC_META = '<!-- github-orchestrator:epic -->';

const DEFAULT_LABELS = {
  task: 'gos:task',
  epic: 'gos:epic',
  statusPrefix: 'gos:status/',
};

const TASK_STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done'];

const LABEL_COLORS = {
  task: '1d76db',
  epic: '5319e7',
  backlog: 'ededed',
  ready: '0e8a16',
  in_progress: 'fbca04',
  review: '1d76db',
  done: '6f42c1',
};

const LABEL_DESCRIPTIONS = {
  task: 'Managed by DeepSeek Harness github-orchestrator',
  epic: 'Generated storyboard for this repository',
};

function statusCodeOf(error) {
  return error?.status ?? error?.statusCode ?? error?.response?.status ?? null;
}

function escapeCell(text) {
  return String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}

function compareTasks(left, right) {
  const number = (task) => {
    const match = /^T(\d+)$/i.exec(String(task?.id ?? ''));
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  const diff = number(left) - number(right);
  if (diff !== 0) return diff;
  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

function taskMetaOf(task, repo) {
  return {
    taskId: task.id,
    repo,
    branch: task.branch,
    status: task.status,
    baseBranch: task.baseBranch,
    worktree: task.worktreePath ?? null,
  };
}

function notesBlock(notes) {
  const list = Array.isArray(notes) ? notes.filter((note) => note && note.text) : [];
  if (list.length === 0) return '_No notes yet._';
  return list.map((note) => `- ${note.at ?? nowIso()} ${note.text}`).join('\n');
}

/**
 * Render the Markdown body and labels for a task issue.
 * @param {object} task
 * @param {{ repo?: string, labels?: { task?: string, epic?: string, statusPrefix?: string } }} [opts]
 * @returns {{ title: string, body: string, labels: string[] }}
 */
export function renderTaskIssue(task, opts = {}) {
  if (!task || typeof task !== 'object') throw new Error('renderTaskIssue requires a task');
  const labels = { ...DEFAULT_LABELS, ...(opts.labels ?? {}) };
  const repo = opts.repo ?? task.repo ?? '';
  const meta = JSON.stringify(taskMetaOf(task, repo));

  const plan = [
    `- Status: \`${task.status}\``,
    `- Priority: \`${task.priority}\``,
    `- Branch: \`${task.branch}\` (base \`${task.baseBranch}\`)`,
  ];
  if (task.worktreePath) plan.push(`- Worktree: \`${task.worktreePath}\``);
  if (task.epicNumber !== undefined && task.epicNumber !== null) plan.push(`- Epic: #${task.epicNumber}`);
  if (task.prNumber !== undefined && task.prNumber !== null) plan.push(`- Pull request: #${task.prNumber}`);
  if (Array.isArray(task.tags) && task.tags.length > 0) plan.push(`- Tags: ${task.tags.join(', ')}`);

  const body = [
    `${TASK_META_START}\n${meta}\n${TASK_META_END}`,
    '## Summary',
    task.description && String(task.description).trim()
      ? String(task.description).trim()
      : '_No description yet._',
    '## Plan',
    plan.join('\n'),
    '## Notes',
    notesBlock(task.notes),
  ].join('\n\n');

  return {
    title: `[${task.id}] ${task.title}`,
    body: `${body}\n`,
    labels: [labels.task, `${labels.statusPrefix}${task.status}`],
  };
}

/**
 * Render the storyboard epic issue for one repository.
 * @param {{ repo: string, tasks: object[], generatedAt?: string,
 *   labels?: { task?: string, epic?: string, statusPrefix?: string } }} opts
 * @returns {{ title: string, body: string, labels: string[] }}
 */
export function renderEpicIssue(opts = {}) {
  const repo = String(opts.repo ?? '');
  if (!repo) throw new Error('renderEpicIssue requires a repo');
  const labels = { ...DEFAULT_LABELS, ...(opts.labels ?? {}) };
  const generatedAt = opts.generatedAt ?? nowIso();
  const tasks = [...(opts.tasks ?? [])].sort(compareTasks);

  const counts = new Map(TASK_STATUSES.map((status) => [status, 0]));
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  const countRows = TASK_STATUSES.map((status) => `| ${status} | ${counts.get(status) ?? 0} |`);

  const taskRows = tasks.map((task) => {
    const issue = task.issueNumber ? `#${task.issueNumber}` : '—';
    return `| [${task.id}] ${escapeCell(task.title)} | ${task.status} | \`${escapeCell(task.branch) || '—'}\` | ${issue} |`;
  });

  const statusRank = new Map(['in_progress', 'ready', 'backlog', 'review'].map((status, index) => [status, index]));
  const nextUp = tasks
    .filter((task) => task.status !== 'done')
    .sort((left, right) => {
      const diff = (statusRank.get(left.status) ?? 9) - (statusRank.get(right.status) ?? 9);
      return diff !== 0 ? diff : compareTasks(left, right);
    })
    .slice(0, 5)
    .map((task) => `- [${task.id}] ${task.title} (${task.status})`);

  const body = [
    EPIC_META,
    `# Storyboard — ${repo}`,
    `_Generated at ${generatedAt}_`,
    '## Counts',
    ['| Status | Count |', '| --- | --- |', ...countRows, `| **Total** | ${tasks.length} |`].join('\n'),
    '## Tasks',
    taskRows.length > 0
      ? ['| Task | Status | Branch | Issue |', '| --- | --- | --- | --- |', ...taskRows].join('\n')
      : '| Task | Status | Branch | Issue |\n| --- | --- | --- | --- |\n| _None yet_ | — | — | — |',
    '## Next up',
    nextUp.length > 0 ? nextUp.join('\n') : '_Nothing queued._',
  ].join('\n\n');

  return {
    title: `[Storyboard] ${repo}`,
    body: `${body}\n`,
    labels: [labels.epic],
  };
}

/**
 * Parse the hidden task metadata block out of an issue body.
 * @param {string} body
 * @returns {object|null} parsed metadata or null when absent/malformed
 */
export function parseTaskMeta(body) {
  const text = String(body ?? '');
  const start = text.indexOf(TASK_META_START);
  if (start === -1) return null;
  const rest = text.slice(start + TASK_META_START.length);
  const end = rest.indexOf(TASK_META_END);
  if (end === -1) return null;
  const raw = rest.slice(0, end).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Remove the hidden task metadata block from an issue body. */
export function stripTaskMeta(body) {
  const text = String(body ?? '');
  const start = text.indexOf(TASK_META_START);
  if (start === -1) return text.trim();
  const end = text.indexOf(TASK_META_END, start);
  if (end === -1) return text.trim();
  return `${text.slice(0, start)}${text.slice(end + TASK_META_END.length)}`.trim();
}

/** Best-effort description for an imported issue: prefer its `## Summary` section. */
function describeIssue(body) {
  const stripped = stripTaskMeta(body);
  const summary = /^##\s+Summary\s*\n+([\s\S]*?)(?:\n##\s+|$)/im.exec(stripped);
  if (summary && summary[1].trim()) return summary[1].trim();
  return stripped;
}

/** Strip a leading `[T3] ` prefix from an issue title. */
function cleanIssueTitle(title, meta) {
  const value = String(title ?? '').trim();
  const withoutPrefix = value.replace(/^\[T\d+\]\s*/i, '').trim();
  if (withoutPrefix) return withoutPrefix;
  return meta?.taskId ? `Imported ${meta.taskId}` : value || 'Imported issue';
}

function validStatus(value) {
  return TASK_STATUSES.includes(value) ? value : undefined;
}

/**
 * Keeps local tasks and GitHub issues in sync. All mutating methods are async
 * and propagate GitHubClient errors except the documented 404 cases.
 */
export class Storyboard {
  /**
   * @param {{ client: object, tasks: object, config?: object, logger?: object }} opts
   */
  constructor(opts = {}) {
    if (!opts.client) throw new Error('Storyboard requires a GitHubClient');
    if (!opts.tasks) throw new Error('Storyboard requires a TaskStore');
    this.client = opts.client;
    this.tasks = opts.tasks;
    this.config = opts.config ?? {};
    this.logger = opts.logger ?? null;
    /** Per-repository tail of the epic-sync chain, so concurrent syncs cannot both create. */
    this.epicSyncs = new Map();
  }

  updateConfig(config) {
    this.config = config ?? {};
  }

  /** Resolved label names for this installation. */
  get labels() {
    return { ...DEFAULT_LABELS, ...(this.config?.labels ?? {}) };
  }

  /** Labels the storyboard wants to exist on a repository. */
  desiredLabels() {
    const labels = this.labels;
    const wanted = [
      { name: labels.task, color: LABEL_COLORS.task, description: LABEL_DESCRIPTIONS.task },
      { name: labels.epic, color: LABEL_COLORS.epic, description: LABEL_DESCRIPTIONS.epic },
    ];
    for (const status of TASK_STATUSES) {
      wanted.push({
        name: `${labels.statusPrefix}${status}`,
        color: LABEL_COLORS[status],
        description: `Storyboard status: ${status}`,
      });
    }
    return wanted;
  }

  async listAllLabels(repo) {
    if (typeof this.client.paginate === 'function') {
      return this.client.paginate(`/repos/${repo}/labels`, { query: { per_page: 100 }, perPage: 100, maxPages: 5 });
    }
    const response = await this.client.get(`/repos/${repo}/labels`, { query: { per_page: 100 } });
    return Array.isArray(response?.data) ? response.data : [];
  }

  /**
   * Create the `gos:task`, `gos:epic` and `gos:status/*` labels that are
   * missing. A 404 (unknown repository) is a documented no-op.
   */
  async ensureLabels(repo) {
    let existing;
    try {
      existing = await this.listAllLabels(repo);
    } catch (error) {
      if (statusCodeOf(error) === 404) return;
      throw error;
    }
    const names = new Set(
      (existing ?? []).map((label) => String(label?.name ?? label).toLowerCase()),
    );
    for (const label of this.desiredLabels()) {
      if (!label.name || names.has(label.name.toLowerCase())) continue;
      try {
        await this.client.post(`/repos/${repo}/labels`, {
          name: label.name,
          color: label.color,
          description: label.description,
        });
        names.add(label.name.toLowerCase());
      } catch (error) {
        const status = statusCodeOf(error);
        if (status === 422 || status === 409) {
          names.add(label.name.toLowerCase());
          continue;
        }
        if (status === 404) return;
        throw error;
      }
    }
  }

  /** Create one GitHub issue for a task. Does not persist issue numbers. */
  async createTaskIssue(repo, task) {
    const rendered = renderTaskIssue(task, { repo, labels: this.labels });
    const response = await this.client.post(`/repos/${repo}/issues`, {
      title: rendered.title,
      body: rendered.body,
      labels: rendered.labels,
    });
    const data = response?.data ?? {};
    return { number: data.number, url: data.html_url ?? data.url ?? '' };
  }

  /** Patch the existing issue of a task; returns null when the issue is gone. */
  async updateTaskIssue(task) {
    if (!task || task.issueNumber === undefined || task.issueNumber === null) return null;
    const rendered = renderTaskIssue(task, { repo: task.repo, labels: this.labels });
    try {
      const response = await this.client.patch(`/repos/${task.repo}/issues/${task.issueNumber}`, {
        title: rendered.title,
        body: rendered.body,
        labels: rendered.labels,
      });
      const data = response?.data ?? {};
      return { number: data.number ?? task.issueNumber, url: data.html_url ?? data.url ?? '' };
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      throw error;
    }
  }

  /** Add a comment to the task issue. */
  async commentTask(task, text) {
    if (!task?.issueNumber) {
      throw new Error(`Task ${task?.id ?? '?'} has no GitHub issue to comment on`);
    }
    await this.client.post(`/repos/${task.repo}/issues/${task.issueNumber}/comments`, {
      body: String(text ?? ''),
    });
  }

  /** Close the task issue, optionally adding a final comment first. */
  async closeTaskIssue(task, comment) {
    if (!task?.issueNumber) return;
    if (comment !== undefined && comment !== null && String(comment).trim()) {
      await this.commentTask(task, comment);
    }
    try {
      await this.client.patch(`/repos/${task.repo}/issues/${task.issueNumber}`, { state: 'closed' });
    } catch (error) {
      if (statusCodeOf(error) !== 404) throw error;
    }
  }

  async listIssues(repo, opts = {}) {
    const query = { state: opts.state ?? 'open', per_page: Math.min(100, opts.perPage ?? 100) };
    if (opts.labels) query.labels = opts.labels;
    const path = `/repos/${repo}/issues`;
    if (typeof this.client.paginate === 'function') {
      return this.client.paginate(path, {
        query,
        perPage: query.per_page,
        maxPages: opts.maxPages ?? 10,
      });
    }
    const response = await this.client.get(path, { query });
    return Array.isArray(response?.data) ? response.data : [];
  }

  async findEpicIssue(repo) {
    const candidates = await this.epicCandidates(repo);
    return candidates[0] ?? null;
  }

  /**
   * Every issue that represents this repository's storyboard, in ascending
   * number order: first exact-title matches, then any issue carrying the epic
   * label. Closed issues are included, because a closed epic must be reused
   * instead of spawning a second one.
   * @param {string} repo
   * @returns {Promise<object[]>}
   */
  async epicCandidates(repo) {
    let issues;
    try {
      issues = await this.listIssues(repo, { state: 'all', perPage: 100, maxPages: 10 });
    } catch (error) {
      if (statusCodeOf(error) === 404) return [];
      throw error;
    }
    const nonPull = (issues ?? []).filter((issue) => issue && !issue.pull_request);
    const title = `[Storyboard] ${repo}`;
    const exact = nonPull.filter((issue) => String(issue.title ?? '').trim() === title);
    const epicLabel = this.labels.epic;
    const labeled = nonPull.filter((issue) => {
      const labels = Array.isArray(issue.labels) ? issue.labels : [];
      return labels.some((label) => String(typeof label === 'string' ? label : label?.name ?? '').toLowerCase() === epicLabel.toLowerCase());
    });
    const byNumber = (left, right) => Number(left.number ?? 0) - Number(right.number ?? 0);
    const seen = new Set();
    const merged = [];
    for (const issue of [...exact.sort(byNumber), ...labeled.sort(byNumber)]) {
      const number = Number(issue.number);
      if (!Number.isInteger(number) || seen.has(number)) continue;
      seen.add(number);
      merged.push(issue);
    }
    return merged;
  }

  /**
   * Resolve a previously recorded epic number, even when the issue was closed.
   * @param {string} repo
   * @param {object[]} tasks
   * @returns {Promise<object|null>}
   */
  async knownEpicIssue(repo, tasks) {
    const numbers = [...new Set(
      (Array.isArray(tasks) ? tasks : [])
        .map((task) => Number(task?.epicNumber))
        .filter((number) => Number.isInteger(number) && number > 0),
    )].sort((left, right) => left - right);
    for (const number of numbers) {
      try {
        const response = await this.client.get(`/repos/${repo}/issues/${number}`);
        const data = response?.data;
        if (data && typeof data === 'object' && !data.pull_request) return data;
      } catch (error) {
        if (statusCodeOf(error) !== 404) throw error;
      }
    }
    return null;
  }

  /**
   * Close extra storyboard epics so only the chosen number stays open. Best
   * effort: a failed cleanup must not fail the sync that already succeeded.
   * @param {string} repo
   * @param {number} keepNumber
   * @param {object[]} candidates
   */
  async closeDuplicateEpics(repo, keepNumber, candidates) {
    for (const issue of candidates ?? []) {
      const number = Number(issue?.number);
      if (!Number.isInteger(number) || number === keepNumber || issue?.state === 'closed') continue;
      try {
        await this.client.post(`/repos/${repo}/issues/${number}/comments`, {
          body: `Closed automatically: this is a duplicate storyboard epic; [#${keepNumber}] is the active one.`,
        });
        await this.client.patch(`/repos/${repo}/issues/${number}`, { state: 'closed' });
      } catch (error) {
        if (statusCodeOf(error) !== 404 && this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn(`Could not close duplicate storyboard epic #${number}: ${error?.message ?? error}`);
        }
      }
    }
  }

  /** Create or update the epic issue for a repository. */
  async syncEpic(repo) {
    const key = String(repo);
    const previous = this.epicSyncs.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.syncEpicLocked(key));
    this.epicSyncs.set(key, next);
    try {
      return await next;
    } finally {
      if (this.epicSyncs.get(key) === next) this.epicSyncs.delete(key);
    }
  }

  /**
   * One serialized epic reconciliation: reuse a known/closed epic, otherwise
   * reuse the oldest matching issue, otherwise create exactly one.
   * @param {string} repo
   */
  async syncEpicLocked(repo) {
    const tasks = this.tasks.list({ repo, includeClosed: true });
    const rendered = renderEpicIssue({ repo, tasks, labels: this.labels });
    const candidates = await this.epicCandidates(repo);
    const known = await this.knownEpicIssue(repo, tasks);
    // Prefer an already-open storyboard so a newer one is not closed in favour
    // of an old closed issue; otherwise reuse the recorded/oldest epic.
    const openCandidates = candidates.filter((issue) => String(issue.state ?? '') !== 'closed');
    let existing = null;
    if (known && String(known.state ?? '') !== 'closed') existing = known;
    else if (openCandidates.length > 0) existing = openCandidates[0];
    else existing = known ?? candidates[0] ?? null;
    if (existing && !candidates.some((issue) => Number(issue.number) === Number(existing.number))) {
      candidates.unshift(existing);
    }
    if (existing) {
      const reopen = String(existing.state ?? '') === 'closed' ? { state: 'open' } : {};
      const response = await this.client.patch(`/repos/${repo}/issues/${existing.number}`, {
        title: rendered.title,
        body: rendered.body,
        labels: rendered.labels,
        ...reopen,
      });
      const data = response?.data ?? {};
      const number = Number(data.number ?? existing.number);
      await this.closeDuplicateEpics(repo, number, candidates);
      return { number, url: data.html_url ?? existing.html_url ?? '' };
    }
    const response = await this.client.post(`/repos/${repo}/issues`, {
      title: rendered.title,
      body: rendered.body,
      labels: rendered.labels,
    });
    const data = response?.data ?? {};
    return { number: data.number, url: data.html_url ?? data.url ?? '' };
  }

  /**
   * Push one task to GitHub: create or update its issue, then refresh the epic.
   * @returns {{ issue?: {number:number,url:string}, epic?: {number:number,url:string} }}
   */
  async syncTask(task) {
    if (!task || !task.id) throw new Error('syncTask requires a task');
    const result = {};
    if (task.issueNumber !== undefined && task.issueNumber !== null) {
      const updated = await this.updateTaskIssue(task);
      if (updated) {
        result.issue = updated;
      } else {
        const created = await this.createTaskIssue(task.repo, task);
        this.tasks.update(task.id, { issueNumber: created.number, issueUrl: created.url });
        result.issue = created;
      }
    } else {
      const created = await this.createTaskIssue(task.repo, task);
      this.tasks.update(task.id, { issueNumber: created.number, issueUrl: created.url });
      result.issue = created;
    }
    const epic = await this.syncEpic(task.repo);
    result.epic = epic;
    if (task.epicNumber !== epic.number) {
      try {
        this.tasks.update(task.id, { epicNumber: epic.number });
      } catch (error) {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn(`Could not record epic number on ${task.id}: ${error?.message ?? error}`);
        }
      }
    }
    return result;
  }

  /**
   * Import open issues that the store does not know yet.
   * @param {string} repo
   * @param {{ label?: string, limit?: number }} [opts]
   * @returns {{ imported:number, skipped:number }}
   */
  async importIssues(repo, opts = {}) {
    const label = opts.label ?? this.labels.task;
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 100;
    let issues;
    try {
      issues = await this.listIssues(repo, {
        state: 'open',
        labels: label,
        perPage: Math.min(limit, 100),
        maxPages: 5,
      });
    } catch (error) {
      if (statusCodeOf(error) === 404) return { imported: 0, skipped: 0 };
      throw error;
    }

    let imported = 0;
    let skipped = 0;
    for (const issue of issues ?? []) {
      if (!issue || issue.pull_request) continue;
      if (imported + skipped >= limit) break;
      if (this.tasks.findBy({ repo, issueNumber: issue.number })) {
        skipped += 1;
        continue;
      }
      const meta = parseTaskMeta(issue.body ?? '');
      if (meta?.taskId && this.tasks.get(String(meta.taskId))) {
        skipped += 1;
        continue;
      }
      const input = {
        repo,
        title: cleanIssueTitle(issue.title, meta),
        description: describeIssue(issue.body ?? ''),
        status: validStatus(meta?.status) ?? 'ready',
        issueNumber: issue.number,
        issueUrl: issue.html_url ?? issue.url ?? '',
      };
      if (typeof meta?.branch === 'string' && meta.branch.trim()) input.branch = meta.branch.trim();
      if (typeof meta?.baseBranch === 'string' && meta.baseBranch.trim()) input.baseBranch = meta.baseBranch.trim();
      if (typeof meta?.worktree === 'string' && meta.worktree.trim()) input.worktreePath = meta.worktree.trim();
      this.tasks.create(input);
      imported += 1;
    }
    return { imported, skipped };
  }

  /** Ensure labels, import existing task issues, then refresh the epic. */
  async bootstrap(repo) {
    await this.ensureLabels(repo);
    const imported = await this.importIssues(repo);
    const epic = await this.syncEpic(repo);
    return { epic, imported };
  }
}
