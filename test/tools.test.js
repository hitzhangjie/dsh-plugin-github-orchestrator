/**
 * Lead-owned tests for the tool orchestration layer: configuration, repo
 * bookkeeping, event inbox actions, task/storyboard orchestration and the
 * worktree + merge lifecycle.
 *
 * Git tests use a local bare origin, so the whole suite stays offline.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { normalizeConfig } from '../lib/config.js';
import { gitOk } from '../lib/git.js';
import { EventStore } from '../lib/events.js';
import { TaskStore } from '../lib/tasks.js';
import { createToolDefinitions } from '../lib/tools.js';

const tempRoots = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeStoryboard() {
  const calls = [];
  return {
    calls,
    async createTaskIssue(repo, task) {
      calls.push({ op: 'createIssue', repo, task: task.id });
      return { number: 10 + calls.length, url: `https://example.test/issues/${10 + calls.length}` };
    },
    async updateTaskIssue(task) {
      calls.push({ op: 'updateIssue', task: task.id, issueNumber: task.issueNumber });
      return task.issueNumber ? { number: task.issueNumber, url: `https://example.test/issues/${task.issueNumber}` } : null;
    },
    async commentTask(task, text) {
      calls.push({ op: 'comment', task: task.id, text });
    },
    async closeTaskIssue(task, comment) {
      calls.push({ op: 'closeIssue', task: task.id, comment });
    },
    async syncEpic(repo) {
      calls.push({ op: 'syncEpic', repo });
      return { number: 1, url: 'https://example.test/issues/1' };
    },
    async syncTask(task) {
      calls.push({ op: 'syncTask', task: task.id });
      return { issue: task.issueNumber ? { number: task.issueNumber } : undefined };
    },
    async importIssues(repo) {
      calls.push({ op: 'importIssues', repo });
      return { imported: 0, skipped: 0 };
    },
    async bootstrap(repo) {
      calls.push({ op: 'bootstrap', repo });
      return { epic: { number: 1 }, imported: { imported: 0, skipped: 0 } };
    },
    updateConfig() {},
  };
}

function createRuntime(opts) {
  const root = opts.root;
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const rawConfig = {
    workspaceRoot: path.join(root, 'workspace'),
    repos: opts.repos ?? [],
    pollIntervalSec: 120,
  };
  let config = normalizeConfig(rawConfig, {}, { env: { DSH_HOME: root }, homeDir: root });
  const storyboard = opts.storyboard ?? fakeStoryboard();
  const poller = {
    running: false,
    async pollOnce() {
      return { repos: config.repos.length, added: 0, errors: [] };
    },
    watermarks() {
      return {};
    },
    start() {
      this.running = true;
    },
    stop() {
      this.running = false;
    },
    updateConfig() {},
  };
  const authState = {
    hasToken: opts.hasToken !== false,
    source: opts.hasToken === false ? 'none' : 'env',
    meta: null,
    pending: null,
  };
  const runtime = {
    storyboard,
    poller,
    events: new EventStore(path.join(stateDir, 'events.json')),
    tasks: new TaskStore(path.join(stateDir, 'tasks.json')),
    getConfig: () => config,
    updateSettings(patch) {
      const merged = { ...(runtime.settings ?? {}), ...patch };
      runtime.settings = merged;
      config = normalizeConfig(rawConfig, merged, { env: { DSH_HOME: root }, homeDir: root });
      return config;
    },
    tokenInfo: () => ({ hasToken: authState.hasToken, source: authState.source }),
    pollerStatus() {
      return { running: false, intervalSec: config.pollIntervalSec, token: authState.hasToken, tokenSource: authState.source, watermarks: {} };
    },
    oauthStatus() {
      return {
        authenticated: authState.hasToken,
        source: authState.source,
        login: authState.meta?.login ?? null,
        scopes: authState.meta?.scopes ?? null,
        clientId: 'test-client-id',
        clientIdSource: 'config',
        credentialsAvailable: true,
        pending: authState.pending ? { ...authState.pending } : null,
      };
    },
    async oauthStart({ scopes } = {}) {
      authState.pending = {
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        intervalSec: 5,
        scopes: scopes ?? 'repo read:user',
        clientId: 'test-client-id',
        clientIdSource: 'config',
      };
      return { ...authState.pending };
    },
    async oauthPoll() {
      if (!authState.pending) throw new Error('No pending GitHub device-flow sign-in.');
      authState.pending = null;
      authState.hasToken = true;
      authState.source = 'oauth';
      authState.meta = { login: 'octocat', scopes: ['repo'] };
      return { authenticated: true, source: 'oauth', login: 'octocat', scopes: ['repo'], stored: true };
    },
    oauthCancel() {
      authState.pending = null;
    },
    async oauthLogout() {
      authState.hasToken = false;
      authState.source = 'none';
      authState.meta = null;
      authState.pending = null;
      return { loggedOut: true, credentialDeleted: true };
    },
  };
  return { runtime, storyboard, stateDir, root, authState };
}

function toolMap(runtime) {
  return Object.fromEntries(createToolDefinitions(runtime).map((tool) => [tool.name, tool]));
}

async function initGitRepo(dir, branch = 'main') {
  await gitOk(['init', '-b', branch], { cwd: dir });
  await gitOk(['config', 'user.email', 'test@example.test'], { cwd: dir });
  await gitOk(['config', 'user.name', 'Test User'], { cwd: dir });
}

async function commitFile(dir, name, content, message) {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  await gitOk(['add', name], { cwd: dir });
  await gitOk(['commit', '-m', message], { cwd: dir });
}

describe('tool surface', () => {
  it('exposes seven tools with model-facing schemas and output rendering', () => {
    const { runtime } = createRuntime({ root: tempDir('gos-tools-') });
    const tools = toolMap(runtime);
    assert.deepEqual(Object.keys(tools).sort(), ['git_sync', 'git_worktree', 'github_auth', 'github_config', 'github_events', 'github_repos', 'github_tasks']);
    for (const tool of Object.values(tools)) {
      assert.equal(typeof tool.name, 'string');
      assert.ok(tool.description.length > 60, `${tool.name} needs a useful description`);
      assert.equal(tool.parameters.type, 'object');
      assert.equal(typeof tool.execute, 'function');
      assert.equal(tool.output.schema.type, 'object');
      const rendered = tool.output.render({}, { ok: true, value: 1 });
      assert.equal(rendered[0].type, 'text');
      assert.match(rendered[0].text, /"ok": true/);
    }
  });
});

describe('github_config', () => {
  it('shows resolved paths and persists workspace overrides', async () => {
    const root = tempDir('gos-config-');
    const { runtime } = createRuntime({ root });
    const tools = toolMap(runtime);
    const shown = await tools.github_config.execute({ action: 'show' }, {});
    assert.equal(shown.ok, true);
    assert.equal(shown.token.available, true);
    assert.equal(shown.repos.length, 0);

    const newWorkspace = path.join(root, 'new-workspace');
    const updated = await tools.github_config.execute({ action: 'set', workspaceRoot: newWorkspace, pollIntervalSec: 30 }, {});
    assert.equal(updated.workspaceRoot, newWorkspace);
    assert.equal(updated.pollIntervalSec, 30);
    assert.equal(fs.existsSync(newWorkspace), true);
    assert.equal(updated.token.available, true);
    assert.equal(updated.workspaceExists, true);
  });
});

describe('github_auth', () => {
  it('reports token status and starts, polls and logs out the device flow', async () => {
    const { runtime } = createRuntime({ root: tempDir('gos-auth-'), hasToken: false });
    const tools = toolMap(runtime);

    const initial = await tools.github_auth.execute({ action: 'status' }, {});
    assert.equal(initial.ok, true);
    assert.equal(initial.authenticated, false);
    assert.equal(initial.credentialsAvailable, true);
    assert.equal(initial.clientId, 'test-client-id');

    const started = await tools.github_auth.execute({ action: 'start', scopes: 'repo' }, {});
    assert.equal(started.ok, true);
    assert.equal(started.userCode, 'ABCD-1234');
    assert.equal(started.verificationUri, 'https://github.com/login/device');
    assert.equal(started.scopes, 'repo');
    assert.equal(typeof started.hint, 'string');

    const pending = await tools.github_auth.execute({ action: 'status' }, {});
    assert.equal(pending.pending.userCode, 'ABCD-1234');

    const polled = await tools.github_auth.execute({ action: 'poll', timeoutSec: 30 }, {});
    assert.equal(polled.ok, true);
    assert.equal(polled.authenticated, true);
    assert.equal(polled.source, 'oauth');
    assert.equal(polled.login, 'octocat');

    const after = await tools.github_auth.execute({ action: 'status' }, {});
    assert.equal(after.authenticated, true);
    assert.equal(after.login, 'octocat');
    assert.equal(after.pending, null);

    const loggedOut = await tools.github_auth.execute({ action: 'logout' }, {});
    assert.equal(loggedOut.ok, true);
    assert.equal(loggedOut.loggedOut, true);
    assert.equal(loggedOut.authenticated, false);
    const json = JSON.stringify(loggedOut);
    assert.equal(/access_token|accessToken|ghp_/.test(json), false);
  });

  it('rejects polling without a pending sign-in', async () => {
    const { runtime } = createRuntime({ root: tempDir('gos-auth-none-') });
    const tools = toolMap(runtime);
    await assert.rejects(() => tools.github_auth.execute({ action: 'poll' }, {}), /No pending/);
  });
});

describe('github_repos', () => {
  it('adds, lists and removes watched repositories without touching files', async () => {
    const root = tempDir('gos-repos-');
    const { runtime } = createRuntime({ root });
    const tools = toolMap(runtime);

    assert.equal((await tools.github_repos.execute({ action: 'list' }, {})).repos.length, 0);
    const added = await tools.github_repos.execute({ action: 'add', repo: 'owner/name', local: 'custom-name' }, {});
    assert.equal(added.added.repo, 'owner/name');
    assert.equal(added.added.local, 'custom-name');

    const listed = await tools.github_repos.execute({ action: 'list' }, {});
    assert.equal(listed.repos.length, 1);
    assert.equal(listed.repos[0].cloned, false);
    assert.equal(listed.repos[0].activeTasks, 0);

    const removed = await tools.github_repos.execute({ action: 'remove', repo: 'owner/name' }, {});
    assert.equal(removed.removed, 'owner/name');
    assert.equal((await tools.github_repos.execute({ action: 'list' }, {})).repos.length, 0);
  });

  it('rejects invalid repository names and duplicates', async () => {
    const { runtime } = createRuntime({ root: tempDir('gos-repos-bad-') });
    const tools = toolMap(runtime);
    await assert.rejects(() => tools.github_repos.execute({ action: 'add', repo: 'not-a-repo' }, {}), /owner\/name/);
    await tools.github_repos.execute({ action: 'add', repo: 'a/b' }, {});
    await assert.rejects(() => tools.github_repos.execute({ action: 'add', repo: 'a/b' }, {}), /already configured/);
  });
});

describe('github_events', () => {
  it('lists, filters and marks events read', async () => {
    const { runtime } = createRuntime({ root: tempDir('gos-events-') });
    const tools = toolMap(runtime);
    runtime.events.add([
      { id: 'e1', repo: 'o/r', kind: 'issue', action: 'opened', number: 1, title: 'A', at: '2026-01-01T00:00:00.000Z', summary: 'a', read: false },
      { id: 'e2', repo: 'o/r', kind: 'push', action: 'pushed', branch: 'main', at: '2026-01-02T00:00:00.000Z', summary: 'b', read: false },
    ]);
    const listed = await tools.github_events.execute({ action: 'list', unreadOnly: true, limit: 10 }, {});
    assert.equal(listed.count, 2);
    assert.equal(listed.stats.unread, 2);

    const marked = await tools.github_events.execute({ action: 'mark', ids: ['e1'] }, {});
    assert.equal(marked.marked, 1);
    const afterMark = await tools.github_events.execute({ action: 'list', unreadOnly: true }, {});
    assert.equal(afterMark.count, 1);
    assert.equal((await tools.github_events.execute({ action: 'stats' }, {})).unread, 1);

    const polled = await tools.github_events.execute({ action: 'poll' }, {});
    assert.equal(polled.ok, true);
  });
});

describe('github_tasks', () => {
  it('creates a task with an issue, updates, notes and closes it', async () => {
    const { runtime, storyboard } = createRuntime({ root: tempDir('gos-tasks-'), repos: ['o/r'] });
    const tools = toolMap(runtime);

    const created = await tools.github_tasks.execute(
      { action: 'create', repo: 'o/r', title: 'Fix parser crash', description: 'Root cause the crash', priority: 'high' },
      {},
    );
    assert.equal(created.ok, true);
    assert.equal(created.task.id, 'T1');
    assert.equal(created.task.status, 'ready');
    assert.equal(created.task.branch, 'task/T1-fix-parser-crash');
    assert.equal(created.task.issueNumber, 11);
    assert.ok(storyboard.calls.some((call) => call.op === 'createIssue'));
    assert.ok(storyboard.calls.some((call) => call.op === 'syncEpic'));

    const updated = await tools.github_tasks.execute({ action: 'update', id: 'T1', status: 'in_progress', note: 'Reproduced locally' }, {});
    assert.equal(updated.task.status, 'in_progress');
    assert.equal(updated.task.notes.length, 1);
    assert.ok(storyboard.calls.some((call) => call.op === 'updateIssue'));

    const listed = await tools.github_tasks.execute({ action: 'list' }, {});
    assert.equal(listed.count, 1);
    const shown = await tools.github_tasks.execute({ action: 'show', id: 'T1' }, {});
    assert.equal(shown.task.title, 'Fix parser crash');

    const closed = await tools.github_tasks.execute({ action: 'close', id: 'T1', note: 'Done' }, {});
    assert.equal(closed.task.status, 'done');
    assert.equal(closed.task.closedAt !== undefined, true);
    assert.ok(storyboard.calls.some((call) => call.op === 'closeIssue'));
  });

  it('creates tasks without issues when no token is available', async () => {
    const { runtime, storyboard } = createRuntime({ root: tempDir('gos-tasks-notoken-'), repos: ['o/r'], hasToken: false });
    const tools = toolMap(runtime);
    const created = await tools.github_tasks.execute({ action: 'create', repo: 'o/r', title: 'No issue' }, {});
    assert.equal(created.task.issueNumber, undefined);
    assert.equal(created.warnings.some((warning) => /No GitHub token/.test(warning)), true);
    assert.equal(storyboard.calls.length, 0);
  });
});

describe('git worktree + merge lifecycle through tools', () => {
  it('creates a worktree, merges the task branch and cleans up', async () => {
    const root = tempDir('gos-git-');
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    const clone = path.join(root, 'workspace', 'o__r');
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    fs.mkdirSync(seed, { recursive: true });

    await gitOk(['init', '--bare', '-b', 'main', origin], { cwd: root });
    await initGitRepo(seed);
    await commitFile(seed, 'README.md', '# demo\n', 'initial');
    await gitOk(['remote', 'add', 'origin', origin], { cwd: seed });
    await gitOk(['push', '-u', 'origin', 'main'], { cwd: seed });
    await gitOk(['-c', 'core.autocrlf=false', 'clone', origin, clone], { cwd: root });
    await gitOk(['config', 'user.email', 'test@example.test'], { cwd: clone });
    await gitOk(['config', 'user.name', 'Test User'], { cwd: clone });

    const { runtime, storyboard } = createRuntime({ root, repos: ['o/r'] });
    runtime.updateSettings({ repos: [{ repo: 'o/r', local: 'o__r' }] });
    const tools = toolMap(runtime);

    const created = await tools.github_tasks.execute({ action: 'create', repo: 'o/r', title: 'Add feature' }, {});
    assert.equal(created.task.id, 'T1');

    const worktree = await tools.git_worktree.execute({ action: 'create', task: 'T1', fetch: false }, {});
    assert.equal(worktree.ok, true);
    assert.equal(worktree.branch, 'task/T1-add-feature');
    assert.equal(fs.existsSync(worktree.worktreePath), true);
    assert.equal(runtime.tasks.get('T1').status, 'in_progress');

    await commitFile(worktree.worktreePath, 'feature.txt', 'feature\n', 'add feature');
    await gitOk(['push', 'origin', 'task/T1-add-feature'], { cwd: worktree.worktreePath });

    const listed = await tools.git_worktree.execute({ action: 'list' }, {});
    assert.equal(listed.repos[0].worktrees.length, 1);
    assert.equal(listed.repos[0].worktrees[0].task.id, 'T1');
    assert.equal(listed.repos[0].worktrees[0].dirty, false);

    const merged = await tools.git_sync.execute({ action: 'merge', task: 'T1' }, {});
    assert.equal(merged.ok, true);
    assert.equal(merged.merged, true);
    assert.equal(fs.existsSync(worktree.worktreePath), false);
    assert.equal(runtime.tasks.get('T1').status, 'done');
    assert.equal(Boolean(runtime.tasks.get('T1').worktreePath), false);
    assert.ok(storyboard.calls.some((call) => call.op === 'closeIssue'));
    assert.ok(merged.cleanup && merged.cleanup.branchDeleted, `cleanup=${JSON.stringify(merged.cleanup)} warnings=${JSON.stringify(merged.warnings)}`);
    await assert.rejects(() => gitOk(['rev-parse', '--verify', 'task/T1-add-feature'], { cwd: clone }));
  });

  it('reports a rebase conflict without throwing and aborts cleanly', async () => {
    const root = tempDir('gos-conflict-');
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    const clone = path.join(root, 'workspace', 'o__r');
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    fs.mkdirSync(seed, { recursive: true });

    await gitOk(['init', '--bare', '-b', 'main', origin], { cwd: root });
    await initGitRepo(seed);
    await commitFile(seed, 'file.txt', 'base\n', 'initial');
    await gitOk(['remote', 'add', 'origin', origin], { cwd: seed });
    await gitOk(['push', '-u', 'origin', 'main'], { cwd: seed });
    await gitOk(['-c', 'core.autocrlf=false', 'clone', origin, clone], { cwd: root });
    await gitOk(['config', 'user.email', 'test@example.test'], { cwd: clone });
    await gitOk(['config', 'user.name', 'Test User'], { cwd: clone });

    const { runtime } = createRuntime({ root, repos: ['o/r'] });
    runtime.updateSettings({ repos: [{ repo: 'o/r', local: 'o__r' }] });
    const tools = toolMap(runtime);

    await tools.github_tasks.execute({ action: 'create', repo: 'o/r', title: 'Conflicting change' }, {});
    const worktree = await tools.git_worktree.execute({ action: 'create', task: 'T1', fetch: false }, {});
    await commitFile(worktree.worktreePath, 'file.txt', 'task version\n', 'task change');

    await commitFile(seed, 'file.txt', 'main version\n', 'main change');
    await gitOk(['push', 'origin', 'main'], { cwd: seed });

    const rebased = await tools.git_sync.execute({ action: 'rebase', task: 'T1' }, {});
    assert.equal(rebased.ok, false);
    assert.deepEqual(rebased.conflicted, ['file.txt']);

    const aborted = await tools.git_sync.execute({ action: 'rebase_abort', task: 'T1' }, {});
    assert.equal(aborted.ok, true);
    const status = await tools.git_sync.execute({ action: 'status' }, {});
    assert.equal(status.repos[0].status.dirty, false);
  });
});
