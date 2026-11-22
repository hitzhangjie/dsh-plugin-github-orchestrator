# V3 spec — issue/PR lists + always-on event dispatch

This extends CONTRACT.md / SPEC-V2.md. Owner rules still apply; do not edit
files outside your task's write scope. The Lead wires index.js, tools.js,
config.js, README and the final integration.

## A. Issue and pull-request listing (`issues-engine`)

New `lib/issues.js` (ESM, Node builtins only, receives a `GitHubClient` from
`lib/github.js`; no direct fetch). Normalized shapes must be JSON-safe.

```js
export class IssuesApiError extends Error { /* optional; or use GitHubError */ }

export async function listIssues(opts: {
  client, repo, state?: 'open'|'closed'|'all' (default 'open'),
  labels?: string|string[], limit?: number (default 30, max 100), sort?: 'updated'|'created'|'comments'
}): Promise<IssueItem[]>
// GET /repos/{repo}/issues?state&sort&direction=desc&per_page&labels
// Exclude entries with `pull_request` set.

export async function listPullRequests(opts: {
  client, repo, state?: 'open'|'closed'|'all' (default 'open'),
  limit?: number, sort?: 'updated'|'created'|'popularity'
}): Promise<PullItem[]>
// GET /repos/{repo}/pulls?state&sort&direction=desc&per_page

export async function listWorkItems(opts: {
  client, repo, kind?: 'issue'|'pr'|'all' (default 'all'),
  state?: ..., limit?: number
}): Promise<Array<IssueItem|PullItem>>  // each item keeps its `kind`; sorted by updatedAt desc

export async function getIssue(opts: { client, repo, number }): Promise<IssueItem & {body, commentsDetail?}>
export async function getPullRequest(opts: { client, repo, number }): Promise<PullItem & {
  body, mergeable, merged, additions, deletions, changedFiles, reviewComments
}>
export async function listReviews(opts: { client, repo, number }): Promise<ReviewItem[]>
export async function createIssue(opts: { client, repo, title, body?, labels? }): Promise<IssueItem>
export async function commentOnIssue(opts: { client, repo, number, body }): Promise<{ id, url }>
```

Normalized `IssueItem`:
`{ kind:'issue', number, title, state:'open'|'closed', url, author, labels:string[],
   assignees:string[], comments:number, createdAt, updatedAt, body?:string, isPull:false }`
Normalized `PullItem`:
`{ kind:'pr', number, title, state:'open'|'closed'|'merged', url, author,
   labels:string[], assignees:string[], comments:number, createdAt, updatedAt,
   draft:boolean, merged:boolean, mergedAt, headRef, baseRef, body?:string,
   requestedReviewers:string[], isPull:true }`
`ReviewItem`: `{ id, author, state:'APPROVED'|'CHANGES_REQUESTED'|'COMMENTED'|'PENDING'|string, submittedAt, body? }`

Rules:
- `state:'merged'` only for merged PRs; GitHub returns merged PRs under
  `state=closed`, so map `merged_at`/`merged` to `'merged'`.
- `limit` clamped 1..100; `labels` joined by comma for the query.
- List items omit `body` (only `get*` includes it). Truncate bodies to 100 KB.
- Handle `GitHubError` transparently (let it throw). 404 → clear error message.
- `createIssue`/`commentOnIssue` are write operations; they may throw on 401/403.

Tests `test/issues.test.js` (offline, own file): use
`test/helpers/mock-github.js` (startMockGitHub / seedIssue / seedPull / recent
helpers). Cover: issue list excludes PRs, state/label/limit filters, PR list
normalization incl. merged mapping and draft, work-items merge sort, get issue /
get PR bodies, reviews, createIssue/comment POST bodies, 404/401 errors.
`node --test test/issues.test.js` must pass. Write scope: `lib/issues.js`,
`test/issues.test.js` only.

## B. Always-on event dispatcher (`dispatch-engine`)

New `lib/dispatch.js` (ESM, builtins only). It turns newly observed GitHub
events into **new agent work** without the human asking: it creates a local
storyboard task and delivers a prompt to one persistent "watcher" DSH session
(creating/resuming it as needed).

```js
export function createUserMessage(text: string, id?: string):
  { id, role:'user', source:{kind:'user'}, content:[{ type:'text', text }] }
// id defaults to a fresh randomUUID() string.

export function buildDispatchPrompt(opts: {
  repo, events: Event[], taskIds: string[], workspaceRoot, config
}): string

export class AutoDispatcher {
  constructor(opts: {
    config, tasks,               // resolved config + TaskStore (lib/tasks.js)
    agents,                      // { get(id), create({sessionId, meta}), resume({resumeSessionId}) }
    statePath,                   // <stateDir>/dispatch.json
    logger?, now?: () => number
  })
  updateConfig(config): void
  status(): {
    enabled: boolean, sessionId: string|null, lastDispatchAt: string|null,
    count: number, lastError: string|null, lastEventAt: string|null,
    seen: number, skipped: number
  }
  async handleEvents(events: Event[]): Promise<{
    dispatched: boolean, reason?: string, sessionId?: string,
    taskIds?: string[], eventIds?: string[]
  }>
  async sendToWatcher(text: string): Promise<{ sessionId: string, sent: true }>
  async tick(): Promise<...>   // convenience: no-op here; the Lead calls handleEvents
}
```

Behaviour:
- Config fields (resolved by config.js; treat missing as defaults):
  `autoDispatch` (boolean, default false), `autoDispatchKinds`
  (default `['issue','pr','review']`), `autoDispatchMinIntervalSec` (default
  120), `autoDispatchMaxEvents` (default 5), `autoDispatchSessionId`
  (settings-persisted watcher session id), `autoDispatchCreateTasks`
  (default true), `autoDispatchTaskStatus` (default `'ready'`), `workspaceRoot`.
- `handleEvents`: ignore `event.baseline === true`, `event.read === true`,
  events whose kind is not configured, repos not watched (config.repos), and
  ids already in the persisted `seen` set (cap 1000, keep newest). If no
  candidates → `{dispatched:false, reason:'no-events'}`.
- Rate limit: when `now - lastDispatchAt < minIntervalSec*1000` →
  `{dispatched:false, reason:'throttled'}` and do **not** mark seen (retry later).
- Pick up to `maxEvents`, prioritize: `review` > `pr` > `issue` > `push`, then
  newest first.
- When `autoDispatchCreateTasks`: create one task per event via `tasks.create`:
  title `[GitHub] {repo}#{number} {title}` (push: `[GitHub] {repo} push {branch}`),
  description from `event.summary`, `status` from config, `prNumber` for PRs,
  `issueNumber` for issues, `tags:['auto-dispatch', event.kind]`.
- Ensure watcher session: `sessionId = config.autoDispatchSessionId || 'session-' + randomUUID()`.
  - `agents.get(sessionId)` → live agent; else try `agents.resume({resumeSessionId: sessionId})`;
    if resume fails, `agents.create({sessionId, meta:{cwd: workspaceRoot}})`.
  - Persist `autoDispatchSessionId` back into the dispatcher state file (NOT the
    plugin settings; the Lead reads it for the panel/status) and expose it in
    `status()`.
- Build prompt via `buildDispatchPrompt`, then `agent.followup(createUserMessage(prompt))`.
  After a successful followup: mark event ids seen, set lastDispatchAt/count/
  sessionId, append task note `Auto-dispatched to session {sessionId}`, persist
  state atomically (`writeJsonAtomic`). On failure: set lastError, leave events
  unseen so the next tick retries.
- Persisted state JSON: `{version:1, seen:[...], lastDispatchAt, lastEventAt,
  sessionId, count, lastError}`; load defensively, write atomically after change.
- `sendToWatcher(text)`: ensure session (same logic), send a user message with
  that text, update `lastEventAt`? (no; keep), return session id. Used by the
  panel/chat trigger.
- Import `randomUUID` from `node:crypto`, `readJson/writeJsonAtomic/nowIso` from
  `./util.js`; do not import dsh packages.

Tests `test/dispatch.test.js` (offline, own file): temp TaskStore + fake agents
(records followups) + temp state path. Cover: disabled; baseline/read/kind/repo
filters; dedupe + seen cap; throttle; task creation fields; prompt content
(repo/number/task id/instructions); resume path vs create path vs live get;
followup failure leaves events unseen and records lastError; state persists
across dispatcher instances; `sendToWatcher` reuses the session;
`createUserMessage` shape. `node --test test/dispatch.test.js` must pass.
Write scope: `lib/dispatch.js`, `test/dispatch.test.js` only.

## C. Runtime API the Lead will provide (for reference)

- `runtime.issues` helpers not needed; the Lead's `github_issues` tool imports
  `lib/issues.js` directly.
- `runtime.dispatchStatus()`, `runtime.dispatchTick()`,
  `runtime.dispatchSend(text)` delegate to AutoDispatcher.
- `runtime.snapshot()` gains `dispatch: dispatcher.status()`.
- Config adds `autoDispatch*` fields; `github_config action=set` accepts them.
- `agents` service is injected in index.js (`inject = ['tools','agents']`).

## D. Panel additions (`ui-engine` resume)

- New tab **Issues/PRs** (`issues`) between Inbox and Tasks: filters kind
  (all/issue/pr), state (open/closed/all), repository, limit; rows show
  `#number`, title, kind/state chips, author, labels, updated; link to GitHub;
  a "Create task" button posts
  `/action {tool:'github_tasks', args:{action:'create', repo, title, description}}`.
  Data via `/action {tool:'github_issues', args:{action:'list', repo, kind, state, limit}}`.
- New tab **Automation** (`automation`) as the last tab: shows
  snapshot.dispatch (enabled, watcher session id, last dispatch/error/count);
  toggle "Always-on auto dispatch" posting
  `github_config action=set {autoDispatch:boolean, autoDispatchKinds?, autoDispatchMinIntervalSec?}`;
  kind checkboxes; "Run check now" posting `github_dispatch action=tick`;
  "Open watcher session" using `props.services.uiWorkspace.openSession(sessionId)`;
  a small "send to watcher" textarea posting
  `/action {tool:'github_dispatch', args:{action:'send', text}}`.
- zh/en copy, theme tokens, 15 s refresh keeps status current.
- Extend `test/web.test.js` with fake action results for issues list and
  automation toggle/status; keep all existing tests green.
