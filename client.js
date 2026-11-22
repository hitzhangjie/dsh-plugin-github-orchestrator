/**
 * @hitzhangjie/dsh-plugin-github-orchestrator - browser half.
 *
 * Registers one sidebar icon (`sidebar.panellist`) and the matching page body
 * under the same key in `main`, so the icon opens this page. The page only
 * reads the plugin's own loopback API (`/api/github-orchestrator`); every
 * GitHub call, Git command and filesystem access stays in the Host half.
 *
 * Plain JavaScript, no JSX and no build step: the Harness Module Loader hands
 * `react` to the factory. The factory id must equal the package name exactly,
 * and the factory must stay side-effect free until `apply(ctx)` runs.
 */
window.__ModuleLoader__.load({
  id: '@hitzhangjie/dsh-plugin-github-orchestrator',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const ROUTE = '/api/github-orchestrator';
    const PANEL_ID = 'github-orchestrator';
    const REFRESH_MS = 15000;
    // Issues/PRs sits between Inbox and Tasks; Automation is deliberately last.
    const TAB_KEYS = ['inbox', 'issues', 'tasks', 'repos', 'worktrees', 'settings', 'automation'];
    const EVENT_LIMITS = [20, 50, 100, 200];
    const TASK_STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done'];
    const ISSUE_KINDS = ['all', 'issue', 'pr'];
    const ISSUE_STATES = ['open', 'closed', 'all'];
    const ISSUE_LIMITS = [10, 20, 30, 50, 100];
    const DEFAULT_AUTO_DISPATCH_KINDS = ['issue', 'pr', 'review'];
    const AUTO_DISPATCH_KINDS = ['issue', 'pr', 'review', 'push', 'comment'];
    const DEFAULT_DISPATCH = {
      enabled: false,
      sessionId: null,
      lastDispatchAt: null,
      count: 0,
      lastError: null,
      lastEventAt: null,
      seen: 0,
      skipped: 0,
      kinds: [],
      minIntervalSec: null,
    };

    // ---------------------------------------------------------------------
    // Embedded copy (zh default, en when the locale service reports English)
    // ---------------------------------------------------------------------

    const COPY = {
      zh: {
        title: 'GitHub 任务编排器',
        tagline: '在一个面板里查看事件收件箱、任务看板、仓库克隆与工作树，并使用 GitHub 账号登录。',
        tabsLabel: '功能分区',
        refresh: '刷新',
        refreshing: '刷新中…',
        pollNow: '立即轮询',
        polling: '轮询中…',
        lastUpdated: (time) => `上次更新：${time}`,
        autoRefresh: (sec) => `每 ${sec} 秒自动刷新`,
        pollerOff: '轮询未启动',
        workspace: '工作区',
        signedInAs: (login) => `已登录 ${login}`,
        notSignedIn: '未登录',
        tokenSource: (source) => `令牌来源：${source}`,
        tokenMissing: '没有可用的 GitHub 令牌',
        source: {
          config: '插件配置',
          credentials: '本地凭据',
          env: '环境变量',
          'gh-cli': 'GitHub CLI',
          oauth: 'OAuth 登录',
          none: '无',
        },
        tabs: {
          inbox: '收件箱',
          issues: '议题/PR',
          tasks: '任务',
          repos: '仓库',
          worktrees: '工作树',
          settings: '设置',
          automation: '自动化',
        },
        common: {
          loading: '加载中…',
          empty: '暂无数据',
          retry: '重试',
          cancel: '取消',
          save: '保存',
          saving: '保存中…',
          confirm: '确认',
          close: '关闭',
          copy: '复制',
          copied: '已复制到剪贴板',
          copyFailed: '复制失败，请手动复制',
          failed: '操作失败',
          unknown: '未知',
          none: '无',
          open: '打开',
          yes: '是',
          no: '否',
          renderErrorTitle: '面板渲染出错',
          renderErrorHint: '这是页面渲染问题，不是数据问题。点击重试可恢复；如果反复出现，请把错误信息发送给维护者。',
          retryRender: '重试渲染',
          removed: '已删除',
          dismiss: '知道',
        },
        inbox: {
          title: '事件收件箱',
          hint: '插件只读取 GitHub 事件；标记已读不会修改 GitHub 上的任何内容。',
          unreadOnly: '只看未读',
          limit: '数量',
          repo: '仓库',
          allRepos: '全部仓库',
          markRead: '标记已读',
          marking: '标记中…',
          markAll: '全部标记已读',
          markAllDone: (count) => `已标记 ${count} 条事件为已读。`,
          count: (n, unread) => `${n} 条事件${unread > 0 ? `（${unread} 条未读）` : ''}`,
          kinds: { issue: 'Issue', pr: 'PR', review: '评审', push: '推送', comment: '评论' },
          taskLink: (id) => `关联任务 ${id}`,
          read: '已读',
          empty: '收件箱是空的。',
          emptyUnread: '没有未读事件。',
          polled: (added) => (added > 0 ? `轮询完成，新增 ${added} 条事件。` : '轮询完成，没有新事件。'),
          updated: (time) => `更新于 ${time}`,
        },
        issues: {
          title: 'Issues 与 Pull Requests',
          hint: '直接读取 GitHub 上的 issue 与 PR；创建任务会把条目写入本地故事板，并同步到 GitHub issue。',
          kind: '类型',
          kindAll: '全部',
          kindIssue: 'Issue',
          kindPr: 'PR',
          state: '状态',
          stateAll: '全部',
          stateOpen: '打开',
          stateClosed: '已关闭',
          stateMerged: '已合并',
          repo: '仓库',
          allRepos: '全部仓库',
          limit: '数量',
          count: (n) => `${n} 条`,
          createTask: '创建任务',
          creatingTask: '创建中…',
          taskCreated: (id) => `已创建任务 ${id}。`,
          taskCreatedGeneric: '已创建任务。',
          taskNeedsRepo: '请先在仓库下拉框中选择一个仓库，再创建任务。',
          by: (author) => `作者 ${author}`,
          labels: (names) => `标签：${names.join('、')}`,
          updated: (time) => `更新于 ${time}`,
          draft: '草稿',
          openLink: '在 GitHub 打开',
          empty: '没有匹配的 issue 或 PR。',
        },
        tasks: {
          title: '任务看板',
          hint: '任务保存在本地，并通过故事板同步到 GitHub issue。',
          statusFilter: '状态',
          openOnly: '仅未完成',
          allStatuses: '全部状态',
          repo: '仓库',
          allRepos: '全部仓库',
          count: (n) => `${n} 个任务`,
          id: '编号',
          status: '状态',
          branch: '分支',
          worktree: '工作树',
          issue: 'Issue',
          sync: '同步故事板',
          syncing: '同步中…',
          close: '关闭任务',
          closing: '关闭中…',
          confirmClose: (id) => `确认关闭任务 ${id}？对应的 GitHub issue 也会被关闭。`,
          statusLabels: {
            backlog: '待办',
            ready: '就绪',
            in_progress: '进行中',
            review: '评审中',
            done: '已完成',
          },
          priorityLabels: { low: '低', normal: '普通', high: '高' },
          empty: '还没有任务。',
          synced: '故事板已同步。',
          closed: '任务已关闭。',
          noWorktree: '无',
          noIssue: '无',
          updated: (time) => `更新于 ${time}`,
        },
        repos: {
          title: '仓库',
          hint: '克隆与抓取都在 Host 侧执行；私有仓库使用已登录的 GitHub 令牌。',
          count: (n) => `${n} 个仓库`,
          clone: '克隆',
          cloning: '克隆中…',
          fetch: '抓取',
          fetching: '抓取中…',
          baseBranch: '基线分支',
          currentBranch: '当前分支',
          cloned: '已克隆',
          notCloned: '未克隆',
          dirty: '有改动',
          clean: '干净',
          worktrees: (n) => `${n} 个工作树`,
          activeTasks: (n) => `${n} 个未完成任务`,
          lastPoll: (time) => `上次轮询 ${time}`,
          empty: '还没有配置仓库。请让智能体使用 github_repos 工具添加并克隆仓库。',
          clonedToast: (repo) => `已克隆 ${repo}。`,
          fetchedToast: (repo) => `已抓取 ${repo}。`,
          ahead: (n) => `领先 ${n}`,
          behind: (n) => `落后 ${n}`,
          error: (message) => `仓库状态不可用：${message}`,
        },
        worktrees: {
          title: '工作树',
          hint: '删除工作树前请确认没有未提交的改动；存在改动时会被强制删除。',
          count: (n) => `${n} 个工作树`,
          repo: '仓库',
          branch: '分支',
          path: '路径',
          dirty: '有改动',
          locked: '已锁定',
          prunable: '可清理',
          task: '任务',
          remove: '删除',
          removing: '删除中…',
          confirmRemove: '确认删除这个工作树？未提交的改动会丢失。',
          removed: '工作树已删除。',
          empty: '没有任务工作树。',
          noBranch: '（分离 HEAD）',
        },
        settings: {
          title: '设置',
          hint: '设置保存在插件的状态目录里，保存后立即生效，无需重启。',
          workspaceTitle: '工作区根目录',
          workspaceHint: '仓库克隆与 .worktrees 都放在这个目录下。',
          pollTitle: '轮询间隔',
          pollHint: '15–3600 秒。修改后立即生效。',
          save: '保存',
          saving: '保存中…',
          saved: '设置已保存。',
          invalidWorkspace: '请输入工作区根目录。',
          invalidInterval: '轮询间隔必须是 15 到 3600 之间的整数。',
          infoTitle: '运行信息',
          stateDir: '状态目录',
          defaultBaseBranch: '默认基线分支',
          branchPrefix: '任务分支前缀',
          remote: '远程名',
          gitBinary: 'Git 可执行文件',
          apiBase: 'GitHub API',
          workspaceExists: '目录存在',
          intervalUnit: '秒',
        },
        automation: {
          title: '自动化',
          hint: '始终开启的 GitHub 事件派发：新的 issue / PR / review / push 会自动创建任务，并发送给一个常驻 watcher 会话。',
          autoTitle: '自动派发',
          autoHint: '新事件会自动变成任务并派给 watcher 会话；关闭后只记录事件，不自动派发。',
          enabled: '始终开启自动派发',
          enabledOn: '已开启',
          enabledOff: '已关闭',
          kinds: '监听的类型',
          minInterval: '最小间隔',
          minIntervalUnit: '秒',
          minIntervalHint: '两次自动派发之间至少间隔的秒数（30–3600）。',
          save: '保存',
          saving: '保存中…',
          saved: '自动化设置已保存。',
          invalidInterval: '最小间隔必须是 30 到 3600 之间的整数。',
          statusTitle: '派发状态',
          watcher: 'Watcher 会话',
          noSession: '还没有 watcher 会话，触发一次检查后会自动创建。',
          openWatcher: '打开 watcher 会话',
          watcherUnavailable: '当前 Harness 没有会话界面，无法打开 watcher 会话。',
          noWatcherSession: '还没有 watcher 会话可打开。',
          lastDispatch: '上次派发',
          dispatchCount: '派发次数',
          lastEvent: '最近事件',
          seen: '已处理事件',
          skipped: '跳过事件',
          lastError: '最近错误',
          noError: '无',
          never: '从未',
          runCheck: '立即检查一次',
          running: '检查中…',
          checkDispatched: (n) => `已派发 ${n} 条事件到 watcher。`,
          checkDispatchedGeneric: '已派发事件到 watcher。',
          checkIdle: (reason) => `本次没有派发：${reason}。`,
          checkUnknownReason: '没有可派发的事件',
          reasons: {
            'no-events': '没有新事件',
            'no-candidates': '没有符合条件的事件',
            throttled: '未到最小间隔',
            disabled: '自动派发已关闭',
          },
          refreshStatus: '刷新状态',
          refreshingStatus: '刷新中…',
          statusRefreshed: '派发状态已刷新。',
          sendTitle: '直接发送给 watcher',
          sendHint: '把一条消息直接发到 watcher 会话，不影响自动派发。',
          sendPlaceholder: '例如：处理收件箱里最新的 review 请求，创建 worktree 并实现。',
          send: '发送',
          sending: '发送中…',
          sendEmpty: '请先输入要发送的内容。',
          sent: (sessionId) => `已发送到会话 ${sessionId}。`,
          sentGeneric: '已发送给 watcher。',
          enabledBadge: '自动派发开启',
        },
        auth: {
          title: 'GitHub 账号',
          signedIn: (login) => `已登录：${login}`,
          source: (source) => `来源：${source}`,
          scopes: (scopes) => `权限：${scopes}`,
          manage: '账号管理',
          hide: '收起',
          start: '使用 GitHub 登录',
          retry: '重新开始',
          starting: '正在启动设备登录…',
          codeLabel: '在 GitHub 授权页输入此代码：',
          verify: '打开 GitHub 授权页',
          poll: '我已完成授权，继续',
          polling: '正在等待授权…',
          cancel: '取消登录',
          canceling: '正在取消…',
          signOut: '退出登录',
          signingOut: '正在退出…',
          confirmSignOut: '确认退出登录？本地保存的 OAuth 凭据会被删除。',
          success: (login) => `登录成功：${login}`,
          pendingHint: '请在浏览器中打开授权页并输入上面的代码，完成后点击“我已完成授权，继续”。',
          pendingRestored: '检测到未完成的登录流程，可以继续完成授权。',
          expiresAt: (time) => `代码有效期至 ${time}`,
          openFailed: '无法打开授权页，请手动访问：',
          logoutDone: '已退出登录。',
          notSignedIn: '当前没有可用的 GitHub 令牌，轮询、Issue 与私有仓库等功能不可用。',
          scopeNone: '（未返回权限信息）',
          continueHint: '授权完成后点击下方按钮，Host 会轮询 GitHub 并保存令牌。',
        },
        time: {
          justNow: '刚刚',
          secondsAgo: (n) => `${n} 秒前`,
          minutesAgo: (n) => `${n} 分钟前`,
          hoursAgo: (n) => `${n} 小时前`,
          daysAgo: (n) => `${n} 天前`,
          never: '从未',
        },
        dispatch: {
          title: '派任务给 Agent',
          hint: '把任务描述发给一个新建的 DSH 会话；新会话会自动获得本插件的工具，并把当前工作目录设为插件的工作目录。也可以直接在主聊天窗口里派任务。',
          placeholder: '例如：查看 GitHub 收件箱，把最新 review 请求对应到任务；需要时创建 worktree、实现、rebase 并 merge 清理。',
          send: '新建会话并派单',
          sending: '派单中…',
          sessionHint: 'Ctrl/⌘+Enter 发送；发送后会自动切到新会话。',
          sent: '已创建会话并发送任务，正在切换到该会话。',
          draftReady: '无法自动发送，已把任务填入新会话的输入框，请按发送。',
          empty: '请先输入任务描述。',
          unavailable: '当前 Harness 没有提供会话服务，暂时无法自动派单；请把上面的文字粘贴到主聊天窗口。',
          failed: '派单失败',
        },
        footer: {
          route: (route) => `接口：${route}`,
          generated: (time) => `快照生成于 ${time}`,
          hostOnly: '所有 GitHub 与 Git 操作都在 Host 侧完成，浏览器不直接访问 GitHub。',
        },
      },
      en: {
        title: 'GitHub orchestrator',
        tagline: 'One panel for the event inbox, storyboard tasks, repository clones and worktrees, with GitHub sign-in.',
        tabsLabel: 'Sections',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        pollNow: 'Poll now',
        polling: 'Polling…',
        lastUpdated: (time) => `Updated ${time}`,
        autoRefresh: (sec) => `Auto-refresh every ${sec}s`,
        pollerOff: 'Poller off',
        workspace: 'Workspace',
        signedInAs: (login) => `Signed in as ${login}`,
        notSignedIn: 'Not signed in',
        tokenSource: (source) => `Token source: ${source}`,
        tokenMissing: 'No GitHub token available',
        source: {
          config: 'Plugin config',
          credentials: 'Local credentials',
          env: 'Environment',
          'gh-cli': 'GitHub CLI',
          oauth: 'OAuth sign-in',
          none: 'none',
        },
        tabs: {
          inbox: 'Inbox',
          issues: 'Issues/PRs',
          tasks: 'Tasks',
          repos: 'Repos',
          worktrees: 'Worktrees',
          settings: 'Settings',
          automation: 'Automation',
        },
        common: {
          loading: 'Loading…',
          empty: 'No data',
          retry: 'Retry',
          cancel: 'Cancel',
          save: 'Save',
          saving: 'Saving…',
          confirm: 'Confirm',
          close: 'Close',
          copy: 'Copy',
          copied: 'Copied to clipboard',
          copyFailed: 'Copy failed; please copy manually',
          failed: 'Action failed',
          unknown: 'unknown',
          none: 'none',
          open: 'Open',
          yes: 'yes',
          no: 'no',
          renderErrorTitle: 'Could not render this page',
          renderErrorHint: 'This is a rendering problem, not a data problem. Retry to recover; if it keeps happening, send the error text to the maintainer.',
          retryRender: 'Retry rendering',
          removed: 'Removed',
          dismiss: 'Dismiss',
        },
        inbox: {
          title: 'Event inbox',
          hint: 'The plugin only reads GitHub events; marking read never changes anything on GitHub.',
          unreadOnly: 'Unread only',
          limit: 'Limit',
          repo: 'Repository',
          allRepos: 'All repositories',
          markRead: 'Mark read',
          marking: 'Marking…',
          markAll: 'Mark all read',
          markAllDone: (count) => `Marked ${count} event(s) read.`,
          count: (n, unread) => `${n} event(s)${unread > 0 ? ` (${unread} unread)` : ''}`,
          kinds: { issue: 'Issue', pr: 'PR', review: 'Review', push: 'Push', comment: 'Comment' },
          taskLink: (id) => `Task ${id}`,
          read: 'Read',
          empty: 'The inbox is empty.',
          emptyUnread: 'No unread events.',
          polled: (added) => (added > 0 ? `Poll finished: ${added} new event(s).` : 'Poll finished: no new events.'),
          updated: (time) => `Updated ${time}`,
        },
        issues: {
          title: 'Issues and pull requests',
          hint: 'Reads issues and pull requests directly from GitHub; creating a task adds it to the local storyboard and mirrors it to a GitHub issue.',
          kind: 'Kind',
          kindAll: 'All',
          kindIssue: 'Issue',
          kindPr: 'PR',
          state: 'State',
          stateAll: 'All',
          stateOpen: 'Open',
          stateClosed: 'Closed',
          stateMerged: 'Merged',
          repo: 'Repository',
          allRepos: 'All repositories',
          limit: 'Limit',
          count: (n) => `${n} item(s)`,
          createTask: 'Create task',
          creatingTask: 'Creating…',
          taskCreated: (id) => `Created task ${id}.`,
          taskCreatedGeneric: 'Task created.',
          taskNeedsRepo: 'Pick a repository in the dropdown before creating a task.',
          by: (author) => `by ${author}`,
          labels: (names) => `Labels: ${names.join(', ')}`,
          updated: (time) => `Updated ${time}`,
          draft: 'Draft',
          openLink: 'Open on GitHub',
          empty: 'No matching issues or pull requests.',
        },
        tasks: {
          title: 'Storyboard tasks',
          hint: 'Tasks live locally and are mirrored to GitHub issues through the storyboard.',
          statusFilter: 'Status',
          openOnly: 'Open only',
          allStatuses: 'All statuses',
          repo: 'Repository',
          allRepos: 'All repositories',
          count: (n) => `${n} task(s)`,
          id: 'Id',
          status: 'Status',
          branch: 'Branch',
          worktree: 'Worktree',
          issue: 'Issue',
          sync: 'Sync storyboard',
          syncing: 'Syncing…',
          close: 'Close task',
          closing: 'Closing…',
          confirmClose: (id) => `Close task ${id}? Its GitHub issue will be closed too.`,
          statusLabels: {
            backlog: 'Backlog',
            ready: 'Ready',
            in_progress: 'In progress',
            review: 'In review',
            done: 'Done',
          },
          priorityLabels: { low: 'Low', normal: 'Normal', high: 'High' },
          empty: 'No tasks yet.',
          synced: 'Storyboard synced.',
          closed: 'Task closed.',
          noWorktree: 'none',
          noIssue: 'none',
          updated: (time) => `Updated ${time}`,
        },
        repos: {
          title: 'Repositories',
          hint: 'Clone and fetch run on the Host; private repositories use the signed-in GitHub token.',
          count: (n) => `${n} repo(s)`,
          clone: 'Clone',
          cloning: 'Cloning…',
          fetch: 'Fetch',
          fetching: 'Fetching…',
          baseBranch: 'Base branch',
          currentBranch: 'Current branch',
          cloned: 'Cloned',
          notCloned: 'Not cloned',
          dirty: 'Dirty',
          clean: 'Clean',
          worktrees: (n) => `${n} worktree(s)`,
          activeTasks: (n) => `${n} open task(s)`,
          lastPoll: (time) => `Last poll ${time}`,
          empty: 'No repositories configured yet. Ask the agent to add and clone one with the github_repos tool.',
          clonedToast: (repo) => `Cloned ${repo}.`,
          fetchedToast: (repo) => `Fetched ${repo}.`,
          ahead: (n) => `${n} ahead`,
          behind: (n) => `${n} behind`,
          error: (message) => `Repository state unavailable: ${message}`,
        },
        worktrees: {
          title: 'Worktrees',
          hint: 'Confirm there are no uncommitted changes before removing a worktree; dirty worktrees are force-removed.',
          count: (n) => `${n} worktree(s)`,
          repo: 'Repository',
          branch: 'Branch',
          path: 'Path',
          dirty: 'Dirty',
          locked: 'Locked',
          prunable: 'Prunable',
          task: 'Task',
          remove: 'Remove',
          removing: 'Removing…',
          confirmRemove: 'Remove this worktree? Uncommitted changes will be lost.',
          removed: 'Worktree removed.',
          empty: 'No task worktrees.',
          noBranch: '(detached HEAD)',
        },
        settings: {
          title: 'Settings',
          hint: 'Settings are stored in the plugin state directory and take effect immediately, no restart needed.',
          workspaceTitle: 'Workspace root',
          workspaceHint: 'Repository clones and .worktrees live under this directory.',
          pollTitle: 'Poll interval',
          pollHint: '15–3600 seconds. Takes effect immediately.',
          save: 'Save',
          saving: 'Saving…',
          saved: 'Settings saved.',
          invalidWorkspace: 'Enter a workspace root directory.',
          invalidInterval: 'Poll interval must be an integer between 15 and 3600 seconds.',
          infoTitle: 'Runtime info',
          stateDir: 'State directory',
          defaultBaseBranch: 'Default base branch',
          branchPrefix: 'Task branch prefix',
          remote: 'Remote',
          gitBinary: 'Git binary',
          apiBase: 'GitHub API',
          workspaceExists: 'Directory exists',
          intervalUnit: 's',
        },
        automation: {
          title: 'Automation',
          hint: 'Always-on GitHub event dispatch: new issues, pull requests, reviews and pushes become tasks and are delivered to one persistent watcher session.',
          autoTitle: 'Auto dispatch',
          autoHint: 'New events become tasks and are sent to the watcher session; when off, events are recorded only.',
          enabled: 'Always-on auto dispatch',
          enabledOn: 'On',
          enabledOff: 'Off',
          kinds: 'Event kinds',
          minInterval: 'Minimum interval',
          minIntervalUnit: 's',
          minIntervalHint: 'Minimum number of seconds between two automatic dispatches (30–3600).',
          save: 'Save',
          saving: 'Saving…',
          saved: 'Automation settings saved.',
          invalidInterval: 'Minimum interval must be an integer between 30 and 3600 seconds.',
          statusTitle: 'Dispatch status',
          watcher: 'Watcher session',
          noSession: 'No watcher session yet; run a check once to create it automatically.',
          openWatcher: 'Open watcher session',
          watcherUnavailable: 'This Harness exposes no session UI, so the watcher session cannot be opened.',
          noWatcherSession: 'No watcher session to open yet.',
          lastDispatch: 'Last dispatch',
          dispatchCount: 'Dispatches',
          lastEvent: 'Last event',
          seen: 'Events seen',
          skipped: 'Events skipped',
          lastError: 'Last error',
          noError: 'none',
          never: 'never',
          runCheck: 'Run check now',
          running: 'Checking…',
          checkDispatched: (n) => `Dispatched ${n} event(s) to the watcher.`,
          checkDispatchedGeneric: 'Dispatched events to the watcher.',
          checkIdle: (reason) => `Nothing dispatched: ${reason}.`,
          checkUnknownReason: 'no dispatchable events',
          reasons: {
            'no-events': 'no new events',
            'no-candidates': 'no matching events',
            throttled: 'minimum interval not reached',
            disabled: 'auto dispatch is off',
          },
          refreshStatus: 'Refresh status',
          refreshingStatus: 'Refreshing…',
          statusRefreshed: 'Dispatch status refreshed.',
          sendTitle: 'Send to watcher',
          sendHint: 'Send one message straight to the watcher session; this does not change automatic dispatch.',
          sendPlaceholder: 'e.g. handle the newest review request in the inbox, create the worktree and implement it.',
          send: 'Send',
          sending: 'Sending…',
          sendEmpty: 'Enter a message first.',
          sent: (sessionId) => `Sent to session ${sessionId}.`,
          sentGeneric: 'Sent to the watcher.',
          enabledBadge: 'Auto dispatch on',
        },
        auth: {
          title: 'GitHub account',
          signedIn: (login) => `Signed in: ${login}`,
          source: (source) => `Source: ${source}`,
          scopes: (scopes) => `Scopes: ${scopes}`,
          manage: 'Account',
          hide: 'Hide',
          start: 'Sign in with GitHub',
          retry: 'Try again',
          starting: 'Starting device flow…',
          codeLabel: 'Enter this code on the GitHub verification page:',
          verify: 'Open GitHub verification page',
          poll: 'I authorized, continue',
          polling: 'Waiting for authorization…',
          cancel: 'Cancel sign-in',
          canceling: 'Cancelling…',
          signOut: 'Sign out',
          signingOut: 'Signing out…',
          confirmSignOut: 'Sign out? The OAuth credential stored locally will be deleted.',
          success: (login) => `Signed in as ${login}.`,
          pendingHint: 'Open the verification page in your browser, enter the code above, then click “I authorized, continue”.',
          pendingRestored: 'An unfinished sign-in was found; you can continue it.',
          expiresAt: (time) => `Code valid until ${time}`,
          openFailed: 'Could not open the verification page; open it manually:',
          logoutDone: 'Signed out.',
          notSignedIn: 'No GitHub token is available, so polling, issues and private repositories are unavailable.',
          scopeNone: '(no scope information returned)',
          continueHint: 'After authorizing, click the button below; the Host polls GitHub and stores the token.',
        },
        time: {
          justNow: 'just now',
          secondsAgo: (n) => `${n}s ago`,
          minutesAgo: (n) => `${n}m ago`,
          hoursAgo: (n) => `${n}h ago`,
          daysAgo: (n) => `${n}d ago`,
          never: 'never',
        },
        dispatch: {
          title: 'Dispatch a task to the agent',
          hint: 'Sends the task to a new DSH session that automatically gets this plugin toolset and uses the plugin workspace as its directory. You can also assign work by typing in the main chat.',
          placeholder: 'e.g. Read the GitHub inbox, map the newest review request to a task, create a worktree, implement it, then rebase and merge with cleanup.',
          send: 'New session and dispatch',
          sending: 'Dispatching…',
          sessionHint: 'Ctrl/⌘+Enter sends; the panel switches to the new session automatically.',
          sent: 'Session created and task sent; switching to it now.',
          draftReady: 'Could not send automatically; the task was placed in the new session draft, press Send there.',
          empty: 'Enter a task description first.',
          unavailable: 'This Harness exposes no session service, so automatic dispatch is unavailable; paste the text into the main chat instead.',
          failed: 'Dispatch failed',
        },
        footer: {
          route: (route) => `API: ${route}`,
          generated: (time) => `Snapshot generated at ${time}`,
          hostOnly: 'Every GitHub and Git operation runs on the Host; the browser never calls GitHub directly.',
        },
      },
    };

    /** @param {string} localeId */
    function copyFor(localeId) {
      return localeId === 'en' ? COPY.en : COPY.zh;
    }

    /**
     * Resolve the active locale from the Harness locale service. Chinese is the
     * documented default when the service is absent or reports nothing usable.
     * @param {any} ctx
     * @returns {'zh'|'en'}
     */
    function readLocaleId(ctx) {
      try {
        const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null;
        const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null;
        const id = snapshot && typeof snapshot.active === 'string'
          ? snapshot.active
          : snapshot && typeof snapshot.id === 'string'
            ? snapshot.id
            : '';
        if (id.length > 0) return id.toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        /* fall through to the default */
      }
      return 'zh';
    }

    /** @param {any} ctx */
    function useLocaleId(ctx) {
      const [localeId, setLocaleId] = useState(() => readLocaleId(ctx));
      useEffect(() => {
        let locale;
        try {
          locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null;
        } catch {
          locale = null;
        }
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        const dispose = locale.subscribe(() => setLocaleId(readLocaleId(ctx)));
        return typeof dispose === 'function' ? dispose : undefined;
      }, [ctx]);
      return localeId;
    }

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------

    /** @param {unknown} value */
    function asText(value) {
      return typeof value === 'string' ? value.trim() : '';
    }

    /** @param {unknown} value */
    function asNumber(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return null;
    }

    /** @param {unknown} value */
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    /** @param {unknown} value */
    function asObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    /** @param {unknown} error */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error ?? 'unknown error');
    }

    /** @param {unknown} value @returns {string|null} */
    function safeUrl(value) {
      const text = asText(value);
      return /^https?:\/\//iu.test(text) ? text : null;
    }

    /** @param {string} value */
    function formatTimestamp(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      try {
        return date.toLocaleString();
      } catch {
        return date.toISOString();
      }
    }

    /** @param {unknown} value @param {any} t */
    function timeAgo(value, t) {
      if (!value) return t.time.never;
      const ms = Date.parse(String(value));
      if (!Number.isFinite(ms)) return t.time.never;
      const diff = Date.now() - ms;
      if (diff < 0) return formatTimestamp(value);
      const seconds = Math.floor(diff / 1000);
      if (seconds < 20) return t.time.justNow;
      if (seconds < 60) return t.time.secondsAgo(seconds);
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return t.time.minutesAgo(minutes);
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t.time.hoursAgo(hours);
      return t.time.daysAgo(Math.floor(hours / 24));
    }

    /** @param {string|number|null|undefined} value */
    function shortNumber(value) {
      if (value === null || value === undefined) return '';
      return `#${value}`;
    }

    /**
     * Build `?query` for the events endpoint; undefined values are omitted.
     * @param {URLSearchParams} params
     */
    function withQuery(path, params) {
      const text = params.toString();
      return text.length > 0 ? `${path}?${text}` : path;
    }

    /**
     * POST one whitelisted tool through the Host API and return its raw result.
     * @param {string} tool
     * @param {object} args
     */
    async function callTool(tool, args) {
      return requestJson('/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ tool, args }),
      });
    }

    /**
     * @param {string} path
     * @param {RequestInit} [init]
     */
    async function requestJson(path, init) {
      const response = await fetch(`${ROUTE}${path}`, {
        ...(init ?? {}),
        headers: { accept: 'application/json', ...((init && init.headers) ?? {}) },
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        throw new Error(payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
      }
      if (!payload || payload.ok !== true) {
        throw new Error(payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
      }
      return payload.data;
    }

    /**
     * Tool results use `{ok:false,error}` for expected failures. Turn those into
     * a display message without treating them as transport errors.
     * @param {unknown} result
     * @returns {string|null}
     */
    function toolFailure(result) {
      const data = asObject(result);
      if (data.ok === false) {
        return asText(data.error) || asText(data.hint) || 'tool failed';
      }
      return null;
    }

    /** @param {any} t @param {string} kind */
    function kindLabel(t, kind) {
      return (t.inbox.kinds && t.inbox.kinds[kind]) || kind;
    }

    /** @param {any} t @param {string} status */
    function statusLabel(t, status) {
      return (t.tasks.statusLabels && t.tasks.statusLabels[status]) || status;
    }

    /** @param {any} t @param {string} source */
    function sourceLabel(t, source) {
      return (t.source && t.source[source]) || source || t.source.none;
    }

    /** @param {string} repoName @param {any[]} repos */
    function repoOptions(snapshot, extraRepos) {
      const seen = new Set();
      const list = [];
      const push = (value) => {
        const text = asText(value);
        if (text.length === 0 || seen.has(text)) return;
        seen.add(text);
        list.push(text);
      };
      for (const entry of asArray(snapshot && snapshot.repos)) push(entry.repo);
      for (const entry of asArray(extraRepos)) push(entry);
      return list.sort((left, right) => left.localeCompare(right));
    }

    // ---------------------------------------------------------------------
    // Snapshot / payload normalization (tolerant to Host-side shape changes)
    // ---------------------------------------------------------------------

    /** @param {unknown} raw */
    function normalizeSnapshot(raw) {
      const root = asObject(raw);
      const config = asObject(root.config);
      const tokenRaw = asObject(root.token);
      const authRaw = asObject(root.auth);
      const pollerRaw = asObject(root.poller);
      const eventStats = asObject(root.eventStats);
      const taskStats = asObject(root.taskStats);

      const workspaceRoot = asText(root.workspaceRoot) || asText(config.workspaceRoot);
      const pollIntervalSec = asNumber(root.pollIntervalSec) ?? asNumber(config.pollIntervalSec) ?? 120;

      const authPendingRaw = asObject(authRaw.pending);
      const pending = Object.keys(authPendingRaw).length > 0
        ? {
            userCode: asText(authPendingRaw.userCode) || asText(authPendingRaw.user_code),
            verificationUri: asText(authPendingRaw.verificationUri) || asText(authPendingRaw.verification_uri),
            expiresAt: authPendingRaw.expiresAt ?? authPendingRaw.expires_at ?? null,
            intervalSec: asNumber(authPendingRaw.intervalSec) ?? asNumber(authPendingRaw.interval) ?? 5,
            scopes: authPendingRaw.scopes ?? null,
          }
        : null;

      const tokenScopes = Array.isArray(tokenRaw.scopes)
        ? tokenRaw.scopes.filter((entry) => typeof entry === 'string')
        : Array.isArray(authRaw.scopes)
          ? authRaw.scopes.filter((entry) => typeof entry === 'string')
          : [];

      const authenticated = authRaw.authenticated === true || tokenRaw.available === true;
      const login = asText(tokenRaw.login) || asText(authRaw.login) || null;
      const source = asText(tokenRaw.source) || asText(authRaw.source) || 'none';

      const repos = asArray(root.repos).map(normalizeRepo);

      return {
        generatedAt: asText(root.generatedAt) || null,
        workspaceRoot,
        workspaceExists: root.workspaceExists === true,
        stateDir: asText(root.stateDir) || asText(config.stateDir),
        pollIntervalSec,
        defaultBaseBranch: asText(root.defaultBaseBranch) || asText(config.defaultBaseBranch),
        branchPrefix: asText(root.branchPrefix) || asText(config.branchPrefix),
        remote: asText(root.remote) || asText(config.remote),
        gitBinary: asText(root.gitBinary) || asText(config.gitBinary),
        githubApiBase: asText(root.githubApiBase) || asText(config.githubApiBase),
        token: {
          available: authenticated,
          source,
          login,
          scopes: tokenScopes,
        },
        auth: {
          authenticated,
          source,
          login,
          scopes: tokenScopes,
          clientId: asText(authRaw.clientId),
          clientIdSource: asText(authRaw.clientIdSource),
          pending,
        },
        eventStats: {
          unread: asNumber(eventStats.unread) ?? 0,
          total: asNumber(eventStats.total) ?? 0,
          byKind: asObject(eventStats.byKind),
          byRepo: asObject(eventStats.byRepo),
          lastEventAt: eventStats.lastEventAt ?? null,
        },
        taskStats: {
          total: asNumber(taskStats.total) ?? 0,
          openTasks: asNumber(taskStats.openTasks) ?? 0,
          active: asNumber(taskStats.active) ?? 0,
          byStatus: asObject(taskStats.byStatus),
          byRepo: asObject(taskStats.byRepo),
        },
        poller: {
          running: pollerRaw.running === true,
          intervalSec: asNumber(pollerRaw.intervalSec) ?? pollIntervalSec,
          lastPollAt: pollerRaw.lastPollAt ?? null,
          watermarks: asObject(pollerRaw.watermarks),
        },
        repos,
        worktreeCount: countWorktrees(root.worktrees),
        dispatch: normalizeDispatch(root.dispatch ?? root.dispatcher, root, config),
      };
    }

    /** @param {unknown} entry */
    function normalizeRepo(entry) {
      const raw = asObject(entry);
      const aheadBehind = asObject(raw.aheadBehind);
      return {
        repo: asText(raw.repo) || asText(raw.name) || asText(raw.local),
        local: asText(raw.local),
        dir: asText(raw.dir) || asText(raw.path),
        baseBranch: asText(raw.baseBranch),
        cloned: raw.cloned === true,
        currentBranch: asText(raw.currentBranch) || null,
        dirty: raw.dirty === true,
        aheadBehind: Object.keys(aheadBehind).length > 0
          ? { ahead: asNumber(aheadBehind.ahead), behind: asNumber(aheadBehind.behind) }
          : null,
        worktrees: asNumber(raw.worktrees),
        activeTasks: asNumber(raw.activeTasks),
        lastPollAt: raw.lastPollAt ?? null,
        error: asText(raw.error) || null,
      };
    }

    /** @param {unknown} rawWorktrees @returns {number|null} */
    function countWorktrees(rawWorktrees) {
      let groups = null;
      if (Array.isArray(rawWorktrees)) {
        groups = rawWorktrees;
      } else {
        const object = asObject(rawWorktrees);
        if (Array.isArray(object.repos)) groups = object.repos;
      }
      if (!groups) return null;
      let count = 0;
      let found = false;
      for (const entry of groups) {
        const group = asObject(entry);
        if (Array.isArray(group.worktrees)) {
          count += group.worktrees.length;
          found = true;
        } else if (asText(group.path).length > 0) {
          count += 1;
          found = true;
        }
      }
      return found ? count : 0;
    }

    /** @param {unknown} data */
    function normalizeEvents(data) {
      const raw = asObject(data);
      const list = Array.isArray(raw.events) ? raw.events : Array.isArray(data) ? data : [];
      const events = list.map(normalizeEvent);
      return {
        events,
        count: asNumber(raw.count) ?? events.length,
        stats: asObject(raw.stats),
      };
    }

    /** @param {unknown} entry */
    function normalizeEvent(entry) {
      const raw = asObject(entry);
      return {
        id: asText(raw.id),
        repo: asText(raw.repo),
        kind: asText(raw.kind),
        action: asText(raw.action),
        number: asNumber(raw.number),
        title: asText(raw.title) || asText(raw.summary) || asText(raw.action),
        url: safeUrl(raw.url),
        actor: asText(raw.actor),
        at: raw.at ?? null,
        summary: asText(raw.summary),
        branch: asText(raw.branch),
        sha: asText(raw.sha),
        taskId: asText(raw.taskId) || null,
        read: raw.read === true,
      };
    }

    /** @param {unknown} data */
    function normalizeTasks(data) {
      const raw = asObject(data);
      const list = Array.isArray(raw.tasks) ? raw.tasks : Array.isArray(data) ? data : [];
      const tasks = list.map((entry) => {
        const task = asObject(entry);
        const taskWorktree = asObject(task.task);
        return {
          id: asText(task.id),
          title: asText(task.title),
          description: asText(task.description),
          repo: asText(task.repo),
          status: asText(task.status) || 'backlog',
          priority: asText(task.priority) || 'normal',
          branch: asText(task.branch),
          baseBranch: asText(task.baseBranch),
          worktreePath: asText(task.worktreePath),
          issueNumber: asNumber(task.issueNumber),
          issueUrl: safeUrl(task.issueUrl),
          prNumber: asNumber(task.prNumber),
          updatedAt: task.updatedAt ?? null,
          notes: asArray(task.notes),
          task: taskWorktree,
        };
      });
      return {
        tasks,
        count: asNumber(raw.count) ?? tasks.length,
        stats: asObject(raw.stats),
      };
    }

    /** @param {unknown} data */
    function normalizeWorktrees(data) {
      const raw = asObject(data);
      const groups = Array.isArray(raw.repos) ? raw.repos : Array.isArray(data) ? [{ worktrees: data }] : [];
      const rows = [];
      for (const entry of groups) {
        const group = asObject(entry);
        const repo = asText(group.repo);
        const dir = asText(group.dir);
        const groupError = asText(group.error) || null;
        for (const worktreeRaw of asArray(group.worktrees)) {
          const worktree = asObject(worktreeRaw);
          const linkedTask = asObject(worktree.task);
          rows.push({
            repo,
            dir,
            groupError,
            path: asText(worktree.path),
            branch: asText(worktree.branch) || null,
            head: asText(worktree.head) || null,
            dirty: worktree.dirty === true,
            locked: worktree.locked === true,
            prunable: worktree.prunable === true,
            detached: worktree.detached === true,
            taskId: asText(worktree.taskId) || asText(linkedTask.id) || null,
            task: linkedTask && asText(linkedTask.id)
              ? { id: asText(linkedTask.id), title: asText(linkedTask.title), status: asText(linkedTask.status) }
              : null,
          });
        }
      }
      return { rows, repos: groups.length };
    }

    /**
     * Normalize a `github_issues action=list` payload. The Host returns
     * `{ok, repo, kind, state, count, items}`; older/tolerant shapes are
     * accepted as well so a Host refactor cannot blank the tab.
     * @param {unknown} data
     */
    function normalizeIssues(data) {
      const raw = asObject(data);
      let list = [];
      for (const key of ['items', 'issues', 'pulls', 'workItems']) {
        if (Array.isArray(raw[key])) {
          list = raw[key];
          break;
        }
      }
      if (list.length === 0 && Array.isArray(raw.data)) list = raw.data;
      if (list.length === 0 && Array.isArray(data)) list = data;
      const items = list.map(normalizeIssueItem);
      return {
        repo: asText(raw.repo),
        kind: asText(raw.kind),
        state: asText(raw.state),
        items,
        count: asNumber(raw.count) ?? items.length,
      };
    }

    /** @param {unknown} entry */
    function normalizeIssueItem(entry) {
      const raw = asObject(entry);
      const stateText = asText(raw.state).toLowerCase();
      const merged = raw.merged === true || stateText === 'merged' || raw.mergedAt !== undefined || raw.merged_at !== undefined;
      const isPull = raw.isPull === true || asText(raw.kind).toLowerCase() === 'pr' || (raw.pull_request !== undefined && raw.pull_request !== null);
      const labels = asArray(raw.labels)
        .map((label) => (typeof label === 'string' ? label.trim() : asText(asObject(label).name)))
        .filter((label) => label.length > 0);
      const assignees = asArray(raw.assignees)
        .map((entryValue) => (typeof entryValue === 'string' ? entryValue.trim() : asText(asObject(entryValue).login)))
        .filter((assignee) => assignee.length > 0);
      return {
        kind: isPull ? 'pr' : 'issue',
        repo: asText(raw.repo),
        number: asNumber(raw.number),
        title: asText(raw.title),
        state: merged ? 'merged' : stateText || 'open',
        url: safeUrl(raw.url),
        author: asText(raw.author) || asText(asObject(raw.user).login),
        labels,
        assignees,
        comments: asNumber(raw.comments) ?? 0,
        createdAt: raw.createdAt ?? raw.created_at ?? null,
        updatedAt: raw.updatedAt ?? raw.updated_at ?? null,
        draft: raw.draft === true,
        merged,
        mergedAt: raw.mergedAt ?? raw.merged_at ?? null,
        headRef: asText(raw.headRef) || asText(asObject(raw.head).ref),
        baseRef: asText(raw.baseRef) || asText(asObject(raw.base).ref),
        body: asText(raw.body),
      };
    }

    /**
     * Normalize the always-on dispatcher status. `snapshot.dispatch` is the
     * authoritative source; `snapshot.autoDispatch` (and a `config.autoDispatch`
     * block) may carry the persisted settings that the status object omits.
     * @param {unknown} raw
     * @param {unknown} root
     * @param {unknown} config
     */
    function normalizeDispatch(raw, root, config) {
      const source = asObject(raw);
      const rootObject = asObject(root);
      const auto = asObject(rootObject.autoDispatch);
      const configAuto = asObject(asObject(config).autoDispatch);
      const first = (...values) => {
        for (const value of values) {
          if (value !== undefined && value !== null) return value;
        }
        return undefined;
      };
      const kindsSource = first(
        source.kinds,
        source.autoDispatchKinds,
        auto.kinds,
        rootObject.autoDispatchKinds,
        configAuto.kinds,
      );
      const kinds = Array.isArray(kindsSource)
        ? kindsSource.map((kind) => asText(kind)).filter((kind) => kind.length > 0)
        : [];
      const rootAutoBoolean = typeof rootObject.autoDispatch === 'boolean' ? rootObject.autoDispatch : undefined;
      const enabled = first(source.enabled, auto.enabled, rootAutoBoolean, configAuto.enabled) === true;
      const minIntervalSec = asNumber(first(
        source.minIntervalSec,
        source.autoDispatchMinIntervalSec,
        auto.minIntervalSec,
        rootObject.autoDispatchMinIntervalSec,
        configAuto.minIntervalSec,
      ));
      return {
        enabled,
        sessionId: asText(source.sessionId) || asText(auto.sessionId) || null,
        lastDispatchAt: source.lastDispatchAt ?? null,
        count: asNumber(source.count) ?? 0,
        lastError: asText(source.lastError) || null,
        lastEventAt: source.lastEventAt ?? null,
        seen: asNumber(source.seen) ?? 0,
        skipped: asNumber(source.skipped) ?? 0,
        kinds,
        minIntervalSec,
      };
    }

    /**
     * Read a pending device-flow code from a tool result.
     * @param {unknown} data
     */
    function normalizeDevice(data) {
      const raw = asObject(data);
      const nested = asObject(raw.device);
      const pickText = (...values) => {
        for (const value of values) {
          const text = asText(value);
          if (text.length > 0) return text;
        }
        return '';
      };
      const pickNumber = (...values) => {
        for (const value of values) {
          const parsed = asNumber(value);
          if (parsed !== null) return parsed;
        }
        return null;
      };
      return {
        userCode: pickText(raw.userCode, raw.user_code, nested.userCode, nested.user_code),
        verificationUri: pickText(raw.verificationUri, raw.verification_uri, nested.verificationUri, nested.verification_uri),
        expiresIn: pickNumber(raw.expiresIn, raw.expires_in, nested.expiresIn) ?? 900,
        intervalSec: pickNumber(raw.intervalSec, raw.interval, nested.intervalSec) ?? 5,
        scopes: pickText(raw.scopes, nested.scopes),
      };
    }

    // ---------------------------------------------------------------------
    // Styles (theme tokens only; every class is prefixed `go-`)
    // ---------------------------------------------------------------------

    const CSS = [
      '.go-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.45;font-family:inherit}',
      '.go-head{flex:none;padding:18px 24px 0}',
      '.go-headrow{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}',
      '.go-title{font-size:20px;font-weight:650;margin:0;letter-spacing:.1px}',
      '.go-tagline{margin:4px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:820px}',
      '.go-headactions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.go-statusbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.go-statusbar code{background:var(--dsw-alias-bg-layer-2);padding:2px 6px;border-radius:6px;font-size:11.5px;overflow-wrap:anywhere}',
      '.go-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block;flex:none}',
      '.go-dot-idle{background:var(--dsw-alias-state-idle-primary)}',
      '.go-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}',
      '.go-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.go-btn:disabled{opacity:.55;cursor:default}',
      '.go-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.go-btn-quiet{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 8px}',
      '.go-btn-quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.go-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.go-chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}',
      '.go-chip-success{color:var(--dsw-alias-state-success-primary)}',
      '.go-chip-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.go-chip-error{color:var(--dsw-alias-state-error-primary)}',
      '.go-chip-brand{color:var(--dsw-alias-brand-primary)}',
      '.go-chip-button{border:0;cursor:pointer;font:inherit;font-size:11px;height:20px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.go-chip-button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-border-l1)}',
      '.go-tabs{flex:none;display:flex;gap:2px;padding:12px 24px 0;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}',
      '.go-tab{position:relative;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13.5px;padding:8px 12px 11px;cursor:pointer;white-space:nowrap;border-radius:8px 8px 0 0}',
      '.go-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}',
      '.go-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.go-tab[aria-selected="true"]::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;background:var(--dsw-alias-brand-primary);border-radius:2px}',
      '.go-tabcount{margin-left:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:400;font-variant-numeric:tabular-nums}',
      '.go-body{flex:1;min-height:0;overflow:auto;padding:16px 24px 40px}',
      '.go-section{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;margin-bottom:14px;min-width:0}',
      '.go-section-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
      '.go-section-title{font-size:14px;font-weight:600;margin:0}',
      '.go-section-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.go-auth{border:1px solid var(--dsw-alias-brand-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;margin:14px 24px 0;flex:none}',
      '.go-auth-row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}',
      '.go-auth-main{flex:1;min-width:240px}',
      '.go-auth-title{font-size:14px;font-weight:600;margin:0 0 2px}',
      '.go-auth-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.go-auth-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.go-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:22px;font-weight:700;letter-spacing:.18em;padding:8px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);user-select:all;display:inline-block;margin:6px 0}',
      '.go-inline-note{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.go-inline-error{font-size:12.5px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.go-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
      '.go-field{display:inline-flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.go-field>input,.go-field>select{height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 10px;outline:none;min-width:160px}',
      '.go-field>input:focus,.go-field>select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.go-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}',
      '.go-check input{accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px;margin:0}',
      '.go-count{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.go-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}',
      '.go-row{display:flex;align-items:flex-start;gap:10px;padding:9px 8px;border-radius:9px;min-width:0}',
      '.go-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.go-row-main{flex:1;min-width:0}',
      '.go-row-title{display:block;font-size:13.5px;overflow-wrap:anywhere}',
      '.go-row-sub{display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;min-width:0}',
      '.go-row-sub code{background:var(--dsw-alias-bg-layer-2);padding:1px 5px;border-radius:5px;font-size:11px;overflow-wrap:anywhere}',
      '.go-row-actions{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap}',
      '.go-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--dsw-alias-brand-primary);font-weight:600;flex:none}',
      '.go-link{color:var(--dsw-alias-brand-primary);text-decoration:none;overflow-wrap:anywhere}',
      '.go-link:hover{text-decoration:underline}',
      '.go-empty{padding:32px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.go-loading{padding:36px 12px;color:var(--dsw-alias-label-secondary);font-size:13px;display:flex;align-items:center;gap:10px;justify-content:center}',
      '.go-spinner{width:15px;height:15px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:go-spin .9s linear infinite;flex:none}',
      '@keyframes go-spin{to{transform:rotate(360deg)}}',
      '.go-banner{margin:14px 24px 0;padding:10px 14px;border-radius:10px;font-size:12.5px;display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}',
      '.go-banner-error{border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.go-banner-text{flex:1;min-width:200px;overflow-wrap:anywhere}',
      '.go-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px;margin-top:6px}',
      '.go-settings-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}',
      '.go-settings-row .go-field{flex:1;min-width:220px}',
      '.go-info{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 18px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.go-info b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.go-info code{background:var(--dsw-alias-bg-layer-2);padding:1px 5px;border-radius:5px;font-size:11.5px;overflow-wrap:anywhere}',
      '.go-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:9px 16px;font-size:13px;z-index:60;max-width:min(760px,90vw);overflow-wrap:anywhere}',
      '.go-dispatch{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;margin:12px 24px 0;display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;flex:none}',
      '.go-dispatch-main{flex:1;min-width:260px}',
      '.go-dispatch-input{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.45;padding:8px 10px;outline:none;margin-top:6px}',
      '.go-dispatch-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.go-dispatch-actions{display:flex;flex-direction:column;gap:6px;align-items:flex-start;flex:none}',
      '.go-chips{display:flex;gap:4px;flex-wrap:wrap;min-width:0}',
      '.go-checkrow{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:6px}',
      '.go-statusline{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.go-watcher{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}',
      '.go-watcher code{background:var(--dsw-alias-bg-layer-2);padding:1px 6px;border-radius:5px;font-size:11.5px;overflow-wrap:anywhere}',
      '.go-footer{flex:none;padding:10px 24px 14px;font-size:11.5px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);display:flex;gap:16px;flex-wrap:wrap}',
      '.go-footer code{background:var(--dsw-alias-bg-layer-2);padding:1px 5px;border-radius:5px;font-size:11px;overflow-wrap:anywhere}',
      '@media (max-width:860px){.go-head,.go-tabs,.go-body{padding-left:14px;padding-right:14px}.go-auth{margin-left:14px;margin-right:14px}.go-dispatch{margin-left:14px;margin-right:14px}.go-banner{margin-left:14px;margin-right:14px}}',
    ].join('\n');

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------

    /** @param {(size?: number) => any} child */
    function icon(size, child) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        child,
      );
    }

    const IconRefresh = (size = 16) => icon(size, h('path', { d: 'M20 11a8 8 0 1 0-.8 4.4M20 4.8V11h-6.2' }));
    const IconPoll = (size = 16) =>
      icon(size, [h('path', { key: 'a', d: 'M13 3.8 5.4 13h5l-1 7.2 7.6-9.2h-5l1-7.2Z' })]);
    const IconCopy = (size = 15) =>
      icon(size, [
        h('rect', { key: 'a', x: 8.5, y: 8.5, width: 10.5, height: 10.5, rx: 2 }),
        h('path', { key: 'b', d: 'M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5' }),
      ]);
    const IconExternal = (size = 15) =>
      icon(size, [
        h('path', { key: 'a', d: 'M14 4.8h5.2V10' }),
        h('path', { key: 'b', d: 'M19.2 4.8 11 13' }),
        h('path', { key: 'c', d: 'M9.2 6H6.4A1.6 1.6 0 0 0 4.8 7.6v10a1.6 1.6 0 0 0 1.6 1.6h10a1.6 1.6 0 0 0 1.6-1.6v-2.8' }),
      ]);
    const IconCheck = (size = 14) => icon(size, h('path', { d: 'm4.6 12.4 4.6 4.6L19.4 6.8' }));
    const IconSignOut = (size = 15) =>
      icon(size, [
        h('path', { key: 'a', d: 'M14.5 4.8h2.7a1.8 1.8 0 0 1 1.8 1.8v10.8a1.8 1.8 0 0 1-1.8 1.8h-2.7' }),
        h('path', { key: 'b', d: 'M10 8.2 6 12l4 3.8' }),
        h('path', { key: 'c', d: 'M6 12h9.2' }),
      ]);
    const IconTrash = (size = 14) =>
      icon(size, [
        h('path', { key: 'a', d: 'M4.8 7.2h14.4' }),
        h('path', { key: 'b', d: 'M9.2 7.2V5.4a1.2 1.2 0 0 1 1.2-1.2h3.2a1.2 1.2 0 0 1 1.2 1.2v1.8' }),
        h('path', { key: 'c', d: 'M6.4 7.2 7.3 19a1.4 1.4 0 0 0 1.4 1.3h6.6a1.4 1.4 0 0 0 1.4-1.3l.9-11.8' }),
      ]);

    /** @param {{ size?: number, active?: boolean }} props */
    function SidebarIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20;
      const active = props.active === true;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)' },
        },
        h('circle', { cx: 6.2, cy: 6.2, r: 2.1, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 6.2, cy: 17.8, r: 2.1, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 17.8, cy: 12, r: 2.1, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M8.3 7.2 15.7 11M8.3 16.8 15.7 13', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      );
    }

    // ---------------------------------------------------------------------
    // Presentational helpers (pure; no hooks)
    // ---------------------------------------------------------------------

    /** @param {{ tone?: string, children?: any }} props */
    function Chip(props) {
      return h('span', { className: props.tone ? `go-chip go-chip-${props.tone}` : 'go-chip' }, props.children);
    }

    /** @param {{ label: string, onClick: () => void, disabled?: boolean, primary?: boolean, danger?: boolean, quiet?: boolean, icon?: any, title?: string }} props */
    function Button(props) {
      const classes = ['go-btn'];
      if (props.primary) classes.push('go-btn-primary');
      if (props.danger) classes.push('go-btn-danger');
      if (props.quiet) classes.push('go-btn-quiet');
      return h(
        'button',
        {
          type: 'button',
          className: classes.join(' '),
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title,
        },
        props.icon ?? null,
        h('span', null, props.label),
      );
    }

    /** @param {{ label: string, value: string|number, onChange: (value: string) => void, options: Array<{value: string, label: string}>, disabled?: boolean }} props */
    function SelectField(props) {
      return h(
        'label',
        { className: 'go-field' },
        h('span', null, props.label),
        h(
          'select',
          {
            value: String(props.value),
            onChange: (event) => props.onChange(event.target.value),
            disabled: props.disabled === true,
          },
          asArray(props.options).map((option) =>
            h('option', { key: option.value, value: option.value }, option.label),
          ),
        ),
      );
    }

    /** @param {{ label: string, value: string, onChange: (value: string) => void, type?: string, min?: number, max?: number, placeholder?: string, disabled?: boolean }} props */
    function InputField(props) {
      return h(
        'label',
        { className: 'go-field' },
        h('span', null, props.label),
        h('input', {
          type: props.type ?? 'text',
          value: props.value,
          min: props.min,
          max: props.max,
          placeholder: props.placeholder,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
        }),
      );
    }

    /** @param {{ t: any, children?: any }} props */
    function Section(props) {
      return h(
        'section',
        { className: 'go-section' },
        props.children,
      );
    }

    /** @param {{ title: string, hint?: string, children?: any }} props */
    function SectionHead(props) {
      return h(
        'div',
        { className: 'go-section-head' },
        h('h3', { className: 'go-section-title' }, props.title),
        props.hint ? h('span', { className: 'go-section-hint' }, props.hint) : null,
      );
    }

    /** @param {{ t: any, text?: string }} props */
    function Loading(props) {
      return h(
        'div',
        { className: 'go-loading', role: 'status' },
        h('span', { className: 'go-spinner', 'aria-hidden': true }),
        h('span', null, props.text || props.t.common.loading),
      );
    }

    /** @param {{ text: string }} props */
    function Empty(props) {
      return h('div', { className: 'go-empty' }, props.text);
    }

    /** @param {{ message: string, onRetry?: () => void, retryLabel: string }} props */
    function ErrorNote(props) {
      return h(
        'div',
        { className: 'go-banner go-banner-error', role: 'alert' },
        h('span', { className: 'go-banner-text' }, props.message),
        props.onRetry ? h(Button, { label: props.retryLabel, onClick: props.onRetry }) : null,
      );
    }

    /**
     * Copy text and return whether it worked (clipboard may be unavailable).
     * @param {string} text
     */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* clipboard permission denied or unavailable */
      }
      return false;
    }

    /** @param {string} url */
    function openExternal(url) {
      try {
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(url, '_blank', 'noopener,noreferrer');
          return true;
        }
      } catch {
        /* popup blocked */
      }
      return false;
    }

    // ---------------------------------------------------------------------
    // Panel component
    // ---------------------------------------------------------------------

    /**
     * @param {{ ctx: any, t: any, slotProps?: any }} props
     */
    function OrchestratorPanel(props) {
      const t = props.t;
      const ctx = props.ctx;

      const [snapshot, setSnapshot] = useState(null);
      const [snapshotError, setSnapshotError] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const [lastRefreshAt, setLastRefreshAt] = useState(null);
      const [tab, setTab] = useState('inbox');
      const [busy, setBusy] = useState('');
      const [toast, setToast] = useState(null);

      const [eventsState, setEventsState] = useState({ status: 'idle', data: null, error: null });
      const [tasksState, setTasksState] = useState({ status: 'idle', data: null, error: null });
      const [worktreesState, setWorktreesState] = useState({ status: 'idle', data: null, error: null });
      const [issuesState, setIssuesState] = useState({ status: 'idle', data: null, error: null });

      const [inboxFilter, setInboxFilter] = useState({ unreadOnly: true, limit: 50, repo: '' });
      const [issuesFilter, setIssuesFilter] = useState({ kind: 'all', state: 'open', repo: '', limit: 30 });
      const [taskFilter, setTaskFilter] = useState({ status: 'open', repo: '' });
      const [settingsDraft, setSettingsDraft] = useState({ workspaceRoot: '', pollIntervalSec: 120 });
      const [settingsDirty, setSettingsDirty] = useState(false);

      const [automationDraft, setAutomationDraft] = useState({
        enabled: false,
        kinds: DEFAULT_AUTO_DISPATCH_KINDS.slice(),
        minIntervalSec: 120,
      });
      const [automationDirty, setAutomationDirty] = useState(false);
      const [automationError, setAutomationError] = useState(null);
      const [watcherDraft, setWatcherDraft] = useState('');
      const [dispatchOverride, setDispatchOverride] = useState(null);

      const [authOpen, setAuthOpen] = useState(false);
      const [authPhase, setAuthPhase] = useState('idle'); // idle | starting | pending | polling | done | error
      const [authDevice, setAuthDevice] = useState(null);
      const [authMessage, setAuthMessage] = useState(null);
      const [authError, setAuthError] = useState(null);
      const [logoutConfirm, setLogoutConfirm] = useState(false);

      const [removeTarget, setRemoveTarget] = useState(null);
      const [closeTarget, setCloseTarget] = useState(null);

      const [dispatchDraft, setDispatchDraft] = useState('');
      const [dispatchError, setDispatchError] = useState(null);

      const toastTimer = useRef(null);
      const requestSeq = useRef(0);
      const tabRef = useRef(tab);
      const inboxFilterRef = useRef(inboxFilter);
      const issuesFilterRef = useRef(issuesFilter);
      const repoDefaultRef = useRef('');
      const settingsDirtyRef = useRef(settingsDirty);
      const automationDirtyRef = useRef(automationDirty);

      useEffect(() => {
        tabRef.current = tab;
      }, [tab]);
      useEffect(() => {
        inboxFilterRef.current = inboxFilter;
      }, [inboxFilter]);
      useEffect(() => {
        issuesFilterRef.current = issuesFilter;
      }, [issuesFilter]);
      useEffect(() => {
        repoDefaultRef.current = snapshot && snapshot.repos.length > 0 ? snapshot.repos[0].repo : '';
      }, [snapshot]);
      useEffect(() => {
        settingsDirtyRef.current = settingsDirty;
      }, [settingsDirty]);
      useEffect(() => {
        automationDirtyRef.current = automationDirty;
      }, [automationDirty]);

      const showToast = useCallback((message) => {
        if (!message) return;
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast(String(message));
        toastTimer.current = setTimeout(() => setToast(null), 5200);
      }, []);

      useEffect(
        () => () => {
          if (toastTimer.current) clearTimeout(toastTimer.current);
        },
        [],
      );

      const isBusy = useCallback((key) => busy === key, [busy]);

      // --- data loading ---------------------------------------------------

      const loadSnapshot = useCallback(async () => {
        const seq = requestSeq.current + 1;
        requestSeq.current = seq;
        try {
          const data = await requestJson('/status');
          if (seq !== requestSeq.current) return;
          const normalized = normalizeSnapshot(data);
          setSnapshot(normalized);
          setSnapshotError(null);
          setDispatchOverride(null);
          if (!settingsDirtyRef.current) {
            setSettingsDraft({
              workspaceRoot: normalized.workspaceRoot,
              pollIntervalSec: normalized.pollIntervalSec,
            });
          }
        } catch (error) {
          if (seq !== requestSeq.current) return;
          setSnapshotError(messageOf(error));
        }
      }, []);

      const loadEvents = useCallback(async (filter) => {
        setEventsState((previous) => ({ ...previous, status: previous.data ? previous.status : 'loading', error: null }));
        try {
          const params = new URLSearchParams();
          if (filter.unreadOnly) params.set('unread', '1');
          params.set('limit', String(filter.limit));
          if (filter.repo) params.set('repo', filter.repo);
          const data = await requestJson(`/events${params.toString() ? `?${params.toString()}` : ''}`);
          setEventsState({ status: 'ready', data: normalizeEvents(data), error: null });
        } catch (error) {
          setEventsState((previous) => ({
            ...previous,
            status: previous.data ? 'ready' : 'error',
            error: messageOf(error),
          }));
        }
      }, []);

      const loadTasks = useCallback(async () => {
        setTasksState((previous) => ({ ...previous, status: previous.data ? previous.status : 'loading', error: null }));
        try {
          const data = await requestJson('/tasks');
          setTasksState({ status: 'ready', data: normalizeTasks(data), error: null });
        } catch (error) {
          setTasksState((previous) => ({
            ...previous,
            status: previous.data ? 'ready' : 'error',
            error: messageOf(error),
          }));
        }
      }, []);

      const loadWorktrees = useCallback(async () => {
        setWorktreesState((previous) => ({ ...previous, status: previous.data ? previous.status : 'loading', error: null }));
        try {
          const data = await requestJson('/worktrees');
          setWorktreesState({ status: 'ready', data: normalizeWorktrees(data), error: null });
        } catch (error) {
          setWorktreesState((previous) => ({
            ...previous,
            status: previous.data ? 'ready' : 'error',
            error: messageOf(error),
          }));
        }
      }, []);

      const loadIssues = useCallback(async (filter) => {
        setIssuesState((previous) => ({ ...previous, status: previous.data ? previous.status : 'loading', error: null }));
        try {
          const repo = asText(filter.repo) || repoDefaultRef.current;
          const args = {
            action: 'list',
            kind: filter.kind,
            state: filter.state,
            limit: Number(filter.limit),
          };
          if (repo) args.repo = repo;
          const data = await callTool('github_issues', args);
          const failure = toolFailure(data);
          if (failure) throw new Error(failure);
          const normalized = normalizeIssues(data);
          if (!normalized.repo && repo) normalized.repo = repo;
          setIssuesState({ status: 'ready', data: normalized, error: null });
        } catch (error) {
          setIssuesState((previous) => ({
            ...previous,
            status: previous.data ? 'ready' : 'error',
            error: messageOf(error),
          }));
        }
      }, []);

      const loadTab = useCallback(
        async (which) => {
          if (which === 'inbox') await loadEvents(inboxFilterRef.current);
          else if (which === 'issues') await loadIssues(issuesFilterRef.current);
          else if (which === 'tasks') await loadTasks();
          else if (which === 'worktrees') await loadWorktrees();
        },
        [loadEvents, loadIssues, loadTasks, loadWorktrees],
      );

      const refreshAll = useCallback(
        async (manual) => {
          if (manual) setRefreshing(true);
          try {
            await loadSnapshot();
            await loadTab(tabRef.current);
            if (manual) setLastRefreshAt(Date.now());
          } finally {
            if (manual) setRefreshing(false);
          }
        },
        [loadSnapshot, loadTab],
      );

      useEffect(() => {
        void loadSnapshot();
      }, [loadSnapshot]);

      useEffect(() => {
        if (tab === 'settings' || tab === 'repos' || tab === 'automation') return undefined;
        void loadTab(tab);
        return undefined;
      }, [tab, loadTab]);

      useEffect(() => {
        void loadEvents(inboxFilter);
      }, [inboxFilter, loadEvents]);

      // Issues filters refetch only while the Issues/PRs tab is visible; the tab
      // switch itself triggers the first load through loadTab.
      useEffect(() => {
        if (tabRef.current !== 'issues') return;
        void loadIssues(issuesFilter);
      }, [issuesFilter, loadIssues]);

      // Keep the automation form in sync with the Host settings until the user
      // starts editing it.
      useEffect(() => {
        if (!snapshot || automationDirtyRef.current) return;
        const dispatch = snapshot.dispatch || DEFAULT_DISPATCH;
        setAutomationDraft((previous) => ({
          enabled: dispatch.enabled,
          kinds: dispatch.kinds.length > 0 ? dispatch.kinds : previous.kinds,
          minIntervalSec: dispatch.minIntervalSec ?? previous.minIntervalSec,
        }));
      }, [snapshot]);

      useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          void refreshAll(false);
        }, REFRESH_MS);
        return () => clearInterval(timer);
      }, [refreshAll]);

      // Restore a pending device flow after a page reload.
      useEffect(() => {
        if (!snapshot || !snapshot.auth.pending) return;
        if (authPhase !== 'idle') return;
        const pending = snapshot.auth.pending;
        setAuthDevice({
          userCode: pending.userCode,
          verificationUri: pending.verificationUri,
          expiresIn: 900,
          intervalSec: pending.intervalSec,
          scopes: typeof pending.scopes === 'string' ? pending.scopes : '',
          expiresAt: pending.expiresAt,
        });
        setAuthOpen(true);
        setAuthPhase('pending');
        setAuthMessage(t.auth.pendingRestored);
      }, [snapshot, authPhase, t]);

      // --- tool action runner ---------------------------------------------

      const runAction = useCallback(
        async (key, tool, args, onSuccess) => {
          setBusy(key);
          try {
            const data = await callTool(tool, args);
            const failure = toolFailure(data);
            if (failure) {
              showToast(failure);
              return null;
            }
            if (onSuccess) await onSuccess(data);
            return data;
          } catch (error) {
            showToast(messageOf(error));
            return null;
          } finally {
            setBusy('');
          }
        },
        [showToast],
      );

      // --- auth actions ---------------------------------------------------

      const startAuth = useCallback(async () => {
        setAuthOpen(true);
        setAuthPhase('starting');
        setAuthError(null);
        setAuthMessage(null);
        setAuthDevice(null);
        try {
          const data = await callTool('github_auth', { action: 'start' });
          const failure = toolFailure(data);
          if (failure) throw new Error(failure);
          const device = normalizeDevice(data);
          setAuthDevice(device);
          setAuthPhase('pending');
          setAuthMessage(null);
          void loadSnapshot();
        } catch (error) {
          setAuthPhase('error');
          setAuthError(messageOf(error));
        }
      }, [loadSnapshot]);

      const pollAuth = useCallback(async () => {
        setAuthPhase('polling');
        setAuthError(null);
        setAuthMessage(null);
        try {
          const data = await callTool('github_auth', { action: 'poll', timeoutSec: 120 });
          const failure = toolFailure(data);
          if (failure) {
            const result = asObject(data);
            if (result.pending === true) {
              setAuthPhase('pending');
              setAuthMessage(failure);
            } else {
              setAuthPhase('error');
              setAuthError(failure);
            }
            return;
          }
          const login = asText(asObject(data).login) || asText(asObject(asObject(data).user).login) || '';
          setAuthPhase('done');
          setAuthDevice(null);
          setAuthMessage(login ? t.auth.success(login) : t.auth.success(t.auth.title));
          showToast(login ? t.auth.success(login) : t.auth.success(t.auth.title));
          await loadSnapshot();
        } catch (error) {
          setAuthPhase('pending');
          setAuthError(messageOf(error));
        }
      }, [loadSnapshot, showToast, t]);

      const cancelAuth = useCallback(async () => {
        setAuthPhase('idle');
        setAuthDevice(null);
        setAuthError(null);
        setAuthMessage(null);
        try {
          await callTool('github_auth', { action: 'cancel' });
        } catch {
          /* cancelling a nonexistent flow is harmless */
        }
        void loadSnapshot();
      }, [loadSnapshot]);

      const logoutAuth = useCallback(async () => {
        setBusy('auth:logout');
        try {
          const data = await callTool('github_auth', { action: 'logout' });
          const failure = toolFailure(data);
          if (failure) throw new Error(failure);
          setLogoutConfirm(false);
          setAuthPhase('idle');
          setAuthDevice(null);
          setAuthMessage(null);
          setAuthError(null);
          showToast(t.auth.logoutDone);
          await loadSnapshot();
        } catch (error) {
          showToast(messageOf(error));
        } finally {
          setBusy('');
        }
      }, [loadSnapshot, showToast, t]);

      // --- other actions --------------------------------------------------

      const pollNow = useCallback(() => {
        void runAction('poll', 'github_events', { action: 'poll' }, async (data) => {
          const added = asNumber(asObject(data).added) ?? 0;
          showToast(t.inbox.polled(added));
          await refreshAll(false);
        });
      }, [runAction, showToast, t, refreshAll]);

      const markEventRead = useCallback(
        (event) => {
          void runAction(`mark:${event.id}`, 'github_events', { action: 'mark', ids: [event.id] }, async () => {
            await loadEvents(inboxFilterRef.current);
            await loadSnapshot();
          });
        },
        [runAction, loadEvents, loadSnapshot],
      );

      const markAllRead = useCallback(() => {
        const repo = inboxFilterRef.current.repo || undefined;
        void runAction('mark:all', 'github_events', { action: 'mark', all: true, ...(repo ? { repo } : {}) }, async (data) => {
          const marked = asNumber(asObject(data).marked) ?? 0;
          showToast(t.inbox.markAllDone(marked));
          await loadEvents(inboxFilterRef.current);
          await loadSnapshot();
        });
      }, [runAction, showToast, t, loadEvents, loadSnapshot]);

      const cloneRepo = useCallback(
        (repo) => {
          void runAction(`clone:${repo}`, 'github_repos', { action: 'clone', repo }, async () => {
            showToast(t.repos.clonedToast(repo));
            await refreshAll(false);
          });
        },
        [runAction, showToast, t, refreshAll],
      );

      const fetchRepo = useCallback(
        (repo) => {
          void runAction(`fetch:${repo}`, 'github_repos', { action: 'fetch', repo }, async () => {
            showToast(t.repos.fetchedToast(repo));
            await refreshAll(false);
          });
        },
        [runAction, showToast, t, refreshAll],
      );

      const syncTask = useCallback(
        (task) => {
          void runAction(`sync:${task.id}`, 'github_tasks', { action: 'sync', id: task.id }, async () => {
            showToast(t.tasks.synced);
            await loadTasks();
            await loadSnapshot();
          });
        },
        [runAction, showToast, t, loadTasks, loadSnapshot],
      );

      const closeTask = useCallback(
        (task) => {
          void runAction(`close:${task.id}`, 'github_tasks', { action: 'close', id: task.id }, async () => {
            setCloseTarget(null);
            showToast(t.tasks.closed);
            await loadTasks();
            await loadSnapshot();
          });
        },
        [runAction, showToast, t, loadTasks, loadSnapshot],
      );

      const removeWorktree = useCallback(
        (row) => {
          void runAction(
            `remove:${row.path}`,
            'git_worktree',
            { action: 'remove', ...(row.repo ? { repo: row.repo } : {}), path: row.path, force: row.dirty === true },
            async () => {
              setRemoveTarget(null);
              showToast(t.worktrees.removed);
              await loadWorktrees();
              await loadSnapshot();
            },
          );
        },
        [runAction, showToast, t, loadWorktrees, loadSnapshot],
      );

      const createTaskFromIssue = useCallback(
        (item) => {
          const repo =
            asText(item.repo) ||
            asText(issuesState.data && issuesState.data.repo) ||
            asText(issuesFilter.repo) ||
            repoDefaultRef.current;
          if (!repo) {
            showToast(t.issues.taskNeedsRepo);
            return;
          }
          const description = item.url
            ? `GitHub ${item.kind} #${item.number}: ${item.url}`
            : `GitHub ${item.kind} #${item.number}`;
          void runAction(
            `issue-task:${item.kind}:${item.number}`,
            'github_tasks',
            { action: 'create', repo, title: item.title || `#${item.number}`, description },
            async (data) => {
              const task = asObject(asObject(data).task);
              const id = asText(task.id) || asText(asObject(data).id);
              showToast(id ? t.issues.taskCreated(id) : t.issues.taskCreatedGeneric);
              await loadSnapshot();
            },
          );
        },
        [issuesState.data, issuesFilter.repo, runAction, showToast, t, loadSnapshot],
      );

      const saveWorkspace = useCallback(async () => {
        const workspaceRoot = asText(settingsDraft.workspaceRoot);
        if (workspaceRoot.length === 0) {
          showToast(t.settings.invalidWorkspace);
          return;
        }
        setBusy('settings:workspace');
        try {
          const data = await callTool('github_config', { action: 'set', workspaceRoot });
          const failure = toolFailure(data);
          if (failure) throw new Error(failure);
          setSettingsDirty(false);
          showToast(t.settings.saved);
          await loadSnapshot();
        } catch (error) {
          showToast(messageOf(error));
        } finally {
          setBusy('');
        }
      }, [settingsDraft.workspaceRoot, showToast, t, loadSnapshot]);

      const savePollInterval = useCallback(async () => {
        const interval = Number(settingsDraft.pollIntervalSec);
        if (!Number.isFinite(interval) || interval < 15 || interval > 3600) {
          showToast(t.settings.invalidInterval);
          return;
        }
        setBusy('settings:poll');
        try {
          const data = await callTool('github_config', { action: 'set', pollIntervalSec: Math.round(interval) });
          const failure = toolFailure(data);
          if (failure) throw new Error(failure);
          setSettingsDirty(false);
          showToast(t.settings.saved);
          await loadSnapshot();
        } catch (error) {
          showToast(messageOf(error));
        } finally {
          setBusy('');
        }
      }, [settingsDraft.pollIntervalSec, showToast, t, loadSnapshot]);

      // --- automation actions ---------------------------------------------

      const setAutoDispatchEnabled = useCallback((enabled) => {
        setAutomationDirty(true);
        setAutomationError(null);
        setAutomationDraft((previous) => ({ ...previous, enabled }));
      }, []);

      const setAutoDispatchKind = useCallback((kind, checked) => {
        setAutomationDirty(true);
        setAutomationError(null);
        setAutomationDraft((previous) => {
          const selected = new Set(previous.kinds);
          if (checked) selected.add(kind);
          else selected.delete(kind);
          return { ...previous, kinds: AUTO_DISPATCH_KINDS.filter((entry) => selected.has(entry)) };
        });
      }, []);

      const setMinInterval = useCallback((value) => {
        setAutomationDirty(true);
        setAutomationError(null);
        setAutomationDraft((previous) => ({ ...previous, minIntervalSec: value }));
      }, []);

      const saveAutomation = useCallback(async () => {
        const interval = Number(automationDraft.minIntervalSec);
        if (!Number.isFinite(interval) || interval < 30 || interval > 3600) {
          showToast(t.automation.invalidInterval);
          return;
        }
        setAutomationError(null);
        setBusy('automation:save');
        try {
          const data = await callTool('github_config', {
            action: 'set',
            autoDispatch: automationDraft.enabled === true,
            autoDispatchKinds: automationDraft.kinds.slice(),
            autoDispatchMinIntervalSec: Math.round(interval),
          });
          const failure = toolFailure(data);
          if (failure) throw new Error(failure);
          setAutomationDirty(false);
          showToast(t.automation.saved);
          setDispatchOverride(null);
          await loadSnapshot();
        } catch (error) {
          setAutomationError(messageOf(error));
          showToast(messageOf(error));
        } finally {
          setBusy('');
        }
      }, [automationDraft, showToast, t, loadSnapshot]);

      const runDispatchCheck = useCallback(() => {
        void runAction('dispatch:tick', 'github_dispatch', { action: 'tick' }, async (data) => {
          const result = asObject(data);
          if (result.dispatched === true) {
            const count = asArray(result.taskIds).length || asArray(result.eventIds).length || 0;
            showToast(count > 0 ? t.automation.checkDispatched(count) : t.automation.checkDispatchedGeneric);
          } else {
            const reason = asText(result.reason);
            const label = (t.automation.reasons && t.automation.reasons[reason]) || t.automation.checkUnknownReason;
            showToast(t.automation.checkIdle(label));
          }
          setDispatchOverride(null);
          await loadSnapshot();
        });
      }, [runAction, showToast, t, loadSnapshot]);

      const refreshDispatchStatus = useCallback(() => {
        void runAction('dispatch:status', 'github_dispatch', { action: 'status' }, async (data) => {
          await loadSnapshot();
          setDispatchOverride(normalizeDispatch(data));
          showToast(t.automation.statusRefreshed);
        });
      }, [runAction, showToast, t, loadSnapshot]);

      const sendToWatcher = useCallback(() => {
        const text = watcherDraft.trim();
        if (text.length === 0) {
          showToast(t.automation.sendEmpty);
          return;
        }
        void runAction('dispatch:send', 'github_dispatch', { action: 'send', text }, async (data) => {
          const sessionId = asText(asObject(data).sessionId);
          setWatcherDraft('');
          setDispatchOverride(null);
          showToast(sessionId ? t.automation.sent(sessionId) : t.automation.sentGeneric);
          await loadSnapshot();
        });
      }, [watcherDraft, runAction, showToast, t, loadSnapshot]);

      const openWatcherSession = useCallback(() => {
        const info = dispatchOverride || (snapshot ? snapshot.dispatch : DEFAULT_DISPATCH);
        const sessionId = info ? info.sessionId : null;
        if (!sessionId) {
          showToast(t.automation.noWatcherSession);
          return;
        }
        const services = props.services || {};
        const uiWorkspace = services.uiWorkspace;
        if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
          showToast(t.automation.watcherUnavailable);
          return;
        }
        try {
          uiWorkspace.openSession(sessionId);
        } catch (error) {
          showToast(messageOf(error));
        }
      }, [dispatchOverride, snapshot, props.services, showToast, t]);

      const copyDeviceCode = useCallback(async () => {
        const code = authDevice ? authDevice.userCode : '';
        if (!code) return;
        const copied = await copyText(code);
        showToast(copied ? t.common.copied : `${t.common.copyFailed}: ${code}`);
      }, [authDevice, showToast, t]);

      // --- derived data ---------------------------------------------------

      const reposForFilter = useMemo(() => {
        const extras = [];
        if (eventsState.data) extras.push(...eventsState.data.events.map((event) => event.repo));
        if (tasksState.data) extras.push(...tasksState.data.tasks.map((task) => task.repo));
        if (worktreesState.data) extras.push(...worktreesState.data.rows.map((row) => row.repo));
        return repoOptions(snapshot, extras);
      }, [snapshot, eventsState.data, tasksState.data, worktreesState.data]);

      const authenticated = snapshot ? snapshot.auth.authenticated : false;
      const tokenLogin = snapshot ? snapshot.auth.login : null;
      const tokenSource = snapshot ? snapshot.auth.source : 'none';
      const tokenScopes = snapshot ? snapshot.auth.scopes : [];
      const dispatchInfo = dispatchOverride || (snapshot ? snapshot.dispatch : DEFAULT_DISPATCH);
      const unreadCount = snapshot
        ? snapshot.eventStats.unread
        : eventsState.data
          ? asNumber(eventsState.data.stats.unread) ?? 0
          : 0;
      const openTaskCount = snapshot
        ? snapshot.taskStats.openTasks || snapshot.taskStats.active || 0
        : tasksState.data
          ? tasksState.data.tasks.filter((task) => task.status !== 'done').length
          : 0;
      const worktreeCount = worktreesState.data
        ? worktreesState.data.rows.length
        : snapshot && typeof snapshot.worktreeCount === 'number'
          ? snapshot.worktreeCount
          : null;

      const tabBadges = {
        inbox: unreadCount > 0 ? unreadCount : null,
        issues: issuesState.data && issuesState.data.items.length > 0 ? issuesState.data.items.length : null,
        tasks: openTaskCount > 0 ? openTaskCount : null,
        repos: snapshot && snapshot.repos.length > 0 ? snapshot.repos.length : null,
        worktrees: worktreeCount && worktreeCount > 0 ? worktreeCount : null,
        settings: null,
        automation: dispatchInfo && dispatchInfo.enabled ? '●' : null,
      };

      const inboxData = eventsState.data;
      const inboxEvents = inboxData ? inboxData.events : [];
      const issuesData = issuesState.data;
      const issueItems = issuesData ? issuesData.items : [];
      const autoDispatchEnabled = automationDraft.enabled === true;
      const tasksData = tasksState.data;
      const filteredTasks = useMemo(() => {
        const list = tasksData ? tasksData.tasks : [];
        return list.filter((task) => {
          if (taskFilter.repo && task.repo !== taskFilter.repo) return false;
          if (taskFilter.status === 'open') return task.status !== 'done';
          if (taskFilter.status === 'all') return true;
          return task.status === taskFilter.status;
        });
      }, [tasksData, taskFilter]);
      const worktreeRows = worktreesState.data ? worktreesState.data.rows : [];
      const repoRows = snapshot ? snapshot.repos : [];

      // --- rendering ------------------------------------------------------

      const header = h(
        'header',
        { className: 'go-head' },
        h(
          'div',
          { className: 'go-headrow' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h1', { className: 'go-title' }, t.title),
            h('p', { className: 'go-tagline' }, t.tagline),
          ),
          h(
            'div',
            { className: 'go-headactions' },
            h(Button, {
              label: isBusy('poll') ? t.polling : t.pollNow,
              icon: IconPoll(15),
              onClick: pollNow,
              disabled: busy !== '' || !authenticated,
              title: !authenticated ? t.auth.notSignedIn : t.pollNow,
            }),
            h(Button, {
              label: refreshing ? t.refreshing : t.refresh,
              icon: IconRefresh(15),
              onClick: () => void refreshAll(true),
              disabled: refreshing,
              primary: true,
            }),
            h(Button, {
              label: authOpen ? t.auth.hide : t.auth.manage,
              onClick: () => setAuthOpen((open) => !open),
              quiet: true,
            }),
          ),
        ),
        h(
          'div',
          { className: 'go-statusbar' },
          h(
            'span',
            null,
            `${t.workspace}: `,
            h('code', { title: snapshot ? snapshot.workspaceRoot : '' }, snapshot ? snapshot.workspaceRoot || t.common.none : t.common.loading),
          ),
          h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            h('span', { className: authenticated ? 'go-dot' : 'go-dot go-dot-idle', 'aria-hidden': true }),
            authenticated && tokenLogin ? t.signedInAs(tokenLogin) : authenticated ? t.signedInAs(t.source[tokenSource] || tokenSource) : t.notSignedIn,
          ),
          authenticated
            ? h(Chip, { tone: 'success' }, t.tokenSource(sourceLabel(t, tokenSource)))
            : h(Chip, { tone: 'warn' }, t.tokenMissing),
          snapshot && snapshot.poller
            ? h('span', null, snapshot.poller.running ? t.autoRefresh(snapshot.poller.intervalSec) : t.pollerOff)
            : null,
          lastRefreshAt ? h('span', null, t.lastUpdated(new Date(lastRefreshAt).toLocaleTimeString())) : null,
        ),
      );

      const dispatchTask = useCallback(async () => {
        const text = dispatchDraft.trim();
        if (text.length === 0) {
          showToast(t.dispatch.empty);
          return;
        }
        setDispatchError(null);
        setBusy('dispatch');
        const services = props.services || {};
        try {
          const sessions = services.sessions;
          if (!sessions || typeof sessions.create !== 'function' || typeof sessions.using !== 'function') {
            throw new Error(t.dispatch.unavailable);
          }
          const cwd = snapshot && snapshot.workspaceRoot ? snapshot.workspaceRoot : undefined;
          const sessionId = await sessions.create(cwd ? { cwd } : {});
          await sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
            const session = reference && reference.binding ? reference.binding.session : null;
            if (!session || typeof session.prompt !== 'function') throw new Error(t.dispatch.unavailable);
            const result = await session.prompt([{ type: 'text', text }], 'queue');
            if (result && result.ok === false) {
              throw new Error((result.error && result.error.message) || t.dispatch.failed);
            }
          });
          if (services.uiWorkspace && typeof services.uiWorkspace.openSession === 'function') {
            services.uiWorkspace.openSession(sessionId);
          }
          setDispatchDraft('');
          showToast(t.dispatch.sent);
        } catch (error) {
          const uiWorkspace = services.uiWorkspace;
          if (uiWorkspace && typeof uiWorkspace.startSession === 'function') {
            try {
              uiWorkspace.startSession(undefined, { prompt: text, whenDraftExists: 'replace' });
              setDispatchDraft('');
              showToast(t.dispatch.draftReady);
              return;
            } catch (fallbackError) {
              setDispatchError(messageOf(fallbackError));
              return;
            }
          }
          setDispatchError(messageOf(error));
        } finally {
          setBusy('');
        }
      }, [dispatchDraft, props.services, showToast, snapshot, t]);

      const authCard = (() => {
        const show = !authenticated || authOpen || authPhase !== 'idle';
        if (!show) return null;
        const accounts = authenticated
          ? h(
              'div',
              { className: 'go-auth-main' },
              h('h2', { className: 'go-auth-title' }, t.auth.title),
              h('div', { className: 'go-auth-sub' }, t.auth.signedIn(tokenLogin || t.source[tokenSource] || tokenSource)),
              h('div', { className: 'go-auth-sub' }, t.auth.source(sourceLabel(t, tokenSource))),
              tokenScopes.length > 0 ? h('div', { className: 'go-auth-sub' }, t.auth.scopes(tokenScopes.join(', '))) : null,
              authMessage ? h('div', { className: 'go-auth-sub' }, authMessage) : null,
            )
          : h(
              'div',
              { className: 'go-auth-main' },
              h('h2', { className: 'go-auth-title' }, t.auth.title),
              h('div', { className: 'go-auth-sub' }, t.auth.notSignedIn),
              authPhase === 'starting'
                ? h('div', { className: 'go-inline-note', role: 'status' }, t.auth.starting)
                : null,
              authPhase === 'polling'
                ? h(
                    'div',
                    { className: 'go-inline-note', role: 'status', style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    h('span', { className: 'go-spinner', 'aria-hidden': true }),
                    h('span', null, t.auth.polling),
                  )
                : null,
              authPhase === 'pending' && authDevice
                ? h(
                    'div',
                    null,
                    h('div', { className: 'go-inline-note', style: { marginTop: 8 } }, t.auth.codeLabel),
                    h('div', null, h('span', { className: 'go-code' }, authDevice.userCode || '…')),
                    h(
                      'div',
                      { className: 'go-auth-actions', style: { marginTop: 4 } },
                      h(Button, { label: t.common.copy, icon: IconCopy(14), onClick: () => void copyDeviceCode() }),
                      authDevice.verificationUri
                        ? h(Button, {
                            label: t.auth.verify,
                            icon: IconExternal(14),
                            onClick: () => {
                              if (!openExternal(authDevice.verificationUri)) {
                                showToast(`${t.auth.openFailed} ${authDevice.verificationUri}`);
                              }
                            },
                          })
                        : null,
                    ),
                    authDevice.verificationUri
                      ? h(
                          'div',
                          { className: 'go-auth-sub', style: { marginTop: 6 } },
                          h('a', { className: 'go-link', href: authDevice.verificationUri, target: '_blank', rel: 'noopener noreferrer' }, authDevice.verificationUri),
                        )
                      : null,
                    h('div', { className: 'go-auth-sub', style: { marginTop: 6 } }, t.auth.pendingHint),
                    h('div', { className: 'go-auth-sub' }, t.auth.continueHint),
                    authDevice.expiresAt
                      ? h('div', { className: 'go-auth-sub' }, t.auth.expiresAt(formatTimestamp(authDevice.expiresAt)))
                      : authDevice.expiresIn
                        ? h('div', { className: 'go-auth-sub' }, t.auth.expiresAt(formatTimestamp(new Date(Date.now() + authDevice.expiresIn * 1000).toISOString())))
                        : null,
                  )
                : null,
              authPhase === 'pending' && !authDevice
                ? h('div', { className: 'go-inline-note' }, t.auth.pendingRestored)
                : null,
              authPhase === 'done' && authMessage ? h('div', { className: 'go-inline-note' }, authMessage) : null,
              authError ? h('div', { className: 'go-inline-error', role: 'alert', style: { marginTop: 6 } }, authError) : null,
            );

        const actions = h(
          'div',
          { className: 'go-auth-actions' },
          !authenticated && authPhase === 'pending'
            ? h(Button, { label: isBusy('auth:poll') ? t.auth.polling : t.auth.poll, onClick: () => void pollAuth(), primary: true, disabled: busy !== '' })
            : null,
          !authenticated && authPhase === 'pending'
            ? h(Button, { label: t.auth.cancel, onClick: () => void cancelAuth(), disabled: busy !== '' })
            : null,
          !authenticated && authPhase === 'starting'
            ? h('span', { className: 'go-inline-note', role: 'status' }, t.auth.starting)
            : null,
          !authenticated && authPhase === 'idle'
            ? h(Button, { label: t.auth.start, onClick: () => void startAuth(), primary: true, disabled: busy !== '' })
            : null,
          !authenticated && authPhase === 'error'
            ? h(Button, { label: t.auth.retry, onClick: () => void startAuth(), primary: true, disabled: busy !== '' })
            : null,
          authenticated
            ? logoutConfirm
              ? h(
                  React.Fragment,
                  null,
                  h('span', { className: 'go-inline-note' }, t.auth.confirmSignOut),
                  h(Button, {
                    label: isBusy('auth:logout') ? t.auth.signingOut : t.common.confirm,
                    danger: true,
                    onClick: () => void logoutAuth(),
                    disabled: busy !== '',
                  }),
                  h(Button, { label: t.common.cancel, onClick: () => setLogoutConfirm(false) }),
                )
              : h(Button, {
                  label: isBusy('auth:logout') ? t.auth.signingOut : t.auth.signOut,
                  icon: IconSignOut(14),
                  onClick: () => setLogoutConfirm(true),
                  disabled: busy !== '',
                })
            : null,
          authenticated && authPhase === 'done'
            ? h(Button, { label: t.common.dismiss, onClick: () => { setAuthPhase('idle'); setAuthMessage(null); } })
            : null,
        );

        return h(
          'section',
          { className: 'go-auth', 'aria-label': t.auth.title },
          h(
            'div',
            { className: 'go-auth-row' },
            accounts,
            h('div', null, actions),
          ),
        );
      })();

      const dispatchCard = h(
        'section',
        { className: 'go-dispatch', 'aria-label': t.dispatch.title },
        h(
          'div',
          { className: 'go-dispatch-main' },
          h('h2', { className: 'go-auth-title' }, t.dispatch.title),
          h('div', { className: 'go-auth-sub' }, t.dispatch.hint),
          h('textarea', {
            className: 'go-dispatch-input',
            rows: 3,
            value: dispatchDraft,
            placeholder: t.dispatch.placeholder,
            'aria-label': t.dispatch.title,
            onChange: (event) => {
              setDispatchDraft(event.target.value);
              setDispatchError(null);
            },
            onKeyDown: (event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                void dispatchTask();
              }
            },
          }),
          dispatchError ? h('div', { className: 'go-inline-error', role: 'alert' }, dispatchError) : null,
        ),
        h(
          'div',
          { className: 'go-dispatch-actions' },
          h(Button, {
            label: isBusy('dispatch') ? t.dispatch.sending : t.dispatch.send,
            primary: true,
            onClick: () => void dispatchTask(),
            disabled: busy !== '',
          }),
          h('span', { className: 'go-auth-sub' }, t.dispatch.sessionHint),
        ),
      );

      const tabBar = h(
        'div',
        { className: 'go-tabs', role: 'tablist', 'aria-label': t.tabsLabel },
        TAB_KEYS.map((key) =>
          h(
            'button',
            {
              key,
              type: 'button',
              role: 'tab',
              id: `go-tab-${key}`,
              'aria-selected': tab === key,
              'aria-controls': `go-panel-${key}`,
              className: 'go-tab',
              onClick: () => setTab(key),
            },
            t.tabs[key],
            tabBadges[key] ? h('span', { className: 'go-tabcount' }, String(tabBadges[key])) : null,
          ),
        ),
      );

      const snapshotBanner = snapshotError
        ? h(ErrorNote, {
            message: snapshotError,
            retryLabel: t.common.retry,
            onRetry: () => void refreshAll(true),
          })
        : null;

      let body;
      if (tab === 'inbox') {
        body = h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'go-toolbar' },
            h(
              'label',
              { className: 'go-check' },
              h('input', {
                type: 'checkbox',
                checked: inboxFilter.unreadOnly,
                onChange: (event) => setInboxFilter((previous) => ({ ...previous, unreadOnly: event.target.checked })),
              }),
              h('span', null, t.inbox.unreadOnly),
            ),
            h(SelectField, {
              label: t.inbox.limit,
              value: String(inboxFilter.limit),
              options: EVENT_LIMITS.map((limit) => ({ value: String(limit), label: String(limit) })),
              onChange: (value) => setInboxFilter((previous) => ({ ...previous, limit: Number(value) })),
            }),
            h(SelectField, {
              label: t.inbox.repo,
              value: inboxFilter.repo,
              options: [{ value: '', label: t.inbox.allRepos }, ...reposForFilter.map((repo) => ({ value: repo, label: repo }))],
              onChange: (value) => setInboxFilter((previous) => ({ ...previous, repo: value })),
            }),
            h(Button, {
              label: isBusy('mark:all') ? t.inbox.marking : t.inbox.markAll,
              icon: IconCheck(14),
              onClick: markAllRead,
              disabled: busy !== '' || !inboxData || inboxData.events.length === 0,
            }),
            h('span', { className: 'go-count' }, t.inbox.count(inboxData ? inboxData.events.length : 0, unreadCount)),
          ),
          h('div', { className: 'go-section-hint', style: { marginBottom: 10 } }, t.inbox.hint),
          eventsState.error ? h(ErrorNote, { message: eventsState.error, retryLabel: t.common.retry, onRetry: () => void loadEvents(inboxFilterRef.current) }) : null,
          !inboxData
            ? eventsState.status === 'error'
              ? null
              : h(Loading, { t })
            : inboxEvents.length === 0
              ? h(Empty, { text: inboxFilter.unreadOnly ? t.inbox.emptyUnread : t.inbox.empty })
              : h(
                  'ul',
                  { className: 'go-list', id: 'go-panel-inbox' },
                  inboxEvents.map((event) =>
                    h(
                      'li',
                      { key: event.id || `${event.repo}:${event.kind}:${event.number}:${event.at}`, className: 'go-row' },
                      h(Chip, { tone: event.kind === 'push' ? 'brand' : null }, kindLabel(t, event.kind)),
                      h(
                        'div',
                        { className: 'go-row-main' },
                        h(
                          'span',
                          { className: 'go-row-title' },
                          event.url
                            ? h('a', { className: 'go-link', href: event.url, target: '_blank', rel: 'noopener noreferrer' }, event.title || event.summary || event.action || event.id)
                            : event.title || event.summary || event.action || event.id,
                        ),
                        h(
                          'span',
                          { className: 'go-row-sub' },
                          event.repo ? h('span', null, event.repo) : null,
                          event.number !== null ? h('span', null, shortNumber(event.number)) : null,
                          event.actor ? h('span', null, `@${event.actor}`) : null,
                          event.at ? h('span', { title: formatTimestamp(event.at) }, timeAgo(event.at, t)) : null,
                          event.taskId
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'go-chip-button',
                                  onClick: () => setTab('tasks'),
                                  title: t.inbox.taskLink(event.taskId),
                                },
                                t.inbox.taskLink(event.taskId),
                              )
                            : null,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'go-row-actions' },
                        event.read
                          ? h(Chip, { tone: 'idle' }, t.inbox.read)
                          : h(Button, {
                              label: isBusy(`mark:${event.id}`) ? t.inbox.marking : t.inbox.markRead,
                              onClick: () => markEventRead(event),
                              disabled: busy !== '' || !event.id,
                              quiet: true,
                            }),
                      ),
                    ),
                  ),
                ),
        );
      } else if (tab === 'issues') {
        body = h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'go-toolbar' },
            h(SelectField, {
              label: t.issues.kind,
              value: issuesFilter.kind,
              options: [
                { value: 'all', label: t.issues.kindAll },
                { value: 'issue', label: t.issues.kindIssue },
                { value: 'pr', label: t.issues.kindPr },
              ],
              onChange: (value) => setIssuesFilter((previous) => ({ ...previous, kind: value })),
            }),
            h(SelectField, {
              label: t.issues.state,
              value: issuesFilter.state,
              options: [
                { value: 'open', label: t.issues.stateOpen },
                { value: 'closed', label: t.issues.stateClosed },
                { value: 'all', label: t.issues.stateAll },
              ],
              onChange: (value) => setIssuesFilter((previous) => ({ ...previous, state: value })),
            }),
            h(SelectField, {
              label: t.issues.repo,
              value: issuesFilter.repo,
              options: [{ value: '', label: t.issues.allRepos }, ...reposForFilter.map((repo) => ({ value: repo, label: repo }))],
              onChange: (value) => setIssuesFilter((previous) => ({ ...previous, repo: value })),
            }),
            h(SelectField, {
              label: t.issues.limit,
              value: String(issuesFilter.limit),
              options: ISSUE_LIMITS.map((limit) => ({ value: String(limit), label: String(limit) })),
              onChange: (value) => setIssuesFilter((previous) => ({ ...previous, limit: Number(value) })),
            }),
            h(Button, {
              label: t.refresh,
              icon: IconRefresh(14),
              onClick: () => void loadIssues(issuesFilterRef.current),
              disabled: busy !== '',
            }),
            h('span', { className: 'go-count' }, t.issues.count(issueItems.length)),
          ),
          h('div', { className: 'go-section-hint', style: { marginBottom: 10 } }, t.issues.hint),
          issuesState.error
            ? h(ErrorNote, { message: issuesState.error, retryLabel: t.common.retry, onRetry: () => void loadIssues(issuesFilterRef.current) })
            : null,
          !issuesData
            ? issuesState.status === 'error'
              ? null
              : h(Loading, { t })
            : issueItems.length === 0
              ? h(Empty, { text: t.issues.empty })
              : h(
                  'ul',
                  { className: 'go-list', id: 'go-panel-issues' },
                  issueItems.map((item) => {
                    const stateTone = item.state === 'merged' ? 'success' : item.state === 'closed' ? 'warn' : item.draft ? 'warn' : null;
                    const stateText = item.state === 'merged'
                      ? t.issues.stateMerged
                      : item.state === 'closed'
                        ? t.issues.stateClosed
                        : t.issues.stateOpen;
                    return h(
                      'li',
                      { key: `${item.kind}:${item.number}`, className: 'go-row' },
                      h('span', { className: 'go-mono' }, shortNumber(item.number)),
                      h(Chip, { tone: item.kind === 'pr' ? 'brand' : null }, item.kind === 'pr' ? t.issues.kindPr : t.issues.kindIssue),
                      h(Chip, { tone: stateTone }, stateText),
                      item.draft ? h(Chip, { tone: 'warn' }, t.issues.draft) : null,
                      h(
                        'div',
                        { className: 'go-row-main' },
                        h(
                          'span',
                          { className: 'go-row-title' },
                          item.url
                            ? h(
                                'a',
                                { className: 'go-link', href: item.url, target: '_blank', rel: 'noopener noreferrer', title: t.issues.openLink },
                                item.title || `#${item.number}`,
                              )
                            : item.title || `#${item.number}`,
                        ),
                        h(
                          'span',
                          { className: 'go-row-sub' },
                          issuesData.repo ? h('span', null, issuesData.repo) : null,
                          item.author ? h('span', null, t.issues.by(item.author)) : null,
                          item.updatedAt ? h('span', { title: formatTimestamp(item.updatedAt) }, t.issues.updated(timeAgo(item.updatedAt, t))) : null,
                          item.labels.length > 0
                            ? h('span', { className: 'go-chips' }, item.labels.map((label) => h(Chip, { key: label }, label)))
                            : null,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'go-row-actions' },
                        h(Button, {
                          label: isBusy(`issue-task:${item.kind}:${item.number}`) ? t.issues.creatingTask : t.issues.createTask,
                          primary: true,
                          quiet: true,
                          onClick: () => createTaskFromIssue(item),
                          disabled: busy !== '',
                        }),
                      ),
                    );
                  }),
                ),
        );
      } else if (tab === 'tasks') {
        body = h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'go-toolbar' },
            h(SelectField, {
              label: t.tasks.statusFilter,
              value: taskFilter.status,
              options: [
                { value: 'open', label: t.tasks.openOnly },
                { value: 'all', label: t.tasks.allStatuses },
                ...TASK_STATUSES.map((status) => ({ value: status, label: statusLabel(t, status) })),
              ],
              onChange: (value) => setTaskFilter((previous) => ({ ...previous, status: value })),
            }),
            h(SelectField, {
              label: t.tasks.repo,
              value: taskFilter.repo,
              options: [{ value: '', label: t.tasks.allRepos }, ...reposForFilter.map((repo) => ({ value: repo, label: repo }))],
              onChange: (value) => setTaskFilter((previous) => ({ ...previous, repo: value })),
            }),
            h(Button, { label: t.refresh, icon: IconRefresh(14), onClick: () => void loadTasks(), disabled: busy !== '' }),
            h('span', { className: 'go-count' }, t.tasks.count(filteredTasks.length)),
          ),
          h('div', { className: 'go-section-hint', style: { marginBottom: 10 } }, t.tasks.hint),
          tasksState.error ? h(ErrorNote, { message: tasksState.error, retryLabel: t.common.retry, onRetry: () => void loadTasks() }) : null,
          !tasksData
            ? tasksState.status === 'error'
              ? null
              : h(Loading, { t })
            : filteredTasks.length === 0
              ? h(Empty, { text: t.tasks.empty })
              : h(
                  'ul',
                  { className: 'go-list', id: 'go-panel-tasks' },
                  filteredTasks.map((task) =>
                    h(
                      'li',
                      { key: task.id, className: 'go-row' },
                      h('span', { className: 'go-mono' }, task.id),
                      h(Chip, { tone: task.status === 'done' ? 'success' : task.status === 'review' ? 'warn' : null }, statusLabel(t, task.status)),
                      h(
                        'div',
                        { className: 'go-row-main' },
                        h('span', { className: 'go-row-title' }, task.title || task.id),
                        h(
                          'span',
                          { className: 'go-row-sub' },
                          task.repo ? h('span', null, task.repo) : null,
                          task.branch ? h('code', { title: task.branch }, task.branch) : null,
                          task.worktreePath ? h('code', { title: task.worktreePath }, task.worktreePath) : null,
                          task.issueNumber !== null
                            ? task.issueUrl
                              ? h('a', { className: 'go-link', href: task.issueUrl, target: '_blank', rel: 'noopener noreferrer' }, `#${task.issueNumber}`)
                              : h('span', null, `#${task.issueNumber}`)
                            : null,
                          task.updatedAt ? h('span', { title: formatTimestamp(task.updatedAt) }, t.tasks.updated(timeAgo(task.updatedAt, t))) : null,
                        ),
                        closeTarget === task.id
                          ? h(
                              'div',
                              { className: 'go-confirm', role: 'group', 'aria-label': t.tasks.confirmClose(task.id) },
                              h('span', null, t.tasks.confirmClose(task.id)),
                              h(Button, {
                                label: isBusy(`close:${task.id}`) ? t.tasks.closing : t.common.confirm,
                                danger: true,
                                onClick: () => closeTask(task),
                                disabled: busy !== '',
                              }),
                              h(Button, { label: t.common.cancel, onClick: () => setCloseTarget(null) }),
                            )
                          : null,
                      ),
                      h(
                        'div',
                        { className: 'go-row-actions' },
                        h(Button, {
                          label: isBusy(`sync:${task.id}`) ? t.tasks.syncing : t.tasks.sync,
                          onClick: () => syncTask(task),
                          disabled: busy !== '',
                          quiet: true,
                        }),
                        task.status === 'done'
                          ? null
                          : h(Button, {
                              label: t.tasks.close,
                              danger: true,
                              quiet: true,
                              onClick: () => setCloseTarget((current) => (current === task.id ? null : task.id)),
                              disabled: busy !== '',
                            }),
                      ),
                    ),
                  ),
                ),
        );
      } else if (tab === 'repos') {
        body = h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'go-toolbar' },
            h(Button, { label: t.refresh, icon: IconRefresh(14), onClick: () => void refreshAll(true), disabled: busy !== '' }),
            h('span', { className: 'go-count' }, t.repos.count(repoRows.length)),
          ),
          h('div', { className: 'go-section-hint', style: { marginBottom: 10 } }, t.repos.hint),
          !snapshot
            ? h(Loading, { t })
            : repoRows.length === 0
              ? h(Empty, { text: t.repos.empty })
              : h(
                  'ul',
                  { className: 'go-list', id: 'go-panel-repos' },
                  repoRows.map((repo) =>
                    h(
                      'li',
                      { key: repo.repo || repo.local, className: 'go-row' },
                      h(
                        'div',
                        { className: 'go-row-main' },
                        h(
                          'span',
                          { className: 'go-row-title' },
                          repo.repo || repo.local,
                          ' ',
                          h(Chip, { tone: repo.cloned ? 'success' : 'warn' }, repo.cloned ? t.repos.cloned : t.repos.notCloned),
                          repo.dirty ? h(Chip, { tone: 'warn' }, t.repos.dirty) : null,
                        ),
                        h(
                          'span',
                          { className: 'go-row-sub' },
                          h('span', null, `${t.repos.baseBranch}: ${repo.baseBranch || t.common.unknown}`),
                          h('span', null, `${t.repos.currentBranch}: ${repo.currentBranch || t.common.none}`),
                          repo.aheadBehind
                            ? h('span', null, `${t.repos.ahead(repo.aheadBehind.ahead ?? 0)} / ${t.repos.behind(repo.aheadBehind.behind ?? 0)}`)
                            : null,
                          repo.worktrees !== null ? h('span', null, t.repos.worktrees(repo.worktrees)) : null,
                          repo.activeTasks !== null ? h('span', null, t.repos.activeTasks(repo.activeTasks)) : null,
                          repo.lastPollAt ? h('span', { title: formatTimestamp(repo.lastPollAt) }, t.repos.lastPoll(timeAgo(repo.lastPollAt, t))) : null,
                        ),
                        h('span', { className: 'go-row-sub' }, h('code', { title: repo.dir }, repo.dir || t.common.none)),
                        repo.error ? h('span', { className: 'go-inline-error', role: 'alert' }, t.repos.error(repo.error)) : null,
                      ),
                      h(
                        'div',
                        { className: 'go-row-actions' },
                        h(Button, {
                          label: isBusy(`clone:${repo.repo}`) ? t.repos.cloning : t.repos.clone,
                          onClick: () => cloneRepo(repo.repo),
                          disabled: busy !== '' || repo.cloned || !repo.repo,
                        }),
                        h(Button, {
                          label: isBusy(`fetch:${repo.repo}`) ? t.repos.fetching : t.repos.fetch,
                          onClick: () => fetchRepo(repo.repo),
                          disabled: busy !== '' || !repo.cloned || !repo.repo,
                          quiet: true,
                        }),
                      ),
                    ),
                  ),
                ),
        );
      } else if (tab === 'worktrees') {
        body = h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'go-toolbar' },
            h(Button, { label: t.refresh, icon: IconRefresh(14), onClick: () => void loadWorktrees(), disabled: busy !== '' }),
            h('span', { className: 'go-count' }, t.worktrees.count(worktreeRows.length)),
          ),
          h('div', { className: 'go-section-hint', style: { marginBottom: 10 } }, t.worktrees.hint),
          worktreesState.error
            ? h(ErrorNote, { message: worktreesState.error, retryLabel: t.common.retry, onRetry: () => void loadWorktrees() })
            : null,
          !worktreesState.data
            ? worktreesState.status === 'error'
              ? null
              : h(Loading, { t })
            : worktreeRows.length === 0
              ? h(Empty, { text: t.worktrees.empty })
              : h(
                  'ul',
                  { className: 'go-list', id: 'go-panel-worktrees' },
                  worktreeRows.map((row) =>
                    h(
                      'li',
                      { key: `${row.repo}:${row.path}`, className: 'go-row' },
                      h(
                        'div',
                        { className: 'go-row-main' },
                        h(
                          'span',
                          { className: 'go-row-title' },
                          row.task && row.task.id ? `${row.task.id} · ${row.task.title || ''}` : row.branch || row.path,
                          row.dirty ? h(Chip, { tone: 'warn' }, t.worktrees.dirty) : null,
                          row.locked ? h(Chip, null, t.worktrees.locked) : null,
                          row.prunable ? h(Chip, { tone: 'warn' }, t.worktrees.prunable) : null,
                        ),
                        h(
                          'span',
                          { className: 'go-row-sub' },
                          row.repo ? h('span', null, row.repo) : null,
                          h('code', { title: row.branch || '' }, row.branch || t.worktrees.noBranch),
                          row.task && row.task.status ? h(Chip, null, statusLabel(t, row.task.status)) : null,
                        ),
                        h('span', { className: 'go-row-sub' }, h('code', { title: row.path }, row.path)),
                        removeTarget === row.path
                          ? h(
                              'div',
                              { className: 'go-confirm', role: 'group', 'aria-label': t.worktrees.confirmRemove },
                              h('span', null, t.worktrees.confirmRemove),
                              h(Button, {
                                label: isBusy(`remove:${row.path}`) ? t.worktrees.removing : t.common.confirm,
                                danger: true,
                                onClick: () => removeWorktree(row),
                                disabled: busy !== '',
                              }),
                              h(Button, { label: t.common.cancel, onClick: () => setRemoveTarget(null) }),
                            )
                          : null,
                      ),
                      h(
                        'div',
                        { className: 'go-row-actions' },
                        h(Button, {
                          label: t.worktrees.remove,
                          icon: IconTrash(14),
                          danger: true,
                          quiet: true,
                          onClick: () => setRemoveTarget((current) => (current === row.path ? null : row.path)),
                          disabled: busy !== '',
                        }),
                      ),
                    ),
                  ),
                ),
        );
      } else if (tab === 'settings') {
        body = h(
          React.Fragment,
          null,
          h(
            Section,
            null,
            h(SectionHead, { title: t.settings.workspaceTitle, hint: t.settings.workspaceHint }),
            h(
              'div',
              { className: 'go-settings-row' },
              h(InputField, {
                label: t.settings.workspaceTitle,
                value: settingsDraft.workspaceRoot,
                placeholder: 'C:\\work\\github',
                onChange: (value) => {
                  setSettingsDirty(true);
                  setSettingsDraft((previous) => ({ ...previous, workspaceRoot: value }));
                },
              }),
              h(Button, {
                label: isBusy('settings:workspace') ? t.settings.saving : t.settings.save,
                icon: IconCheck(14),
                primary: true,
                onClick: () => void saveWorkspace(),
                disabled: busy !== '' || !settingsDirty,
              }),
            ),
          ),
          h(
            Section,
            null,
            h(SectionHead, { title: t.settings.pollTitle, hint: t.settings.pollHint }),
            h(
              'div',
              { className: 'go-settings-row' },
              h(InputField, {
                label: `${t.settings.pollTitle} (${t.settings.intervalUnit})`,
                type: 'number',
                min: 15,
                max: 3600,
                value: String(settingsDraft.pollIntervalSec),
                onChange: (value) => {
                  setSettingsDirty(true);
                  setSettingsDraft((previous) => ({ ...previous, pollIntervalSec: value }));
                },
              }),
              h(Button, {
                label: isBusy('settings:poll') ? t.settings.saving : t.settings.save,
                icon: IconCheck(14),
                primary: true,
                onClick: () => void savePollInterval(),
                disabled: busy !== '' || !settingsDirty,
              }),
            ),
          ),
          h(
            Section,
            null,
            h(SectionHead, { title: t.settings.infoTitle }),
            !snapshot
              ? h(Loading, { t })
              : h(
                  'div',
                  { className: 'go-info' },
                  h('span', null, h('b', null, t.settings.stateDir), ' ', h('code', null, snapshot.stateDir || t.common.none)),
                  h('span', null, h('b', null, t.settings.defaultBaseBranch), ' ', snapshot.defaultBaseBranch || t.common.none),
                  h('span', null, h('b', null, t.settings.branchPrefix), ' ', snapshot.branchPrefix || t.common.none),
                  h('span', null, h('b', null, t.settings.remote), ' ', snapshot.remote || t.common.none),
                  h('span', null, h('b', null, t.settings.gitBinary), ' ', snapshot.gitBinary || t.common.none),
                  h('span', null, h('b', null, t.settings.apiBase), ' ', snapshot.githubApiBase || t.common.none),
                  h('span', null, h('b', null, t.settings.workspaceExists), ' ', snapshot.workspaceExists ? t.common.yes : t.common.no),
                  h('span', null, h('b', null, t.tabs.inbox), ' ', t.inbox.count(snapshot.eventStats.total, snapshot.eventStats.unread)),
                ),
          ),
        );
      } else {
        body = h(
          React.Fragment,
          null,
          h(
            Section,
            null,
            h(SectionHead, { title: t.automation.autoTitle, hint: t.automation.autoHint }),
            h(
              'div',
              { className: 'go-checkrow' },
              h(
                'label',
                { className: 'go-check' },
                h('input', {
                  type: 'checkbox',
                  checked: autoDispatchEnabled,
                  'aria-label': t.automation.enabled,
                  onChange: (event) => setAutoDispatchEnabled(event.target.checked),
                }),
                h('span', null, t.automation.enabled),
              ),
              h(
                Chip,
                { tone: autoDispatchEnabled ? 'success' : 'warn' },
                autoDispatchEnabled ? t.automation.enabledOn : t.automation.enabledOff,
              ),
            ),
            h(
              'div',
              { className: 'go-checkrow' },
              h('span', { className: 'go-section-hint' }, t.automation.kinds),
              AUTO_DISPATCH_KINDS.map((kind) =>
                h(
                  'label',
                  { key: kind, className: 'go-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: automationDraft.kinds.includes(kind),
                    'aria-label': `${t.automation.kinds}: ${kindLabel(t, kind)}`,
                    onChange: (event) => setAutoDispatchKind(kind, event.target.checked),
                  }),
                  h('span', null, kindLabel(t, kind)),
                ),
              ),
            ),
            h(
              'div',
              { className: 'go-settings-row', style: { marginTop: 12 } },
              h(InputField, {
                label: `${t.automation.minInterval} (${t.automation.minIntervalUnit})`,
                type: 'number',
                min: 30,
                max: 3600,
                value: String(automationDraft.minIntervalSec),
                onChange: (value) => setMinInterval(value),
              }),
              h(Button, {
                label: isBusy('automation:save') ? t.automation.saving : t.automation.save,
                icon: IconCheck(14),
                primary: true,
                onClick: () => void saveAutomation(),
                disabled: busy !== '' || !automationDirty,
              }),
            ),
            h('div', { className: 'go-section-hint', style: { marginTop: 6 } }, t.automation.minIntervalHint),
            automationError ? h('div', { className: 'go-inline-error', role: 'alert', style: { marginTop: 6 } }, automationError) : null,
          ),
          h(
            Section,
            null,
            h(SectionHead, { title: t.automation.statusTitle }),
            h(
              'div',
              { className: 'go-statusline' },
              h(
                Chip,
                { tone: dispatchInfo.enabled ? 'success' : 'warn' },
                dispatchInfo.enabled ? t.automation.enabledOn : t.automation.enabledOff,
              ),
              h('span', null, `${t.automation.dispatchCount}: ${dispatchInfo.count}`),
              h('span', null, `${t.automation.seen}: ${dispatchInfo.seen}`),
              h('span', null, `${t.automation.skipped}: ${dispatchInfo.skipped}`),
              h('span', null, `${t.automation.lastDispatch}: ${dispatchInfo.lastDispatchAt ? timeAgo(dispatchInfo.lastDispatchAt, t) : t.automation.never}`),
              h('span', null, `${t.automation.lastEvent}: ${dispatchInfo.lastEventAt ? timeAgo(dispatchInfo.lastEventAt, t) : t.automation.never}`),
            ),
            h(
              'div',
              { className: 'go-watcher' },
              h('span', { className: 'go-section-hint' }, t.automation.watcher),
              dispatchInfo.sessionId
                ? h('code', { title: dispatchInfo.sessionId }, dispatchInfo.sessionId)
                : h('span', { className: 'go-section-hint' }, t.automation.noSession),
              h(Button, {
                label: t.automation.openWatcher,
                onClick: openWatcherSession,
                disabled: busy !== '' || !dispatchInfo.sessionId,
                quiet: true,
              }),
            ),
            dispatchInfo.lastError
              ? h(ErrorNote, { message: `${t.automation.lastError}: ${dispatchInfo.lastError}` })
              : null,
            h(
              'div',
              { className: 'go-toolbar', style: { marginTop: 10, marginBottom: 0 } },
              h(Button, {
                label: isBusy('dispatch:tick') ? t.automation.running : t.automation.runCheck,
                icon: IconPoll(14),
                primary: true,
                onClick: runDispatchCheck,
                disabled: busy !== '',
              }),
              h(Button, {
                label: isBusy('dispatch:status') ? t.automation.refreshingStatus : t.automation.refreshStatus,
                icon: IconRefresh(14),
                onClick: refreshDispatchStatus,
                disabled: busy !== '',
              }),
            ),
          ),
          h(
            Section,
            null,
            h(SectionHead, { title: t.automation.sendTitle, hint: t.automation.sendHint }),
            h('textarea', {
              className: 'go-dispatch-input',
              rows: 3,
              value: watcherDraft,
              placeholder: t.automation.sendPlaceholder,
              'aria-label': t.automation.sendTitle,
              onChange: (event) => setWatcherDraft(event.target.value),
            }),
            h(
              'div',
              { className: 'go-toolbar', style: { marginTop: 10, marginBottom: 0 } },
              h(Button, {
                label: isBusy('dispatch:send') ? t.automation.sending : t.automation.send,
                primary: true,
                onClick: sendToWatcher,
                disabled: busy !== '' || watcherDraft.trim().length === 0,
              }),
            ),
          ),
        );
      }

      const footer = h(
        'footer',
        { className: 'go-footer' },
        h('span', null, t.footer.hostOnly),
        snapshot && snapshot.generatedAt ? h('span', null, t.footer.generated(formatTimestamp(snapshot.generatedAt))) : null,
        h('span', null, t.footer.route(ROUTE)),
      );

      return h(
        'div',
        { className: 'go-root' },
        h('style', null, CSS),
        header,
        snapshotBanner,
        authCard,
        dispatchCard,
        tabBar,
        h('div', { className: 'go-body', id: `go-panel-${tab}`, role: 'tabpanel' }, body),
        footer,
        toast ? h('div', { className: 'go-toast', role: 'status', 'aria-live': 'polite' }, toast) : null,
      );
    }

    // ---------------------------------------------------------------------
    // Error boundary: a render error must not blank the whole main panel
    // ---------------------------------------------------------------------

    class PageErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.reset = () => this.setState({ error: null });
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        try {
          console.error('[github-orchestrator] render error', error, info);
        } catch {
          /* logging must never throw */
        }
      }

      render() {
        const t = this.props.t || COPY.zh;
        if (this.state.error) {
          return h(
            'div',
            { className: 'go-root' },
            h('style', null, CSS),
            h(
              'div',
              { className: 'go-banner go-banner-error', style: { marginTop: 24 }, role: 'alert' },
              h(
                'div',
                { style: { flex: 1 } },
                h('div', { style: { fontWeight: 600 } }, t.common.renderErrorTitle),
                h('div', { className: 'go-banner-text' }, String((this.state.error && this.state.error.message) || this.state.error)),
                h('div', { className: 'go-banner-text' }, t.common.renderErrorHint),
              ),
              h(Button, { label: t.common.retryRender, onClick: this.reset }),
            ),
          );
        }
        return this.props.children;
      }
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    /**
     * @param {any} ctx
     */
    const apply = (ctx) => {
      // Optional client services used by the "dispatch a task" card. They are
      // resolved through scoped inject so the panel still renders when a
      // deployment lacks session services.
      const services = { sessions: null, uiWorkspace: null };
      try {
        ctx.inject(['sessions'], (sctx) => {
          services.sessions = sctx.sessions;
        });
      } catch {
        /* session service unavailable */
      }
      try {
        ctx.inject(['uiWorkspace'], (sctx) => {
          services.uiWorkspace = sctx.uiWorkspace;
        });
      } catch {
        /* workspace UI service unavailable */
      }
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: () => copyFor(readLocaleId(ctx)).title,
          },
          SidebarIcon,
        ),
      );
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          (slotProps) => {
            const localeId = useLocaleId(ctx);
            const t = copyFor(localeId);
            return h(PageErrorBoundary, { t }, h(OrchestratorPanel, { ...slotProps, ctx, t, services }));
          },
        ),
      );
    };

    return { apply, inject: ['slots'] };
  },
});
