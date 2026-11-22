/**
 * Git primitives used by the orchestrator.
 *
 * Every command runs through `spawn` with `shell: false`, so branch names,
 * refs and paths are never interpreted by a shell. `runGit` reports non-zero
 * exits as values; the higher level helpers throw `GitError` when a non-zero
 * exit is a real failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { splitLines, toErrorMessage } from './util.js';

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

const GIT_ENV_DEFAULTS = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  LC_ALL: 'C',
};

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Optional provider supplying the GitHub token used for HTTPS remotes.
 * Kept as module state so callers that already use the plain git helpers get
 * token-authenticated clones/fetches/pushes without passing an env everywhere.
 * @type {null | (() => { token?: string|null } | null)}
 */
let gitAuthProvider = null;

/**
 * Install the token provider used by every `runGit` child process. Pass null
 * (or any non-function) to clear it.
 *
 * @param {null | (() => { token?: string|null } | null)} provider
 * @returns {void}
 */
export function setGitAuthProvider(provider) {
  gitAuthProvider = typeof provider === 'function' ? provider : null;
}

/**
 * Build the child-process environment that authenticates `https://github.com`
 * with an OAuth/PAT token through git's `http.<url>.extraheader` setting.
 *
 * The token lives only in the child env (`GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`):
 * it never appears in argv or in `.git/config`, and no credential helper or SSH
 * key is involved. Returns `{}` when there is no token.
 *
 * @param {{ token?: string|null } | null | undefined} auth
 * @returns {Record<string, string>}
 */
export function buildGitAuthEnv(auth) {
  const token = typeof auth?.token === 'string' ? auth.token.trim() : '';
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Auth env from the installed provider; a throwing provider is ignored. */
function gitAuthEnv() {
  if (!gitAuthProvider) return {};
  try {
    return buildGitAuthEnv(gitAuthProvider());
  } catch {
    return {};
  }
}

/** Error raised by git helpers; carries the command that failed. */
export class GitError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number|null, stdout?: string, stderr?: string, args?: string[], cwd?: string|null }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'GitError';
    this.exitCode = details.exitCode ?? null;
    this.stdout = details.stdout ?? '';
    this.stderr = details.stderr ?? '';
    this.args = Array.isArray(details.args) ? details.args.slice() : [];
    this.cwd = details.cwd ?? null;
  }
}

/** Canonical absolute path, falling back to `path.resolve` when missing. */
function canonicalPath(target) {
  const resolved = path.resolve(String(target));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function gitEnv(extra) {
  // Order matters: process env < hardened defaults < OAuth auth env < caller env.
  return { ...process.env, ...GIT_ENV_DEFAULTS, ...gitAuthEnv(), ...(extra ?? {}) };
}

function gitFailure(result, args, cwd) {
  const command = ['git', ...args].join(' ');
  const detail = String(result.stderr ?? '').trim() || String(result.stdout ?? '').trim();
  const message = `${command} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ''}`;
  return new GitError(message, {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    args,
    cwd: cwd ? path.resolve(String(cwd)) : null,
  });
}

function unquotePath(value) {
  const text = String(value ?? '');
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return text;
}

function statusFilePath(rawPath) {
  let filePath = String(rawPath ?? '');
  const arrow = filePath.lastIndexOf(' -> ');
  if (arrow >= 0) filePath = filePath.slice(arrow + 4);
  return unquotePath(filePath.trim());
}

function parseStatusFiles(statusText) {
  const files = [];
  for (const line of String(statusText ?? '').split(/\r?\n/)) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const filePath = statusFilePath(line.slice(3));
    if (!filePath) continue;
    files.push({ status, path: filePath });
  }
  return files;
}

async function symbolicBranch(dir, gitBinary) {
  try {
    const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: dir,
      gitBinary,
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isRebaseInProgress(repoDir, gitBinary) {
  try {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const result = await runGit(['rev-parse', '--git-path', name], { cwd: repoDir, gitBinary });
      if (result.exitCode !== 0) continue;
      const target = path.resolve(repoDir, result.stdout.trim());
      if (fs.existsSync(target)) return true;
    }
  } catch {
    // Ignore: an unreadable git dir means no rebase state we can detect.
  }
  return false;
}

async function conflictedFiles(repoDir, opts = {}) {
  const result = await runGit(['status', '--porcelain=v1'], {
    cwd: repoDir,
    gitBinary: opts.gitBinary,
  });
  if (result.exitCode !== 0) return [];
  return parseConflictedFiles(result.stdout);
}

async function remoteBranchExists(repoDir, remote, branch, gitBinary) {
  const result = await runGit(['ls-remote', '--heads', String(remote), String(branch)], {
    cwd: repoDir,
    gitBinary,
  });
  if (result.exitCode !== 0) return false;
  return result.stdout.trim().length > 0;
}

/**
 * Run a git command and resolve with its captured output.
 * Non-zero exits resolve normally; spawn failures reject.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, gitBinary?: string, env?: object, maxBuffer?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runGit(args, opts = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return Promise.reject(new TypeError('runGit expects an array of string arguments'));
  }
  return new Promise((resolve, reject) => {
    const gitBinary = opts.gitBinary || 'git';
    const cwd = path.resolve(opts.cwd ? String(opts.cwd) : process.cwd());
    const maxBuffer = opts.maxBuffer === undefined ? DEFAULT_MAX_BUFFER : Number(opts.maxBuffer);
    const timeoutMs = Number(opts.timeoutMs ?? 0);
    const env = gitEnv(opts.env);

    let child;
    try {
      child = spawn(gitBinary, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new GitError(`Failed to spawn "${gitBinary}": ${toErrorMessage(error)}`, {
          args,
          cwd,
        }),
      );
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let timer = null;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      settle(value);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        child.kill();
        finish(
          reject,
          new GitError(
            `git ${args.join(' ')} exceeded maxBuffer (${maxBuffer} bytes) while writing stdout`,
            { args, cwd, exitCode: null },
          ),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        child.kill();
        finish(
          reject,
          new GitError(
            `git ${args.join(' ')} exceeded maxBuffer (${maxBuffer} bytes) while writing stderr`,
            { args, cwd, exitCode: null },
          ),
        );
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      finish(
        reject,
        new GitError(`Failed to run "${gitBinary}": ${toErrorMessage(error)}`, {
          args,
          cwd,
        }),
      );
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      let stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        stderr += `${stderr.endsWith('\n') || stderr === '' ? '' : '\n'}git ${args.join(' ')} timed out after ${timeoutMs}ms`;
        finish(resolve, { stdout, stderr, exitCode: 124 });
        return;
      }
      finish(resolve, { stdout, stderr, exitCode: code === null ? 1 : code });
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}

/**
 * Run a git command expected to succeed; resolves with trimmed stdout.
 * @returns {Promise<string>}
 */
export async function gitOk(args, opts = {}) {
  const result = await runGit(args, opts);
  if (result.exitCode !== 0) throw gitFailure(result, args, opts.cwd);
  return result.stdout.trim();
}

/** @returns {Promise<boolean>} */
export async function isGitRepo(dir) {
  if (!dir) return false;
  try {
    const result = await runGit(['rev-parse', '--git-dir'], { cwd: path.resolve(String(dir)) });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Inspect a working tree: branch, HEAD, dirty and conflict state, tracking info.
 * Never throws for a directory that is not a repository (returns `isRepo: false`).
 *
 * @param {string} dir
 * @param {{ gitBinary?: string, remote?: string }} [opts]
 * @returns {Promise<{ isRepo: boolean, root: string|null, head: string|null, branch: string|null,
 *   detached: boolean, dirty: boolean, conflicted: string[], files: Array<{ status: string, path: string }>,
 *   ahead?: number, behind?: number, remoteUrl?: string }>}
 */
export async function repoStatus(dir, opts = {}) {
  const cwd = path.resolve(String(dir));
  const gitBinary = opts.gitBinary;
  const notRepo = {
    isRepo: false,
    root: null,
    head: null,
    branch: null,
    detached: false,
    dirty: false,
    conflicted: [],
    files: [],
  };
  if (!dir) return notRepo;

  let inside;
  try {
    inside = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd, gitBinary });
  } catch {
    return notRepo;
  }
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return notRepo;

  const rootResult = await runGit(['rev-parse', '--show-toplevel'], { cwd, gitBinary });
  const root = rootResult.exitCode === 0 ? canonicalPath(rootResult.stdout.trim()) : cwd;

  const headResult = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd, gitBinary });
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;

  const branch = await symbolicBranch(cwd, gitBinary);
  const detached = Boolean(head) && !branch;

  const statusResult = await runGit(['status', '--porcelain=v1'], { cwd, gitBinary });
  const statusText = statusResult.exitCode === 0 ? statusResult.stdout : '';
  const files = parseStatusFiles(statusText);

  /** @type {{ isRepo: boolean, root: string|null, head: string|null, branch: string|null,
   *   detached: boolean, dirty: boolean, conflicted: string[], files: Array<{ status: string, path: string }>,
   *   ahead?: number, behind?: number, remoteUrl?: string }} */
  const status = {
    isRepo: true,
    root,
    head,
    branch,
    detached,
    dirty: files.length > 0,
    conflicted: parseConflictedFiles(statusText),
    files,
  };

  const tracking = await runGit(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { cwd, gitBinary },
  );
  if (tracking.exitCode === 0) {
    const upstream = tracking.stdout.trim();
    if (upstream) {
      const counts = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], {
        cwd,
        gitBinary,
      });
      if (counts.exitCode === 0) {
        const [ahead, behind] = counts.stdout
          .trim()
          .split(/\s+/)
          .map((value) => Number.parseInt(value, 10));
        if (Number.isFinite(ahead) && Number.isFinite(behind)) {
          status.ahead = ahead;
          status.behind = behind;
        }
      }
    }
  }

  const remote = opts.remote || 'origin';
  const remoteResult = await runGit(['remote', 'get-url', remote], { cwd, gitBinary });
  if (remoteResult.exitCode === 0 && remoteResult.stdout.trim()) {
    status.remoteUrl = remoteResult.stdout.trim();
  }
  return status;
}

/**
 * Clone a repository into a directory.
 * @param {{ url: string, dir: string, gitBinary?: string, branch?: string, depth?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ dir: string }>}
 */
export async function cloneRepo(opts = {}) {
  const url = String(opts.url ?? '').trim();
  const dir = String(opts.dir ?? '').trim();
  if (!url) throw new Error('cloneRepo requires a url');
  if (!dir) throw new Error('cloneRepo requires a dir');
  const target = path.resolve(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const args = ['clone'];
  const depth = Number(opts.depth);
  if (Number.isFinite(depth) && depth > 0) args.push('--depth', String(Math.floor(depth)));
  if (opts.branch) args.push('--branch', String(opts.branch));
  args.push(url, target);
  await gitOk(args, {
    cwd: path.dirname(target),
    gitBinary: opts.gitBinary,
    timeoutMs: opts.timeoutMs,
  });
  return { dir: target };
}

/**
 * Fetch a remote and report the branch names it now advertises.
 * @param {string} repoDir
 * @param {{ remote?: string, prune?: boolean, gitBinary?: string }} [opts]
 * @returns {Promise<{ remote: string, branches: string[] }>}
 */
export async function fetchAll(repoDir, opts = {}) {
  const remote = opts.remote || 'origin';
  const args = ['fetch', remote];
  if (opts.prune !== false) args.push('--prune');
  args.push('--tags');
  await gitOk(args, { cwd: repoDir, gitBinary: opts.gitBinary });
  const branches = await listBranches(repoDir, { remote, gitBinary: opts.gitBinary });
  return { remote, branches };
}

/**
 * Resolve the repository default branch: `origin/HEAD`, then local/remote main or master.
 * @param {string} repoDir
 * @param {{ remote?: string, gitBinary?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function resolveDefaultBranch(repoDir, opts = {}) {
  const remote = opts.remote || 'origin';
  const gitBinary = opts.gitBinary;
  const head = await runGit(
    ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`],
    { cwd: repoDir, gitBinary },
  );
  if (head.exitCode === 0) {
    const ref = head.stdout.trim();
    if (ref) return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
  }
  for (const candidate of ['main', 'master']) {
    if (await branchExists(repoDir, candidate, { gitBinary })) return candidate;
    if (await branchExists(repoDir, candidate, { remote, gitBinary })) return candidate;
  }
  return 'main';
}

/**
 * Resolve a ref to a commit SHA.
 * @param {string} repoDir
 * @param {string} ref
 * @param {{ gitBinary?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function revParse(repoDir, ref, opts = {}) {
  if (!ref) throw new Error('revParse requires a ref');
  return gitOk(['rev-parse', '--verify', String(ref)], {
    cwd: repoDir,
    gitBinary: opts.gitBinary,
  });
}

/**
 * @param {string} repoDir
 * @param {string} branch
 * @param {{ remote?: string, gitBinary?: string }} [opts] `remote` checks the remote-tracking ref.
 * @returns {Promise<boolean>}
 */
export async function branchExists(repoDir, branch, opts = {}) {
  if (!branch) return false;
  const name = String(branch);
  const ref = opts.remote ? `refs/remotes/${opts.remote}/${name}` : `refs/heads/${name}`;
  try {
    const result = await runGit(['rev-parse', '--verify', '--quiet', ref], {
      cwd: repoDir,
      gitBinary: opts.gitBinary,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Create a local branch, optionally from a start point.
 * @param {string} repoDir
 * @param {string} branch
 * @param {string} [from] defaults to HEAD
 * @param {{ gitBinary?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function createBranch(repoDir, branch, from, opts = {}) {
  if (!branch) throw new Error('createBranch requires a branch name');
  const args = ['branch', String(branch)];
  if (from) args.push(String(from));
  await gitOk(args, { cwd: repoDir, gitBinary: opts.gitBinary });
}

/**
 * Delete a local branch and, when requested, its remote counterpart.
 * @param {string} repoDir
 * @param {string} branch
 * @param {{ force?: boolean, remote?: boolean|string, gitBinary?: string }} [opts]
 * @returns {Promise<{ deleted: boolean, remoteDeleted: boolean }>}
 */
export async function deleteBranch(repoDir, branch, opts = {}) {
  const name = String(branch ?? '');
  if (!name) throw new Error('deleteBranch requires a branch name');
  const gitBinary = opts.gitBinary;

  let deleted = false;
  const localExists = await branchExists(repoDir, name, { gitBinary });
  if (localExists) {
    const args = ['branch', opts.force ? '-D' : '-d', name];
    const result = await runGit(args, { cwd: repoDir, gitBinary });
    if (result.exitCode !== 0) {
      const detail = String(result.stderr || result.stdout).trim();
      if (/not fully merged/i.test(detail)) {
        throw new GitError(
          `Failed to delete branch "${name}" (exit code ${result.exitCode}): ${detail}. Use force: true to delete an unmerged branch.`,
          {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            args,
            cwd: path.resolve(String(repoDir)),
          },
        );
      }
      throw gitFailure(result, args, repoDir);
    }
    deleted = true;
  }

  let remoteDeleted = false;
  const remoteName = opts.remote === true ? 'origin' : typeof opts.remote === 'string' ? opts.remote : null;
  if (remoteName) {
    const exists = await remoteBranchExists(repoDir, remoteName, name, gitBinary);
    if (exists) {
      const args = ['push', remoteName, '--delete', name];
      const result = await runGit(args, { cwd: repoDir, gitBinary });
      if (result.exitCode !== 0) throw gitFailure(result, args, repoDir);
      remoteDeleted = true;
    }
  }
  return { deleted, remoteDeleted };
}

/**
 * Count commits that are unique to each side of a comparison.
 * `ahead` counts commits reachable from `left` but not `right`.
 * @returns {Promise<{ ahead: number, behind: number }>}
 */
export async function aheadBehind(repoDir, left, right, opts = {}) {
  if (!left || !right) throw new Error('aheadBehind requires left and right refs');
  const out = await gitOk(
    ['rev-list', '--left-right', '--count', `${left}...${right}`],
    { cwd: repoDir, gitBinary: opts.gitBinary },
  );
  const [ahead, behind] = out
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
}

/**
 * Rebase the current branch onto `onto`. A conflict is a normal result, not a throw.
 * @param {string} repoDir
 * @param {string} onto
 * @param {{ gitBinary?: string }} [opts]
 * @returns {Promise<{ ok: boolean, conflicted: string[] }>}
 */
export async function rebase(repoDir, onto, opts = {}) {
  if (!onto) throw new Error('rebase requires an onto ref');
  const args = ['rebase', String(onto)];
  const result = await runGit(args, {
    cwd: repoDir,
    gitBinary: opts.gitBinary,
    env: { GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':' },
  });
  if (result.exitCode === 0) return { ok: true, conflicted: [] };
  if (result.exitCode === 1) {
    const conflicted = await conflictedFiles(repoDir, opts);
    if (conflicted.length > 0) return { ok: false, conflicted };
  }
  throw gitFailure(result, args, repoDir);
}

/**
 * Continue an in-progress rebase after conflicts were resolved and staged.
 * @returns {Promise<{ ok: boolean, conflicted: string[] }>}
 */
export async function rebaseContinue(repoDir, opts = {}) {
  const args = ['rebase', '--continue'];
  const result = await runGit(args, {
    cwd: repoDir,
    gitBinary: opts.gitBinary,
    env: { GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':' },
  });
  if (result.exitCode === 0) return { ok: true, conflicted: [] };
  const conflicted = await conflictedFiles(repoDir, opts);
  if (conflicted.length > 0) return { ok: false, conflicted };
  if (result.exitCode === 1 && (await isRebaseInProgress(repoDir, opts.gitBinary))) {
    return { ok: false, conflicted: [] };
  }
  throw gitFailure(result, args, repoDir);
}

/**
 * Abort an in-progress rebase. A missing rebase is tolerated.
 * @returns {Promise<void>}
 */
export async function rebaseAbort(repoDir, opts = {}) {
  const args = ['rebase', '--abort'];
  const result = await runGit(args, { cwd: repoDir, gitBinary: opts.gitBinary });
  if (result.exitCode === 0) return;
  if (/no rebase in progress/i.test(`${result.stderr}${result.stdout}`)) return;
  throw gitFailure(result, args, repoDir);
}

/**
 * Merge `branch` into the current branch. A conflict leaves MERGE_HEAD in place.
 * @param {string} repoDir
 * @param {string} branch
 * @param {{ noFf?: boolean, message?: string, ffOnly?: boolean, gitBinary?: string }} [opts]
 * @returns {Promise<{ ok: boolean, conflicted: string[], commit: string|null }>}
 */
export async function merge(repoDir, branch, opts = {}) {
  if (!branch) throw new Error('merge requires a branch');
  const args = ['merge'];
  if (opts.ffOnly) args.push('--ff-only');
  if (opts.noFf) args.push('--no-ff');
  if (opts.message) args.push('-m', String(opts.message));
  args.push(String(branch));
  const result = await runGit(args, {
    cwd: repoDir,
    gitBinary: opts.gitBinary,
    env: { GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':' },
  });
  if (result.exitCode === 0) {
    const commit = await revParse(repoDir, 'HEAD', { gitBinary: opts.gitBinary });
    return { ok: true, conflicted: [], commit };
  }
  if (result.exitCode === 1) {
    const mergeHead = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
      cwd: repoDir,
      gitBinary: opts.gitBinary,
    });
    if (mergeHead.exitCode === 0) {
      return { ok: false, conflicted: await conflictedFiles(repoDir, opts), commit: null };
    }
  }
  throw gitFailure(result, args, repoDir);
}

/**
 * Abort an in-progress merge. A missing merge is tolerated.
 * @returns {Promise<void>}
 */
export async function mergeAbort(repoDir, opts = {}) {
  const args = ['merge', '--abort'];
  const result = await runGit(args, { cwd: repoDir, gitBinary: opts.gitBinary });
  if (result.exitCode === 0) return;
  if (/no merge to abort|MERGE_HEAD missing/i.test(`${result.stderr}${result.stdout}`)) return;
  throw gitFailure(result, args, repoDir);
}

/**
 * Push a branch to a remote.
 * @param {string} repoDir
 * @param {string} branch
 * @param {{ remote?: string, setUpstream?: boolean, forceWithLease?: boolean, gitBinary?: string }} [opts]
 * @returns {Promise<{ remote: string, branch: string }>}
 */
export async function push(repoDir, branch, opts = {}) {
  if (!branch) throw new Error('push requires a branch');
  const remote = opts.remote || 'origin';
  const args = ['push'];
  if (opts.forceWithLease) args.push('--force-with-lease');
  if (opts.setUpstream !== false) args.push('--set-upstream');
  args.push(remote, String(branch));
  await gitOk(args, { cwd: repoDir, gitBinary: opts.gitBinary });
  return { remote, branch: String(branch) };
}

function worktreeEntryFromLine(line, current) {
  if (line.startsWith('worktree ')) {
    return {
      path: canonicalPath(line.slice('worktree '.length).trim()),
      head: null,
      branch: null,
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    };
  }
  if (!current) return null;
  if (line.startsWith('HEAD ')) {
    current.head = line.slice('HEAD '.length).trim() || null;
  } else if (line.startsWith('branch ')) {
    const ref = line.slice('branch '.length).trim();
    current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) || null : ref || null;
  } else if (line === 'bare') {
    current.bare = true;
  } else if (line === 'detached') {
    current.detached = true;
  } else if (line === 'locked' || line.startsWith('locked ')) {
    current.locked = true;
  } else if (line === 'prunable' || line.startsWith('prunable ')) {
    current.prunable = true;
  }
  return null;
}

/**
 * List registered worktrees using `git worktree list --porcelain`.
 * Paths are canonical absolute paths; `branch` is null for detached worktrees.
 * @param {string} repoDir
 * @param {{ gitBinary?: string }} [opts]
 * @returns {Promise<Array<{ path: string, head: string|null, branch: string|null,
 *   bare: boolean, detached: boolean, locked: boolean, prunable: boolean }>>}
 */
export async function listWorktrees(repoDir, opts = {}) {
  const out = await gitOk(['worktree', 'list', '--porcelain'], {
    cwd: repoDir,
    gitBinary: opts.gitBinary,
  });
  const entries = [];
  let current = null;
  for (const line of splitLines(out)) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = worktreeEntryFromLine(line, null);
      continue;
    }
    if (!current) continue;
    worktreeEntryFromLine(line, current);
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Add a worktree, either creating a branch or attaching an existing one.
 * @param {string} repoDir
 * @param {{ path: string, branch: string, createBranch?: boolean, from?: string, gitBinary?: string }} opts
 * @returns {Promise<void>}
 */
export async function addWorktree(repoDir, opts = {}) {
  const target = String(opts.path ?? '').trim();
  const branch = String(opts.branch ?? '').trim();
  if (!target) throw new Error('addWorktree requires a path');
  if (!branch) throw new Error('addWorktree requires a branch');
  const worktreePath = path.resolve(target);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const args = ['worktree', 'add'];
  if (opts.createBranch) {
    args.push('-b', branch, worktreePath, opts.from ? String(opts.from) : 'HEAD');
  } else {
    args.push(worktreePath, branch);
  }
  await gitOk(args, { cwd: repoDir, gitBinary: opts.gitBinary });
}

/**
 * Remove a worktree from the repository.
 * @param {string} repoDir
 * @param {string} worktreePath
 * @param {{ force?: boolean, gitBinary?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function removeWorktree(repoDir, worktreePath, opts = {}) {
  if (!worktreePath) throw new Error('removeWorktree requires a worktree path');
  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(path.resolve(String(worktreePath)));
  await gitOk(args, { cwd: repoDir, gitBinary: opts.gitBinary });
}

/**
 * Prune worktree metadata for deleted directories.
 * @param {string} repoDir
 * @param {{ gitBinary?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function pruneWorktrees(repoDir, opts = {}) {
  await gitOk(['worktree', 'prune'], { cwd: repoDir, gitBinary: opts.gitBinary });
}

/**
 * List branch names.
 * With `opts.remote` as a string the `<remote>/` prefix is stripped; with
 * `opts.remote === true` full remote-tracking names are returned.
 * @param {string} repoDir
 * @param {{ remote?: boolean|string, gitBinary?: string }} [opts]
 * @returns {Promise<string[]>}
 */
export async function listBranches(repoDir, opts = {}) {
  const gitBinary = opts.gitBinary;
  if (!opts.remote) {
    const out = await gitOk(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
      cwd: repoDir,
      gitBinary,
    });
    return splitLines(out).map((line) => line.trim()).filter(Boolean).sort();
  }
  const out = await gitOk(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], {
    cwd: repoDir,
    gitBinary,
  });
  // `%(refname:short)` shortens refs/remotes/<remote>/HEAD to just `<remote>`,
  // so keep only names that still carry a remote/ prefix.
  const all = splitLines(out)
    .map((line) => line.trim())
    .filter((name) => Boolean(name) && name.includes('/') && !name.endsWith('/HEAD'));
  if (typeof opts.remote === 'string') {
    const prefix = `${opts.remote}/`;
    return all
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
      .sort();
  }
  return all.sort();
}

/**
 * Current branch name, or null for a detached HEAD / non-repository.
 * @param {string} dir
 * @returns {Promise<string|null>}
 */
export async function currentBranch(dir) {
  if (!dir) return null;
  return symbolicBranch(path.resolve(String(dir)), undefined);
}

/**
 * Read the one-line commit log.
 * @param {string} repoDir
 * @param {{ limit?: number, range?: string, gitBinary?: string }} [opts]
 * @returns {Promise<string[]>}
 */
export async function logOneline(repoDir, opts = {}) {
  const limitValue = Number(opts.limit);
  const limit = Number.isFinite(limitValue) && limitValue >= 0 ? Math.floor(limitValue) : 20;
  const args = ['log', '--oneline'];
  if (opts.range) args.push(String(opts.range));
  if (limit > 0) args.push('-n', String(limit));
  const out = await gitOk(args, { cwd: repoDir, gitBinary: opts.gitBinary });
  return splitLines(out).map((line) => line.trim()).filter(Boolean);
}

/**
 * Extract conflicted paths from `git status --porcelain` output.
 * @param {string} statusText
 * @returns {string[]}
 */
export function parseConflictedFiles(statusText) {
  const files = [];
  const seen = new Set();
  for (const line of String(statusText ?? '').split(/\r?\n/)) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    if (!CONFLICT_CODES.has(status)) continue;
    const filePath = statusFilePath(line.slice(3));
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    files.push(filePath);
  }
  return files;
}
