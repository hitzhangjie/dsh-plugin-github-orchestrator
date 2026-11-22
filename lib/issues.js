/**
 * Issue and pull-request listing for the GitHub orchestrator plugin.
 *
 * Every function receives an existing `GitHubClient` from `lib/github.js`
 * (never calls `fetch` itself) and returns plain, JSON-safe objects. List
 * results are intentionally compact: they never carry the issue/PR `body`
 * (use `getIssue` / `getPullRequest` for that) and malformed or partial GitHub
 * payloads (deleted users, missing labels/assignees, `merged_at` only, no
 * `draft` field, ...) are normalized instead of crashing the panel.
 *
 * GitHub 404 responses are surfaced as `IssuesApiError` (a `GitHubError`
 * subclass) with a human-readable message; every other HTTP/network failure is
 * rethrown untouched so callers can inspect `status`/`code`/rate-limit fields.
 */
import { GitHubError, parseRepo } from './github.js';
import { truncate } from './util.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_BODY_LENGTH = 100 * 1024;
const REVIEWS_PAGE_SIZE = 100;

const ISSUE_STATES = new Set(['open', 'closed', 'all']);
const ISSUE_SORTS = new Set(['updated', 'created', 'comments']);
const PULL_SORTS = new Set(['updated', 'created', 'popularity']);
const WORK_ITEM_KINDS = new Set(['issue', 'pr', 'all']);

/** Error with a clear, actionable message; thrown for GitHub 404 responses. */
export class IssuesApiError extends GitHubError {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, url?: string|null, body?: any, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'IssuesApiError';
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

function requireClient(client, method) {
  if (!client || typeof client[method] !== 'function') {
    throw new Error(`A GitHubClient with ${method}() is required`);
  }
  return client;
}

function repoFullName(repo) {
  return parseRepo(repo).repo;
}

function repoApiPath(repo, suffix = '') {
  return `/repos/${repo}${suffix}`;
}

function listOf(data) {
  return Array.isArray(data) ? data.filter((item) => item && typeof item === 'object') : [];
}

function clampLimit(value) {
  const numeric = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(numeric)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(numeric)));
}

function normalizeStateFilter(value) {
  const state = String(value ?? 'open').trim().toLowerCase();
  if (!ISSUE_STATES.has(state)) {
    throw new Error(`Invalid state "${value}": expected "open", "closed" or "all"`);
  }
  return state;
}

function normalizeSort(value, allowed, fallback = 'updated') {
  const sort = String(value ?? fallback).trim().toLowerCase();
  if (!allowed.has(sort)) {
    throw new Error(`Invalid sort "${value}": expected ${[...allowed].join(', ')}`);
  }
  return sort;
}

function normalizeKind(value) {
  const kind = String(value ?? 'all').trim().toLowerCase();
  if (!WORK_ITEM_KINDS.has(kind)) {
    throw new Error(`Invalid kind "${value}": expected "issue", "pr" or "all"`);
  }
  return kind;
}

function requirePositiveInteger(value, label = 'number') {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`Invalid ${label} "${value}": expected a positive integer`);
  }
  return numeric;
}

function itemNumber(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function toCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : 0;
}

function isoOrNull(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text || null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

/** Accepts a login string or a GitHub user object; returns a login or null. */
function normalizeLogin(user) {
  if (typeof user === 'string') return user.trim() || null;
  if (user && typeof user === 'object' && typeof user.login === 'string') return user.login.trim() || null;
  return null;
}

/** Accepts a login/label string or an object with `name`/`login`. */
function normalizeName(entry) {
  if (typeof entry === 'string') return entry.trim() || null;
  if (entry && typeof entry === 'object') {
    if (typeof entry.name === 'string') return entry.name.trim() || null;
    return normalizeLogin(entry);
  }
  return null;
}

/**
 * Normalize an array of label/user objects (or strings, or a comma separated
 * string) to unique, non-empty names.
 */
function normalizeNameList(input) {
  if (typeof input === 'string') {
    return normalizeNameList(input.split(','));
  }
  if (!Array.isArray(input)) return [];
  const names = [];
  const seen = new Set();
  for (const entry of input) {
    const name = normalizeName(entry);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function labelNames(value) {
  if (value === undefined || value === null) return [];
  return normalizeNameList(Array.isArray(value) ? value : String(value));
}

function labelsQueryValue(value) {
  const names = labelNames(value);
  return names.length > 0 ? names.join(',') : undefined;
}

function normalizeAssignees(item) {
  const names = normalizeNameList(item?.assignees);
  if (names.length > 0) return names;
  const single = normalizeLogin(item?.assignee);
  return single ? [single] : [];
}

function branchRef(branch) {
  if (typeof branch === 'string') return branch.trim() || null;
  if (branch && typeof branch === 'object' && typeof branch.ref === 'string') return branch.ref.trim() || null;
  return null;
}

function normalizeBody(value) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return truncate(text, MAX_BODY_LENGTH);
}

/**
 * Normalize one raw GitHub issue object. Returns null for entries without a
 * usable number so one malformed row cannot break a whole list.
 */
function toIssueItem(raw) {
  const number = itemNumber(raw?.number);
  if (number === null) return null;
  const createdAt = isoOrNull(raw.created_at);
  return {
    kind: 'issue',
    number,
    title: String(raw.title ?? ''),
    state: raw.state === 'closed' ? 'closed' : 'open',
    url: typeof raw.html_url === 'string' ? raw.html_url : null,
    author: normalizeLogin(raw.user),
    labels: normalizeNameList(raw.labels),
    assignees: normalizeAssignees(raw),
    comments: toCount(raw.comments),
    createdAt,
    updatedAt: isoOrNull(raw.updated_at) ?? createdAt,
    isPull: false,
  };
}

/** Normalize one raw GitHub pull-request object (merged PRs map to state merged). */
function toPullItem(raw) {
  const number = itemNumber(raw?.number);
  if (number === null) return null;
  const createdAt = isoOrNull(raw.created_at);
  const mergedAt = isoOrNull(raw.merged_at);
  const merged = mergedAt !== null || raw.merged === true;
  return {
    kind: 'pr',
    number,
    title: String(raw.title ?? ''),
    state: merged ? 'merged' : raw.state === 'closed' ? 'closed' : 'open',
    url: typeof raw.html_url === 'string' ? raw.html_url : null,
    author: normalizeLogin(raw.user),
    labels: normalizeNameList(raw.labels),
    assignees: normalizeAssignees(raw),
    comments: toCount(raw.comments),
    createdAt,
    updatedAt: isoOrNull(raw.updated_at) ?? createdAt,
    draft: raw.draft === true,
    merged,
    mergedAt,
    headRef: branchRef(raw.head),
    baseRef: branchRef(raw.base),
    requestedReviewers: normalizeNameList(raw.requested_reviewers),
    isPull: true,
  };
}

/** Normalize one raw GitHub review object; reviews without an id are skipped. */
function toReviewItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let id = null;
  if (typeof raw.id === 'number' && Number.isFinite(raw.id)) id = raw.id;
  else if (raw.id !== undefined && raw.id !== null) id = String(raw.id);
  if (id === null) return null;
  const state = String(raw.state ?? 'PENDING').trim().toUpperCase() || 'PENDING';
  const item = {
    id,
    author: normalizeLogin(raw.user),
    state,
    submittedAt: isoOrNull(raw.submitted_at) ?? null,
  };
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (body) item.body = truncate(body, MAX_BODY_LENGTH);
  return item;
}

/**
 * Run an API call, converting only 404 into an `IssuesApiError` with `message`.
 * Every other error (401/403/rate limits/network) propagates unchanged.
 */
async function guardNotFound(message, run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      throw new IssuesApiError(message, {
        status: 404,
        code: 'not_found',
        url: error.url,
        body: error.body,
        cause: error,
      });
    }
    throw error;
  }
}

function unexpectedPayload(message, response) {
  return new IssuesApiError(message, { status: response?.status ?? 0, code: 'invalid_response' });
}

function compareByUpdatedAtDesc(left, right) {
  const leftTime = Date.parse(left.updatedAt ?? '') || 0;
  const rightTime = Date.parse(right.updatedAt ?? '') || 0;
  if (rightTime !== leftTime) return rightTime - leftTime;
  return (right.number ?? 0) - (left.number ?? 0);
}

/**
 * List issues (never pull requests; the GitHub issues endpoint returns PRs too).
 *
 * @param {{ client: any, repo: string, state?: 'open'|'closed'|'all', labels?: string|string[],
 *   limit?: number, sort?: 'updated'|'created'|'comments' }} opts
 * @returns {Promise<Array<object>>} normalized IssueItem list without bodies
 */
export async function listIssues(opts = {}) {
  const client = requireClient(opts.client, 'get');
  const repo = repoFullName(opts.repo);
  const state = normalizeStateFilter(opts.state);
  const sort = normalizeSort(opts.sort, ISSUE_SORTS);
  const limit = clampLimit(opts.limit);
  const query = { state, sort, direction: 'desc', per_page: limit };
  const labels = labelsQueryValue(opts.labels);
  if (labels) query.labels = labels;

  const response = await guardNotFound(`Repository "${repo}" was not found or is not accessible`, () =>
    client.get(repoApiPath(repo, '/issues'), { query }),
  );
  return listOf(response?.data)
    .filter((item) => !item.pull_request)
    .map(toIssueItem)
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * List pull requests; merged PRs are returned with `state:'merged'` even though
 * GitHub reports them as closed.
 *
 * @param {{ client: any, repo: string, state?: 'open'|'closed'|'all',
 *   limit?: number, sort?: 'updated'|'created'|'popularity' }} opts
 * @returns {Promise<Array<object>>} normalized PullItem list without bodies
 */
export async function listPullRequests(opts = {}) {
  const client = requireClient(opts.client, 'get');
  const repo = repoFullName(opts.repo);
  const state = normalizeStateFilter(opts.state);
  const sort = normalizeSort(opts.sort, PULL_SORTS);
  const limit = clampLimit(opts.limit);
  const query = { state, sort, direction: 'desc', per_page: limit };

  const response = await guardNotFound(`Repository "${repo}" was not found or is not accessible`, () =>
    client.get(repoApiPath(repo, '/pulls'), { query }),
  );
  return listOf(response?.data)
    .map(toPullItem)
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * List issues and/or pull requests merged into one list, newest update first.
 * Each item keeps its own `kind`; the overall result is capped at `limit`.
 *
 * @param {{ client: any, repo: string, kind?: 'issue'|'pr'|'all',
 *   state?: 'open'|'closed'|'all', limit?: number }} opts
 * @returns {Promise<Array<object>>}
 */
export async function listWorkItems(opts = {}) {
  const client = requireClient(opts.client, 'get');
  const repo = opts.repo;
  const kind = normalizeKind(opts.kind);
  const limit = clampLimit(opts.limit);

  const requests = [];
  if (kind === 'issue' || kind === 'all') {
    requests.push(listIssues({ ...opts, client, repo, limit }));
  }
  if (kind === 'pr' || kind === 'all') {
    requests.push(listPullRequests({ ...opts, client, repo, limit }));
  }
  const groups = await Promise.all(requests);
  const items = groups.flat();
  items.sort(compareByUpdatedAtDesc);
  return items.slice(0, limit);
}

/**
 * Fetch one issue with its body (truncated to 100 KB).
 *
 * @param {{ client: any, repo: string, number: number }} opts
 * @returns {Promise<object>} IssueItem plus `body`
 */
export async function getIssue(opts = {}) {
  const client = requireClient(opts.client, 'get');
  const repo = repoFullName(opts.repo);
  const number = requirePositiveInteger(opts.number);

  const response = await guardNotFound(`Issue #${number} not found in ${repo}`, () =>
    client.get(repoApiPath(repo, `/issues/${number}`)),
  );
  const item = toIssueItem(response?.data);
  if (!item) throw unexpectedPayload(`Issue #${number} in ${repo} returned an unexpected payload`, response);
  return { ...item, body: normalizeBody(response.data.body) };
}

/**
 * Fetch one pull request with its body and merge/change metadata.
 *
 * @param {{ client: any, repo: string, number: number }} opts
 * @returns {Promise<object>} PullItem plus body, mergeable, merged, additions,
 *   deletions, changedFiles and reviewComments
 */
export async function getPullRequest(opts = {}) {
  const client = requireClient(opts.client, 'get');
  const repo = repoFullName(opts.repo);
  const number = requirePositiveInteger(opts.number);

  const response = await guardNotFound(`Pull request #${number} not found in ${repo}`, () =>
    client.get(repoApiPath(repo, `/pulls/${number}`)),
  );
  const raw = response?.data;
  const item = toPullItem(raw);
  if (!item) throw unexpectedPayload(`Pull request #${number} in ${repo} returned an unexpected payload`, response);
  return {
    ...item,
    body: normalizeBody(raw.body),
    mergeable: typeof raw.mergeable === 'boolean' ? raw.mergeable : null,
    merged: item.merged,
    additions: toCount(raw.additions),
    deletions: toCount(raw.deletions),
    changedFiles: toCount(raw.changed_files),
    reviewComments: toCount(raw.review_comments),
  };
}

/**
 * List reviews for one pull request, oldest API order preserved.
 *
 * @param {{ client: any, repo: string, number: number }} opts
 * @returns {Promise<Array<object>>} normalized ReviewItem list
 */
export async function listReviews(opts = {}) {
  const client = requireClient(opts.client, 'get');
  const repo = repoFullName(opts.repo);
  const number = requirePositiveInteger(opts.number);

  const response = await guardNotFound(`Pull request #${number} not found in ${repo}`, () =>
    client.get(repoApiPath(repo, `/pulls/${number}/reviews`), { query: { per_page: REVIEWS_PAGE_SIZE } }),
  );
  return listOf(response?.data).map(toReviewItem).filter(Boolean);
}

/**
 * Create an issue; write operations may throw on 401/403.
 *
 * @param {{ client: any, repo: string, title: string, body?: string,
 *   labels?: string|string[] }} opts
 * @returns {Promise<object>} normalized IssueItem (no body)
 */
export async function createIssue(opts = {}) {
  const client = requireClient(opts.client, 'post');
  const repo = repoFullName(opts.repo);
  const title = String(opts.title ?? '').trim();
  if (!title) throw new Error('createIssue requires a non-empty title');

  const payload = { title };
  if (opts.body !== undefined && opts.body !== null) payload.body = String(opts.body);
  const labels = labelNames(opts.labels);
  if (labels.length > 0) payload.labels = labels;

  const response = await guardNotFound(`Repository "${repo}" was not found or is not accessible`, () =>
    client.post(repoApiPath(repo, '/issues'), payload),
  );
  const item = toIssueItem(response?.data);
  if (!item) throw unexpectedPayload(`Creating an issue in ${repo} returned an unexpected payload`, response);
  return item;
}

/**
 * Add a comment to an issue (GitHub's comments endpoint also accepts PR
 * numbers). Write operations may throw on 401/403.
 *
 * @param {{ client: any, repo: string, number: number, body: string }} opts
 * @returns {Promise<{ id: number|string|null, url: string|null }>}
 */
export async function commentOnIssue(opts = {}) {
  const client = requireClient(opts.client, 'post');
  const repo = repoFullName(opts.repo);
  const number = requirePositiveInteger(opts.number);
  const text = String(opts.body ?? '');
  if (!text.trim()) throw new Error('commentOnIssue requires a non-empty body');

  const response = await guardNotFound(`Issue #${number} not found in ${repo}`, () =>
    client.post(repoApiPath(repo, `/issues/${number}/comments`), { body: text }),
  );
  const data = response?.data;
  if (!data || typeof data !== 'object') {
    throw unexpectedPayload(`Commenting on issue #${number} in ${repo} returned an unexpected payload`, response);
  }
  return { id: data.id ?? null, url: typeof data.html_url === 'string' ? data.html_url : null };
}
