/**
 * Tests for lib/git.js against real temporary repositories under os.tmpdir().
 * No network access is required: remotes are local bare repositories.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GitError,
  addWorktree,
  aheadBehind,
  branchExists,
  cloneRepo,
  createBranch,
  currentBranch,
  deleteBranch,
  fetchAll,
  gitOk,
  isGitRepo,
  listBranches,
  listWorktrees,
  logOneline,
  merge,
  mergeAbort,
  parseConflictedFiles,
  pruneWorktrees,
  push,
  rebase,
  rebaseAbort,
  rebaseContinue,
  removeWorktree,
  repoStatus,
  resolveDefaultBranch,
  revParse,
  runGit,
} from '../lib/git.js';

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

/** Direct git invocation used only to build fixtures and verify results. */
function git(cwd, ...args) {
  // Force LF checkouts regardless of the machine's global core.autocrlf; the
  // plugin's canonical fixtures are LF and must stay clean after `git clone`.
  return execFileSync(GIT, ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: TEST_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const tempRoots = [];

function newRoot(prefix = 'gos-git-') {
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

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--initial-branch=main', '--quiet');
  return configureRepo(dir);
}

function configureRepo(dir) {
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/** Bare origin + seed repository (and a clone unless disabled). */
function createFixture(root, options = {}) {
  const originDir = path.join(root, 'origin.git');
  git(root, 'init', '--bare', '--initial-branch=main', '--quiet', originDir);

  const seedDir = initRepo(path.join(root, 'seed'));
  writeFile(seedDir, 'README.md', '# fixture\n');
  commitAll(seedDir, 'initial commit');
  git(seedDir, 'remote', 'add', 'origin', originDir);
  git(seedDir, 'push', '--quiet', '--set-upstream', 'origin', 'main');

  let cloneDir = null;
  if (options.clone !== false) {
    cloneDir = path.join(root, 'clone');
    git(root, 'clone', '--quiet', originDir, cloneDir);
    configureRepo(cloneDir);
  }
  return { originDir, seedDir, cloneDir };
}

/** Create divergent commits on `main` and `feature` that both touch conflict.txt. */
function setupConflict(cloneDir) {
  writeFile(cloneDir, 'conflict.txt', 'base\n');
  commitAll(cloneDir, 'add base file');

  git(cloneDir, 'checkout', '--quiet', '-b', 'feature');
  writeFile(cloneDir, 'conflict.txt', 'feature\n');
  const featureSha = commitAll(cloneDir, 'feature change');

  git(cloneDir, 'checkout', '--quiet', 'main');
  writeFile(cloneDir, 'conflict.txt', 'main\n');
  const mainSha = commitAll(cloneDir, 'main change');

  git(cloneDir, 'checkout', '--quiet', 'feature');
  return { featureSha, mainSha };
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

test('runGit captures stdout/exit codes and never rejects for a non-zero exit', async () => {
  const root = newRoot();
  const repo = initRepo(path.join(root, 'repo'));

  const version = await runGit(['--version'], { cwd: repo });
  assert.equal(version.exitCode, 0);
  assert.match(version.stdout, /git version/);

  const missing = await runGit(['rev-parse', '--verify', 'does-not-exist'], { cwd: repo });
  assert.notEqual(missing.exitCode, 0);
  assert.ok(missing.stdout.length >= 0);
  assert.match(`${missing.stderr}${missing.stdout}`, /fatal|unknown|bad revision/i);
});

test('runGit rejects with GitError when the git binary cannot be spawned', async () => {
  const root = newRoot();
  const repo = initRepo(path.join(root, 'repo'));
  await assert.rejects(
    () => runGit(['--version'], { cwd: repo, gitBinary: 'definitely-not-a-git-binary' }),
    (error) => {
      assert.ok(error instanceof GitError);
      assert.match(error.message, /Failed to run/);
      return true;
    },
  );
});

test('gitOk returns trimmed stdout and throws GitError with command details', async () => {
  const root = newRoot();
  const repo = initRepo(path.join(root, 'repo'));
  writeFile(repo, 'a.txt', 'a\n');
  const head = commitAll(repo, 'first');

  assert.equal(await gitOk(['rev-parse', 'HEAD'], { cwd: repo }), head);

  await assert.rejects(
    () => gitOk(['rev-parse', '--verify', 'nope'], { cwd: repo }),
    (error) => {
      assert.ok(error instanceof GitError);
      assert.equal(error.name, 'GitError');
      assert.notEqual(error.exitCode, 0);
      assert.equal(error.cwd, repo);
      assert.deepEqual(error.args, ['rev-parse', '--verify', 'nope']);
      assert.match(error.message, /git rev-parse --verify nope failed with exit code/);
      assert.ok(error.stderr.length > 0);
      return true;
    },
  );
});

test('isGitRepo distinguishes repositories, plain directories and missing paths', async () => {
  const root = newRoot();
  const repo = initRepo(path.join(root, 'repo'));
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);

  assert.equal(await isGitRepo(repo), true);
  assert.equal(await isGitRepo(plain), false);
  assert.equal(await isGitRepo(path.join(root, 'does-not-exist')), false);
});

test('repoStatus reports a clean repository including branch and remote url', async () => {
  const root = newRoot();
  const { originDir, cloneDir } = createFixture(root);

  const status = await repoStatus(cloneDir);
  assert.equal(status.isRepo, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.detached, false);
  assert.equal(status.dirty, false);
  assert.deepEqual(status.conflicted, []);
  assert.deepEqual(status.files, []);
  assert.equal(status.head, await revParse(cloneDir, 'HEAD'));
  assert.equal(fs.realpathSync.native(status.root), fs.realpathSync.native(cloneDir));
  assert.equal(path.resolve(status.remoteUrl), path.resolve(originDir));
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);

  const plainStatus = await repoStatus(path.join(root, 'plain'));
  assert.equal(plainStatus.isRepo, false);
  assert.deepEqual(plainStatus.files, []);
});

test('repoStatus reports untracked files and ahead/behind counts', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);

  writeFile(cloneDir, 'untracked.txt', 'hello\n');
  const dirty = await repoStatus(cloneDir);
  assert.equal(dirty.dirty, true);
  assert.ok(dirty.files.some((file) => file.path === 'untracked.txt' && file.status === '??'));

  commitAll(cloneDir, 'local commit');
  const aheadStatus = await repoStatus(cloneDir);
  assert.equal(aheadStatus.dirty, false);
  assert.equal(aheadStatus.ahead, 1);
  assert.equal(aheadStatus.behind, 0);
});

test('cloneRepo clones and honors an explicit branch', async () => {
  const root = newRoot();
  const { originDir, seedDir } = createFixture(root);

  git(seedDir, 'checkout', '--quiet', '-b', 'dev');
  writeFile(seedDir, 'dev.txt', 'dev\n');
  commitAll(seedDir, 'dev commit');
  git(seedDir, 'push', '--quiet', '--set-upstream', 'origin', 'dev');

  const mainClone = path.join(root, 'main-clone');
  const mainResult = await cloneRepo({ url: originDir, dir: mainClone });
  assert.equal(path.resolve(mainResult.dir), path.resolve(mainClone));
  assert.ok(fs.existsSync(path.join(mainClone, '.git')));
  assert.equal(await currentBranch(mainClone), 'main');

  const devClone = path.join(root, 'dev-clone');
  await cloneRepo({ url: originDir, dir: devClone, branch: 'dev' });
  assert.equal(await currentBranch(devClone), 'dev');
});

test('fetchAll updates remote-tracking branches and resolveDefaultBranch finds origin/HEAD', async () => {
  const root = newRoot();
  const { seedDir, cloneDir } = createFixture(root);

  writeFile(seedDir, 'README.md', '# fixture updated\n');
  const seedHead = commitAll(seedDir, 'second commit');
  git(seedDir, 'push', '--quiet', 'origin', 'main');

  const fetched = await fetchAll(cloneDir);
  assert.equal(fetched.remote, 'origin');
  assert.ok(fetched.branches.includes('main'));
  assert.equal(await revParse(cloneDir, 'origin/main'), seedHead);
  assert.equal(await resolveDefaultBranch(cloneDir), 'main');
});

test('resolveDefaultBranch falls back to local main/master without a remote', async () => {
  const root = newRoot();
  const mainRepo = initRepo(path.join(root, 'main-repo'));
  writeFile(mainRepo, 'a.txt', 'a\n');
  commitAll(mainRepo, 'commit');
  assert.equal(await resolveDefaultBranch(mainRepo), 'main');

  const masterRepo = path.join(root, 'master-repo');
  fs.mkdirSync(masterRepo);
  git(masterRepo, 'init', '--initial-branch=master', '--quiet');
  configureRepo(masterRepo);
  writeFile(masterRepo, 'a.txt', 'a\n');
  commitAll(masterRepo, 'commit');
  assert.equal(await resolveDefaultBranch(masterRepo), 'master');
});

test('createBranch, branchExists and currentBranch reflect branch state; detached HEAD yields null', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);

  await createBranch(cloneDir, 'feature', 'main');
  assert.equal(await branchExists(cloneDir, 'feature'), true);
  assert.equal(await branchExists(cloneDir, 'missing-branch'), false);

  git(cloneDir, 'checkout', '--quiet', 'feature');
  assert.equal(await currentBranch(cloneDir), 'feature');

  git(cloneDir, 'checkout', '--quiet', '--detach');
  assert.equal(await currentBranch(cloneDir), null);
  const detached = await repoStatus(cloneDir);
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
  assert.ok(detached.head);

  git(cloneDir, 'checkout', '--quiet', 'main');
});

test('deleteBranch removes local branches and remote branches when requested', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);

  await createBranch(cloneDir, 'temp-merged', 'main');
  const localResult = await deleteBranch(cloneDir, 'temp-merged');
  assert.deepEqual(localResult, { deleted: true, remoteDeleted: false });
  assert.equal(await branchExists(cloneDir, 'temp-merged'), false);

  const missingResult = await deleteBranch(cloneDir, 'never-existed');
  assert.deepEqual(missingResult, { deleted: false, remoteDeleted: false });

  await createBranch(cloneDir, 'remote-feature', 'main');
  git(cloneDir, 'push', '--quiet', '--set-upstream', 'origin', 'remote-feature');
  const remoteResult = await deleteBranch(cloneDir, 'remote-feature', { remote: 'origin' });
  assert.deepEqual(remoteResult, { deleted: true, remoteDeleted: true });
  assert.equal(await branchExists(cloneDir, 'remote-feature'), false);
  assert.equal(git(cloneDir, 'ls-remote', '--heads', 'origin', 'remote-feature'), '');
});

test('deleteBranch refuses to drop an unmerged branch without force', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);

  await createBranch(cloneDir, 'unmerged-feature', 'main');
  git(cloneDir, 'checkout', '--quiet', 'unmerged-feature');
  writeFile(cloneDir, 'unmerged.txt', 'x\n');
  commitAll(cloneDir, 'unmerged commit');
  git(cloneDir, 'checkout', '--quiet', 'main');

  await assert.rejects(() => deleteBranch(cloneDir, 'unmerged-feature'), (error) => {
    assert.ok(error instanceof GitError);
    assert.match(error.message, /not fully merged/i);
    assert.match(error.message, /force/i);
    return true;
  });
  assert.equal(await branchExists(cloneDir, 'unmerged-feature'), true);

  const forced = await deleteBranch(cloneDir, 'unmerged-feature', { force: true });
  assert.deepEqual(forced, { deleted: true, remoteDeleted: false });
});

test('aheadBehind counts commits unique to each side', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);

  writeFile(cloneDir, 'local.txt', 'local\n');
  commitAll(cloneDir, 'local commit');

  assert.deepEqual(await aheadBehind(cloneDir, 'HEAD', 'origin/main'), { ahead: 1, behind: 0 });
  assert.deepEqual(await aheadBehind(cloneDir, 'origin/main', 'HEAD'), { ahead: 0, behind: 1 });
});

test('rebase reapplies commits onto the new base', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);

  git(cloneDir, 'checkout', '--quiet', '-b', 'feature');
  writeFile(cloneDir, 'feature.txt', 'feature\n');
  commitAll(cloneDir, 'feature work');

  git(cloneDir, 'checkout', '--quiet', 'main');
  writeFile(cloneDir, 'main.txt', 'main\n');
  const mainSha = commitAll(cloneDir, 'main work');

  git(cloneDir, 'checkout', '--quiet', 'feature');
  const result = await rebase(cloneDir, 'main');
  assert.deepEqual(result, { ok: true, conflicted: [] });
  assert.equal(git(cloneDir, 'rev-parse', 'HEAD~1'), mainSha);
  assert.equal(await currentBranch(cloneDir), 'feature');
  assert.equal((await repoStatus(cloneDir)).dirty, false);
  assert.ok((await logOneline(cloneDir, { limit: 10 })).some((line) => line.includes('main work')));
});

test('rebase reports conflicts, and rebaseContinue finishes after resolution', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  const { mainSha } = setupConflict(cloneDir);

  const result = await rebase(cloneDir, 'main');
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicted, ['conflict.txt']);

  const conflictedStatus = await repoStatus(cloneDir);
  assert.deepEqual(conflictedStatus.conflicted, ['conflict.txt']);

  writeFile(cloneDir, 'conflict.txt', 'resolved\n');
  git(cloneDir, 'add', 'conflict.txt');

  const continued = await rebaseContinue(cloneDir);
  assert.deepEqual(continued, { ok: true, conflicted: [] });
  assert.equal(git(cloneDir, 'rev-parse', 'HEAD~1'), mainSha);
  assert.equal(fs.readFileSync(path.join(cloneDir, 'conflict.txt'), 'utf8'), 'resolved\n');
  assert.equal((await repoStatus(cloneDir)).dirty, false);
});

test('rebaseAbort restores the branch after a conflict', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  const { featureSha } = setupConflict(cloneDir);

  const result = await rebase(cloneDir, 'main');
  assert.equal(result.ok, false);

  await rebaseAbort(cloneDir);
  assert.equal(git(cloneDir, 'rev-parse', 'HEAD'), featureSha);
  assert.equal(await currentBranch(cloneDir), 'feature');
  const status = await repoStatus(cloneDir);
  assert.equal(status.dirty, false);
  assert.deepEqual(status.conflicted, []);
});

test('merge --no-ff creates a merge commit and reports already-up-to-date merges', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  const mainSha = git(cloneDir, 'rev-parse', 'main');

  git(cloneDir, 'checkout', '--quiet', '-b', 'feature');
  writeFile(cloneDir, 'feature.txt', 'feature\n');
  commitAll(cloneDir, 'feature work');
  git(cloneDir, 'checkout', '--quiet', 'main');

  const result = await merge(cloneDir, 'feature', { noFf: true, message: 'Merge feature branch' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicted, []);
  assert.equal(result.commit, git(cloneDir, 'rev-parse', 'HEAD'));
  assert.notEqual(result.commit, mainSha);
  const parents = git(cloneDir, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/);
  assert.equal(parents.length, 3);
  assert.ok((await logOneline(cloneDir, { limit: 5 })).some((line) => line.includes('Merge feature branch')));

  const again = await merge(cloneDir, 'feature', { noFf: true });
  assert.equal(again.ok, true);
  assert.equal(again.commit, result.commit);
});

test('merge reports conflicts, leaves MERGE_HEAD and mergeAbort clears it', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  setupConflict(cloneDir);
  git(cloneDir, 'checkout', '--quiet', 'main');

  const result = await merge(cloneDir, 'feature', { noFf: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicted, ['conflict.txt']);
  assert.equal(result.commit, null);
  assert.equal(git(cloneDir, 'rev-parse', '--verify', 'MERGE_HEAD').length, 40);

  await mergeAbort(cloneDir);
  const status = await repoStatus(cloneDir);
  assert.equal(status.dirty, false);
  assert.deepEqual(status.conflicted, []);
  assert.throws(() => git(cloneDir, 'rev-parse', '--verify', 'MERGE_HEAD'));
});

test('push updates the remote and configures upstream tracking', async () => {
  const root = newRoot();
  const { originDir, cloneDir } = createFixture(root);

  writeFile(cloneDir, 'pushed.txt', 'pushed\n');
  const head = commitAll(cloneDir, 'push me');
  const result = await push(cloneDir, 'main', { remote: 'origin' });
  assert.deepEqual(result, { remote: 'origin', branch: 'main' });
  assert.equal(git(originDir, 'rev-parse', 'main'), head);

  await createBranch(cloneDir, 'push-me', 'main');
  const branchPush = await push(cloneDir, 'push-me', { remote: 'origin' });
  assert.deepEqual(branchPush, { remote: 'origin', branch: 'push-me' });
  assert.equal(git(cloneDir, 'rev-parse', '--abbrev-ref', 'push-me@{upstream}'), 'origin/push-me');
  assert.equal(git(originDir, 'rev-parse', 'push-me'), git(cloneDir, 'rev-parse', 'push-me'));
});

test('worktree add/list/remove/prune round trip', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  const mainSha = git(cloneDir, 'rev-parse', 'main');
  const worktreePath = path.join(root, '.worktrees', 'sample__T1');

  await addWorktree(cloneDir, {
    path: worktreePath,
    branch: 'wt-feature',
    createBranch: true,
    from: 'main',
  });

  let worktrees = await listWorktrees(cloneDir);
  assert.equal(worktrees.length, 2);
  const added = worktrees.find((entry) => entry.branch === 'wt-feature');
  assert.ok(added);
  assert.equal(added.path, fs.realpathSync.native(worktreePath));
  assert.equal(added.head, mainSha);
  assert.equal(added.detached, false);
  assert.equal(added.bare, false);
  assert.equal(added.locked, false);
  assert.equal(added.prunable, false);
  assert.ok(fs.existsSync(path.join(worktreePath, 'README.md')));

  await removeWorktree(cloneDir, worktreePath);
  worktrees = await listWorktrees(cloneDir);
  assert.equal(worktrees.length, 1);
  assert.equal(fs.existsSync(worktreePath), false);

  await assert.rejects(
    () => removeWorktree(cloneDir, path.join(root, 'not-a-worktree')),
    (error) => {
      assert.ok(error instanceof GitError);
      return true;
    },
  );

  const stalePath = path.join(root, '.worktrees', 'sample__T2');
  await addWorktree(cloneDir, { path: stalePath, branch: 'stale-branch', createBranch: true });
  fs.rmSync(stalePath, { recursive: true, force: true });
  const staleList = await listWorktrees(cloneDir);
  assert.equal(staleList.find((entry) => entry.branch === 'stale-branch').prunable, true);

  await pruneWorktrees(cloneDir);
  worktrees = await listWorktrees(cloneDir);
  assert.equal(worktrees.length, 1);
});

test('listBranches names local and remote branches without HEAD aliases', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);
  await createBranch(cloneDir, 'feature', 'main');

  const local = await listBranches(cloneDir);
  assert.ok(local.includes('main'));
  assert.ok(local.includes('feature'));

  const remote = await listBranches(cloneDir, { remote: 'origin' });
  assert.deepEqual(remote, ['main']);

  const fullRemote = await listBranches(cloneDir, { remote: true });
  assert.deepEqual(fullRemote, ['origin/main']);
});

test('logOneline honors limit and range', async () => {
  const root = newRoot();
  const { cloneDir } = createFixture(root);

  writeFile(cloneDir, 'one.txt', '1\n');
  commitAll(cloneDir, 'commit one');
  writeFile(cloneDir, 'two.txt', '2\n');
  commitAll(cloneDir, 'commit two');

  const limited = await logOneline(cloneDir, { limit: 2 });
  assert.equal(limited.length, 2);
  assert.match(limited[0], /commit two/);

  const ranged = await logOneline(cloneDir, { range: 'HEAD~1..HEAD' });
  assert.equal(ranged.length, 1);
  assert.match(ranged[0], /commit two/);
});

test('parseConflictedFiles extracts only unmerged paths', () => {
  const statusText = [
    'UU src/a.js',
    'AA src/b.js',
    ' M src/c.js',
    '?? src/d.js',
    'DU src/e.js',
    'AU src/f.js',
    'UA src/g.js',
    'DD src/h.js',
    'UD src/i.js',
    'R  old.js -> new.js',
    '',
  ].join('\n');
  assert.deepEqual(parseConflictedFiles(statusText), [
    'src/a.js',
    'src/b.js',
    'src/e.js',
    'src/f.js',
    'src/g.js',
    'src/h.js',
    'src/i.js',
  ]);
  assert.deepEqual(parseConflictedFiles(''), []);
  assert.deepEqual(parseConflictedFiles(' M clean.txt'), []);
});
