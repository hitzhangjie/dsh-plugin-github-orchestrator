/**
 * GitHub OAuth device flow (RFC 8628) for the orchestrator.
 *
 * The flow lets a user authorize from inside the plugin without registering a
 * new OAuth App: `startDeviceFlow` returns a short user code, the user enters
 * it at https://github.com/login/device, and `pollDeviceFlow` resolves with an
 * access token. The token is then handed to `lib/git.js` through its auth
 * provider so private HTTPS repositories work without SSH or a credential
 * helper.
 *
 * Node builtins only. Every network entry point accepts an injectable
 * `fetchImpl`, which keeps the tests fully offline.
 */
import { toErrorMessage } from './util.js';

/** Default scopes requested by the device flow. */
export const DEFAULT_OAUTH_SCOPES = 'repo read:user';

/**
 * Public client id of the GitHub CLI OAuth app. This is a *fallback* so local
 * installs work without registering a new OAuth App; users can override it
 * with `config.oauthClientId` or `GITHUB_OAUTH_CLIENT_ID`.
 */
export const DEFAULT_OAUTH_CLIENT_ID = '178c6fc778ccc68e1d6a';

const DEFAULT_BASE_URL = 'https://github.com';
const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'dsh-plugin-github-orchestrator';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const KNOWN_ERROR_CODES = new Set([
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
  'incorrect_device_code',
  'unsupported_grant_type',
  'invalid_client',
  'network_error',
  'timeout',
  'aborted',
]);

/** Error raised while running the OAuth device flow. */
export class DeviceFlowError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, description?: string, status?: number|null }} [details]
   */
  constructor(message, details = {}) {
    const description = typeof details.description === 'string' ? details.description : '';
    super(String(message || description || details.code || 'OAuth device flow error'));
    this.name = 'DeviceFlowError';
    this.code = typeof details.code === 'string' && details.code ? details.code : 'network_error';
    this.description = description;
    this.status = details.status === undefined ? null : details.status;
  }
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function normalizeBaseUrl(value, fallback) {
  const text = cleanString(value);
  if (!text) return fallback;
  return text.replace(/\/+$/, '');
}

function toNonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * Decide which OAuth App client id to use.
 *
 * Precedence: `config.oauthClientId` -> `GITHUB_OAUTH_CLIENT_ID` -> built-in
 * fallback. `env` defaults to `process.env` so callers can omit it.
 *
 * @param {{ config?: { oauthClientId?: unknown }|null, env?: Record<string, unknown> }} [opts]
 * @returns {{ clientId: string, source: 'config'|'env'|'builtin' }}
 */
export function resolveOAuthClientId(opts = {}) {
  const config = opts.config ?? null;
  const environment = opts.env === undefined ? process.env : opts.env;
  const configured = cleanString(config?.oauthClientId);
  if (configured) return { clientId: configured, source: 'config' };
  const fromEnv = cleanString(environment?.GITHUB_OAUTH_CLIENT_ID);
  if (fromEnv) return { clientId: fromEnv, source: 'env' };
  return { clientId: DEFAULT_OAUTH_CLIENT_ID, source: 'builtin' };
}

function abortedError() {
  return new DeviceFlowError('Device flow was aborted by the caller', { code: 'aborted' });
}

async function readJsonBody(response) {
  if (!response) return null;
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  if (typeof response.text === 'function') {
    try {
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function readHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return typeof value === 'string' ? value : null;
  }
  if (typeof headers === 'object') {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== wanted) continue;
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.join(', ');
    }
  }
  return null;
}

function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isFinite(status) ? status : null;
}

function isSuccessResponse(response) {
  if (!response) return false;
  const status = responseStatus(response);
  if (status !== null && (status < 200 || status >= 300)) return false;
  if (response.ok === false) return false;
  return true;
}

/** Build the DeviceFlowError described by a GitHub OAuth error payload. */
function errorFromPayload(payload, status) {
  const rawCode = cleanString(payload?.error) ?? 'network_error';
  const code = KNOWN_ERROR_CODES.has(rawCode) ? rawCode : 'network_error';
  const rawDescription = cleanString(payload?.error_description) ?? '';
  const description = rawDescription || (rawCode !== code ? rawCode : '');
  const message = description
    ? `GitHub OAuth error (${rawCode}): ${description}`
    : `GitHub OAuth error: ${rawCode}`;
  return new DeviceFlowError(message, { code, description, status });
}

/**
 * POST a JSON request and decode its JSON body.
 * Throws DeviceFlowError with code 'aborted' / 'timeout' / 'network_error'.
 */
async function requestJson(fetchImpl, url, init, opts = {}) {
  const { timeoutMs = 0, signal = null } = opts;
  let timer = null;
  let timeoutController = null;
  const initOut = { ...init };
  const signals = [];
  if (signal) signals.push(signal);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutController = new AbortController();
    timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    signals.push(timeoutController.signal);
  }
  if (signals.length === 1) {
    initOut.signal = signals[0];
  } else if (signals.length > 1) {
    initOut.signal = AbortSignal.any(signals);
  }
  try {
    const response = await fetchImpl(url, initOut);
    const body = await readJsonBody(response);
    return { response, body };
  } catch (error) {
    if (signal?.aborted) throw abortedError();
    if (timeoutController?.signal.aborted) {
      throw new DeviceFlowError(`OAuth request timed out after ${timeoutMs}ms`, {
        code: 'timeout',
      });
    }
    if (error instanceof DeviceFlowError) throw error;
    throw new DeviceFlowError(`OAuth request failed: ${toErrorMessage(error)}`, {
      code: 'network_error',
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const timer = setTimeout(() => {
      if (typeof signal?.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    if (typeof signal?.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Begin the device flow: ask GitHub for a user code the user types in a browser.
 *
 * @param {{
 *   clientId: string,
 *   scopes?: string,
 *   fetchImpl?: Function,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ deviceCode: string, userCode: string, verificationUri: string,
 *   expiresIn: number, interval: number, clientId: string, scopes: string }>}
 */
export async function startDeviceFlow(opts = {}) {
  const clientId = cleanString(opts.clientId);
  if (!clientId) throw new Error('startDeviceFlow requires a clientId');
  const scopes = cleanString(opts.scopes) ?? DEFAULT_OAUTH_SCOPES;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('startDeviceFlow requires a fetch implementation');
  const baseUrl = normalizeBaseUrl(opts.baseUrl, DEFAULT_BASE_URL);
  const timeoutMs = toNonNegativeNumber(opts.timeoutMs, 0);

  const { response, body } = await requestJson(
    fetchImpl,
    `${baseUrl}/login/device/code`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client_id: clientId, scope: scopes }),
    },
    { timeoutMs },
  );

  const status = responseStatus(response);
  if (!isSuccessResponse(response) || body?.error) {
    throw errorFromPayload(body, status);
  }
  const deviceCode = cleanString(body?.device_code);
  const userCode = cleanString(body?.user_code);
  if (!deviceCode || !userCode) {
    throw new DeviceFlowError('Malformed device code response from GitHub', {
      code: 'network_error',
      description: 'response is missing device_code or user_code',
      status,
    });
  }
  return {
    deviceCode,
    userCode,
    verificationUri: cleanString(body.verification_uri) ?? cleanString(body.verification_url) ?? '',
    expiresIn: toNonNegativeNumber(body.expires_in, 900),
    interval: toNonNegativeNumber(body.interval, 5),
    clientId,
    scopes,
  };
}

/**
 * Poll `POST /login/oauth/access_token` until the user authorizes, the code
 * expires, the request is aborted, or `maxWaitMs` elapses.
 *
 * @param {{
 *   clientId: string,
 *   deviceCode: string,
 *   intervalSec?: number,
 *   expiresInSec?: number,
 *   fetchImpl?: Function,
 *   baseUrl?: string,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   signal?: AbortSignal,
 *   maxWaitMs?: number,
 * }} opts
 * @returns {Promise<{ accessToken: string, tokenType: string, scope: string }>}
 */
export async function pollDeviceFlow(opts = {}) {
  const clientId = cleanString(opts.clientId);
  if (!clientId) throw new Error('pollDeviceFlow requires a clientId');
  const deviceCode = cleanString(opts.deviceCode);
  if (!deviceCode) throw new Error('pollDeviceFlow requires a deviceCode');

  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('pollDeviceFlow requires a fetch implementation');
  const baseUrl = normalizeBaseUrl(opts.baseUrl, DEFAULT_BASE_URL);
  const signal = opts.signal ?? null;
  const sleepImpl = typeof opts.sleep === 'function' ? opts.sleep : null;
  const nowMs = typeof opts.now === 'function' ? opts.now : () => Date.now();

  let intervalMs = toNonNegativeNumber(opts.intervalSec, 5) * 1000;
  const expiresInMs = toNonNegativeNumber(opts.expiresInSec, 900) * 1000;
  const maxWaitMs = Number(opts.maxWaitMs);
  const startedAt = nowMs();
  const expiresAt = startedAt + expiresInMs;
  const hardDeadline =
    Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? Math.min(expiresAt, startedAt + maxWaitMs) : expiresAt;

  const wait = async (ms) => {
    if (signal?.aborted) throw abortedError();
    if (sleepImpl) {
      await sleepImpl(ms);
      if (signal?.aborted) throw abortedError();
      return;
    }
    await abortableSleep(ms, signal);
  };

  for (;;) {
    if (signal?.aborted) throw abortedError();
    const current = nowMs();
    if (current > expiresAt) {
      throw new DeviceFlowError('The device code expired before authorization completed', {
        code: 'timeout',
        description: 'device code expired',
      });
    }
    if (current >= hardDeadline) {
      throw new DeviceFlowError('The device flow did not complete in time', {
        code: 'timeout',
        description: 'max wait exceeded',
      });
    }

    const { response, body } = await requestJson(
      fetchImpl,
      `${baseUrl}/login/oauth/access_token`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: DEVICE_CODE_GRANT,
        }),
      },
      { signal },
    );

    const payload = body ?? {};
    if (payload.error) {
      const code = String(payload.error);
      if (code === 'authorization_pending') {
        await wait(intervalMs);
        continue;
      }
      if (code === 'slow_down') {
        intervalMs += 5000;
        await wait(intervalMs);
        continue;
      }
      throw errorFromPayload(payload, responseStatus(response));
    }

    const accessToken = cleanString(payload.access_token);
    if (accessToken) {
      return {
        accessToken,
        tokenType: cleanString(payload.token_type) ?? 'bearer',
        scope: typeof payload.scope === 'string' ? payload.scope : '',
      };
    }
    throw new DeviceFlowError('Malformed access token response from GitHub', {
      code: 'network_error',
      description: 'response contains neither error nor access_token',
      status: responseStatus(response),
    });
  }
}

/**
 * Read the authenticated user with a token. Scopes come from the
 * `x-oauth-scopes` response header.
 *
 * @param {{ token: string, fetchImpl?: Function, apiBase?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ login: string, id: number|null, name: string|null, scopes: string[] }>}
 */
export async function fetchGitHubUser(opts = {}) {
  const token = cleanString(opts.token);
  if (!token) throw new Error('fetchGitHubUser requires a token');
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetchGitHubUser requires a fetch implementation');
  const apiBase = normalizeBaseUrl(opts.apiBase, DEFAULT_API_BASE);
  const timeoutMs = toNonNegativeNumber(opts.timeoutMs, 10000);

  const { response, body } = await requestJson(
    fetchImpl,
    `${apiBase}/user`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': DEFAULT_USER_AGENT,
      },
    },
    { timeoutMs },
  );

  const status = responseStatus(response);
  if (!isSuccessResponse(response)) {
    const detail = cleanString(body?.message);
    const error = new Error(
      `GitHub user request failed with status ${status ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
    );
    error.status = status;
    throw error;
  }
  if (!body || typeof body !== 'object') {
    const error = new Error('GitHub user response was not valid JSON');
    error.status = status;
    throw error;
  }

  const scopesHeader = readHeader(response, 'x-oauth-scopes');
  const scopes = scopesHeader
    ? scopesHeader
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean)
    : [];

  return {
    login: cleanString(body.login) ?? '',
    id: typeof body.id === 'number' && Number.isFinite(body.id) ? body.id : null,
    name: cleanString(body.name),
    scopes,
  };
}
