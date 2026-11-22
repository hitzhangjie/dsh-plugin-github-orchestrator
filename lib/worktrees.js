/**
 * Task worktree lifecycle: create, inspect, rebase and merge Git worktrees that
 * belong to orchestrator tasks. Worktree directories follow the
 * `<name>__T<number>` convention so a task id can be recovered from the path.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  addWorktree,
  branchExists,
  currentBranch,
  deleteBranch,
  listWorktrees,
  merge,
  pruneWorktrees,
  push,
  rebase,
  removeWorktree,
  repoStatus,
  revParse,
  runGit,
  gitOk,
} from './git.js';
import { toErrorMessage } from './util.js';

/** Canonical absolute path, falling back to `path.resolve` when missing. */
function canonicalPath(target) {
  const resolved = path.resolve(String(target));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const resolved = path.resolve(String(value));
    try {
      return fs.realpathSync.native(resolved).toLowerCase();
    } catch {
      return resolved.toLowerCase();
    }
  };
  return normalize(left) === normalize(right);
}

function remoteNameOf(remote) {
  if (remote === true) return 'origin';
  if (typeof remote === 'string' && remote.trim()) return remote.trim();
  return null;
}

/** Parsed task id from a trailing `__T<number>` path segment, or null. */
function taskIdFromPath(worktreePath) {
  const base = path.basename(path.resolve(String(worktreePath)));
  const match = /__T(\d+)$/.exec(base);
  return match ? `T${match[1]}` : null;
}

/**
 * Create a worktree for a task.
 *
 * `createBranch: true` creates the branch from `from`, otherwise from
 * `<remote>/<baseBranch>` (falling back to `<baseBranch>` or `HEAD`).
 * `createBranch: false` attaches an existing local branch. When the flag is
 * omitted the branch is created only if it does not exist locally.
 *
 * @param {{ repoDir: string, worktreePath: string, branch: string, baseBranch?: string,
 *   remote?: string, createBranch?: boolean, from?: string, gitBinary?: string }} opts
 * @returns {Promise<{ worktreePath: string, branch: string, baseBranch: string|null, baseCommit: string }>}
 */
export async function createTaskWorktree(opts = {}) {
  const repoDir = opts.repoDir ? path.resolve(String(opts.repoDir)) : '';
  const worktreePath = opts.worktreePath ? path.resolve(String(opts.worktreePath)) : '';
  const branch = String(opts.branch ?? '').trim();
  if (!repoDir) throw new Error('createTaskWorktree requires repoDir');
  if (!worktreePath) throw new Error('createTaskWorktree requires worktreePath');
  if (!branch) throw new Error('createTaskWorktree requires branch');

  const remote = opts.remote || 'origin';
  const gitBinary = opts.gitBinary;
  const repo = await repoStatus(repoDir, { gitBinary });
  if (!repo.isRepo) throw new Error(`Not a git repository: ${repoDir}`);

  const localBranchExists = await branchExists(repoDir, branch, { gitBinary });
  const shouldCreate =
    opts.createBranch === true ? true : opts.createBranch === false ? false : !localBranchExists;

  if (shouldCreate && localBranchExists) {
    throw new Error(`Branch "${branch}" already exists; omit createBranch to attach it`);
  }
  if (!shouldCreate && !localBranchExists) {
    throw new Error(`Branch "${branch}" does not exist locally`);
  }

  let baseRef = opts.from ? String(opts.from) : null;
  if (!baseRef) {
    if (opts.baseBranch) {
      const baseBranch = String(opts.baseBranch);
      if (await branchExists(repoDir, baseBranch, { remote, gitBinary })) {
        baseRef = `${remote}/${baseBranch}`;
      } else if (await branchExists(repoDir, baseBranch, { gitBinary })) {
        baseRef = baseBranch;
      }
    }
    if (!baseRef) baseRef = shouldCreate ? 'HEAD' : branch;
  }

  let baseCommit;
  try {
    baseCommit = await revParse(repoDir, baseRef, { gitBinary });
  } catch (error) {
    if (!shouldCreate) {
      baseCommit = await revParse(repoDir, branch, { gitBinary });
    } else {
      throw error;
    }
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await addWorktree(repoDir, {
    path: worktreePath,
    branch,
    createBranch: shouldCreate,
    from: shouldCreate ? baseRef : undefined,
    gitBinary,
  });

  return {
    worktreePath: canonicalPath(worktreePath),
    branch,
    baseBranch: opts.baseBranch ? String(opts.baseBranch) : null,
    baseCommit,
  };
}

/**
 * Remove a task worktree, prune metadata, then delete the local branch and
 * optionally its remote counterpart. Non-fatal problems are reported in
 * `warnings` instead of throwing.
 *
 * @param {{ repoDir: string, worktreePath: string, force?: boolean, deleteBranch?: boolean,
 *   branch?: string, remote?: boolean|string, gitBinary?: string }} opts
 * @returns {Promise<{ removed: boolean, branchDeleted: boolean, remoteDeleted: boolean, warnings: string[] }>}
 */
export async function removeTaskWorktree(opts = {}) {
  const repoDir = opts.repoDir ? path.resolve(String(opts.repoDir)) : '';
  const worktreePath = opts.worktreePath ? path.resolve(String(opts.worktreePath)) : '';
  if (!repoDir) throw new Error('removeTaskWorktree requires repoDir');
  if (!worktreePath) throw new Error('removeTaskWorktree requires worktreePath');

  const gitBinary = opts.gitBinary;
  const remoteName = remoteNameOf(opts.remote);
  const warnings = [];

  let entry = null;
  try {
    const worktrees = await listWorktrees(repoDir, { gitBinary });
    entry = worktrees.find((item) => samePath(item.path, worktreePath)) ?? null;
  } catch (error) {
    warnings.push(`Could not list worktrees: ${toErrorMessage(error)}`);
  }

  const exists = Boolean(entry) || fs.existsSync(worktreePath);
  const branch = String(opts.branch ?? entry?.branch ?? '').trim() || null;

  let removed = false;
  if (!exists) {
    warnings.push(`Worktree not found: ${worktreePath}`);
  } else {
    try {
      await removeWorktree(repoDir, worktreePath, { force: Boolean(opts.force), gitBinary });
      removed = true;
    } catch (error) {
      warnings.push(`Failed to remove worktree ${worktreePath}: ${toErrorMessage(error)}`);
    }
  }

  try {
    await pruneWorktrees(repoDir, { gitBinary });
  } catch (error) {
    warnings.push(`Failed to prune worktrees: ${toErrorMessage(error)}`);
  }

  let branchDeleted = false;
  let remoteDeleted = false;
  if (opts.deleteBranch) {
    if (!branch) {
      warnings.push('deleteBranch was requested but no branch name could be determined');
    } else if (!removed && exists) {
      warnings.push(`Skipped deleting branch "${branch}" because the worktree could not be removed`);
    } else {
      try {
        const result = await deleteBranch(repoDir, branch, {
          force: Boolean(opts.force),
          remote: remoteName ?? false,
          gitBinary,
        });
        branchDeleted = result.deleted;
        remoteDeleted = result.remoteDeleted;
      } catch (error) {
        warnings.push(`Failed to delete branch "${branch}": ${toErrorMessage(error)}`);
      }
    }
  }

  return { removed, branchDeleted, remoteDeleted, warnings };
}

/**
 * List worktrees with their task id and computed dirty state.
 * @param {string} repoDir
 * @param {{ gitBinary?: string }} [opts]
 * @returns {Promise<Array<{ path: string, branch: string|null, head: string|null, dirty: boolean,
 *   taskId: string|null, locked: boolean, prunable: boolean }>>}
 */
export async function listTaskWorktrees(repoDir, opts = {}) {
  const worktrees = await listWorktrees(repoDir, { gitBinary: opts?.gitBinary });
  const result = [];
  for (const worktree of worktrees) {
    let dirty = false;
    try {
      const status = await runGit(['status', '--porcelain=v1'], {
        cwd: worktree.path,
        gitBinary: opts?.gitBinary,
      });
      dirty = status.exitCode === 0 ? status.stdout.trim().length > 0 : true;
    } catch {
      dirty = true;
    }
    result.push({
      path: worktree.path,
      branch: worktree.branch,
      head: worktree.head,
      dirty,
      taskId: taskIdFromPath(worktree.path),
      locked: worktree.locked,
      prunable: worktree.prunable,
    });
  }
  return result;
}

async function refExists(repoDir, ref, gitBinary) {
  try {
    const result = await runGit(['rev-parse', '--verify', '--quiet', String(ref)], {
      cwd: repoDir,
      gitBinary,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Fetch the base branch and rebase a task worktree onto it.
 * A conflict is reported in the result; it does not throw.
 *
 * @param {{ worktreePath: string, baseBranch: string, remote?: string, repoDir?: string, gitBinary?: string }} opts
 * @returns {Promise<{ ok: boolean, conflicted: string[], upToDate: boolean, onto: string }>}
 */
export async function rebaseWorktree(opts = {}) {
  const worktreePath = opts.worktreePath ? path.resolve(String(opts.worktreePath)) : '';
  const baseBranch = String(opts.baseBranch ?? '').trim();
  if (!worktreePath) throw new Error('rebaseWorktree requires worktreePath');
  if (!baseBranch) throw new Error('rebaseWorktree requires baseBranch');

  const gitBinary = opts.gitBinary;
  const remote = opts.remote || 'origin';
  const fetchTarget = opts.repoDir ? path.resolve(String(opts.repoDir)) : worktreePath;

  let fetchError = null;
  try {
    await gitOk(['fetch', remote, '--prune'], { cwd: fetchTarget, gitBinary });
  } catch (error) {
    fetchError = error;
  }

  const remoteRef = `${remote}/${baseBranch}`;
  let onto;
  if (await branchExists(worktreePath, baseBranch, { remote, gitBinary })) {
    onto = remoteRef;
  } else if (await branchExists(worktreePath, baseBranch, { gitBinary })) {
    onto = baseBranch;
  } else if (await refExists(worktreePath, remoteRef, gitBinary)) {
    onto = remoteRef;
  } else {
    const suffix = fetchError ? `: ${toErrorMessage(fetchError)}` : '';
    throw new Error(
      `Cannot resolve "${remoteRef}" or "${baseBranch}" for rebase in ${worktreePath}${suffix}`,
    );
  }

  const targetSha = await revParse(worktreePath, onto, { gitBinary });
  const headSha = await revParse(worktreePath, 'HEAD', { gitBinary });
  if (headSha === targetSha) {
    return { ok: true, conflicted: [], upToDate: true, onto };
  }
  const ancestor = await runGit(['merge-base', '--is-ancestor', targetSha, headSha], {
    cwd: worktreePath,
    gitBinary,
  });
  if (ancestor.exitCode === 0) {
    return { ok: true, conflicted: [], upToDate: true, onto };
  }

  const result = await rebase(worktreePath, onto, { gitBinary });
  return { ok: result.ok, conflicted: result.conflicted, upToDate: false, onto };
}

/**
 * Merge a task branch into the base branch, optionally pushing the result.
 *
 * The repository must be clean. The base branch is checked out and
 * fast-forwarded to `<remote>/<baseBranch>` before the merge. On conflict the
 * merge state is left in place for the caller to abort.
 *
 * @param {{ repoDir: string, branch: string, baseBranch: string, remote?: string,
 *   push?: boolean, noFf?: boolean, message?: string, gitBinary?: string }} opts
 * @returns {Promise<{ merged: boolean, commit: string|null, pushed: boolean,
 *   baseBranch: string, branch: string }>}
 */
export async function mergeTaskBranch(opts = {}) {
  const repoDir = opts.repoDir ? path.resolve(String(opts.repoDir)) : '';
  const branch = String(opts.branch ?? '').trim();
  const baseBranch = String(opts.baseBranch ?? '').trim();
  if (!repoDir) throw new Error('mergeTaskBranch requires repoDir');
  if (!branch) throw new Error('mergeTaskBranch requires branch');
  if (!baseBranch) throw new Error('mergeTaskBranch requires baseBranch');

  const gitBinary = opts.gitBinary;
  const remote = opts.remote || 'origin';

  const status = await repoStatus(repoDir, { gitBinary });
  if (!status.isRepo) throw new Error(`Not a git repository: ${repoDir}`);
  if (status.conflicted.length > 0) {
    throw new Error(`Repository has unresolved conflicts: ${status.conflicted.join(', ')}`);
  }
  if (status.dirty) {
    throw new Error('Repository has uncommitted changes; commit or stash them before merging');
  }

  const current = await currentBranch(repoDir);
  if (current !== baseBranch) {
    await gitOk(['checkout', baseBranch], { cwd: repoDir, gitBinary });
  }

  const remoteRef = `${remote}/${baseBranch}`;
  if (await branchExists(repoDir, baseBranch, { remote, gitBinary })) {
    await gitOk(['merge', '--ff-only', remoteRef], { cwd: repoDir, gitBinary });
  }

  const result = await merge(repoDir, branch, {
    noFf: opts.noFf !== false,
    message: opts.message || `Merge branch '${branch}' into ${baseBranch}`,
    gitBinary,
  });
  if (!result.ok) {
    return { merged: false, commit: null, pushed: false, baseBranch, branch };
  }

  let pushed = false;
  if (opts.push) {
    await push(repoDir, baseBranch, { remote, setUpstream: false, gitBinary });
    pushed = true;
  }

  return { merged: true, commit: result.commit, pushed, baseBranch, branch };
}
