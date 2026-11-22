# V2 extension spec — OAuth device flow + Web UI panel

This file extends CONTRACT.md (still authoritative for existing modules). Two
independent workstreams share this spec; do not edit files outside your task's
write scope. The Lead wires `index.js`, `lib/tools.js`, `lib/config.js`,
`package.json`, locales and README.

## A. OAuth engine (`oauth-engine`)

New file `lib/oauth.js` (ESM, Node builtins only, injectable `fetchImpl`):

```js
export const DEFAULT_OAUTH_SCOPES = 'repo read:user';
// Public client id of the GitHub CLI OAuth app. It is a *fallback* so local
// installs work without registering a new OAuth App. Users can set
// config.oauthClientId or GITHUB_OAUTH_CLIENT_ID to use their own app.
export const DEFAULT_OAUTH_CLIENT_ID = '178c6fc778ccc68e1d6a';

export class DeviceFlowError extends Error {
  // name = 'DeviceFlowError'; code one of:
  // 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied'
  // | 'incorrect_device_code' | 'unsupported_grant_type' | 'invalid_client'
  // | 'network_error' | 'timeout' | 'aborted'
  code; description; status;
}

export function resolveOAuthClientId({ config, env } = {}):
  { clientId: string, source: 'config'|'env'|'builtin' }

export async function startDeviceFlow(opts: {
  clientId: string,
  scopes?: string,                 // default DEFAULT_OAUTH_SCOPES
  fetchImpl?: Function,
  baseUrl?: string,                // default 'https://github.com'
  timeoutMs?: number,
}): Promise<{
  deviceCode: string, userCode: string, verificationUri: string,
  expiresIn: number, interval: number, clientId: string, scopes: string
}>
// POST <baseUrl>/login/device/code, Accept: application/json,
// Content-Type: application/json, body {client_id, scope}.

export async function pollDeviceFlow(opts: {
  clientId: string,
  deviceCode: string,
  intervalSec?: number,            // default 5
  expiresInSec?: number,           // default 900
  fetchImpl?: Function,
  baseUrl?: string,
  sleep?: (ms:number)=>Promise<void>,   // injectable for tests
  now?: ()=>number,
  signal?: AbortSignal,
  maxWaitMs?: number,              // hard cap for one call, default no cap
}): Promise<{ accessToken: string, tokenType: string, scope: string }>
// POST <baseUrl>/login/oauth/access_token with body
// {client_id, device_code, grant_type:'urn:ietf:params:oauth:grant-type:device_code'}
// - authorization_pending -> keep polling after `interval`
// - slow_down -> interval += 5 seconds, keep polling
// - expired_token / access_denied / incorrect_device_code / invalid_client -> throw DeviceFlowError
// - aborted signal -> throw DeviceFlowError code 'aborted'
// - maxWaitMs exceeded -> throw DeviceFlowError code 'timeout'
// Also throw code 'timeout' when now() > startedAt + expiresInSec*1000.

export async function fetchGitHubUser(opts: {
  token: string, fetchImpl?: Function, apiBase?: string, timeoutMs?: number,
}): Promise<{ login: string, id: number|null, name: string|null, scopes: string[] }>
// GET <apiBase>/user with Bearer token; scopes from x-oauth-scopes response header.
```

Modify `lib/git.js` (you own it for this task):

```js
export function setGitAuthProvider(provider: (() => { token?: string|null } | null) | null): void;
export function buildGitAuthEnv(auth: { token?: string|null } | null | undefined): Record<string,string>;
// buildGitAuthEnv returns {} for no token, otherwise:
// {
//   GIT_CONFIG_COUNT: '1',
//   GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
//   GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + base64('x-access-token:' + token),
// }
// runGit() merges buildGitAuthEnv(provider()) into the child env (after the
// standard env, before explicit opts.env). A provider that throws is ignored.
// This lets private HTTPS clones/fetches/pushes use the OAuth/PAT token without
// SSH, without putting the token in argv or in .git/config.
```

Acceptance for this task:
- `node --test test/oauth.test.js test/git-auth.test.js` passes, offline (mock fetch; real temp git repo only).
- `startDeviceFlow` request assertions: URL, method, headers, JSON body.
- Poll covers pending → success, slow_down, expired_token, access_denied, timeout, abort.
- Git auth env test decodes the base64 header and verifies `runGit(['status'])` still works in a temp repo with a provider installed; provider reset in cleanup.
- No writes outside lib/oauth.js, lib/git.js, test/oauth.test.js, test/git-auth.test.js.

## B. Web UI (`ui-engine`)

New files `lib/web.js` and `client.js`, plus `test/web.test.js`.

### Host HTTP API (`lib/web.js`)

```js
export const ROUTE_PREFIX = '/api/github-orchestrator';

export function registerWebRoutes(ctx, runtime): () => void
// ctx.webServer.register({kind:'prefix', path: ROUTE_PREFIX, handler})
// Returns the disposer. Same-origin/local-only check like the bookmarks
// plugin's index.js (sec-fetch-site, Origin host must be loopback).
// runtime contract:
//   runtime.snapshot(): Promise<object>            // combined dashboard snapshot
//   runtime.invokeTool(name: string, args: object): Promise<unknown>
```

Endpoints (all JSON, `cache-control: no-store`):
- `GET  /status`   -> `{ ok:true, data: await runtime.snapshot() }`
- `GET  /events`   -> `runtime.invokeTool('github_events', { action:'list', unreadOnly, limit, repo })`
  query: `unread=1`, `limit` (1..200), `repo`
- `GET  /tasks`    -> `runtime.invokeTool('github_tasks', { action:'list', includeClosed:true })`
- `GET  /worktrees` -> `runtime.invokeTool('git_worktree', { action:'list' })`
- `POST /action`   body `{ tool: string, args: object }`
  -> whitelist `github_config|github_repos|github_events|github_tasks|git_worktree|git_sync|github_auth`
  -> `runtime.invokeTool(tool, args)`
- Unknown route -> 404 `{ok:false,error:'not-found'}`.
- Tool errors -> 200 with `{ok:false,error:<message>}` (so the panel can render
  them) unless the request itself is invalid (400).
- Response envelope: `{ok:true,data:...}` or `{ok:false,error:'...'}`.

`test/web.test.js`: fake `ctx.webServer.register` capturing the handler, fake
runtime with `snapshot`/`invokeTool`; exercise status, events filters, action
whitelist rejection, 404, method guard. Use plain fake req/res objects (an
EventEmitter for req + writable collector for res) or `node:http` against a
real localhost server; offline only.

### Browser panel (`client.js`)

Copy the *registration shape* of
`C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-plugin-bookmarks-center\client.js`
(tail of file): `window.__ModuleLoader__.load({ id:'@hitzhangjie/dsh-plugin-github-orchestrator', factory(require){...} })`,
plain React via `require('react')`, no JSX, no build step, no external imports.

Register:
- `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({name:'sidebar.panellist', id:'github-orchestrator', order: 30, label: () => copy.title}, SidebarIcon))`
- `ctx.slots.inject('main', () => ctx.slots.register({name:'main', key:'github-orchestrator'}, (slotProps) => page))`
- Return `{ apply, inject: ['slots'] }`; wrap page in an error boundary.

Panel content (React, theme tokens only, CSS class prefix `go-`, embedded
zh/en copy selected from `ctx.get('locale')` like bookmarks):
- Header: title, workspace root, token badge (source), "Poll now", "Refresh".
- Auth card: when no token or user opens it — "Sign in with GitHub" starts
  `POST /action {tool:'github_auth',args:{action:'start'}}`, then shows the
  `userCode` and a link to `verificationUri` plus "I authorized, continue"
  which calls `{action:'poll',timeoutSec:120}`; show login/scope on success.
  Also "Sign out" -> `{action:'logout'}`.
- Tabs: **Inbox** (unread list, kind chips, task id link, mark read / mark all),
  **Tasks** (status, branch, issue link, worktree path, sync storyboard button,
  close task button), **Repos** (clone/fetch buttons, clone state, base branch,
  dirty), **Worktrees** (repo/branch/dirty, remove with confirm), **Settings**
  (workspace root input + save, poll interval input + save; both call
  `github_config`/`github_config action=set` through `/action`).
- Auto-refresh every 15s; manual refresh; loading/empty/error states; no crash
  on missing data.
- All visible strings in zh/en via `copy` (Chinese default when locale absent).
- Accessible buttons/inputs, no `document.body` appending, no reading other
  plugins' DOM.

`client.js` must only read the four endpoints above (plus `/action`). Do not
call GitHub directly from the browser.

Acceptance for this task:
- `node --test test/web.test.js` passes.
- `node --check client.js` clean; client factory is side-effect free until
  `apply` is called.
- No writes outside lib/web.js, client.js, test/web.test.js; do not edit
  package.json, index.js, locales, README or other owners' files.
