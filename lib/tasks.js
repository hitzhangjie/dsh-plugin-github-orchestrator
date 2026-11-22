/**
 * Persistent task store. One JSON document holds all tasks; every mutation is
 * written through a temporary sibling file and renamed, so concurrent readers
 * never observe a half-written file.
 *
 * A task is the unit of work the plugin tracks locally and mirrors into a
 * GitHub issue (see storyboard.js). The on-disk shape is:
 *   { version: 1, nextId: <number>, tasks: Task[] }
 */
import { nowIso, readJson, slugify, writeJsonAtomic } from './util.js';

export const TASK_STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done'];
export const TASK_PRIORITIES = ['low', 'normal', 'high'];

const STORE_VERSION = 1;
const DEFAULT_STATUS = 'backlog';
const DEFAULT_PRIORITY = 'normal';
const DEFAULT_BASE_BRANCH = 'main';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function toText(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function toNumberOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toTags(value) {
  if (!Array.isArray(value)) return [];
  return value.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0);
}

function toNotes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((note) => isPlainObject(note))
    .map((note) => ({ at: toText(note.at), text: toText(note.text) }));
}

function normalizeStatus(value, fallback = DEFAULT_STATUS) {
  return TASK_STATUSES.includes(value) ? value : fallback;
}

function normalizePriority(value, fallback = DEFAULT_PRIORITY) {
  return TASK_PRIORITIES.includes(value) ? value : fallback;
}

function cloneTask(task) {
  return {
    ...task,
    tags: [...(task.tags ?? [])],
    notes: (task.notes ?? []).map((note) => ({ ...note })),
  };
}

/** Numeric part of ids like `T12`; 0 when the id carries no number. */
function idNumber(id) {
  const match = /^T(\d+)$/i.exec(String(id ?? ''));
  return match ? Number(match[1]) : 0;
}

function normalizeTask(raw) {
  const task = {
    id: toText(raw.id),
    repo: toText(raw.repo),
    title: toText(raw.title),
    description: toText(raw.description),
    status: normalizeStatus(raw.status),
    priority: normalizePriority(raw.priority),
    branch: toText(raw.branch),
    baseBranch: toText(raw.baseBranch) || DEFAULT_BASE_BRANCH,
    tags: toTags(raw.tags),
    notes: toNotes(raw.notes),
    createdAt: toText(raw.createdAt),
    updatedAt: toText(raw.updatedAt),
  };
  const optionalNumbers = ['issueNumber', 'epicNumber', 'prNumber'];
  for (const key of optionalNumbers) {
    const value = toNumberOrUndefined(raw[key]);
    if (value !== undefined) task[key] = value;
  }
  if (raw.issueUrl !== undefined && raw.issueUrl !== null) task.issueUrl = toText(raw.issueUrl);
  if (raw.worktreePath !== undefined && raw.worktreePath !== null) task.worktreePath = toText(raw.worktreePath);
  if (raw.closedAt !== undefined && raw.closedAt !== null) task.closedAt = toText(raw.closedAt);
  return task;
}

function emptyState() {
  return { version: STORE_VERSION, nextId: 1, tasks: [] };
}

function readState(filePath) {
  const raw = readJson(filePath, null);
  if (!isPlainObject(raw) || !Array.isArray(raw.tasks)) return emptyState();
  const tasks = raw.tasks.filter(isPlainObject).map(normalizeTask);
  let nextId = Number.isInteger(raw.nextId) && raw.nextId > 0 ? raw.nextId : 1;
  for (const task of tasks) {
    const number = idNumber(task.id);
    if (number >= nextId) nextId = number + 1;
  }
  return { version: STORE_VERSION, nextId, tasks };
}

function writeState(filePath, state) {
  writeJsonAtomic(filePath, {
    version: STORE_VERSION,
    nextId: state.nextId,
    tasks: state.tasks,
  });
}

function compareTasks(left, right) {
  const diff = idNumber(left.id) - idNumber(right.id);
  if (diff !== 0) return diff;
  return String(left.id).localeCompare(String(right.id));
}

/**
 * JSON-file backed task store. Methods are synchronous because the file is
 * small and every operation must see the latest persisted state.
 */
export class TaskStore {
  /** @param {string} filePath absolute path of the store JSON file */
  constructor(filePath) {
    if (!hasText(filePath)) throw new Error('TaskStore requires a file path');
    this.filePath = filePath;
  }

  /**
   * @param {{ repo?: string, status?: string, includeClosed?: boolean }} [filter]
   * @returns {object[]} matching tasks, oldest first
   */
  list(filter = {}) {
    const state = readState(this.filePath);
    const repo = filter.repo;
    const status = filter.status;
    const includeClosed = filter.includeClosed === true || status === 'done';
    return state.tasks
      .filter((task) => {
        if (repo !== undefined && task.repo !== repo) return false;
        if (status !== undefined) return task.status === status;
        if (!includeClosed && task.status === 'done') return false;
        return true;
      })
      .sort(compareTasks)
      .map(cloneTask);
  }

  /** @param {string} id @returns {object|undefined} */
  get(id) {
    const wanted = String(id ?? '').trim();
    if (!wanted) return undefined;
    const task = readState(this.filePath).tasks.find(
      (entry) => entry.id === wanted || entry.id.toLowerCase() === wanted.toLowerCase(),
    );
    return task ? cloneTask(task) : undefined;
  }

  /**
   * @param {{ repo?: string, issueNumber?: number, branch?: string, worktreePath?: string }} criteria
   * @returns {object|undefined}
   */
  findBy(criteria = {}) {
    const checks = [];
    if (criteria.repo !== undefined) checks.push((task) => task.repo === criteria.repo);
    if (criteria.issueNumber !== undefined) {
      const wanted = Number(criteria.issueNumber);
      checks.push((task) => task.issueNumber === wanted);
    }
    if (criteria.branch !== undefined) checks.push((task) => task.branch === criteria.branch);
    if (criteria.worktreePath !== undefined) {
      checks.push((task) => task.worktreePath === criteria.worktreePath);
    }
    if (checks.length === 0) return undefined;
    const task = readState(this.filePath).tasks.find((entry) => checks.every((check) => check(entry)));
    return task ? cloneTask(task) : undefined;
  }

  /**
   * Create a task and persist it.
   * @param {{ repo: string, title: string, description?: string, status?: string,
   *   priority?: string, branch?: string, baseBranch?: string, issueNumber?: number,
   *   issueUrl?: string, epicNumber?: number, worktreePath?: string, tags?: string[],
   *   prNumber?: number }} input
   * @returns {object} the new task
   */
  create(input = {}) {
    if (!isPlainObject(input)) throw new Error('create() requires a task object');
    const repo = toText(input.repo).trim();
    const title = toText(input.title).trim();
    if (!repo) throw new Error('Task repo is required');
    if (!title) throw new Error('Task title is required');
    if (input.status !== undefined) {
      if (!TASK_STATUSES.includes(input.status)) {
        throw new Error(`Invalid task status "${input.status}" (expected ${TASK_STATUSES.join(', ')})`);
      }
    }
    if (input.priority !== undefined) {
      if (!TASK_PRIORITIES.includes(input.priority)) {
        throw new Error(`Invalid task priority "${input.priority}" (expected ${TASK_PRIORITIES.join(', ')})`);
      }
    }

    const state = readState(this.filePath);
    const id = `T${state.nextId}`;
    const at = nowIso();
    const task = {
      id,
      repo,
      title,
      description: toText(input.description),
      status: input.status ?? DEFAULT_STATUS,
      priority: input.priority ?? DEFAULT_PRIORITY,
      branch: hasText(input.branch) ? String(input.branch).trim() : `task/${id.toLowerCase()}-${slugify(title)}`,
      baseBranch: hasText(input.baseBranch) ? String(input.baseBranch).trim() : DEFAULT_BASE_BRANCH,
      tags: toTags(input.tags),
      notes: [],
      createdAt: at,
      updatedAt: at,
    };
    const optionalNumbers = ['issueNumber', 'epicNumber', 'prNumber'];
    for (const key of optionalNumbers) {
      const value = toNumberOrUndefined(input[key]);
      if (value !== undefined) task[key] = value;
    }
    if (input.issueUrl !== undefined) task.issueUrl = toText(input.issueUrl);
    if (input.worktreePath !== undefined) task.worktreePath = toText(input.worktreePath);

    state.tasks.push(task);
    state.nextId += 1;
    writeState(this.filePath, state);
    return cloneTask(task);
  }

  /**
   * Patch task fields. `note` (when provided) is appended to the notes timeline.
   * @param {string} id
   * @param {Partial<object> & { note?: string }} patch
   * @returns {object} the updated task
   */
  update(id, patch = {}) {
    if (!isPlainObject(patch)) throw new Error('update() requires a patch object');
    const state = readState(this.filePath);
    const task = state.tasks.find((entry) => entry.id === id || entry.id.toLowerCase() === String(id).toLowerCase());
    if (!task) throw new Error(`Task "${id}" not found`);

    const at = nowIso();
    const fieldKeys = [
      'repo',
      'title',
      'description',
      'status',
      'priority',
      'branch',
      'baseBranch',
      'issueNumber',
      'issueUrl',
      'epicNumber',
      'prNumber',
      'worktreePath',
      'closedAt',
    ];
    const textKeys = new Set(['repo', 'title', 'description', 'branch', 'baseBranch', 'issueUrl', 'worktreePath']);
    const numberKeys = new Set(['issueNumber', 'epicNumber', 'prNumber']);

    for (const key of fieldKeys) {
      const value = patch[key];
      if (value === undefined) continue;
      if (key === 'status') {
        if (!TASK_STATUSES.includes(value)) {
          throw new Error(`Invalid task status "${value}" (expected ${TASK_STATUSES.join(', ')})`);
        }
        task.status = value;
        continue;
      }
      if (key === 'priority') {
        if (!TASK_PRIORITIES.includes(value)) {
          throw new Error(`Invalid task priority "${value}" (expected ${TASK_PRIORITIES.join(', ')})`);
        }
        task.priority = value;
        continue;
      }
      if (key === 'closedAt') {
        task.closedAt = value === null ? null : toText(value);
        continue;
      }
      if (numberKeys.has(key)) {
        const number = toNumberOrUndefined(value);
        if (number === undefined) delete task[key];
        else task[key] = number;
        continue;
      }
      if (textKeys.has(key)) {
        task[key] = toText(value);
        continue;
      }
    }

    if (Array.isArray(patch.tags)) task.tags = toTags(patch.tags);
    if (Array.isArray(patch.notes)) task.notes = toNotes(patch.notes);
    if (patch.note !== undefined && patch.note !== null) {
      const text = toText(patch.note).trim();
      if (text) task.notes.push({ at, text });
    }
    if (task.status === 'done' && !task.closedAt && patch.closedAt === undefined) {
      task.closedAt = at;
    }
    task.updatedAt = at;
    writeState(this.filePath, state);
    return cloneTask(task);
  }

  /**
   * Mark a task done (idempotent; keeps the first `closedAt`).
   * @param {string} id
   * @param {{ note?: string }} [opts]
   * @returns {object} the closed task
   */
  close(id, opts = {}) {
    const task = this.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    const patch = { status: 'done' };
    if (!task.closedAt) patch.closedAt = nowIso();
    if (opts && opts.note) patch.note = opts.note;
    return this.update(id, patch);
  }

  /** @param {string} id @returns {boolean} whether a task was removed */
  remove(id) {
    const state = readState(this.filePath);
    const wanted = String(id ?? '').trim().toLowerCase();
    const before = state.tasks.length;
    state.tasks = state.tasks.filter((task) => task.id.toLowerCase() !== wanted);
    if (state.tasks.length === before) return false;
    writeState(this.filePath, state);
    return true;
  }

  /** @returns {{ total:number, byStatus:Record<string,number>, byRepo:Record<string,number>, openTasks:number }} */
  stats() {
    const state = readState(this.filePath);
    const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
    const byRepo = {};
    let openTasks = 0;
    for (const task of state.tasks) {
      if (byStatus[task.status] === undefined) byStatus[task.status] = 0;
      byStatus[task.status] += 1;
      byRepo[task.repo] = (byRepo[task.repo] ?? 0) + 1;
      if (task.status !== 'done') openTasks += 1;
    }
    return { total: state.tasks.length, byStatus, byRepo, openTasks };
  }

  /** Peek at the id the next created task will receive (`T1`, `T2`, ...). */
  nextTaskId() {
    return `T${readState(this.filePath).nextId}`;
  }
}
