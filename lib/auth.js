/**
 * GitHub token resolution.
 *
 * Resolution order (first hit wins):
 *   1. explicit token passed in the config        -> source 'config'
 *   2. credentials record 'github-orchestrator'   -> source 'credentials'
 *   3. environment GITHUB_TOKEN or GH_TOKEN       -> source 'env'
 *   4. `gh auth token` from the GitHub CLI        -> source 'gh-cli'
 * otherwise { token: null, source: 'none' }.
 *
 * No secret is ever logged here; callers should still pass any error text
 * through `redactToken` before surfacing it.
 */
import { execFile } from 'node:child_process';

import { toErrorMessage } from './util.js';

/** Key under which the DSH credentials service stores this plugin's token record. */
export const CREDENTIAL_KEY = 'github-orchestrator';

/** Environment variables checked in order. */
export const TOKEN_ENV_KEYS = Object.freeze(['GITHUB_TOKEN', 'GH_TOKEN']);

function cleanToken(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token.length > 0 ? token : null;
}

/** Extract a token from a credential record (string, or object with token/secret/value). */
export function tokenFromRecord(record) {
  if (!record) return null;
  if (typeof record === 'string') return cleanToken(record);
  if (typeof record !== 'object') return null;
  for (const key of ['token', 'secret', 'value', 'apiKey']) {
    const token = cleanToken(record[key]);
    if (token) return token;
  }
  return null;
}

/**
 * Read the plugin credential record from a DSH credentials service.
 * Accepts the DSH service shape (`readRecord`), a generic `get`/`read` method,
 * or a plain object keyed by the record name. Never throws.
 */
export async function readCredentialRecord(credentials, key = CREDENTIAL_KEY) {
  if (!credentials) return null;
  try {
    if (typeof credentials.readRecord === 'function') return await credentials.readRecord(key);
    if (typeof credentials.get === 'function') return await credentials.get(key);
    if (typeof credentials.read === 'function') return await credentials.read(key);
    if (typeof credentials === 'object' && credentials && key in credentials) return credentials[key];
  } catch {
    return null;
  }
  return null;
}

/**
 * Run `gh auth token` and return its trimmed stdout, or null when the CLI is
 * missing / not authenticated / times out.
 *
 * `opts.execImpl(command, args)` is a test hook: when provided it is awaited
 * instead of spawning a process.
 */
export async function readGhToken(opts = {}) {
  const args = ['auth', 'token'];
  if (typeof opts.execImpl === 'function') {
    try {
      return cleanToken(String((await opts.execImpl(opts.ghBinary ?? 'gh', args)) ?? ''));
    } catch {
      return null;
    }
  }
  const env = { ...process.env, ...(opts.env ?? {}) };
  if (opts.homeDir) {
    env.HOME = opts.homeDir;
    env.USERPROFILE = opts.homeDir;
  }
  const timeout = Number.isFinite(opts.ghTimeoutMs) ? opts.ghTimeoutMs : 5000;
  return await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = execFile(
        opts.ghBinary ?? 'gh',
        args,
        { env, timeout, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            done(null);
            return;
          }
          done(cleanToken(String(stdout ?? '')));
        },
      );
      child.on('error', () => done(null));
    } catch {
      done(null);
    }
  });
}

/**
 * Resolve the GitHub token for the plugin.
 * @param {{
 *   explicit?: string,
 *   env?: object,
 *   credentials?: object,
 *   homeDir?: string,
 *   ghBinary?: string,
 *   ghTimeoutMs?: number,
 *   execImpl?: (command: string, args: string[]) => Promise<string>|string,
 * }} [opts]
 * @returns {Promise<{ token: string|null, source: 'config'|'credentials'|'env'|'gh-cli'|'none' }>}
 */
export async function resolveGitHubToken(opts = {}) {
  const explicit = cleanToken(opts.explicit);
  if (explicit) return { token: explicit, source: 'config' };

  const record = await readCredentialRecord(opts.credentials);
  const credentialToken = tokenFromRecord(record);
  if (credentialToken) return { token: credentialToken, source: 'credentials' };

  const env = opts.env ?? process.env;
  for (const key of TOKEN_ENV_KEYS) {
    const token = cleanToken(env?.[key]);
    if (token) return { token, source: 'env' };
  }

  const ghToken = await readGhToken(opts);
  if (ghToken) return { token: ghToken, source: 'gh-cli' };

  return { token: null, source: 'none' };
}

/** Human readable description of a token source, safe for tool output. */
export function describeTokenSource(source) {
  switch (source) {
    case 'config':
      return 'plugin config';
    case 'credentials':
      return 'stored credentials';
    case 'env':
      return 'environment variable';
    case 'gh-cli':
      return 'GitHub CLI';
    default:
      return 'missing';
  }
}

export { toErrorMessage };
