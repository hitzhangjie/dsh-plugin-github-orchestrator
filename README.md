# GitHub orchestrator for DeepSeek Harness

[![test](https://github.com/hitzhangjie/dsh-plugin-github-orchestrator/actions/workflows/test.yml/badge.svg)](https://github.com/hitzhangjie/dsh-plugin-github-orchestrator/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Host + Web UI plugin that turns a local workspace into a small GitHub
workbench:

1. **A panel in the Harness Web UI** — a sidebar icon opens a dashboard for the
   workspace, GitHub sign-in, event inbox, tasks, repositories and worktrees.
   No terminal commands are required to use the common flows.
2. **OAuth sign-in, no SSH** — one click starts GitHub's OAuth device flow; after
   entering the shown code on github.com the plugin stores the token in the
   Harness credentials service. Private repository clones, fetches and pushes
   then use that token over HTTPS (no SSH keys, no credential helper, no manual
   token pasting).
3. **Follow repository activity** — issues, pull requests, reviews and branch
   pushes are polled into a normalized event inbox, so review requests, new
   issues and CI-relevant pushes do not disappear between sessions.
4. **Run tasks in parallel worktrees** — one workspace directory holds any
   number of clones; each task gets its own `git worktree` and branch, created
   from the remote base branch.
5. **Land and clean up work** — rebase a task branch onto the advanced base
   (conflicts are reported, not forced), merge it into the base branch in the
   main clone, then remove the worktree, delete the branch, close the task and
   update the storyboard.
6. **Keep a storyboard in GitHub issues** — every task is mirrored to an issue;
   a per-repository epic issue is regenerated with the task table and status
   counts. The local task store is the fast cache, GitHub issues are the durable
   shared memory.

Everything runs locally: the plugin talks to the GitHub REST API with `fetch`
and to Git through the local `git` executable. No server, webhook endpoint or
public URL is required.

## Install

The repository is <https://github.com/hitzhangjie/dsh-plugin-github-orchestrator>.
The package is a Cordis bundle with a Host half and a browser half.

```bash
git clone https://github.com/hitzhangjie/dsh-plugin-github-orchestrator.git
cd dsh-plugin-github-orchestrator
node --check index.js
node --check client.js
node --test "test/**/*.test.js"
```

Install into the current profile:

```
plugin_manager action=install_bundle target=<absolute path to this directory>
```

After installation a GitHub branch icon appears in the left sidebar. Click it to
open the dashboard, or use the nine tools directly:

| Tool | Purpose |
| --- | --- |
| `github_config` | Show/change workspace root, poll interval, base branch, branch prefix, remote, git binary, OAuth client id/scopes and automation fields |
| `github_auth` | OAuth device-flow sign-in: status / start / poll / cancel / logout |
| `github_repos` | Add/remove watched repositories; clone/fetch; inspect clone state |
| `github_issues` | List/show/create/comment on issues and pull requests (the current backlog, not just event deltas) |
| `github_events` | Read/poll/mark the event inbox; inspect poller watermarks |
| `github_tasks` | Create/list/update/close tasks; sync task issues and the epic storyboard; import existing issues |
| `github_dispatch` | Control the always-on dispatcher: status / run a check now / send text to the watcher session |
| `git_worktree` | Create/list/remove/prune task worktrees |
| `git_sync` | Fetch, rebase, rebase continue/abort, merge + cleanup, cleanup already-merged worktrees, status |

The plugin also contributes a compact `## GitHub orchestrator` runtime context
section: workspace root, active tasks, unread event counts by repository and
kind, and token availability.

## The panel

The sidebar panel contains:

- **Header** — workspace root, token badge ("OAuth", "environment", "GitHub
  CLI", …), *Poll now*, *Refresh*.
- **Sign in card** — *Sign in with GitHub* starts the device flow; the panel
  shows the one-time code and a link to `https://github.com/login/device`.
  After approving, press *I authorized, continue*; the token is stored in the
  credentials service and the panel switches to the signed-in state. *Sign out*
  deletes the stored credential.
- **Inbox** — unread events with kind chips, repository, branch/PR/issue links
  and the linked task id; mark one or all as read.
- **Issues/PRs** — the current open/closed issue and pull-request backlog (not
  only event deltas), filterable by kind, state, repository and limit, with a
  one-click *Create task* per row.
- **Tasks** — status, branch, issue link, worktree path; sync the storyboard or
  close a task.
- **Repos** — clone/fetch each watched repository, see base branch and dirty
  state.
- **Worktrees** — every live task worktree with its branch and dirty state;
  remove one with confirmation.
- **Automation** — always-on event dispatch: on/off, which event kinds, the
  minimum interval, the watcher session id, *Run check now*, *Open watcher
  session* and a textbox to send a chat-style instruction to the watcher.
- **Settings** — edit the workspace root and poll interval; changes persist
  immediately.

All network and Git work happens in the Host; the browser only calls the
plugin's loopback API (`/api/github-orchestrator/...`), guarded to same-origin
local requests. The panel refreshes itself every 15 seconds.

## How to assign a task

This plugin does not run a separate bot process: it gives **every DSH session**
the GitHub/worktree/storyboard tools. There are two ways to put it to work:

1. **Main chat (always available)** — write the assignment in the normal
   conversation, for example:

   > 看一下 GitHub 收件箱，把最新 review 请求对应到任务；需要的话创建 worktree 实现，
   > 完成后 rebase 到最新 main，再 merge、清理 worktree 和分支、关闭 issue。

   The agent then calls `github_events`, `github_tasks`, `git_worktree` and
   `git_sync` itself. This is the most flexible path, and the same session can
   keep steering the work.

2. **Panel → “派任务给 Agent”** — type the task in the dispatch card and click
   **新建会话并派单**. The panel creates a new DSH session with the plugin
   workspace as its working directory, sends the text as the first user
   message, and switches to that session so you can watch the agent work. If a
   deployment does not expose the client session service, the panel falls back
   to opening a new session with the task pre-filled in the composer draft —
   press Send there.

Both paths use the same tools and state (event inbox, tasks, storyboard), so a
task dispatched from the panel is the same task you can follow from the chat
and see in the plugin's Tasks tab.

## Always-on automation (Grok-bot mode)

With `autoDispatch` enabled the plugin stops waiting to be asked. On every poll
cycle the dispatcher:

1. takes newly observed, unread, non-baseline events for the configured kinds
   (default `issue`, `pr`, `review`),
2. de-duplicates them against its persisted `dispatch.json` and applies a
   minimum interval to avoid storms,
3. creates one local storyboard task per event (`[GitHub] repo#123 title`,
   linked to the issue/PR number),
4. delivers a structured instruction prompt to one persistent **watcher
   session** — creating it on first use and resuming it after restarts — so the
   agent starts working without a human asking.

The watcher session is an ordinary DSH conversation: open it from the
Automation tab (or the sidebar) to watch, interrupt, or continue the work. You
can also type into it directly; the agent has the same plugin tools there. If a
prompt cannot be delivered the event stays unseen and the next tick retries it;
the last error is shown in the Automation tab.

Enable it once:

```
github_config action=set autoDispatch=true autoDispatchKinds=["issue","pr","review"] autoDispatchMinIntervalSec=120
```

or use the Automation tab's toggle. `github_dispatch action=status` reports the
watcher session id and last dispatch; `github_dispatch action=tick` runs a check
on demand; `github_dispatch action=send text="..."` injects a chat-style
instruction into the same watcher session.

Automation is off by default so installing the plugin never starts model work
unexpectedly; the panel and `github_config action=set` turn it on per install.
The watcher agent is created with the configured `autoDispatchAgentPreset`
(default `standard`), so it receives the normal file/shell/tool set and can
actually execute work rather than only read GitHub metadata.

## Configuration

Initial values live in the bundle config (`cordis.patch.yml`):

```yaml
- insert:
    - id: hitzhangjie-github-orchestrator
      name: '@hitzhangjie/dsh-plugin-github-orchestrator'
      config:
        workspaceRoot: 'C:\Users\me\github-work'   # empty => <DSH_HOME>/github-work
        repos: ['owner/name']                       # or { repo, local, baseBranch }
        pollIntervalSec: 120
        defaultBaseBranch: main
        branchPrefix: 'task/'
        oauthClientId: ''                           # optional own OAuth App
        oauthScopes: 'repo read:user'
        autoDispatch: false                         # always-on automation (off by default)
        autoDispatchKinds: ['issue', 'pr', 'review']
        autoDispatchMinIntervalSec: 120
        autoDispatchMaxEvents: 5
        autoDispatchCreateTasks: true
        autoDispatchTaskStatus: ready
        autoDispatchAgentPreset: standard
```

At runtime, `github_config action=set` (or the panel's Settings tab) persists
overrides to `<DSH_HOME>/github-orchestrator/settings.json`; the patch file is
never rewritten. `github_repos action=add|remove` stores the watched repository
list the same way. Changing the workspace root creates the directory
immediately.

The workspace layout is:

```
<workspaceRoot>/
  owner__name/          # clone (one per repository)
  .worktrees/           # generated worktrees, one per task
    owner__name__T1/
```

Each clone keeps its own `.git`, so fetch/rebase/merge never touch another
repository.

## GitHub authorization

`github_auth` and the panel use the **OAuth device flow** (RFC 8628):

1. `github_auth action=start` returns `userCode` and `verificationUri`.
2. The human opens `https://github.com/login/device`, enters the code and
   approves the requested scopes (`repo read:user` by default).
3. `github_auth action=poll` (or the panel button) waits for the approval, reads
   the account login and scopes, stores the token in the Harness credentials
   service under the `github-orchestrator` record, and applies it immediately.

The client id comes from, in order: `oauthClientId` in the plugin config,
`GITHUB_OAUTH_CLIENT_ID`, then a documented built-in public fallback (the GitHub
CLI OAuth app) so a local install works without registering an application. For
a dedicated app identity, create an OAuth App at
<https://github.com/settings/developers>, enable device flow, and set
`oauthClientId`.

For Git, the plugin injects the token into child `git` processes through
`GIT_CONFIG_*` environment variables (`http.https://github.com/.extraheader`).
The token therefore never appears in a command line or in `.git/config`, and
private HTTPS clones/fetches/pushes work without SSH or a credential helper.

Fallback token resolution for headless use still works:
`githubToken` config → credentials record → `GITHUB_TOKEN` / `GH_TOKEN` →
`gh auth token`. Token values are never logged or included in tool output.

## Typical workflow

Through the panel: sign in → add/clone a repository in **Repos** → watch
**Inbox** → create a task (tool) → create its worktree → work in that directory
→ *Sync storyboard* / merge from the tools.

With tools:

```
# 1. sign in once (or use gh auth / GITHUB_TOKEN)
github_auth    action=start
github_auth    action=poll

# 2. configure a workspace and watch a repository
github_config  action=set workspaceRoot="C:\work\github"
github_repos   action=add repo="owner/name"
github_repos   action=clone repo="owner/name"

# 3. see what happened upstream
github_events  action=poll
github_events  action=list unreadOnly=true limit=20

# 4. turn a new issue into a task; this also creates a storyboard issue
github_tasks   action=create repo="owner/name" title="Fix parser crash" description="..."

# 5. give the task its own worktree and branch
git_worktree   action=create task=T1

# ... edit files in the worktree path returned above ...

# 6. keep it current while the base branch advances
git_sync       action=rebase task=T1
#    conflict? resolve files, git add, then:
git_sync       action=rebase_continue task=T1

# 7. land it, then remove worktree + branch + close issue + update storyboard
git_sync       action=merge task=T1
```

`git_sync action=merge` defaults to **not pushing** the base branch. Pass
`push=true` to push it, and `cleanup=false`/`closeIssue=false` to keep the
worktree or issue for follow-up work.

`git_sync action=cleanup dryRun=true` lists worktrees whose branches are already
merged into the remote base branch; without `dryRun` it removes them, deletes
the branches and prunes stale registrations. Dirty worktrees are skipped.
Add `closeTasks=true` to also close the matching tasks and issues.

## Storyboard format

- Task issue title: `[T1] Fix parser crash`; labels `gos:task`,
  `gos:status/<status>`.
- The issue body starts with a hidden machine-readable block
  (`<!-- github-orchestrator:task ... -->`) followed by summary, branch,
  worktree, base branch and the note timeline. It is regenerated on every
  `github_tasks action=update|sync`.
- Epic issue title: `[Storyboard] owner/name`; label `gos:epic`. It contains the
  generated timestamp, status counts and a task table linking every task issue
  and branch.
- `github_tasks action=bootstrap repo=...` creates the epic and imports existing
  `gos:task` issues whose local task is missing, which is how an existing
  project history becomes storyboard memory.

Statuses: `backlog` → `ready` → `in_progress` → `review` → `done`.

## Events

`github_events action=watch` shows poller state and per-repository watermarks.
Each poll compares watermarks against the GitHub API for:

- issues (`/issues`, pull requests excluded),
- pull requests (`/pulls`, opened/updated/merged/closed detection),
- reviews for changed open pull requests (`/pulls/{n}/reviews`),
- branch tips (`/branches`) for push detection.

The first poll primes watermarks and emits at most 25 baseline events per
repository for open issues/PRs updated within `baselineDays` (14) so a freshly
watched repository is not silent. Event ids are deterministic, so repeated polls
never duplicate inbox entries. A failing repository records an error and does
not stop the other repositories' polling.

`github_events action=list` annotates each event with the local task it belongs
to when the event's branch matches a task branch, or its issue/PR number matches
a task's `issueNumber`/`prNumber`. That makes the jump from "review requested on
PR #42" to task `T3` explicit.

## State files

All under `<DSH_HOME>/github-orchestrator/`:

| File | Contents |
| --- | --- |
| `settings.json` | runtime overrides written by `github_config` / `github_repos` |
| `events.json` | event inbox (capped at `maxEvents`, default 2000) |
| `events-watermarks.json` | polling watermarks per repository |
| `dispatch.json` | automation state: seen event ids, watcher session id, last dispatch/error |
| `tasks.json` | local storyboard tasks and notes |

The OAuth token is **not** in these files: it is stored in the Harness
credentials service. Each state file is written atomically (temp file + rename).
Deleting `events.json` or `events-watermarks.json` is safe: the next poll
re-primes. Deleting `tasks.json` loses local task state unless it can be
re-imported from issue meta blocks with `github_tasks action=import`.

## Notes and limits

- Git repositories must be reachable from the **Host** filesystem (Windows
  paths). A WSL path such as `\\wsl.localhost\...` is not a supported Git
  worktree root for this plugin.
- GitHub polling, not webhooks: latency is one poll interval. No public
  endpoint is opened.
- Private repositories work through the OAuth/PAT token over HTTPS. SSH remotes
  are also fine if the Host already has keys; the token injection only targets
  `https://github.com/`.
- Concurrent tasks are Git worktrees of the same clone; if two tasks modify the
  same files, resolve the merge/rebase conflict explicitly.
- The built-in OAuth fallback client id belongs to the GitHub CLI app; use your
  own OAuth App client id if you want the consent screen to name your app.

## Chinese quick start

1. 点侧边栏的 GitHub 图标打开面板，点“使用 GitHub 登录”，按提示在
   `https://github.com/login/device` 输入一次性代码并授权——不需要 SSH，也不用手动粘贴 token。
2. 在“仓库”页添加并克隆仓库（可多个）；在“设置”页改工作目录。
3. “收件箱”看事件增量，“议题/PR”页直接拉取当前 issue / PR 列表（可按 kind、状态、仓库过滤），
   每行可一键“创建任务”。
4. 打开“自动化”页：打开 **Always-on auto dispatch**，选择要驱动任务的 event 类型
   （issue/pr/review）与最小间隔。此后新事件会：
   自动建任务 → 写入持久 watcher 会话 → Agent 立即开始处理，不需要你再问“有没有事件”。
   可在该页“打开 watcher 会话”查看/打断，或“立即检查”手动触发一次。
5. 用工具创建任务：`github_tasks action=create repo="owner/name" title="..."`（自动建 issue）。
6. `git_worktree action=create task=T1` 创建并发 worktree；
   `git_sync action=rebase task=T1` 跟随主干变基；
   `git_sync action=merge task=T1` 合并后自动清理 worktree、分支、关闭 issue 并刷新故事板。
7. 任务页可“同步故事板”，仓库页可克隆/拉取，Worktree 页可安全删除；自动化状态可用
   `github_dispatch action=status` 查看。

## Verification

`node --test "test/**/*.test.js"` runs **231 tests** covering the Git engine,
token-authenticated Git, GitHub client, issue/PR listing, OAuth device flow,
event poller, auto-dispatch engine, task store, storyboard, the tool layer, the
Host web API and integration scenarios offline (temp repositories, an
in-process mock GitHub server and mock fetch).

Live checks against the running Harness and GitHub: the client halves register
as active `sidebar.panellist` / `main` occupants, the loopback API answers
`/status`, `/events` and `/action` with real data, `github_issues` lists the
real open issues/PRs of `hitzhangjie/golang-debugger-book`, the device-flow
start returns a real user code, and a private repository cloned through the
plugin with the token alone (no SSH, no credential helper) — with no token
written to `.git/config`. The always-on path was exercised end to end: a
synthetic event was observed by the dispatcher, a storyboard task was created,
the watcher session was created with its preset tools, and the agent read the
event, marked it handled, closed the task and stopped. The rendered panel
layout is exercised by the offline React harness in `test/web.test.js`; visual
inspection in the page was not automated.
