/**
 * Offline tests for the Host HTTP API (`lib/web.js`) and for the browser
 * half's registration contract (`client.js`). No real GitHub, no network, no
 * web server: the plugin route handler is exercised with fake `req`/`res`
 * objects, and `client.js` is evaluated in a `node:vm` sandbox with a fake
 * module loader.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { ACTION_TOOLS, BODY_LIMIT_BYTES, ROUTE_PREFIX, registerWebRoutes } from '../lib/web.js';

const ORIGIN = 'http://127.0.0.1:12869';

/**
 * @param {{ method?: string, url?: string, headers?: Record<string, string>, body?: string }} opts
 */
function makeReq(opts = {}) {
  const req = new EventEmitter();
  req.method = opts.method ?? 'GET';
  req.url = opts.url ?? '/';
  req.headers = opts.headers ?? {};
  req.destroy = () => {
    /* fake socket teardown */
  };
  const body = opts.body;
  if (body !== undefined) {
    setTimeout(() => {
      req.emit('data', Buffer.from(body, 'utf8'));
      req.emit('end');
    }, 0);
  } else {
    setTimeout(() => req.emit('end'), 0);
  }
  return req;
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    headersSent: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk));
      this.headersSent = true;
    },
    get body() {
      return this.chunks.join('');
    },
    json() {
      return JSON.parse(this.body);
    },
  };
  return res;
}

/**
 * Register the route on a fake web server and return a request helper.
 * @param {{ snapshot?: Function, invokeTool?: Function }} runtime
 */
function setup(runtime = {}) {
  let registration;
  const disposers = [];
  const ctx = {
    webServer: {
      port: 12869,
      register(options) {
        registration = options;
        const dispose = () => disposers.push('disposed');
        return dispose;
      },
    },
    logger: { warn() {} },
  };
  const dispose = registerWebRoutes(ctx, runtime);
  assert.ok(registration, 'registerWebRoutes must call ctx.webServer.register');
  assert.equal(registration.kind, 'prefix');
  assert.equal(registration.path, ROUTE_PREFIX);
  assert.equal(typeof registration.handler, 'function');
  return {
    registration,
    dispose,
    disposers,
    async request(opts = {}) {
      const req = makeReq({ headers: { origin: ORIGIN }, ...opts });
      const res = makeRes();
      await registration.handler(req, res);
      return {
        status: res.statusCode,
        headers: res.headers,
        body: res.body,
        json: res.body ? JSON.parse(res.body) : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

test('registers a prefix route on /api/github-orchestrator and returns a disposer', () => {
  const harness = setup({ snapshot: async () => ({}), invokeTool: async () => ({}) });
  assert.equal(typeof harness.dispose, 'function');
  harness.dispose();
  assert.deepEqual(harness.disposers, ['disposed']);
  harness.dispose();
  assert.deepEqual(harness.disposers, ['disposed'], 'disposer must be idempotent');
});

test('rejects a context without a webServer.register', () => {
  assert.throws(() => registerWebRoutes({}, {}), /webServer/);
});

test('resolves the web server from ctx.get when it is not injected', () => {
  let registration;
  const ctx = {
    get(name) {
      assert.equal(name, 'webServer');
      return {
        port: 12869,
        register(options) {
          registration = options;
          return () => {};
        },
      };
    },
  };
  const dispose = registerWebRoutes(ctx, { snapshot: async () => ({}), invokeTool: async () => ({}) });
  assert.equal(registration.kind, 'prefix');
  assert.equal(registration.path, ROUTE_PREFIX);
  assert.equal(typeof registration.handler, 'function');
  assert.equal(typeof dispose, 'function');
});

// ---------------------------------------------------------------------------
// GET /status
// ---------------------------------------------------------------------------

test('GET /status returns the runtime snapshot in the success envelope', async () => {
  const snapshot = {
    workspaceRoot: 'C:\\work',
    token: { available: true, source: 'env' },
    repos: [],
    eventStats: { unread: 2 },
  };
  const harness = setup({ snapshot: async () => snapshot, invokeTool: async () => ({}) });
  const result = await harness.request({ url: `${ROUTE_PREFIX}/status` });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(result.json, { ok: true, data: snapshot });
});

test('GET /status reports a snapshot failure as a 200 error envelope', async () => {
  const harness = setup({
    snapshot: async () => {
      throw new Error('state unavailable');
    },
    invokeTool: async () => ({}),
  });
  const result = await harness.request({ url: `${ROUTE_PREFIX}/status` });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: false, error: 'state unavailable' });
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('GET /status reports a missing runtime.snapshot as an error envelope', async () => {
  const harness = setup({ invokeTool: async () => ({}) });
  const result = await harness.request({ url: `${ROUTE_PREFIX}/status` });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /snapshot/);
});

// ---------------------------------------------------------------------------
// GET /events
// ---------------------------------------------------------------------------

test('GET /events maps unread/limit/repo onto the github_events tool call', async () => {
  const calls = [];
  const toolResult = { ok: true, count: 2, events: [{ id: 'e1' }, { id: 'e2' }], stats: { unread: 2 } };
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async (name, args) => {
      calls.push({ name, args });
      return toolResult;
    },
  });
  const result = await harness.request({
    url: `${ROUTE_PREFIX}/events?unread=1&limit=50&repo=owner%2Fname`,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, data: toolResult });
  assert.deepEqual(calls, [
    { name: 'github_events', args: { action: 'list', unreadOnly: true, limit: 50, repo: 'owner/name' } },
  ]);
});

test('GET /events without filters lets the tool use its defaults', async () => {
  const calls = [];
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, events: [], stats: {} };
    },
  });
  await harness.request({ url: `${ROUTE_PREFIX}/events?unread=0` });
  assert.deepEqual(calls, [{ name: 'github_events', args: { action: 'list', unreadOnly: false } }]);
});

test('GET /events clamps limit to 1..200 and forwards optional kind filters', async () => {
  const calls = [];
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, events: [] };
    },
  });
  await harness.request({ url: `${ROUTE_PREFIX}/events?limit=5000&kinds=pr%2Creview&unread=true` });
  await harness.request({ url: `${ROUTE_PREFIX}/events?limit=0` });
  assert.deepEqual(calls[0].args, { action: 'list', unreadOnly: true, limit: 200, kinds: ['pr', 'review'] });
  assert.deepEqual(calls[1].args, { action: 'list', unreadOnly: false, limit: 1 });
});

test('GET /events reports an invokeTool rejection as a 200 error envelope', async () => {
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async () => {
      throw new Error('rate limited');
    },
  });
  const result = await harness.request({ url: `${ROUTE_PREFIX}/events` });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: false, error: 'rate limited' });
});

// ---------------------------------------------------------------------------
// GET /tasks and GET /worktrees
// ---------------------------------------------------------------------------

test('GET /tasks lists tasks including closed ones', async () => {
  const calls = [];
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, count: 0, tasks: [], stats: {} };
    },
  });
  const result = await harness.request({ url: `${ROUTE_PREFIX}/tasks` });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.deepEqual(calls, [{ name: 'github_tasks', args: { action: 'list', includeClosed: true } }]);
});

test('GET /worktrees lists git worktrees', async () => {
  const calls = [];
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, repos: [] };
    },
  });
  const result = await harness.request({ url: `${ROUTE_PREFIX}/worktrees` });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.deepEqual(calls, [{ name: 'git_worktree', args: { action: 'list' } }]);
});

// ---------------------------------------------------------------------------
// POST /action
// ---------------------------------------------------------------------------

test('POST /action invokes a whitelisted tool with the supplied args', async () => {
  const calls = [];
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, polled: true };
    },
  });
  const result = await harness.request({
    method: 'POST',
    url: `${ROUTE_PREFIX}/action`,
    body: JSON.stringify({ tool: 'github_events', args: { action: 'poll', repo: 'owner/name' } }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, data: { ok: true, polled: true } });
  assert.deepEqual(calls, [{ name: 'github_events', args: { action: 'poll', repo: 'owner/name' } }]);
});

test('POST /action defaults missing args to an empty object', async () => {
  const calls = [];
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async (name, args) => {
      calls.push({ name, args });
      return {};
    },
  });
  await harness.request({
    method: 'POST',
    url: `${ROUTE_PREFIX}/action`,
    body: JSON.stringify({ tool: 'github_config' }),
  });
  assert.deepEqual(calls, [{ name: 'github_config', args: {} }]);
});

test('POST /action accepts every documented tool and the auth tool', async () => {
  const calls = [];
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async (name, args) => {
      calls.push(name);
      return { ok: true };
    },
  });
  for (const tool of ACTION_TOOLS) {
    const result = await harness.request({
      method: 'POST',
      url: `${ROUTE_PREFIX}/action`,
      body: JSON.stringify({ tool, args: { action: 'status' } }),
    });
    assert.equal(result.status, 200, `tool ${tool} should be accepted`);
  }
  assert.equal(calls.length, ACTION_TOOLS.length);
  assert.ok(calls.includes('github_auth'));
});

test('POST /action rejects a tool outside the whitelist without invoking it', async () => {
  let invoked = false;
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async () => {
      invoked = true;
      return {};
    },
  });
  const result = await harness.request({
    method: 'POST',
    url: `${ROUTE_PREFIX}/action`,
    body: JSON.stringify({ tool: 'git_push_everything', args: {} }),
  });
  assert.equal(result.status, 400);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /tool-not-allowed/);
  assert.equal(invoked, false);
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('POST /action rejects malformed bodies and args', async () => {
  const harness = setup({ snapshot: async () => ({}), invokeTool: async () => ({}) });

  const badJson = await harness.request({ method: 'POST', url: `${ROUTE_PREFIX}/action`, body: '{not json' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error, 'invalid-json');

  const missingTool = await harness.request({
    method: 'POST',
    url: `${ROUTE_PREFIX}/action`,
    body: JSON.stringify({ args: {} }),
  });
  assert.equal(missingTool.status, 400);
  assert.match(missingTool.json.error, /tool-not-allowed/);

  const arrayBody = await harness.request({ method: 'POST', url: `${ROUTE_PREFIX}/action`, body: '[]' });
  assert.equal(arrayBody.status, 400);
  assert.equal(arrayBody.json.error, 'invalid-body');

  const arrayArgs = await harness.request({
    method: 'POST',
    url: `${ROUTE_PREFIX}/action`,
    body: JSON.stringify({ tool: 'github_repos', args: [] }),
  });
  assert.equal(arrayArgs.status, 400);
  assert.equal(arrayArgs.json.error, 'invalid-args');

  const nullArgs = await harness.request({
    method: 'POST',
    url: `${ROUTE_PREFIX}/action`,
    body: JSON.stringify({ tool: 'github_repos', args: null }),
  });
  assert.equal(nullArgs.status, 400);
  assert.equal(nullArgs.json.error, 'invalid-args');
});

test('POST /action keeps expected tool failures renderable (200 + ok:false)', async () => {
  const harness = setup({
    snapshot: async () => ({}),
    invokeTool: async () => {
      const error = new Error('No GitHub token resolved. Sign in with GitHub first.');
      throw error;
    },
  });
  const result = await harness.request({
    method: 'POST',
    url: `${ROUTE_PREFIX}/action`,
    body: JSON.stringify({ tool: 'github_auth', args: { action: 'poll' } }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, {
    ok: false,
    error: 'No GitHub token resolved. Sign in with GitHub first.',
  });
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('POST /action rejects a body larger than the limit', async () => {
  const harness = setup({ snapshot: async () => ({}), invokeTool: async () => ({}) });
  const result = await harness.request({
    method: 'POST',
    url: `${ROUTE_PREFIX}/action`,
    body: 'x'.repeat(BODY_LIMIT_BYTES + 10),
  });
  assert.equal(result.status, 413);
  assert.equal(result.json.error, 'body-too-large');
});

// ---------------------------------------------------------------------------
// routing, method guard, security guard
// ---------------------------------------------------------------------------

test('unknown routes return 404 not-found', async () => {
  const harness = setup({ snapshot: async () => ({}), invokeTool: async () => ({}) });
  const result = await harness.request({ url: `${ROUTE_PREFIX}/nope` });
  assert.equal(result.status, 404);
  assert.deepEqual(result.json, { ok: false, error: 'not-found' });
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('wrong methods return 405 with an Allow header', async () => {
  const harness = setup({ snapshot: async () => ({}), invokeTool: async () => ({}) });

  const postStatus = await harness.request({ method: 'POST', url: `${ROUTE_PREFIX}/status` });
  assert.equal(postStatus.status, 405);
  assert.equal(postStatus.headers.allow, 'GET');
  assert.deepEqual(postStatus.json, { ok: false, error: 'method-not-allowed' });

  const getAction = await harness.request({ method: 'GET', url: `${ROUTE_PREFIX}/action` });
  assert.equal(getAction.status, 405);
  assert.equal(getAction.headers.allow, 'POST');

  const deleteTasks = await harness.request({ method: 'DELETE', url: `${ROUTE_PREFIX}/tasks` });
  assert.equal(deleteTasks.status, 405);
});

test('cross-site and non-loopback origins are forbidden', async () => {
  const harness = setup({ snapshot: async () => ({ ok: true }), invokeTool: async () => ({}) });

  const crossSite = await harness.request({
    url: `${ROUTE_PREFIX}/status`,
    headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(crossSite.json, { ok: false, error: 'forbidden' });

  const remoteOrigin = await harness.request({
    url: `${ROUTE_PREFIX}/status`,
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(remoteOrigin.status, 403);

  const wrongPort = await harness.request({
    url: `${ROUTE_PREFIX}/status`,
    headers: { origin: 'http://127.0.0.1:9999' },
  });
  assert.equal(wrongPort.status, 403);

  const malformed = await harness.request({
    url: `${ROUTE_PREFIX}/status`,
    headers: { origin: 'not a url' },
  });
  assert.equal(malformed.status, 403);
});

test('same-origin, loopback and non-browser clients are allowed', async () => {
  const harness = setup({ snapshot: async () => ({ ok: true }), invokeTool: async () => ({}) });

  const sameOrigin = await harness.request({
    url: `${ROUTE_PREFIX}/status`,
    headers: { 'sec-fetch-site': 'same-origin', origin: ORIGIN },
  });
  assert.equal(sameOrigin.status, 200);

  const localhost = await harness.request({
    url: `${ROUTE_PREFIX}/status`,
    headers: { origin: 'http://localhost:12869' },
  });
  assert.equal(localhost.status, 200);

  const noHeaders = await harness.request({ url: `${ROUTE_PREFIX}/status` });
  assert.equal(noHeaders.status, 200);
});

// ---------------------------------------------------------------------------
// browser half: registration shape and side-effect-free factory
// ---------------------------------------------------------------------------

function loadClientModule(extraGlobals = {}) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  let spec;
  const sandbox = {
    ...extraGlobals,
    window: {
      __ModuleLoader__: {
        load(candidate) {
          spec = candidate;
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    URL,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    RegExp,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Symbol,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(spec, 'client.js must call window.__ModuleLoader__.load({...})');
  return spec;
}

function makeReactStub() {
  class Component {
    constructor(props) {
      this.props = props;
    }
    setState() {}
  }
  const stub = {
    Component,
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
  };
  for (const hook of ['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useReducer', 'useContext']) {
    stub[hook] = () => undefined;
  }
  return stub;
}

test('client factory is side-effect free until apply(ctx) runs', () => {
  const spec = loadClientModule();
  assert.equal(spec.id, '@hitzhangjie/dsh-plugin-github-orchestrator');

  const registered = [];
  const mod = spec.factory((name) => {
    assert.equal(name, 'react', 'the factory may only require react');
    return makeReactStub();
  });
  assert.equal(typeof mod.apply, 'function');
  // `mod` comes from the vm realm, so compare structurally instead of by
  // prototype-sensitive deep equality.
  assert.deepEqual(Array.from(mod.inject), ['slots']);

  // Nothing may be registered merely by evaluating the factory.
  assert.deepEqual(registered, []);
});

test('apply(ctx) registers the sidebar icon and the main page under one key', () => {
  const spec = loadClientModule();
  const mod = spec.factory(() => makeReactStub());

  const injected = [];
  const registered = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        injected.push(name);
        callback();
        return { dispose() {} };
      },
      register(meta, component) {
        registered.push({ meta, component });
        assert.equal(typeof component, 'function');
        return { dispose() {} };
      },
    },
    get(name) {
      if (name === 'locale') {
        return { getLocale: () => ({ active: 'en' }), subscribe: () => () => {} };
      }
      return null;
    },
  };

  mod.apply(ctx);

  assert.deepEqual(injected, ['sidebar.panellist', 'main']);

  const sidebar = registered.find((entry) => entry.meta.name === 'sidebar.panellist');
  const main = registered.find((entry) => entry.meta.name === 'main');
  assert.ok(sidebar, 'sidebar.panellist must be registered');
  assert.ok(main, 'main page must be registered');
  assert.equal(sidebar.meta.id, 'github-orchestrator');
  assert.equal(sidebar.meta.order, 30);
  assert.equal(typeof sidebar.meta.label, 'function');
  assert.equal(typeof sidebar.meta.label(), 'string');

  assert.equal(main.meta.key, 'github-orchestrator');
  assert.equal(typeof main.meta.key, 'string');
  assert.equal(typeof main.component, 'function');
});

// ---------------------------------------------------------------------------
// browser half: full-render smoke test with a minimal React harness
//
// This runs client.js with fake fetch responses and checks that the page
// actually renders the panel, tabs and auth card without throwing. It is not a
// browser: a tiny hook/commit loop stands in for React, which is enough to
// catch undefined copy keys, broken normalizers and render-time crashes.
// ---------------------------------------------------------------------------

const PANEL_ROUTE = '/api/github-orchestrator';
const PANEL_ISO = '2026-11-22T10:00:00.000Z';
const PANEL_WORKSPACE = 'C:\\work\\github';
const PANEL_WORKTREE = 'C:\\work\\github\\.worktrees\\owner__name__T1';

function panelSnapshot(overrides = {}) {
  return {
    generatedAt: PANEL_ISO,
    workspaceRoot: PANEL_WORKSPACE,
    workspaceExists: true,
    stateDir: 'C:\\Users\\tester\\.dsh\\github-orchestrator',
    pollIntervalSec: 120,
    defaultBaseBranch: 'main',
    branchPrefix: 'task/',
    remote: 'origin',
    gitBinary: 'git',
    githubApiBase: 'https://api.github.com',
    token: { available: true, source: 'env', login: 'octocat', scopes: ['repo', 'read:user'] },
    repos: [
      {
        repo: 'owner/name',
        local: 'owner__name',
        dir: 'C:\\work\\github\\owner__name',
        baseBranch: 'main',
        cloned: true,
        currentBranch: 'main',
        dirty: false,
        aheadBehind: { ahead: 1, behind: 2 },
        worktrees: 1,
        activeTasks: 1,
        lastPollAt: PANEL_ISO,
      },
    ],
    events: [{ id: 'e1', repo: 'owner/name', kind: 'pr', title: 'Fix login bug', number: 7, url: 'https://github.com/owner/name/pull/7', actor: 'octocat', at: PANEL_ISO, read: false }],
    eventStats: { unread: 2, total: 5, byKind: { pr: 1 }, byRepo: { 'owner/name': 1 }, lastEventAt: PANEL_ISO },
    tasks: [
      { id: 'T1', repo: 'owner/name', title: 'Implement OAuth', status: 'in_progress', branch: 'task/T1-oauth', worktreePath: PANEL_WORKTREE, issueNumber: 3, issueUrl: 'https://github.com/owner/name/issues/3', updatedAt: PANEL_ISO },
      { id: 'T2', repo: 'owner/name', title: 'Write docs', status: 'ready', branch: 'task/T2-docs', updatedAt: PANEL_ISO },
    ],
    taskStats: { total: 2, openTasks: 2, active: 1, byStatus: { in_progress: 1, ready: 1 }, byRepo: { 'owner/name': 2 } },
    worktrees: [
      {
        repo: 'owner/name',
        dir: 'C:\\work\\github\\owner__name',
        cloned: true,
        worktrees: [
          {
            path: PANEL_WORKTREE,
            branch: 'task/T1-oauth',
            head: 'abc1234',
            dirty: false,
            taskId: 'T1',
            task: { id: 'T1', title: 'Implement OAuth', status: 'in_progress' },
          },
        ],
      },
    ],
    auth: {
      authenticated: true,
      source: 'env',
      login: 'octocat',
      scopes: ['repo'],
      clientId: 'client',
      clientIdSource: 'builtin',
      credentialsAvailable: true,
      pending: null,
    },
    dispatch: {
      enabled: true,
      sessionId: 'session-watcher-1',
      lastDispatchAt: PANEL_ISO,
      count: 3,
      lastError: null,
      lastEventAt: PANEL_ISO,
      seen: 12,
      skipped: 2,
    },
    autoDispatch: {
      enabled: true,
      kinds: ['issue', 'pr', 'review'],
      minIntervalSec: 120,
    },
    poller: { running: true, intervalSec: 120, token: true, tokenSource: 'env', watermarks: {}, lastPollAt: PANEL_ISO },
    ...overrides,
  };
}

/**
 * Default tool results for the panel's POST /action calls. Tests can override
 * any of them through `options.actionResult`.
 * @param {{ tool?: string, args?: object }} body
 */
function defaultActionResult(body) {
  const tool = body && body.tool;
  const args = (body && body.args) || {};
  if (tool === 'github_issues' && args.action === 'list') {
    return {
      ok: true,
      repo: args.repo ?? 'owner/name',
      kind: args.kind ?? 'all',
      state: args.state ?? 'open',
      count: 2,
      items: [
        {
          kind: 'issue',
          number: 101,
          title: 'Fix broken login',
          state: 'open',
          url: 'https://github.com/owner/name/issues/101',
          author: 'octocat',
          labels: ['bug', 'P1'],
          assignees: ['octocat'],
          comments: 3,
          createdAt: PANEL_ISO,
          updatedAt: PANEL_ISO,
          isPull: false,
        },
        {
          kind: 'pr',
          number: 102,
          title: 'Add OAuth login',
          state: 'open',
          url: 'https://github.com/owner/name/pull/102',
          author: 'monalisa',
          labels: ['feature'],
          assignees: [],
          comments: 1,
          createdAt: PANEL_ISO,
          updatedAt: PANEL_ISO,
          draft: false,
          merged: false,
          isPull: true,
        },
      ],
    };
  }
  if (tool === 'github_dispatch') {
    if (args.action === 'tick') {
      return { ok: true, dispatched: true, sessionId: 'session-watcher-1', taskIds: ['T9'], eventIds: ['e9'] };
    }
    if (args.action === 'send') {
      return { ok: true, sessionId: 'session-watcher-1', sent: true };
    }
    if (args.action === 'status') {
      return {
        ok: true,
        enabled: true,
        sessionId: 'session-watcher-1',
        lastDispatchAt: PANEL_ISO,
        count: 9,
        lastError: null,
        lastEventAt: PANEL_ISO,
        seen: 20,
        skipped: 1,
      };
    }
  }
  if (tool === 'github_tasks' && args.action === 'create') {
    return { ok: true, task: { id: 'T42', title: args.title } };
  }
  if (tool === 'github_config' && args.action === 'set') {
    return { ok: true };
  }
  return { ok: true };
}

/**
 * @param {object} snapshot
 * @param {{ actionResult?: (body: object) => any }} [options]
 */
function makePanelFetch(snapshot, options = {}) {
  const calls = [];
  const actions = [];
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    calls.push(text);
    const path = text.startsWith(PANEL_ROUTE) ? text.slice(PANEL_ROUTE.length) : text;
    const route = path.split('?')[0];
    if (route === '/action') {
      const body = JSON.parse(init.body ?? '{}');
      actions.push(body);
      const result = options.actionResult ? await options.actionResult(body) : defaultActionResult(body);
      return { ok: true, status: 200, json: async () => ({ ok: true, data: result }) };
    }
    let data;
    if (route === '/status') data = snapshot;
    else if (route === '/events') data = { ok: true, count: snapshot.events.length, events: snapshot.events, stats: snapshot.eventStats };
    else if (route === '/tasks') data = { ok: true, count: snapshot.tasks.length, tasks: snapshot.tasks, stats: snapshot.taskStats };
    else if (route === '/worktrees') data = { ok: true, repos: snapshot.worktrees };
    else throw new Error(`unexpected browser request: ${text}`);
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };
  return { fetchImpl, calls, actions };
}

/**
 * Minimal React replacement: useState/useCallback/useRef/useMemo/useEffect for
 * function components, class components, fragments, and a commit loop that runs
 * effects whose dependencies changed. Enough to render the panel once per
 * state change in tests, not a general React implementation.
 */
function createTestReact() {
  const Fragment = Symbol('Fragment');
  const slots = new Map();
  const rendered = new Set();
  let current = null;
  let dirty = true;

  function ensureSlot(key) {
    let slot = slots.get(key);
    if (!slot) {
      slot = { hooks: [], effects: [] };
      slots.set(key, slot);
    }
    return slot;
  }
  function slotOfCurrent() {
    return ensureSlot(current.key);
  }
  function nextRaw(initial) {
    const slot = slotOfCurrent();
    const index = current.index++;
    if (!(index in slot.hooks)) slot.hooks[index] = initial;
    return { slot, index, value: slot.hooks[index] };
  }
  function markDirty() {
    dirty = true;
  }

  class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state) : patch;
      this.state = { ...this.state, ...(next ?? {}) };
      markDirty();
    }
  }
  // React marks class components with this prototype flag; subclasses inherit it.
  Component.prototype.isReactComponent = {};

  const React = {
    Fragment,
    Component,
    createElement(type, props, ...children) {
      const nextProps = { ...(props ?? {}) };
      if (children.length === 1) nextProps.children = children[0];
      else if (children.length > 1) nextProps.children = children;
      return { $$element: true, type, props: nextProps };
    },
  };
  React.useState = (initial) => {
    const slot = slotOfCurrent();
    const index = current.index++;
    if (!(index in slot.hooks)) slot.hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [
      slot.hooks[index],
      (next) => {
        slot.hooks[index] = typeof next === 'function' ? next(slot.hooks[index]) : next;
        markDirty();
      },
    ];
  };
  React.useReducer = (reducer, initialArg) => React.useState(initialArg);
  React.useEffect = (fn, deps) => {
    const slot = slotOfCurrent();
    const index = current.index++;
    const previous = slot.effects[index];
    slot.effects[index] = {
      fn,
      deps: deps === undefined ? null : deps,
      lastDeps: previous ? previous.lastDeps : undefined,
      cleanup: previous ? previous.cleanup : undefined,
      ran: previous ? previous.ran : false,
    };
    slot.touched.add(index);
  };
  React.useCallback = (fn, deps) => {
    const slot = slotOfCurrent();
    const index = current.index++;
    const nextDeps = deps === undefined ? null : deps;
    const previous = slot.hooks[index];
    if (!previous || !sameDeps(nextDeps, previous.deps)) slot.hooks[index] = { fn, deps: nextDeps };
    return slot.hooks[index].fn;
  };
  React.useMemo = (fn, deps) => {
    const slot = slotOfCurrent();
    const index = current.index++;
    const nextDeps = deps === undefined ? null : deps;
    const previous = slot.hooks[index];
    if (!previous || !sameDeps(nextDeps, previous.deps)) slot.hooks[index] = { value: fn(), deps: nextDeps };
    return slot.hooks[index].value;
  };
  React.useRef = (initial) => {
    const slot = slotOfCurrent();
    const index = current.index++;
    if (!(index in slot.hooks)) slot.hooks[index] = { current: initial };
    return slot.hooks[index];
  };
  React.useContext = () => undefined;

  function sameDeps(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!Object.is(left[index], right[index])) return false;
    }
    return true;
  }

  function renderNode(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) {
      const output = [];
      for (const child of node) {
        const renderedChild = renderNode(child);
        if (renderedChild === null) continue;
        output.push(renderedChild);
      }
      return output;
    }
    if (!node || node.$$element !== true) return null;
    const type = node.type;
    if (type === Fragment) return renderNode(node.props.children);
    if (typeof type === 'string') {
      return { tag: type, props: node.props, children: renderNode(node.props.children) };
    }
    if (typeof type === 'function') {
      const isClass = Boolean(type.prototype && type.prototype.isReactComponent);
      const slot = ensureSlot(type);
      slot.touched = new Set();
      rendered.add(type);
      const previous = current;
      current = { key: type, index: 0 };
      let child;
      try {
        if (isClass) {
          const instance = new type(node.props);
          child = instance.render();
        } else {
          child = type(node.props);
        }
      } finally {
        current = previous;
      }
      return renderNode(child);
    }
    return null;
  }

  function runEffects() {
    for (const key of rendered) {
      const slot = slots.get(key);
      for (const index of slot.touched) {
        const effect = slot.effects[index];
        if (!effect || typeof effect.fn !== 'function') continue;
        const changed = effect.deps === null || !effect.ran || !sameDeps(effect.deps, effect.lastDeps);
        if (!changed) continue;
        try {
          if (typeof effect.cleanup === 'function') effect.cleanup();
        } catch {
          /* ignore cleanup failures in the harness */
        }
        effect.lastDeps = effect.deps;
        effect.ran = true;
        const cleanup = effect.fn();
        effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
    }
  }

  function flushTimers() {
    return new Promise((resolve) => setTimeout(resolve, 0)).then(
      () => new Promise((resolve) => setTimeout(resolve, 0)),
    );
  }

  return {
    React,
    async settle(component, props) {
      const root = React.createElement(component, props ?? {});
      let tree = null;
      for (let pass = 0; pass < 40; pass += 1) {
        dirty = false;
        rendered.clear();
        tree = renderNode(root);
        runEffects();
        await flushTimers();
        if (!dirty) break;
      }
      return tree;
    },
    dispose() {
      for (const slot of slots.values()) {
        for (const effect of slot.effects) {
          if (effect && typeof effect.cleanup === 'function') {
            try {
              effect.cleanup();
            } catch {
              /* ignore cleanup failures in the harness */
            }
          }
        }
      }
      slots.clear();
      rendered.clear();
    },
  };
}

function collectText(node, output = []) {
  if (node === null || node === undefined) return output;
  if (typeof node === 'string' || typeof node === 'number') {
    output.push(String(node));
    return output;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, output);
    return output;
  }
  if (node.tag === 'style') return output;
  collectText(node.children, output);
  return output;
}

function findRenderedNode(node, predicate) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRenderedNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'string' || typeof node === 'number') return null;
  if (predicate(node)) return node;
  return findRenderedNode(node.children, predicate);
}

function textOfRendered(node) {
  return collectText(node).join(' ');
}

/**
 * Boot the browser half, apply it to a fake ctx and render the main page.
 * @param {{ snapshot?: object, locale?: string, actionResult?: Function, ctxExtra?: object }} options
 */
async function renderPanel(options = {}) {
  const snapshot = options.snapshot ?? panelSnapshot();
  const { fetchImpl, calls, actions } = makePanelFetch(snapshot, options);
  const react = createTestReact();
  const spec = loadClientModule({ fetch: fetchImpl, document: { hidden: false }, navigator: {} });
  const mod = spec.factory(() => react.React);

  const registered = [];
  const injected = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        injected.push(name);
        callback();
        return { dispose() {} };
      },
      register(meta, component) {
        registered.push({ meta, component });
        return { dispose() {} };
      },
    },
    get(name) {
      if (name === 'locale') {
        return { getLocale: () => ({ active: options.locale ?? 'zh' }), subscribe: () => () => {} };
      }
      return null;
    },
    ...(options.ctxExtra ?? {}),
  };
  mod.apply(ctx);

  const main = registered.find((entry) => entry.meta.name === 'main');
  assert.ok(main, 'main page must be registered');
  const state = {
    tree: await react.settle(main.component, {}),
    calls,
    actions,
    registered,
    injected,
    async settle() {
      state.tree = await react.settle(main.component, {});
      return state.tree;
    },
    dispose() {
      react.dispose();
    },
  };
  return state;
}

test('panel renders the dashboard, reads only its own endpoints and switches tabs', async () => {
  const panel = await renderPanel();
  try {
    const initialText = textOfRendered(panel.tree);
    assert.match(initialText, /GitHub 任务编排器/u);
    assert.ok(initialText.includes(PANEL_WORKSPACE), 'workspace root should be visible');
    assert.ok(initialText.includes('已登录 octocat'), 'token badge should show the signed-in user');
    assert.ok(initialText.includes('Fix login bug'), 'unread event should be listed in the inbox');
    assert.ok(initialText.includes('owner/name'), 'event repo should be visible');

    // The browser may only read the plugin's own endpoints; GitHub stays Host-side.
    assert.ok(panel.calls.length > 0);
    for (const url of panel.calls) {
      assert.ok(url.startsWith(PANEL_ROUTE), `unexpected browser request: ${url}`);
    }
    assert.ok(panel.calls.some((url) => url.startsWith(`${PANEL_ROUTE}/status`)));
    assert.ok(panel.calls.some((url) => url.startsWith(`${PANEL_ROUTE}/events`)));
    for (const url of panel.calls) {
      assert.ok(!/github\.com|api\.github/u.test(url), `browser must not call GitHub directly: ${url}`);
    }

    const clickTab = async (label) => {
      const button = findRenderedNode(
        panel.tree,
        (node) => node.tag === 'button' && node.props.role === 'tab' && textOfRendered(node).includes(label),
      );
      assert.ok(button, `tab ${label} should be rendered`);
      button.props.onClick();
      await panel.settle();
    };

    await clickTab('任务');
    const tasksText = textOfRendered(panel.tree);
    assert.ok(tasksText.includes('Implement OAuth'), 'task title should render on the tasks tab');
    assert.ok(tasksText.includes('task/T1-oauth'), 'task branch should render');
    assert.ok(panel.calls.some((url) => url.startsWith(`${PANEL_ROUTE}/tasks`)));

    await clickTab('仓库');
    const reposText = textOfRendered(panel.tree);
    assert.ok(reposText.includes('owner/name'));
    assert.ok(reposText.includes('已克隆'));
    assert.ok(reposText.includes('抓取'));

    await clickTab('工作树');
    const worktreesText = textOfRendered(panel.tree);
    assert.ok(worktreesText.includes(PANEL_WORKTREE), 'worktree path should render');
    assert.ok(worktreesText.includes('删除'));
    assert.ok(panel.calls.some((url) => url.startsWith(`${PANEL_ROUTE}/worktrees`)));

    await clickTab('设置');
    const settingsText = textOfRendered(panel.tree);
    assert.ok(settingsText.includes('工作区根目录'));
    assert.ok(settingsText.includes('轮询间隔'));
    const workspaceInput = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'input' && node.props.value === PANEL_WORKSPACE,
    );
    assert.ok(workspaceInput, 'settings should show the workspace root input');
    const intervalInput = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'input' && node.props.type === 'number' && String(node.props.value) === '120',
    );
    assert.ok(intervalInput, 'settings should show the poll interval input');

    // Managed account card opens from the header and offers sign-out.
    const accountButton = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'button' && textOfRendered(node).includes('账号管理'),
    );
    assert.ok(accountButton, 'account button should be rendered');
    accountButton.props.onClick();
    await panel.settle();
    const accountText = textOfRendered(panel.tree);
    assert.ok(accountText.includes('退出登录'), 'auth card should offer sign-out');
    assert.ok(accountText.includes('octocat'));
  } finally {
    panel.dispose();
  }
});

test('panel shows sign-in and a pending device code when no token is available', async () => {
  const snapshot = panelSnapshot();
  snapshot.token = { available: false, source: 'none', login: null, scopes: null };
  snapshot.auth = {
    authenticated: false,
    source: 'none',
    login: null,
    scopes: [],
    clientId: 'client',
    clientIdSource: 'builtin',
    credentialsAvailable: false,
    pending: {
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      intervalSec: 5,
      scopes: 'repo read:user',
    },
  };
  const panel = await renderPanel({ snapshot });
  try {
    const text = textOfRendered(panel.tree);
    assert.ok(text.includes('未登录'), 'unsigned state should be visible');
    assert.ok(text.includes('ABCD-1234'), 'pending device code should be shown');
    assert.ok(text.includes('我已完成授权，继续'), 'continue button should be shown');
    assert.ok(text.includes('https://github.com/login/device'), 'verification link should be shown');

    const pollButton = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'button' && textOfRendered(node).includes('立即轮询'),
    );
    assert.ok(pollButton, 'poll now button should be rendered');
    assert.equal(pollButton.props.disabled, true, 'poll now must be disabled without a token');
  } finally {
    panel.dispose();
  }
});

test('panel renders in English when the locale service reports en', async () => {
  const panel = await renderPanel({ locale: 'en' });
  try {
    const text = textOfRendered(panel.tree);
    assert.ok(text.includes('GitHub orchestrator'));
    assert.ok(text.includes('Poll now'));
    assert.ok(text.includes('Inbox'));
    assert.ok(text.includes('Signed in as octocat'));
  } finally {
    panel.dispose();
  }
});
async function clickRenderedButton(panel, label, extraPredicate) {
  const button = findRenderedNode(
    panel.tree,
    (node) =>
      node.tag === 'button' &&
      textOfRendered(node).includes(label) &&
      (extraPredicate ? extraPredicate(node) : true),
  );
  assert.ok(button, `button ${label} should be rendered`);
  button.props.onClick();
  await panel.settle();
  return button;
}

test('panel sends repo, task, worktree and settings actions through POST /action', async () => {
  const panel = await renderPanel();
  try {
    const clickTab = async (label) => {
      await clickRenderedButton(panel, label, (node) => node.props.role === 'tab');
    };

    await clickTab('仓库');
    await clickRenderedButton(panel, '抓取');
    assert.deepEqual(panel.actions[0], { tool: 'github_repos', args: { action: 'fetch', repo: 'owner/name' } });
    assert.ok(textOfRendered(panel.tree).includes('已抓取 owner/name'));

    await clickTab('任务');
    await clickRenderedButton(panel, '同步故事板');
    assert.deepEqual(panel.actions[1], { tool: 'github_tasks', args: { action: 'sync', id: 'T1' } });

    await clickTab('工作树');
    await clickRenderedButton(panel, '删除');
    await clickRenderedButton(panel, '确认');
    assert.deepEqual(panel.actions[2], {
      tool: 'git_worktree',
      args: { action: 'remove', repo: 'owner/name', path: PANEL_WORKTREE, force: false },
    });

    await clickTab('设置');
    const workspaceInput = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'input' && node.props.value === PANEL_WORKSPACE,
    );
    assert.ok(workspaceInput);
    workspaceInput.props.onChange({ target: { value: 'C:\\work\\new' } });
    await panel.settle();
    await clickRenderedButton(panel, '保存', (node) => node.props.disabled !== true);
    const configCall = panel.actions.find(
      (call) => call.tool === 'github_config' && call.args && call.args.action === 'set',
    );
    assert.ok(configCall, 'settings save should call github_config action=set');
    assert.equal(configCall.args.workspaceRoot, 'C:\\work\\new');
  } finally {
    panel.dispose();
  }
});

test('panel dispatches a task to a new session through the client session services', async () => {
  const created = [];
  const prompts = [];
  const opened = [];
  const sessions = {
    async create(options) {
      created.push(options);
      return 'session-github-task-1';
    },
    async using(sessionId, options, operation) {
      return operation({
        sessionId,
        binding: {
          session: {
            async prompt(content, mode) {
              prompts.push({ sessionId, content, mode });
              return { ok: true, value: { accepted: true } };
            },
          },
        },
      });
    },
  };
  const uiWorkspace = {
    openSession(sessionId) {
      opened.push(sessionId);
    },
  };
  const panel = await renderPanel({
    ctxExtra: {
      inject(deps, callback) {
        callback({ sessions, uiWorkspace });
      },
    },
  });
  try {
    const textarea = findRenderedNode(panel.tree, (node) => node.tag === 'textarea');
    assert.ok(textarea, 'dispatch textarea should be rendered');
    textarea.props.onChange({ target: { value: '处理 T1：创建 worktree 并实现' } });
    await panel.settle();
    await clickRenderedButton(panel, '新建会话并派单');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await panel.settle();

    assert.equal(created.length, 1);
    assert.equal(created[0].cwd, PANEL_WORKSPACE);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionId, 'session-github-task-1');
    assert.equal(prompts[0].mode, 'queue');
    assert.equal(JSON.stringify(prompts[0].content), JSON.stringify([{ type: 'text', text: '处理 T1：创建 worktree 并实现' }]));
    assert.deepEqual(opened, ['session-github-task-1']);
    assert.match(textOfRendered(panel.tree), /已创建会话并发送任务/);
  } finally {
    panel.dispose();
  }
});

test('panel starts and finishes the GitHub device flow through POST /action', async () => {
  const snapshot = panelSnapshot();
  snapshot.token = { available: false, source: 'none', login: null, scopes: null };
  snapshot.auth = { authenticated: false, source: 'none', login: null, scopes: [], pending: null };
  const actionResult = (body) => {
    if (body.tool === 'github_auth' && body.args.action === 'start') {
      return {
        ok: true,
        userCode: 'WXYZ-9876',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        intervalSec: 5,
        scopes: 'repo read:user',
      };
    }
    if (body.tool === 'github_auth' && body.args.action === 'poll') {
      return { ok: true, authenticated: true, source: 'oauth', login: 'newuser', scopes: ['repo'] };
    }
    return { ok: true };
  };
  const panel = await renderPanel({ snapshot, actionResult });
  try {
    await clickRenderedButton(panel, '使用 GitHub 登录');
    assert.deepEqual(panel.actions[0], { tool: 'github_auth', args: { action: 'start' } });
    const pendingText = textOfRendered(panel.tree);
    assert.ok(pendingText.includes('WXYZ-9876'), 'device code should be displayed');
    assert.ok(pendingText.includes('https://github.com/login/device'), 'verification URL should be displayed');

    await clickRenderedButton(panel, '我已完成授权，继续');
    assert.deepEqual(panel.actions[1], { tool: 'github_auth', args: { action: 'poll', timeoutSec: 120 } });
    assert.ok(textOfRendered(panel.tree).includes('登录成功：newuser'));
  } finally {
    panel.dispose();
  }
});

test('issues tab lists issues and PRs and creates a storyboard task', async () => {
  const panel = await renderPanel();
  try {
    await clickRenderedButton(panel, '议题/PR', (node) => node.props.role === 'tab');

    const issuesCalls = () => panel.actions.filter((entry) => entry.tool === 'github_issues');
    assert.ok(issuesCalls().length > 0, 'opening the tab should request github_issues');
    assert.deepEqual(issuesCalls()[0].args, {
      action: 'list',
      kind: 'all',
      state: 'open',
      limit: 30,
      repo: 'owner/name',
    });

    const text = textOfRendered(panel.tree);
    assert.ok(text.includes('#101'), 'issue number should render');
    assert.ok(text.includes('Fix broken login'), 'issue title should render');
    assert.ok(text.includes('#102'), 'PR number should render');
    assert.ok(text.includes('Add OAuth login'), 'PR title should render');
    assert.ok(text.includes('作者 octocat'), 'author should render');
    assert.ok(text.includes('bug') && text.includes('P1'), 'labels should render');
    assert.ok(text.includes('打开'), 'open state chip should render');
    const issueLink = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'a' && node.props.href === 'https://github.com/owner/name/issues/101',
    );
    assert.ok(issueLink, 'GitHub link should render for the issue');

    // Changing the kind filter refetches with the new argument.
    const kindSelect = findRenderedNode(panel.tree, (node) => node.tag === 'select' && node.props.value === 'all');
    assert.ok(kindSelect, 'kind filter should render');
    kindSelect.props.onChange({ target: { value: 'pr' } });
    await panel.settle();
    const lastIssuesCall = issuesCalls()[issuesCalls().length - 1];
    assert.equal(lastIssuesCall.args.kind, 'pr');

    // State and limit filters are forwarded as well.
    const stateSelect = findRenderedNode(panel.tree, (node) => node.tag === 'select' && node.props.value === 'open');
    assert.ok(stateSelect, 'state filter should render');
    stateSelect.props.onChange({ target: { value: 'closed' } });
    await panel.settle();
    const limitSelect = findRenderedNode(panel.tree, (node) => node.tag === 'select' && node.props.value === '30');
    assert.ok(limitSelect, 'limit filter should render');
    limitSelect.props.onChange({ target: { value: '50' } });
    await panel.settle();
    const filteredCall = issuesCalls()[issuesCalls().length - 1];
    assert.equal(filteredCall.args.state, 'closed');
    assert.equal(filteredCall.args.limit, 50);

    // "Create task" posts the exact github_tasks create body for that row.
    const before = panel.actions.length;
    await clickRenderedButton(panel, '创建任务');
    const createCall = panel.actions.slice(before).find((entry) => entry.tool === 'github_tasks');
    assert.ok(createCall, 'create task should post github_tasks');
    assert.deepEqual(createCall.args, {
      action: 'create',
      repo: 'owner/name',
      title: 'Fix broken login',
      description: 'GitHub issue #101: https://github.com/owner/name/issues/101',
    });
    assert.ok(textOfRendered(panel.tree).includes('已创建任务 T42'), 'created task id should be toasted');
  } finally {
    panel.dispose();
  }
});

test('automation tab shows dispatch status and drives config and dispatch actions', async () => {
  const opened = [];
  const uiWorkspace = {
    openSession(sessionId) {
      opened.push(sessionId);
    },
  };
  const panel = await renderPanel({
    ctxExtra: {
      inject(deps, callback) {
        callback({ sessions: null, uiWorkspace });
      },
    },
  });
  try {
    await clickRenderedButton(panel, '自动化', (node) => node.props.role === 'tab');

    const statusText = textOfRendered(panel.tree);
    assert.ok(statusText.includes('自动派发'), 'auto dispatch section should render');
    assert.ok(statusText.includes('派发状态'), 'dispatch status section should render');
    assert.ok(statusText.includes('session-watcher-1'), 'watcher session id should render');
    assert.ok(statusText.includes('派发次数: 3'), 'dispatch count should render');
    assert.ok(statusText.includes('已开启'), 'enabled state should render');

    const toggle = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === '始终开启自动派发',
    );
    assert.ok(toggle, 'auto dispatch toggle should render');
    toggle.props.onChange({ target: { checked: false } });
    await panel.settle();
    assert.ok(textOfRendered(panel.tree).includes('已关闭'), 'disabled state should render');

    const reviewKind = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === '监听的类型: 评审',
    );
    assert.ok(reviewKind, 'review kind checkbox should render');
    reviewKind.props.onChange({ target: { checked: false } });
    await panel.settle();
    const pushKind = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === '监听的类型: 推送',
    );
    assert.ok(pushKind, 'push kind checkbox should render');
    pushKind.props.onChange({ target: { checked: true } });
    await panel.settle();

    const intervalInput = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'input' && node.props.type === 'number' && String(node.props.value) === '120',
    );
    assert.ok(intervalInput, 'min interval input should render');
    intervalInput.props.onChange({ target: { value: '300' } });
    await panel.settle();

    await clickRenderedButton(panel, '保存', (node) => node.props.disabled !== true);
    const configCall = panel.actions.filter((entry) => entry.tool === 'github_config').pop();
    assert.ok(configCall, 'saving automation should post github_config action=set');
    assert.deepEqual(configCall.args, {
      action: 'set',
      autoDispatch: false,
      autoDispatchKinds: ['issue', 'pr', 'push'],
      autoDispatchMinIntervalSec: 300,
    });

    await clickRenderedButton(panel, '立即检查一次');
    const tickCall = panel.actions.filter((entry) => entry.tool === 'github_dispatch' && entry.args.action === 'tick').pop();
    assert.ok(tickCall, 'run check should post github_dispatch action=tick');
    assert.ok(textOfRendered(panel.tree).includes('已派发 1 条事件到 watcher'), 'dispatch result should be toasted');

    await clickRenderedButton(panel, '刷新状态');
    const statusCall = panel.actions.filter((entry) => entry.tool === 'github_dispatch' && entry.args.action === 'status').pop();
    assert.ok(statusCall, 'refresh status should post github_dispatch action=status');
    assert.ok(textOfRendered(panel.tree).includes('派发次数: 9'), 'refreshed status should render');

    await clickRenderedButton(panel, '打开 watcher 会话');
    assert.deepEqual(opened, ['session-watcher-1'], 'openSession should receive the watcher session id');

    const sendArea = findRenderedNode(
      panel.tree,
      (node) => node.tag === 'textarea' && node.props['aria-label'] === '直接发送给 watcher',
    );
    assert.ok(sendArea, 'send-to-watcher textarea should render');
    sendArea.props.onChange({ target: { value: '处理最新 review' } });
    await panel.settle();
    await clickRenderedButton(panel, '发送');
    const sendCall = panel.actions.filter((entry) => entry.tool === 'github_dispatch' && entry.args.action === 'send').pop();
    assert.ok(sendCall, 'send should post github_dispatch action=send');
    assert.deepEqual(sendCall.args, { action: 'send', text: '处理最新 review' });
    assert.ok(textOfRendered(panel.tree).includes('已发送到会话 session-watcher-1'), 'send result should be toasted');
  } finally {
    panel.dispose();
  }
});

test('issues and automation tabs render English copy', async () => {
  const panel = await renderPanel({ locale: 'en' });
  try {
    await clickRenderedButton(panel, 'Issues/PRs', (node) => node.props.role === 'tab');
    const issuesText = textOfRendered(panel.tree);
    assert.ok(issuesText.includes('Reads issues and pull requests directly'));
    assert.ok(issuesText.includes('Create task'));
    assert.ok(issuesText.includes('by octocat'));
    assert.ok(issuesText.includes('Fix broken login'));

    await clickRenderedButton(panel, 'Automation', (node) => node.props.role === 'tab');
    const automationText = textOfRendered(panel.tree);
    assert.ok(automationText.includes('Auto dispatch'));
    assert.ok(automationText.includes('Watcher session'));
    assert.ok(automationText.includes('Run check now'));
    assert.ok(automationText.includes('Send to watcher'));
    assert.ok(automationText.includes('Dispatch status'));
  } finally {
    panel.dispose();
  }
});
