/**
 * Tests for lib/worktrees.js against real temporary repositories under os.tmpdir().
 * Remotes are local bare repositories, so no network access is required.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  branchExists,
  currentBranch,
  fetchAll,
  logOneline,
  mergeAbort,
  rebaseAbort,
  repoStatus,
  revParse,
} from '../lib/git.js';
import {
  createTaskWorktree,
  listTaskWorktrees,
  mergeTaskBranch,
  rebaseWorktree,
  removeTaskWorktree,
} from '../lib/worktrees.js';

const GIT = 'git';
const TEST_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, ...args) {
  return execFileSync(GIT, ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: TEST_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const tempRoots = [];

function newRoot(prefix = 'gos-wt-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

function configureRepo(dir) {
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--initial-branch=main', '--quiet');
  return configureRepo(dir);
}

/** Bare origin + seed repository + clone. */
function createFixture(root) {
  const originDir = path.join(root, 'origin.git');
  git(root, 'init', '--bare', '--initial-branch=main', '--quiet', originDir);

  const seedDir = initRepo(path.join(root, 'seed'));
  writeFile(seedDir, 'README.md', '# fixture\n');
  commitAll(seedDir, 'initial commit');
  git(seedDir, 'remote', 'add', 'origin', originDir);
  git(seedDir, 'push', '--quiet', '--set-upstream', 'origin', 'main');

  const cloneDir = path.join(root, 'clone');
  git(root, 'clone', '--quiet', originDir, cloneDir);
  configureRepo(cloneDir);

  return { originDir, seedDir, cloneDir };
}

function commitToClone(cloneDir, name, content, message) {
  writeFile(cloneDir, name, content);
  return commitAll(cloneDir, message);
}

function pushFromClone(cloneDir, branch = 'main') {
  git(cloneDir, 'push', '--quiet', 'origin', branch);
}

after(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Best effort cleanup on Windows where files can be briefly locked.
    }
  }
});

test('createTaskWorktree creates a branch worktree from the remote base branch', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  const worktreePath = path.join(root, '.worktrees', 'sample__T7');
  const baseCommit = git(cloneDir, 'rev-parse', 'main');

  const created = await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch: 'task/T7-demo',
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });

  assert.equal(created.branch, 'task/T7-demo');
  assert.equal(created.baseBranch, 'main');
  assert.equal(created.baseCommit, baseCommit);
  assert.equal(created.worktreePath, fs.realpathSync.native(worktreePath));
  assert.ok(fs.existsSync(path.join(worktreePath, 'README.md')));
  assert.equal(await currentBranch(worktreePath), 'task/T7-demo');
  assert.equal(await branchExists(cloneDir, 'task/T7-demo'), true);

  await removeTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    force: true,
    deleteBranch: true,
    branch: 'task/T7-demo',
  });
});

test('listTaskWorktrees parses task ids and computes dirty state', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  const worktreePath = path.join(root, '.worktrees', 'sample__T9');
  const baseCommit = git(cloneDir, 'rev-parse', 'main');

  await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch: 'task/T9-list',
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });

  let listed = await listTaskWorktrees(cloneDir);
  const mainEntry = listed.find((entry) => entry.taskId === null);
  assert.ok(mainEntry);
  assert.equal(mainEntry.branch, 'main');
  assert.equal(mainEntry.dirty, false);

  const entry = listed.find((item) => item.taskId === 'T9');
  assert.ok(entry);
  assert.equal(entry.path, fs.realpathSync.native(worktreePath));
  assert.equal(entry.branch, 'task/T9-list');
  assert.equal(entry.head, baseCommit);
  assert.equal(entry.dirty, false);
  assert.equal(entry.locked, false);
  assert.equal(entry.prunable, false);

  writeFile(worktreePath, 'wip.txt', 'work in progress\n');
  listed = await listTaskWorktrees(cloneDir);
  assert.equal(listed.find((item) => item.taskId === 'T9').dirty, true);

  await removeTaskWorktree({ repoDir: cloneDir, worktreePath, force: true, deleteBranch: true });
});

test('removeTaskWorktree removes the worktree, prunes and deletes the branch locally and remotely', async () => {
  const root = newRoot();
  const { originDir, cloneDir } = createFixture(root);
  const worktreePath = path.join(root, '.worktrees', 'sample__T11');

  await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch: 'task/T11-remove',
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });
  writeFile(worktreePath, 'task.txt', 'task work\n');
  commitAll(worktreePath, 'task commit');
  pushFromClone(cloneDir, 'task/T11-remove');

  const result = await removeTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    force: true,
    deleteBranch: true,
    remote: 'origin',
  });

  assert.equal(result.removed, true);
  assert.equal(result.branchDeleted, true);
  assert.equal(result.remoteDeleted, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(await branchExists(cloneDir, 'task/T11-remove'), false);
  assert.equal(git(cloneDir, 'ls-remote', '--heads', 'origin', 'task/T11-remove'), '');
  assert.equal((await listTaskWorktrees(cloneDir)).length, 1);
});

test('removeTaskWorktree reports warnings for dirty and already-missing worktrees', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  const worktreePath = path.join(root, '.worktrees', 'sample__T12');

  await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch: 'task/T12-warn',
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });
  writeFile(worktreePath, 'dirty.txt', 'uncommitted\n');

  const blocked = await removeTaskWorktree({ repoDir: cloneDir, worktreePath });
  assert.equal(blocked.removed, false);
  assert.ok(blocked.warnings.length > 0);
  assert.ok(fs.existsSync(worktreePath));

  const forced = await removeTaskWorktree({ repoDir: cloneDir, worktreePath, force: true });
  assert.equal(forced.removed, true);

  const missing = await removeTaskWorktree({ repoDir: cloneDir, worktreePath });
  assert.equal(missing.removed, false);
  assert.ok(missing.warnings.some((warning) => /not found/i.test(warning)));
});

test('createTaskWorktree attaches an existing branch and validates createBranch flags', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  const worktreePath = path.join(root, '.worktrees', 'sample__T3');
  const baseCommit = git(cloneDir, 'rev-parse', 'main');
  git(cloneDir, 'branch', 'attach-branch', 'main');

  const created = await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch: 'attach-branch',
    baseBranch: 'main',
    remote: 'origin',
    createBranch: false,
  });
  assert.equal(created.branch, 'attach-branch');
  assert.equal(created.baseCommit, baseCommit);
  assert.equal(await currentBranch(worktreePath), 'attach-branch');

  await assert.rejects(
    () =>
      createTaskWorktree({
        repoDir: cloneDir,
        worktreePath: path.join(root, '.worktrees', 'sample__T3b'),
        branch: 'attach-branch',
        baseBranch: 'main',
        remote: 'origin',
        createBranch: true,
      }),
    /already exists/i,
  );

  await assert.rejects(
    () =>
      createTaskWorktree({
        repoDir: cloneDir,
        worktreePath: path.join(root, '.worktrees', 'sample__T3c'),
        branch: 'no-such-branch',
        baseBranch: 'main',
        remote: 'origin',
        createBranch: false,
      }),
    /does not exist locally/i,
  );

  await removeTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    force: true,
    deleteBranch: true,
    branch: 'attach-branch',
  });
});

test('rebaseWorktree fetches the base branch, rebases, then reports up-to-date', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  const worktreePath = path.join(root, '.worktrees', 'sample__T1');
  const branch = 'task/T1-rebase';

  await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch,
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });
  writeFile(worktreePath, 'task.txt', 'task work\n');
  commitAll(worktreePath, 'task work');

  const newMainSha = commitToClone(cloneDir, 'base.txt', 'base work\n', 'base work');
  pushFromClone(cloneDir);

  const first = await rebaseWorktree({
    worktreePath,
    baseBranch: 'main',
    remote: 'origin',
    repoDir: cloneDir,
  });
  assert.equal(first.ok, true);
  assert.deepEqual(first.conflicted, []);
  assert.equal(first.upToDate, false);
  assert.equal(first.onto, 'origin/main');
  assert.equal(git(worktreePath, 'rev-parse', 'HEAD~1'), newMainSha);
  assert.equal(await branchExists(cloneDir, branch), true);

  const second = await rebaseWorktree({
    worktreePath,
    baseBranch: 'main',
    remote: 'origin',
    repoDir: cloneDir,
  });
  assert.deepEqual(second, { ok: true, conflicted: [], upToDate: true, onto: 'origin/main' });

  await removeTaskWorktree({ repoDir: cloneDir, worktreePath, force: true, deleteBranch: true });
});

test('rebaseWorktree reports conflicts without throwing', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  writeFile(cloneDir, 'conflict.txt', 'base\n');
  commitAll(cloneDir, 'base file');
  pushFromClone(cloneDir);

  const worktreePath = path.join(root, '.worktrees', 'sample__T2');
  await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch: 'task/T2-conflict',
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });
  writeFile(worktreePath, 'conflict.txt', 'task side\n');
  commitAll(worktreePath, 'task change');
  const taskSha = git(worktreePath, 'rev-parse', 'HEAD');

  writeFile(cloneDir, 'conflict.txt', 'main side\n');
  commitAll(cloneDir, 'main change');
  pushFromClone(cloneDir);

  const result = await rebaseWorktree({
    worktreePath,
    baseBranch: 'main',
    remote: 'origin',
    repoDir: cloneDir,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicted, ['conflict.txt']);
  assert.equal(result.upToDate, false);
  assert.equal(result.onto, 'origin/main');
  assert.deepEqual((await repoStatus(worktreePath)).conflicted, ['conflict.txt']);

  await rebaseAbort(worktreePath);
  assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), taskSha);
  assert.equal((await repoStatus(worktreePath)).dirty, false);

  await removeTaskWorktree({ repoDir: cloneDir, worktreePath, force: true, deleteBranch: true });
});

test('mergeTaskBranch fast-forwards main and merges the task branch with --no-ff', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);

  // Advance origin/main while the clone's local main stays behind.
  const newMainSha = commitToClone(cloneDir, 'base.txt', 'base work\n', 'base work');
  pushFromClone(cloneDir);
  await fetchAll(cloneDir);
  git(cloneDir, 'reset', '--hard', 'HEAD~1');
  assert.notEqual(git(cloneDir, 'rev-parse', 'main'), newMainSha);

  const worktreePath = path.join(root, '.worktrees', 'sample__T4');
  await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch: 'task/T4-merge',
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });
  writeFile(worktreePath, 'task.txt', 'task work\n');
  const taskSha = commitAll(worktreePath, 'task work');

  const result = await mergeTaskBranch({
    repoDir: cloneDir,
    branch: 'task/T4-merge',
    baseBranch: 'main',
    remote: 'origin',
    message: 'Merge T4',
  });

  assert.equal(result.merged, true);
  assert.equal(result.pushed, false);
  assert.equal(result.baseBranch, 'main');
  assert.equal(result.branch, 'task/T4-merge');
  assert.equal(result.commit, git(cloneDir, 'rev-parse', 'HEAD'));
  assert.equal(await currentBranch(cloneDir), 'main');

  const parents = git(cloneDir, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/);
  assert.equal(parents.length, 3);
  assert.equal(parents[1], newMainSha);
  assert.equal(parents[2], taskSha);
  assert.ok(fs.existsSync(path.join(cloneDir, 'task.txt')));
  assert.ok((await logOneline(cloneDir, { limit: 5 })).some((line) => line.includes('Merge T4')));

  await removeTaskWorktree({ repoDir: cloneDir, worktreePath, force: true, deleteBranch: true });
});

test('mergeTaskBranch pushes the base branch when requested', async () => {
  const root = newRoot();
  const { originDir, cloneDir } = createFixture(root);
  const worktreePath = path.join(root, '.worktrees', 'sample__T5');

  await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch: 'task/T5-push',
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });
  writeFile(worktreePath, 'task.txt', 'task work\n');
  commitAll(worktreePath, 'task work');

  const result = await mergeTaskBranch({
    repoDir: cloneDir,
    branch: 'task/T5-push',
    baseBranch: 'main',
    remote: 'origin',
    push: true,
  });

  assert.equal(result.merged, true);
  assert.equal(result.pushed, true);
  assert.equal(git(originDir, 'rev-parse', 'main'), result.commit);

  await removeTaskWorktree({ repoDir: cloneDir, worktreePath, force: true, deleteBranch: true });
});

test('mergeTaskBranch reports conflicts, leaves merge state and can be aborted', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  writeFile(cloneDir, 'conflict.txt', 'base\n');
  commitAll(cloneDir, 'base file');
  pushFromClone(cloneDir);

  const worktreePath = path.join(root, '.worktrees', 'sample__T6');
  await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch: 'task/T6-conflict',
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });
  writeFile(worktreePath, 'conflict.txt', 'task side\n');
  commitAll(worktreePath, 'task change');

  writeFile(cloneDir, 'conflict.txt', 'main side\n');
  commitAll(cloneDir, 'main change');

  const result = await mergeTaskBranch({
    repoDir: cloneDir,
    branch: 'task/T6-conflict',
    baseBranch: 'main',
    remote: 'origin',
  });
  assert.equal(result.merged, false);
  assert.equal(result.commit, null);
  assert.equal(result.pushed, false);
  assert.equal(git(cloneDir, 'rev-parse', '--verify', 'MERGE_HEAD').length, 40);
  assert.deepEqual((await repoStatus(cloneDir)).conflicted, ['conflict.txt']);

  await mergeAbort(cloneDir);
  const status = await repoStatus(cloneDir);
  assert.equal(status.dirty, false);
  assert.deepEqual(status.conflicted, []);

  await removeTaskWorktree({ repoDir: cloneDir, worktreePath, force: true, deleteBranch: true });
});

test('mergeTaskBranch refuses a repository with uncommitted changes', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  const worktreePath = path.join(root, '.worktrees', 'sample__T8');

  await createTaskWorktree({
    repoDir: cloneDir,
    worktreePath,
    branch: 'task/T8-dirty',
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });
  writeFile(worktreePath, 'task.txt', 'task work\n');
  commitAll(worktreePath, 'task work');
  writeFile(cloneDir, 'uncommitted.txt', 'dirty\n');

  await assert.rejects(
    () =>
      mergeTaskBranch({
        repoDir: cloneDir,
        branch: 'task/T8-dirty',
        baseBranch: 'main',
        remote: 'origin',
      }),
    /uncommitted changes/i,
  );

  fs.rmSync(path.join(cloneDir, 'uncommitted.txt'));
  await removeTaskWorktree({ repoDir: cloneDir, worktreePath, force: true, deleteBranch: true });
});
