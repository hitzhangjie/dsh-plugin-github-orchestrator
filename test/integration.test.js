/**
 * End-to-end integration tests for dsh-plugin-github-orchestrator.
 *
 * These tests compose the real modules against:
 *  - real local Git repositories under os.tmpdir() (never a real user repo),
 *  - the in-process mock GitHub HTTP server (never api.github.com).
 *
 * Scenarios:
 *  1. worktree create -> task commit -> rebase onto advanced origin/base ->
 *     merge branch into base and push -> worktree remove + branch cleanup.
 *  2. EventPoller + EventStore vs mock GitHub -> task -> Storyboard issue/epic
 *     sync -> close task + close issue.
 *  3. rebase conflict returns conflicted files without throwing -> rebase abort
 *     restores a clean, usable worktree.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';

import { normalizeConfig, worktreePathOf } from '../lib/config.js';
import {
  branchExists,
  currentBranch,
  fetchAll,
  listWorktrees,
  rebaseAbort,
  repoStatus,
  revParse,
  runGit,
} from '../lib/git.js';
import { createTaskWorktree, mergeTaskBranch, rebaseWorktree, removeTaskWorktree } from '../lib/worktrees.js';
import { TaskStore } from '../lib/tasks.js';

const execFileAsync = promisify(execFile);

// Commits made by the modules must work without a global git identity; the
// environment is inherited by every spawn()ed git process.
process.env.GIT_AUTHOR_NAME ??= 'GOS Integration';
process.env.GIT_AUTHOR_EMAIL ??= 'gos-integration@example.invalid';
process.env.GIT_COMMITTER_NAME ??= 'GOS Integration';
process.env.GIT_COMMITTER_EMAIL ??= 'gos-integration@example.invalid';

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** Run raw git for fixture setup; throws on non-zero exit. */
async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

/** Root temp dir for the whole file. */
let root;
let context;

before(async () => {
  // Resolve the 8.3 short TEMP path to its long form: git records the long
  // form, so worktree paths stay comparable across modules.
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gos-integration-')));

  const originDir = path.join(root, 'origin.git');
  const seedDir = path.join(root, 'seed');
  const workspaceRoot = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  await git(root, 'init', '--bare', '--initial-branch=main', originDir);
  await git(root, 'init', '--initial-branch=main', seedDir);
  fs.writeFileSync(path.join(seedDir, 'README.md'), '# demo\n');
  await git(seedDir, 'add', '-A');
  await git(seedDir, 'commit', '-m', 'chore: initial commit');
  await git(seedDir, 'remote', 'add', 'origin', originDir);
  await git(seedDir, 'push', '-u', 'origin', 'main');
  await git(seedDir, 'config', 'user.email', 'gos-integration@example.invalid');
  await git(seedDir, 'config', 'user.name', 'GOS Integration');

  const config = normalizeConfig(
    {
      workspaceRoot,
      repos: [{ repo: 'acme/demo', local: 'acme__demo', baseBranch: 'main' }],
    },
    undefined,
    { env: { ...process.env, DSH_HOME: stateDir }, homeDir: root },
  );
  const spec = config.repos[0];
  const repoDir = path.join(workspaceRoot, spec.local);

  // Clone through the module under test (also exercises cloneRepo indirectly
  // in later runs, but here a plain clone keeps the fixture explicit).
  await git(root, 'clone', originDir, repoDir);
  await git(repoDir, 'config', 'user.email', 'gos-integration@example.invalid');
  await git(repoDir, 'config', 'user.name', 'GOS Integration');
  await git(repoDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  await git(repoDir, 'fetch', 'origin');

  const tasks = new TaskStore(path.join(stateDir, 'tasks.json'));

  context = { root, originDir, seedDir, workspaceRoot, stateDir, config, spec, repoDir, tasks };
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function normalized(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved).replace(/\\/g, '/').toLowerCase();
  } catch {
    return resolved.replace(/\\/g, '/').toLowerCase();
  }
}

test('scenario 1: worktree create -> rebase onto advanced base -> merge -> cleanup', async () => {
  const { repoDir, seedDir, originDir, config, spec, tasks } = context;
  const task = tasks.create({
    repo: spec.repo,
    title: 'Add greeting',
    description: 'Introduce greeting.txt',
    status: 'in_progress',
    branch: 'task/T1-add-greeting',
    baseBranch: 'main',
    worktreePath: worktreePathOf(config, spec, 'T1'),
  });
  assert.equal(task.id, 'T1');
  const worktreePath = task.worktreePath;

  // --- create the worktree from origin/main -------------------------------
  const created = await createTaskWorktree({
    repoDir,
    worktreePath,
    branch: task.branch,
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });
  assert.equal(created.branch, task.branch);
  assert.ok(fs.existsSync(worktreePath), 'worktree directory exists after create');
  assert.equal(await currentBranch(worktreePath), task.branch, 'worktree checks out the task branch');

  // --- task commit inside the worktree ------------------------------------
  fs.writeFileSync(path.join(worktreePath, 'greeting.txt'), 'hello from task\n');
  await git(worktreePath, 'add', '-A');
  await git(worktreePath, 'commit', '-m', 'feat: add greeting');
  const taskCommit = await git(worktreePath, 'rev-parse', 'HEAD');

  // --- origin/main advances while the task is in flight --------------------
  await git(seedDir, 'pull', '--ff-only', 'origin', 'main');
  fs.writeFileSync(path.join(seedDir, 'advance.txt'), 'advanced on main\n');
  await git(seedDir, 'add', '-A');
  await git(seedDir, 'commit', '-m', 'chore: advance main');
  await git(seedDir, 'push', 'origin', 'main');
  const advancedCommit = await git(seedDir, 'rev-parse', 'HEAD');

  await fetchAll(repoDir, { remote: 'origin' });

  // --- rebase the worktree onto the advanced base -------------------------
  const rebased = await rebaseWorktree({
    worktreePath,
    baseBranch: 'main',
    remote: 'origin',
    repoDir,
  });
  assert.equal(rebased.ok, true, `expected clean rebase, conflicted=${JSON.stringify(rebased.conflicted)}`);
  assert.deepEqual(rebased.conflicted, []);
  const rebasedHead = await revParse(worktreePath, 'HEAD');
  assert.notEqual(rebasedHead, taskCommit, 'a successful rebase rewrites the task commit');
  const containsAdvance = await runGit(['merge-base', '--is-ancestor', advancedCommit, 'HEAD'], { cwd: worktreePath });
  assert.equal(containsAdvance.exitCode, 0, 'rebased HEAD contains the advanced base commit');

  // --- merge the task branch into base and push ---------------------------
  const merged = await mergeTaskBranch({
    repoDir,
    branch: task.branch,
    baseBranch: 'main',
    remote: 'origin',
    push: true,
  });
  assert.equal(merged.merged, true);
  assert.equal(merged.pushed, true);
  assert.match(String(merged.commit), /^[0-9a-f]{40}$/, 'merge commit sha returned');
  assert.equal(await currentBranch(repoDir), 'main', 'main clone is left on the base branch');

  const originMain = await git(root, '--git-dir', originDir, 'rev-parse', 'refs/heads/main');
  assert.equal(originMain, merged.commit, 'pushed base branch tip is the merge commit');
  const parents = (await git(root, '--git-dir', originDir, 'show', '-s', '--format=%P', 'refs/heads/main'))
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(parents.length, 2, 'merge commit has two parents (--no-ff)');
  const originFiles = await git(root, '--git-dir', originDir, 'ls-tree', '--name-only', 'refs/heads/main');
  assert.ok(originFiles.split('\n').includes('greeting.txt'), 'merged content pushed to origin');

  // The merged task can be closed and records a closedAt timestamp.
  const closed = tasks.close(task.id, { note: 'merged into main' });
  assert.equal(closed.status, 'done');
  assert.ok(closed.closedAt, 'closedAt set on close');

  // --- remove the worktree and clean up the branch ------------------------
  const removed = await removeTaskWorktree({
    repoDir,
    worktreePath,
    force: true,
    deleteBranch: true,
    branch: task.branch,
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchDeleted, true);
  assert.equal(await branchExists(repoDir, task.branch), false, 'local task branch deleted');
  const worktrees = await listWorktrees(repoDir);
  assert.ok(
    !worktrees.some((entry) => normalized(entry.path) === normalized(worktreePath)),
    'removed worktree no longer listed',
  );
  assert.ok(!fs.existsSync(worktreePath), 'worktree directory removed from disk');
  const status = await repoStatus(repoDir);
  assert.equal(status.isRepo, true);
  assert.equal(status.dirty, false, 'main clone clean after cleanup');
});

test('scenario 3: rebase conflict is reported, abort restores a clean worktree', async () => {
  const { repoDir, seedDir, config, spec, tasks } = context;
  const task = tasks.create({
    repo: spec.repo,
    title: 'Conflicting change',
    status: 'in_progress',
    branch: 'task/T2-conflict',
    baseBranch: 'main',
    worktreePath: worktreePathOf(config, spec, 'T2'),
  });
  const worktreePath = task.worktreePath;

  const created = await createTaskWorktree({
    repoDir,
    worktreePath,
    branch: task.branch,
    baseBranch: 'main',
    remote: 'origin',
    createBranch: true,
  });
  assert.equal(created.branch, task.branch);

  fs.writeFileSync(path.join(worktreePath, 'greeting.txt'), 'task version\n');
  await git(worktreePath, 'add', '-A');
  await git(worktreePath, 'commit', '-m', 'feat: task side of the conflict');
  const taskCommit = await git(worktreePath, 'rev-parse', 'HEAD');

  // Origin/main changes the same line -> guaranteed rebase conflict.
  await git(seedDir, 'pull', '--ff-only', 'origin', 'main');
  fs.writeFileSync(path.join(seedDir, 'greeting.txt'), 'main version\n');
  await git(seedDir, 'add', '-A');
  await git(seedDir, 'commit', '-m', 'chore: main side of the conflict');
  await git(seedDir, 'push', 'origin', 'main');
  await fetchAll(repoDir, { remote: 'origin' });

  const rebased = await rebaseWorktree({
    worktreePath,
    baseBranch: 'main',
    remote: 'origin',
    repoDir,
  });
  assert.equal(rebased.ok, false, 'conflicting rebase reports ok:false instead of throwing');
  const conflicted = rebased.conflicted.map((file) => file.replace(/\\/g, '/'));
  assert.ok(conflicted.includes('greeting.txt'), `conflicted files list includes greeting.txt, got ${JSON.stringify(conflicted)}`);

  const during = await repoStatus(worktreePath);
  assert.equal(during.isRepo, true);
  assert.ok(during.conflicted.includes('greeting.txt'), 'repoStatus reports the conflicted file');

  // Abort must restore the worktree to its pre-rebase state.
  await rebaseAbort(worktreePath);
  const afterAbort = await repoStatus(worktreePath);
  assert.deepEqual(afterAbort.conflicted, [], 'no conflicted files after abort');
  assert.equal(afterAbort.dirty, false, 'worktree clean after abort');
  assert.equal(await revParse(worktreePath, 'HEAD'), taskCommit, 'HEAD restored to the task commit');
  assert.equal(await currentBranch(worktreePath), task.branch, 'task branch still checked out after abort');

  // The restored worktree is still usable: amend the file and commit.
  fs.writeFileSync(path.join(worktreePath, 'greeting.txt'), 'task version reconciled\n');
  await git(worktreePath, 'add', '-A');
  const commit = await runGit(['commit', '-m', 'fix: reconcile conflict'], { cwd: worktreePath });
  assert.equal(commit.exitCode, 0, `commit after abort succeeds: ${commit.stderr}`);

  const removed = await removeTaskWorktree({
    repoDir,
    worktreePath,
    force: true,
    deleteBranch: true,
    branch: task.branch,
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchDeleted, true);
});

test('scenario 1b: two task worktrees coexist in one clone without interfering', async () => {
  const { repoDir, config, spec, tasks } = context;
  const taskA = tasks.create({
    repo: spec.repo,
    title: 'Parallel task A',
    status: 'in_progress',
    branch: 'task/T3-parallel-a',
    baseBranch: 'main',
    worktreePath: worktreePathOf(config, spec, 'T3'),
  });
  const taskB = tasks.create({
    repo: spec.repo,
    title: 'Parallel task B',
    status: 'in_progress',
    branch: 'task/T4-parallel-b',
    baseBranch: 'main',
    worktreePath: worktreePathOf(config, spec, 'T4'),
  });

  for (const task of [taskA, taskB]) {
    await createTaskWorktree({
      repoDir,
      worktreePath: task.worktreePath,
      branch: task.branch,
      baseBranch: 'main',
      remote: 'origin',
      createBranch: true,
    });
  }

  // Both worktrees are alive at the same time and tracked independently.
  const registered = await listWorktrees(repoDir);
  for (const task of [taskA, taskB]) {
    assert.ok(
      registered.some((entry) => normalized(entry.path) === normalized(task.worktreePath)),
      `worktree registered for ${task.id}`,
    );
  }

  fs.writeFileSync(path.join(taskA.worktreePath, 'a.txt'), 'from A\n');
  await git(taskA.worktreePath, 'add', '-A');
  await git(taskA.worktreePath, 'commit', '-m', 'feat: task A change');
  fs.writeFileSync(path.join(taskB.worktreePath, 'b.txt'), 'from B\n');
  await git(taskB.worktreePath, 'add', '-A');
  await git(taskB.worktreePath, 'commit', '-m', 'feat: task B change');

  const headA = await revParse(taskA.worktreePath, 'HEAD');
  const headB = await revParse(taskB.worktreePath, 'HEAD');
  assert.notEqual(headA, headB, 'each worktree commits on its own branch');
  assert.equal(await currentBranch(taskA.worktreePath), taskA.branch);
  assert.equal(await currentBranch(taskB.worktreePath), taskB.branch);
  assert.ok(!fs.existsSync(path.join(taskA.worktreePath, 'b.txt')), 'task A does not see task B files');
  assert.ok(!fs.existsSync(path.join(taskB.worktreePath, 'a.txt')), 'task B does not see task A files');

  for (const task of [taskA, taskB]) {
    const removed = await removeTaskWorktree({
      repoDir,
      worktreePath: task.worktreePath,
      force: true,
      deleteBranch: true,
      branch: task.branch,
    });
    assert.equal(removed.removed, true);
    assert.equal(removed.branchDeleted, true);
  }
  const remaining = await listWorktrees(repoDir);
  assert.ok(
    !remaining.some(
      (entry) =>
        normalized(entry.path) === normalized(taskA.worktreePath) ||
        normalized(entry.path) === normalized(taskB.worktreePath),
    ),
    'both parallel worktrees removed',
  );
});

test('scenario 2: poll events -> task -> storyboard issue/epic -> close', async () => {
  const { startMockGitHub } = await import('./helpers/mock-github.js');
  const { GitHubClient } = await import('../lib/github.js');
  const { EventStore, EventPoller } = await import('../lib/events.js');
  const { EPIC_META, Storyboard, TASK_META_START, parseTaskMeta } = await import('../lib/storyboard.js');

  const mock = await startMockGitHub();
  try {
    const repo = 'acme/demo';
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();

    // Seed one fresh open issue, one stale closed issue, one open PR and the
    // base branch; all polling must stay inside the mock server.
    mock.seedIssue(repo, { number: 1, title: 'First issue', state: 'open', labels: ['bug'], updated_at: now });
    mock.seedIssue(repo, { number: 2, title: 'Stale closed issue', state: 'closed', updated_at: stale });
    mock.seedPull(repo, {
      number: 1,
      title: 'Add feature',
      state: 'open',
      updated_at: now,
      head: { ref: 'feature/x', sha: 'a'.repeat(40) },
    });
    mock.seedBranch(repo, { name: 'main', sha: 'b'.repeat(40) });

    const scenarioRoot = path.join(root, 'scenario2');
    const scenarioConfig = normalizeConfig(
      {
        workspaceRoot: path.join(scenarioRoot, 'work'),
        repos: [{ repo, local: 'acme__demo' }],
        baselineDays: 14,
        maxEvents: 500,
      },
      undefined,
      { env: { ...process.env, DSH_HOME: path.join(scenarioRoot, 'state') }, homeDir: root },
    );
    const client = new GitHubClient({ token: 'test-token', apiBase: mock.url, retryDelayMs: 10 });
    const eventsFile = path.join(scenarioRoot, 'events.json');
    const watermarksFile = path.join(scenarioRoot, 'watermarks.json');
    const store = new EventStore(eventsFile);
    const poller = new EventPoller({
      client,
      store,
      config: scenarioConfig,
      watermarksPath: watermarksFile,
    });

    // --- first poll primes the watermark and emits baseline events ----------
    const first = await poller.pollOnce({ baseline: true });
    assert.equal(first.repos, 1);
    assert.deepEqual(first.errors, []);
    assert.ok(first.added > 0, 'baseline poll adds events for fresh open issues/PRs');
    const baseline = store.list({ limit: 500 });
    assert.equal(baseline.length, first.added);
    for (const event of baseline) {
      assert.equal(event.repo, repo);
      assert.equal(event.read, false);
      assert.equal(typeof event.id, 'string');
      assert.ok(event.id.length > 0);
    }
    assert.equal(new Set(baseline.map((event) => event.id)).size, baseline.length, 'event ids are unique');
    const baselineKinds = new Set(baseline.map((event) => event.kind));
    assert.ok(baselineKinds.has('issue'), `baseline issue event expected, got ${[...baselineKinds]}`);
    assert.ok(baselineKinds.has('pr'), `baseline pull event expected, got ${[...baselineKinds]}`);
    assert.ok(baseline.some((event) => event.baseline === true), 'baseline events are flagged');
    assert.ok(fs.existsSync(watermarksFile), 'watermarks persisted to the constructor path');

    // --- re-polling the unchanged API produces no duplicates ----------------
    const second = await poller.pollOnce();
    assert.deepEqual(second.errors, []);
    assert.equal(second.added, 0, 'unchanged GitHub state yields no new events');
    assert.equal(store.list({ limit: 500 }).length, baseline.length);

    // --- changed issue, new review and moved branch are detected -----------
    const future = new Date(Date.now() + 5000).toISOString();
    mock.updateIssue(repo, 1, { title: 'First issue renamed', updated_at: future });
    mock.updatePull(repo, 1, { updated_at: future });
    mock.seedReview(repo, 1, { id: 2, state: 'APPROVED', body: 'LGTM', submitted_at: future });
    mock.seedBranch(repo, { name: 'main', sha: 'c'.repeat(40) });

    const third = await poller.pollOnce();
    assert.deepEqual(third.errors, []);
    assert.ok(third.added >= 2, `expected new events after remote changes, added=${third.added}`);
    const afterChanges = store.list({ limit: 500 });
    const changedKinds = new Set(afterChanges.map((event) => event.kind));
    assert.ok(changedKinds.has('issue'), 'renamed issue produces an issue event');
    assert.ok(changedKinds.has('review'), `new review produces a review event, got ${[...changedKinds]}`);
    assert.ok(changedKinds.has('push'), `moved branch produces a push event, got ${[...changedKinds]}`);

    const fourth = await poller.pollOnce();
    assert.deepEqual(fourth.errors, []);
    assert.equal(fourth.added, 0, 're-polling after changes is idempotent');

    const unreadBefore = store.unreadCount({ repo });
    assert.ok(unreadBefore > 0);
    const toMark = store.list({ unreadOnly: true, limit: 2 }).map((event) => event.id);
    const marked = store.markRead(toMark);
    assert.equal(marked, toMark.length);
    assert.equal(store.unreadCount({ repo }), unreadBefore - marked);
    const stats = store.stats();
    assert.equal(stats.total, afterChanges.length);
    assert.ok(stats.byRepo[repo] > 0);
    assert.ok(Object.keys(stats.byKind).length > 0);

    // --- task -> GitHub issue/epic -> close task and issue -----------------
    const tasks = new TaskStore(path.join(scenarioRoot, 'tasks.json'));
    const storyboard = new Storyboard({ client, tasks, config: scenarioConfig });
    const task = tasks.create({
      repo,
      title: 'Wire up polling',
      description: 'Poll GitHub and mirror tasks into issues',
      status: 'ready',
      branch: 'task/T1-wire-up-polling',
      baseBranch: 'main',
    });

    const synced = await storyboard.syncTask(task);
    assert.ok(synced.issue?.number > 0, 'task issue created on mock GitHub');
    assert.ok(synced.epic?.number > 0, 'epic issue created on mock GitHub');
    const reloaded = tasks.get(task.id);
    assert.equal(reloaded.issueNumber, synced.issue.number);
    assert.equal(reloaded.epicNumber, synced.epic.number);

    const issue = (await client.get(`/repos/${repo}/issues/${synced.issue.number}`)).data;
    assert.equal(issue.title, `[${task.id}] Wire up polling`);
    assert.ok(issue.body.startsWith(TASK_META_START), 'issue body starts with the hidden meta block');
    assert.equal(parseTaskMeta(issue.body).taskId, task.id);
    const epic = (await client.get(`/repos/${repo}/issues/${synced.epic.number}`)).data;
    assert.ok(epic.body.includes(EPIC_META), 'epic body carries the epic marker');
    assert.ok(epic.body.includes('Wire up polling'), 'epic lists the task');

    const resynced = await storyboard.syncTask(reloaded);
    assert.equal(resynced.issue.number, synced.issue.number, 'sync is idempotent for the issue');
    assert.equal(resynced.epic.number, synced.epic.number, 'sync is idempotent for the epic');

    const closed = tasks.close(task.id, { note: 'verified end to end' });
    assert.equal(closed.status, 'done');
    assert.ok(closed.closedAt);
    await storyboard.closeTaskIssue(closed, 'Closing after verification');
    const closedIssue = (await client.get(`/repos/${repo}/issues/${synced.issue.number}`)).data;
    assert.equal(closedIssue.state, 'closed', 'task issue closed on mock GitHub');
    const commentRequest = mock.requests.find(
      (request) =>
        request.method === 'POST' &&
        request.path === `/repos/${repo}/issues/${synced.issue.number}/comments`,
    );
    assert.ok(commentRequest, 'closing comment posted');
    assert.equal(commentRequest.body.body, 'Closing after verification');

    const epicAfter = await storyboard.syncEpic(repo);
    assert.equal(epicAfter.number, synced.epic.number);
    const epicAfterBody = (await client.get(`/repos/${repo}/issues/${epicAfter.number}`)).data.body;
    assert.ok(epicAfterBody.includes('| done | 1 |'), 'epic counts reflect the closed task');
  } finally {
    await mock.close();
  }
});
