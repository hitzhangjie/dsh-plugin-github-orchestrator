/**
 * Host HTTP API for the GitHub orchestrator browser panel.
 *
 * The browser half (`client.js`) never talks to GitHub itself: every data read
 * and every action is funnelled through this loopback route, which delegates to
 * the Host runtime (`runtime.snapshot()` / `runtime.invokeTool()`). That keeps
 * the OAuth token, the Git binary and the filesystem on the Host side.
 *
 * Protocol (every response is JSON with `cache-control: no-store`):
 *   GET  <prefix>/status    -> { ok:true, data: await runtime.snapshot() }
 *   GET  <prefix>/events    -> { ok:true, data: await invokeTool('github_events', {...}) }
 *   GET  <prefix>/tasks     -> { ok:true, data: await invokeTool('github_tasks', {...}) }
 *   GET  <prefix>/worktrees -> { ok:true, data: await invokeTool('git_worktree', {...}) }
 *   POST <prefix>/action    -> { ok:true, data: await invokeTool(tool, args) }
 *
 * Errors use `{ ok:false, error:"message" }`. A tool that rejects is reported as
 * HTTP 200 with `ok:false` so the panel can render the message inline; only a
 * malformed request (bad JSON, unknown tool, bad args) is a 400. Unknown routes
 * are 404, wrong methods 405, and non-same-origin/non-loopback callers 403.
 */

/** Route prefix owned by this plugin; mirrors the browser half. */
export const ROUTE_PREFIX = '/api/github-orchestrator';

/**
 * Tools the panel may invoke through `POST /action`. Everything here is a
 * deliberate, explicit user action; the list is frozen so a browser cannot ask
 * the Host to run arbitrary registered tools.
 */
export const ACTION_TOOLS = Object.freeze([
  'github_config',
  'github_repos',
  'github_issues',
  'github_events',
  'github_tasks',
  'github_dispatch',
  'git_worktree',
  'git_sync',
  'github_auth',
]);

/** Upper bound for a `POST /action` request body. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

/** Maximum events a single `GET /events` may request. */
export const MAX_EVENTS_LIMIT = 200;

const GET_ROUTES = new Set(['/status', '/events', '/tasks', '/worktrees']);

/** @param {unknown} error */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error ?? 'unknown error');
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} payload
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, statusCode, payload, headers) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (headers) {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  }
  res.end(JSON.stringify(payload === undefined ? null : payload));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string[]} methods
 */
function sendMethodNotAllowed(res, methods) {
  sendJson(res, 405, { ok: false, error: 'method-not-allowed' }, { allow: methods.join(', ') });
}

/**
 * Read and decode a JSON request body, with a hard size cap.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
function readBody(req, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        const error = new Error('request body too large');
        error.code = 'BODY_TOO_LARGE';
        fail(error);
        try {
          req.destroy?.();
        } catch {
          /* the connection is already unusable */
        }
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => fail(error));
  });
}

/**
 * Only the Harness Web UI (same origin) or a local non-browser client may use
 * this API. This is the same defence line the bookmarks plugin uses: a page on
 * another origin cannot read the user's GitHub token state or trigger actions.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [port]
 * @returns {boolean}
 */
export function requestAllowed(req, port) {
  const headers = req?.headers ?? {};
  const site = headers['sec-fetch-site'];
  if (typeof site === 'string' && site.length > 0 && site !== 'same-origin' && site !== 'none') {
    return false;
  }
  const origin = headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.replace(/^\[/u, '').replace(/\]$/u, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
    if (typeof port === 'number' && port > 0 && parsed.port !== '' && Number(parsed.port) !== port) return false;
  }
  return true;
}

/**
 * @param {unknown} raw
 * @returns {number|undefined} clamped 1..MAX_EVENTS_LIMIT
 */
function parseLimit(raw) {
  if (raw === null || raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(MAX_EVENTS_LIMIT, Math.max(1, Math.round(value)));
}

/**
 * @param {string|null} raw
 * @returns {boolean}
 */
function parseUnread(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Split an optional comma-separated query value into a clean string list.
 * @param {string|null} raw
 * @returns {string[]}
 */
function parseList(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * @param {object} runtime
 * @param {string} tool
 * @param {object} args
 * @returns {Promise<unknown>}
 */
async function invoke(runtime, tool, args) {
  if (!runtime || typeof runtime.invokeTool !== 'function') {
    throw new Error('runtime.invokeTool is unavailable');
  }
  return runtime.invokeTool(tool, args);
}

/**
 * @param {object} runtime
 * @returns {Promise<unknown>}
 */
async function readSnapshot(runtime) {
  if (!runtime || typeof runtime.snapshot !== 'function') {
    throw new Error('runtime.snapshot is unavailable');
  }
  return runtime.snapshot();
}

/**
 * Register the panel's HTTP route on the Harness web server.
 *
 * @param {{ webServer?: { register?: Function, port?: number }, logger?: { warn?: Function } }} ctx
 * @param {{ snapshot?: () => Promise<unknown>, invokeTool?: (name: string, args: object) => Promise<unknown> }} runtime
 * @returns {() => void} disposer for the route; also safe to call twice.
 */
export function registerWebRoutes(ctx, runtime) {
  // The plugin also activates headless, so index.js does not hard-inject
  // `webServer`; it is resolved from the service container instead.
  let webServer = ctx?.webServer;
  if (!webServer && typeof ctx?.get === 'function') {
    try {
      webServer = ctx.get('webServer');
    } catch {
      webServer = undefined;
    }
  }
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('registerWebRoutes needs a webServer that exposes register()');
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const handler = async (req, res) => {
    const port = typeof webServer.port === 'number' ? webServer.port : undefined;
    if (!requestAllowed(req, port)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }

    let action;
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
      action = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-request' });
      return;
    }

    try {
      if (action === '/action') {
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res, ['POST']);
          return;
        }
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch (error) {
          const status = error && error.code === 'BODY_TOO_LARGE' ? 413 : 400;
          sendJson(res, status, { ok: false, error: error && error.code === 'BODY_TOO_LARGE' ? 'body-too-large' : 'invalid-json' });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: 'invalid-body' });
          return;
        }
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        if (!ACTION_TOOLS.includes(tool)) {
          sendJson(res, 400, { ok: false, error: `tool-not-allowed: ${tool || '(missing)'}` });
          return;
        }
        const rawArgs = body.args;
        if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
          sendJson(res, 400, { ok: false, error: 'invalid-args' });
          return;
        }
        try {
          const data = await invoke(runtime, tool, rawArgs ?? {});
          sendJson(res, 200, { ok: true, data });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: messageOf(error) });
        }
        return;
      }

      if (GET_ROUTES.has(action)) {
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res, ['GET']);
          return;
        }
        try {
          if (action === '/status') {
            sendJson(res, 200, { ok: true, data: await readSnapshot(runtime) });
            return;
          }
          if (action === '/events') {
            const params = url.searchParams;
            const args = { action: 'list', unreadOnly: parseUnread(params.get('unread')) };
            const limit = parseLimit(params.get('limit'));
            if (limit !== undefined) args.limit = limit;
            const repo = (params.get('repo') ?? '').trim();
            if (repo.length > 0) args.repo = repo;
            const kinds = parseList(params.get('kinds'));
            if (kinds.length > 0) args.kinds = kinds;
            sendJson(res, 200, { ok: true, data: await invoke(runtime, 'github_events', args) });
            return;
          }
          if (action === '/tasks') {
            sendJson(res, 200, { ok: true, data: await invoke(runtime, 'github_tasks', { action: 'list', includeClosed: true }) });
            return;
          }
          // action === '/worktrees'
          sendJson(res, 200, { ok: true, data: await invoke(runtime, 'git_worktree', { action: 'list' }) });
          return;
        } catch (error) {
          sendJson(res, 200, { ok: false, error: messageOf(error) });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not-found' });
    } catch (error) {
      // Last-resort guard: the HTTP handler must never reject into the server.
      try {
        ctx?.logger?.warn?.(`[github-orchestrator] web ${req.method} ${action}: ${messageOf(error)}`);
      } catch {
        /* logging must not throw */
      }
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: messageOf(error) });
    }
  };

  const disposer = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler,
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof disposer === 'function') disposer();
  };
}

export default registerWebRoutes;
