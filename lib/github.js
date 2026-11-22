/**
 * Minimal GitHub REST client for the orchestrator plugin.
 *
 * Uses the global `fetch` (Node >= 22) and only Node builtins. The client is
 * stateless apart from rate-limit bookkeeping; `fetchImpl` is injectable so
 * tests can run fully offline against a stub or the in-process mock server.
 */
import { nowIso, redactToken, toErrorMessage } from './util.js';
import { resolveGitHubToken } from './auth.js';

export { resolveGitHubToken };
export {
  CREDENTIAL_KEY,
  TOKEN_ENV_KEYS,
  readCredentialRecord,
  readGhToken,
  tokenFromRecord,
  describeTokenSource,
} from './auth.js';

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'dsh-plugin-github-orchestrator/0.1.0';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/** Error thrown for non-2xx GitHub responses, network failures and rate limits. */
export class GitHubError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'GitHubError';
    /** HTTP status, 0 for transport errors. */
    this.status = Number.isFinite(opts.status) ? opts.status : 0;
    /** Machine-readable code: 'http_error' | 'rate_limited' | 'network_error' | 'timeout'. */
    this.code = opts.code ?? 'http_error';
    this.url = opts.url ?? null;
    this.body = opts.body ?? null;
    this.rateLimitRemaining = Number.isFinite(opts.rateLimitRemaining) ? opts.rateLimitRemaining : null;
    this.rateLimitReset = opts.rateLimitReset ?? null;
  }

  /** Redacted JSON-friendly representation, safe for logs and tool output. */
  toJSON() {
    return {
      name: this.name,
      message: redactToken(this.message),
      status: this.status,
      code: this.code,
      url: this.url ? redactToken(this.url) : null,
      rateLimitRemaining: this.rateLimitRemaining,
      rateLimitReset: this.rateLimitReset,
    };
  }
}

/**
 * Accepts "owner/name", a GitHub URL, or an SSH remote and returns
 * `{ owner, name, repo }` with repo = "owner/name".
 * @param {string} full
 */
export function parseRepo(full) {
  let text = String(full ?? '').trim();
  if (!text) throw new Error('Repository is required, expected "owner/name"');
  const sshMatch = text.match(/^git@[^:]+:(.+)$/);
  if (sshMatch) {
    text = sshMatch[1];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      throw new Error(`Invalid repository URL "${full}"`);
    }
    text = parsed.pathname;
  }
  text = text.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = text.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid repository "${full}": expected "owner/name"`);
  }
  // Only the leading owner/name pair matters; extra segments (e.g. a URL path
  // such as /tree/main) are ignored.
  const owner = parts[0];
  const name = parts[1];
  const valid = /^[A-Za-z0-9._-]+$/;
  if (!valid.test(owner) || !valid.test(name)) {
    throw new Error(`Invalid repository "${full}": expected "owner/name"`);
  }
  return { owner, name, repo: `${owner}/${name}` };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function headersToObject(headers) {
  const result = {};
  if (!headers) return result;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      result[String(key).toLowerCase()] = String(value);
    });
    return result;
  }
  for (const [key, value] of Object.entries(headers)) {
    result[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

function parseBody(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function numberOfHeader(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoFromEpochSeconds(value) {
  const seconds = numberOfHeader(value);
  if (seconds === null) return null;
  return new Date(seconds * 1000).toISOString();
}

function redactUrl(url) {
  return redactToken(String(url ?? ''));
}

export class GitHubClient {
  /**
   * @param {{ token?: string, apiBase?: string, userAgent?: string, fetchImpl?: Function,
   *   timeoutMs?: number, logger?: object, retryDelayMs?: number, maxRetries?: number }} [opts]
   */
  constructor(opts = {}) {
    const token = typeof opts.token === 'string' ? opts.token.trim() : '';
    this.token = token || null;
    this.apiBase = String(opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.userAgent = String(opts.userAgent ?? DEFAULT_USER_AGENT);
    this.fetchImpl =
      typeof opts.fetchImpl === 'function'
        ? opts.fetchImpl
        : (url, init) => globalThis.fetch(url, init);
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs : DEFAULT_RETRY_DELAY_MS;
    this.maxRetries = Number.isFinite(opts.maxRetries) ? Math.max(0, opts.maxRetries) : 2;
    this.logger = opts.logger ?? null;
    this._rateLimitRemaining = null;
    this._rateLimitReset = null;
  }

  /** Build the absolute request URL, appending defined query parameters. */
  buildUrl(path, query) {
    const rawPath = String(path ?? '');
    const url = /^https?:\/\//i.test(rawPath)
      ? new URL(rawPath)
      : new URL(`${this.apiBase}${rawPath.startsWith('/') ? '' : '/'}${rawPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, typeof value === 'boolean' ? String(value) : String(value));
      }
    }
    return url.toString();
  }

  _updateRateLimit(headers) {
    const remaining = headers?.['x-ratelimit-remaining'];
    const reset = headers?.['x-ratelimit-reset'];
    if (remaining !== undefined) this._rateLimitRemaining = numberOfHeader(remaining);
    if (reset !== undefined) this._rateLimitReset = isoFromEpochSeconds(reset);
  }

  _errorFromResponse(method, url, status, headers, data) {
    const remaining = numberOfHeader(headers?.['x-ratelimit-remaining']);
    const resetAt = isoFromEpochSeconds(headers?.['x-ratelimit-reset']);
    const detail = typeof data?.message === 'string' ? data.message : typeof data === 'string' ? data : '';
    const rateLimited =
      (status === 403 && remaining === 0) || (status === 429 && (remaining === 0 || remaining === null));
    if (rateLimited) {
      return new GitHubError(
        `GitHub API rate limit exceeded for ${method} ${redactUrl(url)}; resets at ${resetAt ?? 'unknown'}`,
        { status, code: 'rate_limited', url, body: data, rateLimitRemaining: remaining, rateLimitReset: resetAt },
      );
    }
    const message = `GitHub API ${method} ${redactUrl(url)} failed with status ${status}${detail ? `: ${redactToken(detail)}` : ''}`;
    return new GitHubError(message, {
      status,
      code: 'http_error',
      url,
      body: data,
      rateLimitRemaining: remaining,
      rateLimitReset: resetAt,
    });
  }

  /**
   * Perform one HTTP request with auth headers, timeout, conditional ETag
   * support and retries (2x by default) on 502/503/504 and network errors.
   * @returns {Promise<{status:number, headers:Record<string,string>, data:any, etag?:string, notModified?:boolean}>}
   */
  async request(method, path, opts = {}) {
    const upperMethod = String(method ?? 'GET').toUpperCase();
    const url = this.buildUrl(path, opts.query);
    const headers = {
      Accept: String(opts.accept ?? 'application/vnd.github+json'),
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.userAgent,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (opts.etag) headers['If-None-Match'] = String(opts.etag);
    let bodyText;
    if (opts.body !== undefined && opts.body !== null) {
      headers['Content-Type'] = 'application/json';
      bodyText = JSON.stringify(opts.body);
    }
    const allowStatus = new Set(Array.isArray(opts.allowStatus) ? opts.allowStatus : []);
    let lastError = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
        this.logger?.debug?.(`retrying GitHub request (attempt ${attempt + 1}/${this.maxRetries + 1}): ${upperMethod} ${redactUrl(url)}`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: upperMethod,
          headers,
          body: bodyText,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const aborted = error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
        lastError = new GitHubError(
          aborted
            ? `GitHub API ${upperMethod} ${redactUrl(url)} timed out after ${this.timeoutMs}ms`
            : `GitHub API ${upperMethod} ${redactUrl(url)} failed: ${redactToken(toErrorMessage(error))}`,
          { status: 0, code: aborted ? 'timeout' : 'network_error', url },
        );
        continue;
      }
      clearTimeout(timer);

      let rawText = '';
      try {
        rawText = await response.text();
      } catch {
        rawText = '';
      }
      const data = parseBody(rawText);
      const responseHeaders = headersToObject(response.headers);
      const status = Number(response.status ?? 0);
      this._updateRateLimit(responseHeaders);

      if (RETRYABLE_STATUSES.has(status) && attempt < this.maxRetries) {
        lastError = this._errorFromResponse(upperMethod, url, status, responseHeaders, data);
        this.logger?.warn?.(lastError.message);
        continue;
      }

      if (status === 304) {
        return {
          status,
          headers: responseHeaders,
          data: null,
          etag: responseHeaders.etag ?? opts.etag ?? undefined,
          notModified: true,
        };
      }
      if ((status >= 200 && status < 300) || allowStatus.has(status)) {
        const result = { status, headers: responseHeaders, data };
        if (responseHeaders.etag) result.etag = responseHeaders.etag;
        return result;
      }
      throw this._errorFromResponse(upperMethod, url, status, responseHeaders, data);
    }
    throw lastError ?? new GitHubError(`GitHub API ${upperMethod} ${redactUrl(url)} failed`, { status: 0, code: 'network_error', url });
  }

  get(path, opts = {}) {
    return this.request('GET', path, opts);
  }

  post(path, body, opts = {}) {
    return this.request('POST', path, { ...opts, body });
  }

  patch(path, body, opts = {}) {
    return this.request('PATCH', path, { ...opts, body });
  }

  put(path, body, opts = {}) {
    return this.request('PUT', path, { ...opts, body });
  }

  del(path, opts = {}) {
    return this.request('DELETE', path, opts);
  }

  /**
   * Walk a paginated list endpoint. Stops on an empty/short page or at maxPages.
   * @returns {Promise<any[]>}
   */
  async paginate(path, opts = {}) {
    const perPage = Number.isFinite(opts.perPage) ? opts.perPage : 100;
    const maxPages = Number.isFinite(opts.maxPages) ? Math.max(1, opts.maxPages) : 10;
    const results = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.get(path, {
        query: { ...(opts.query ?? {}), per_page: perPage, page },
        allowStatus: opts.allowStatus,
      });
      const data = response.data;
      if (!Array.isArray(data) || data.length === 0) break;
      results.push(...data);
      if (data.length < perPage) break;
    }
    return results;
  }

  /** Last observed GitHub rate-limit state. */
  rateLimit() {
    return { remaining: this._rateLimitRemaining, resetAt: this._rateLimitReset };
  }

  /** Timestamp helper kept for parity with the util module (`nowIso`). */
  static nowIso() {
    return nowIso();
  }
}
