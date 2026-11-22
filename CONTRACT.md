# Module contract — dsh-plugin-github-orchestrator

Host-only Cordis bundle, ESM, **no npm dependencies** (Node builtins only). Node >= 22.5.
All modules live under `lib/`, tests under `test/`, run with `node --test "test/**/*.test.js"`
(Node 24 treats positional arguments as glob patterns; the bare `test/` directory form is not ported).
Code comments and user-facing tool output are English. Chinese only in `locale/zh.json` and README.

## Global rules

- Every exported async function takes an optional `signal` only where noted; otherwise no cancellation.
- Errors: throw `Error` with a clear message. Git commands throw `GitError` (see git.js).
- Never assume the process cwd. All paths passed explicitly. Use `node:path` with Windows paths.
- JSON writes must be atomic (write temp file in same dir, then rename).
- Time is ISO-8601 UTC string via `new Date().toISOString()` unless stated.
- No secrets in logs or tool output: redact `token` fields.

## lib/util.js (Lead — frozen, use it)

```js
export function nowIso(): string
export function ensureDir(dir: string): void
export function readJson(file: string, fallback: unknown): unknown
export function writeJsonAtomic(file: string, value: unknown): void
export function slugify(text: string, max = 48): string      // lowercase, [a-z0-9-], collapse dashes
export function shortHash(text: string, len = 8): string      // sha256 hex prefix
export function truncate(text: string, max: number): string
export function toErrorMessage(error: unknown): string
export function redactToken(text: string): string             // replaces ghp_/gho_/github_pat_* tokens
export function splitLines(text: string): string[]
```

## lib/config.js (Lead — frozen)

```js
export const DEFAULT_CONFIG = { /* see file */ }
export function parseRepoSpec(spec: string|object): { repo, owner, name, local, baseBranch?, issueLabel? }
export function normalizeRepos(input: unknown): RepoSpec[]        // strings or objects, de-duped, validated
export function normalizeConfig(raw: object|undefined, settings: object|undefined, ctx: { env, homeDir }):
  { workspaceRoot, stateDir, dataDir, repos: RepoSpec[], pollIntervalSec, ... }
export function repoDirOf(config, spec): string                   // <workspaceRoot>/<spec.local>
export function worktreePathOf(config, spec, taskId): string       // <workspaceRoot>/.worktrees/<spec.local>__<taskId>
export class SettingsStore {
  constructor(filePath: string)
  read(): object
  patch(partial: object): object   // shallow merge + atomic save; returns new settings
}
```

`settings` override `repos`, `workspaceRoot`, `pollIntervalSec`, `defaultBaseBranch`, `branchPrefix`, `remote`.
`stateDir` = `<DSH_HOME>/github-orchestrator` (`DSH_HOME` env or `~/.dsh`).

## lib/git.js — owner: git-engine

```js
export class GitError extends Error { /* name='GitError', exitCode, stdout, stderr, args, cwd */ }
export async function runGit(args: string[], opts?: { cwd, gitBinary?, env?, maxBuffer?, timeoutMs? }):
  Promise<{ stdout, stderr, exitCode }>                        // never rejects for non-zero exit
export async function gitOk(args: string[], opts?): Promise<string>   // returns trimmed stdout, throws GitError
export async function isGitRepo(dir: string): Promise<boolean>
export async function repoStatus(dir: string, opts?): Promise<{
  isRepo, root, head, branch, detached, dirty, conflicted,
  files: Array<{ status, path }>, ahead?, behind?, remoteUrl?
}>
export async function cloneRepo(opts: { url, dir, gitBinary?, branch?, depth? }): Promise<{ dir }>
export async function fetchAll(repoDir, opts?: { remote?, prune?, gitBinary? }): Promise<{ remote, branches }>
export async function resolveDefaultBranch(repoDir, opts?): Promise<string>   // origin/HEAD -> fallback main/master
export async function revParse(repoDir, ref, opts?): Promise<string>
export async function branchExists(repoDir, branch, opts?): Promise<boolean>
export async function createBranch(repoDir, branch, from, opts?): Promise<void>
export async function deleteBranch(repoDir, branch, opts?: { force?, remote?, gitBinary? }): Promise<{ deleted, remoteDeleted }>
export async function aheadBehind(repoDir, left, right, opts?): Promise<{ ahead, behind }>
export async function rebase(repoDir, onto, opts?): Promise<{ ok, conflicted: string[] }>
export async function rebaseContinue(repoDir, opts?): Promise<{ ok, conflicted: string[] }>
export async function rebaseAbort(repoDir, opts?): Promise<void>
export async function merge(repoDir, branch, opts?: { noFf?, message?, ffOnly? }): Promise<{ ok, conflicted: string[], commit }>
export async function mergeAbort(repoDir, opts?): Promise<void>
export async function push(repoDir, branch, opts?: { remote?, setUpstream?, forceWithLease? }): Promise<{ remote, branch }>
export async function listWorktrees(repoDir, opts?): Promise<Array<{
  path, head, branch(null if detached), bare, detached, locked, prunable
}>>
export async function addWorktree(repoDir, opts: { path, branch, createBranch?, from? }): Promise<void>
export async function removeWorktree(repoDir, path, opts?: { force? }): Promise<void>
export async function pruneWorktrees(repoDir, opts?): Promise<void>
export async function listBranches(repoDir, opts?: { remote? }): Promise<string[]>
export async function currentBranch(dir): Promise<string|null>
export async function logOneline(repoDir, opts?: { limit?, range? }): Promise<string[]>
export function parseConflictedFiles(statusText: string): string[]
```

Behavior notes:
- `runGit` uses `spawn` (shell:false), captures stdout/stderr with maxBuffer default 16 MiB, env `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `LC_ALL=C`.
- `rebase` runs `git fetch <remote>` first? NO — caller fetches. It runs `git rebase <onto>` in `repoDir`; on exit code 1 + conflict returns `{ok:false, conflicted}` (do not throw). Other exit codes throw.
- `merge` on conflict returns `{ok:false, conflicted:[]}` and leaves MERGE_HEAD (caller can abort). Other errors throw.
- worktree paths are canonical absolute paths (fs.realpath where possible).

## lib/worktrees.js — owner: git-engine

```js
export async function createTaskWorktree(opts: {
  repoDir, worktreePath, branch, baseBranch, remote?, createBranch?, from? , gitBinary?
}): Promise<{ worktreePath, branch, baseBranch, baseCommit }>
// createBranch=true: `git worktree add -b branch path <from || remote/baseBranch>`
// else: `git worktree add path branch` (existing branch)
export async function removeTaskWorktree(opts: {
  repoDir, worktreePath, force?, deleteBranch?, branch?, remote?, gitBinary?
}): Promise<{ removed, branchDeleted, remoteDeleted, warnings:string[] }>
// removes worktree, prunes, then deletes local (and remote if remote=true) branch when requested.
export async function listTaskWorktrees(repoDir, opts?): Promise<Array<{ path, branch, head, dirty, taskId, locked, prunable }>>
// taskId parsed from trailing `__T<number>` convention in path basename; dirty computed via status.
export async function rebaseWorktree(opts: { worktreePath, baseBranch, remote?: string, repoDir?, gitBinary? }):
  Promise<{ ok, conflicted:string[], upToDate:boolean, onto:string }>
// fetch in repoDir (or worktreePath parent), then rebase onto <remote>/<baseBranch>; returns conflict info.
export async function mergeTaskBranch(opts: {
  repoDir, branch, baseBranch, remote?, push?, noFf?, message?, gitBinary?
}): Promise<{ merged:boolean, commit, pushed, baseBranch, branch }>
// verify clean repo; checkout baseBranch; fast-forward to <remote>/<baseBranch>; merge --no-ff branch; push if requested.
```

## lib/github.js — owner: github-engine

```js
export class GitHubError extends Error { /* status, code, url, body, rateLimitRemaining, rateLimitReset */ }
export function parseRepo(full: string): { owner, name, repo }
export class GitHubClient {
  constructor(opts: { token?: string, apiBase?, userAgent?, fetchImpl?, timeoutMs?, logger? })
  async request(method: 'GET'|'POST'|'PATCH'|'PUT'|'DELETE', path: string, opts?: {
    query?: Record<string,string|number|boolean|undefined>, body?, accept?, etag?, allowStatus?: number[]
  }): Promise<{ status:number, headers:Record<string,string>, data:any, etag?:string, notModified?:boolean }>
  async get(path, opts?); async post(path, body, opts?); async patch(path, body, opts?); async del(path, opts?)
  async paginate(path, opts?: { query?, maxPages?: number, perPage?: number }): Promise<any[]>
  rateLimit(): { remaining:number|null, resetAt:string|null }
}
export async function resolveGitHubToken(opts: {
  explicit?: string, env?: object, credentials?: object, homeDir?: string
}): Promise<{ token:string|null, source:'config'|'credentials'|'env'|'gh-cli'|'none' }>
// explicit -> credentials.readRecord('github-orchestrator') {token} -> GITHUB_TOKEN/GH_TOKEN -> `gh auth token`
```

`request` adds `Authorization: Bearer`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent`.
Non-2xx throws GitHubError except `allowStatus`/304. 403/429 with `x-ratelimit-remaining: 0` → rate-limit message. Retries 2x on 502/503/504 and network errors with backoff.

## lib/events.js — owner: github-engine

```js
export class EventStore {
  constructor(filePath: string)
  list(filter?: { repo?, kinds?: string[], unreadOnly?: boolean, since?, limit?: number }): Event[]
  unreadCount(filter?: { repo? }): number
  add(events: Event[]): { added:number, duplicates:number }   // dedupe by id, cap maxEvents (drop oldest)
  markRead(ids?: string[], opts?: { all?: boolean, repo?: string }): number
  prune(opts?: { max?: number }): void
  stats(): { total, unread, byRepo, byKind, lastEventAt }
}
export function createEvent(partial): Event
// Event = { id, repo, kind:'issue'|'pr'|'review'|'push'|'comment',
//   action, number?, title?, url?, actor?, at, summary, branch?, sha?, taskId?, read:boolean, baseline?:boolean }

export class EventPoller {
  constructor(opts: {
    client: GitHubClient, store: EventStore, config, logger?, now?: () => number, pollIntervalSec?: number
  })
  updateConfig(config): void
  start(): void          // idempotent; setInterval (unref) using pollIntervalSec
  stop(): void
  async pollOnce(opts?: { repo?: string, baseline?: boolean }): Promise<{ repos:number, added:number, errors:Array<{repo,error}> }>
  async pollRepo(spec): Promise<{ added:number, events:Event[] }>
  watermarks(): object
}
```

Polling design (must implement):
- Persist watermarks to `<stateDir>/events-watermarks.json` via atomic writes after each poll (constructor takes `watermarksPath`).
- Per repo state: `{ primed:boolean, lastPollAt, issues:{ [number]: updated_at }, pulls:{...}, branches:{ [name]: sha }, reviews:{ [prNumber]: { [reviewId]: submitted_at } } }`.
- Streams: issues list (`/repos/{repo}/issues?state=all&sort=updated&direction=desc&per_page=50`, skip items with `pull_request`), pulls list, reviews for changed open PRs (max 10 PRs), branch tips (`/branches?per_page=100`, max 2 pages) for push detection.
- New events only when watermarks change. First poll primes state and (when `baseline !== false`) emits at most 25 baseline events per repo for open issues/PRs updated within `baselineDays`, `baseline:true`.
- Push events: when a branch SHA changes, emit `{kind:'push', action:'pushed', branch, sha, summary}`; skip branches whose SHA was never seen (baseline).
- Every event id is deterministic (`repo + kind + number + key`); re-poll cannot duplicate.
- Filter out the plugin's own bot comments/edits? Not required.
- On GitHub API failure for one repo: record error, continue with other repos; do not stop the timer.

## lib/tasks.js — owner: storyboard-engine

```js
export class TaskStore {
  constructor(filePath: string)
  list(filter?: { repo?, status?, includeClosed? }): Task[]
  get(id: string): Task|undefined
  findBy(criteria: { repo?, issueNumber?, branch?, worktreePath? }): Task|undefined
  create(input: {
    repo, title, description?, status?, priority?, branch?, baseBranch?, issueNumber?, issueUrl?,
    epicNumber?, worktreePath?, tags?, prNumber?
  }): Task
  update(id, patch: Partial<Task> & { note?: string }): Task
  close(id, opts?: { note?: string }): Task
  remove(id): boolean
  stats(): { total, byStatus, byRepo, openTasks }
  nextTaskId(): string        // T1, T2, ...
}
// Task = { id:'T1', repo, title, description, status:'backlog'|'ready'|'in_progress'|'review'|'done',
//   priority:'low'|'normal'|'high', branch, baseBranch, worktreePath?, issueNumber?, issueUrl?,
//   epicNumber?, prNumber?, tags:string[], notes:[{ at, text }], createdAt, updatedAt, closedAt? }
```

Status transitions are free-form but preserve `closedAt` when moving to `done`. Notes append with timestamp.

## lib/storyboard.js — owner: storyboard-engine

```js
export const TASK_META_START = '<!-- github-orchestrator:task';
export function renderTaskIssue(task: Task, opts?: { repo?: string }): { title, body, labels: string[] }
export function renderEpicIssue(opts: { repo: string, tasks: Task[], generatedAt?: string }):
  { title, body, labels: string[] }
export function parseTaskMeta(body: string): object | null
export class Storyboard {
  constructor(opts: { client: GitHubClient, tasks: TaskStore, config, logger? })
  updateConfig(config): void
  async ensureLabels(repo: string): Promise<void>       // create missing `gos:task`, `gos:epic`, `gos:status/*`
  async createTaskIssue(repo: string, task: Task): Promise<{ number, url }>
  async updateTaskIssue(task: Task): Promise<{ number, url } | null>   // no-op when task has no issue
  async commentTask(task: Task, text: string): Promise<void>
  async closeTaskIssue(task: Task, comment?: string): Promise<void>
  async syncEpic(repo: string): Promise<{ number, url }>
  async syncTask(task: Task): Promise<{ issue?, epic? }>
  async importIssues(repo: string, opts?: { label?: string, limit?: number }): Promise<{ imported:number, skipped:number }>
  async bootstrap(repo: string): Promise<{ epic, imported }>
}
```

Issue formats (GitHub-flavored Markdown):
- Task issue title: `[T{n}] {title}`; labels: `gos:task`, `gos:status/<status>`, optional `repo` label omitted.
- Body begins with hidden meta block:
  ```
  <!-- github-orchestrator:task
  {"taskId":"T1","repo":"owner/name","branch":"task/T1-x","status":"ready","baseBranch":"main","worktree":"..."}
  -->
  ```
  then `## Summary`, `## Plan` (checklist derived from notes? Keep simple: description + notes timeline), `## Notes` with `- [ ]`/`- [x]` for done? Keep: notes as `- {at} {text}`.
- Epic issue title: `[Storyboard] {repo}`; labels `gos:epic`; label `gos:storyboard` optional. Body contains `<!-- github-orchestrator:epic -->`, generated timestamp, counts table, tasks table (`| Task | Status | Branch | Issue |`) and a "Next up" list.
- `syncEpic` creates the epic if missing (search open issues with label `gos:epic` and title), otherwise PATCH body.
- `importIssues` lists open issues with label (default `gos:task`), creates local tasks for ones whose meta taskId is not in the store (or no meta → use issue number as taskId? create `T{n}` but store `externalIssue`? Keep: create local task titled from issue, branch `task/T{n}-slug`, issueNumber set).
- All API paths use `/repos/{repo}/...`. Handle 404 gracefully where documented.

## lib/tools.js + index.js (Lead)

Owned by Lead; imports the modules above. Teammates must not edit.

## Project fixture dependency

`test/helpers/mock-github.js` — owner: github-engine. A minimal in-process HTTP server implementing:
`GET /repos/:repo/issues`, `/pulls`, `/pulls/:n/reviews`, `/branches`, `/issues/:n`, `POST/PATCH /repos/:repo/issues`, `POST /repos/:repo/issues/:n/comments`, `POST /repos/:repo/labels`, `GET /repos/:repo/labels`; returns JSON with proper status codes and records requests. Used by storyboard + integration tests. Export `startMockGitHub(options?)` returning `{ url, close, requests, setHandler? }`.

## Test expectations

- `node --test "test/**/*.test.js"` must pass offline (no real network).
- Git tests create temp repos under `os.tmpdir()` and clean up.
- Do not touch real GitHub in tests.
