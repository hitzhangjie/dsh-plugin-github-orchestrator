import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  EPIC_META,
  Storyboard,
  TASK_META_START,
  parseTaskMeta,
  renderEpicIssue,
  renderTaskIssue,
  stripTaskMeta,
} from '../lib/storyboard.js';
import { TaskStore } from '../lib/tasks.js';

/**
 * Minimal GitHubClient-compatible wrapper around the in-process mock server.
 * Only the methods Storyboard uses are implemented; non-2xx responses throw an
 * Error carrying the HTTP status under `.status`, like GitHubError.
 */
class TestGitHubClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.requests = [];
  }

  async request(method, requestPath, opts = {}) {
    const url = new URL(`${this.baseUrl}${requestPath}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    };
    const response = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    this.requests.push({ method, path: url.pathname, search: url.search, body: opts.body });
    if (response.status >= 400) {
      const error = new Error(
        `GitHub ${method} ${requestPath} failed with ${response.status}: ${text}`,
      );
      error.status = response.status;
      error.body = data;
      throw error;
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), data };
  }

  get(requestPath, opts) {
    return this.request('GET', requestPath, opts);
  }

  post(requestPath, body, opts = {}) {
    return this.request('POST', requestPath, { ...opts, body });
  }

  patch(requestPath, body, opts = {}) {
    return this.request('PATCH', requestPath, { ...opts, body });
  }

  async paginate(requestPath, opts = {}) {
    const response = await this.get(requestPath, {
      query: { ...(opts.query ?? {}), per_page: opts.perPage ?? 100 },
    });
    if (Array.isArray(response.data)) return response.data;
    if (Array.isArray(response.data?.items)) return response.data.items;
    return [];
  }
}

const metaOf = (task, repo) => ({
  taskId: task.id,
  repo,
  branch: task.branch,
  status: task.status,
  baseBranch: task.baseBranch,
  worktree: task.worktreePath ?? null,
});

describe('storyboard rendering', () => {
  it('renders a deterministic task issue with parsable metadata', () => {
    const task = {
      id: 'T7',
      repo: 'acme/demo',
      title: 'Speed up cache',
      description: 'LRU please',
      status: 'ready',
      priority: 'high',
      branch: 'task/t7-speed-up-cache',
      baseBranch: 'main',
      worktreePath: 'C:/work/.worktrees/demo__T7',
      tags: ['perf'],
      notes: [{ at: '2026-01-01T00:00:00.000Z', text: 'opened' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const first = renderTaskIssue(task);
    const second = renderTaskIssue(task);
    assert.deepEqual(first, second);
    assert.equal(first.title, '[T7] Speed up cache');
    assert.deepEqual(first.labels, ['gos:task', 'gos:status/ready']);
    assert.ok(first.body.startsWith(TASK_META_START));
    assert.match(first.body, /## Summary\n\nLRU please/);
    assert.match(first.body, /## Plan\n\n- Status: `ready`/);
    assert.match(first.body, /- Worktree: `C:\/work\/\.worktrees\/demo__T7`/);
    assert.match(first.body, /## Notes\n\n- 2026-01-01T00:00:00\.000Z opened/);

    const meta = parseTaskMeta(first.body);
    assert.deepEqual(meta, metaOf(task, 'acme/demo'));
    assert.equal(meta.taskId, task.id);
    assert.equal(meta.status, task.status);
    assert.equal(meta.branch, task.branch);
  });

  it('renders placeholders when description and notes are empty', () => {
    const task = {
      id: 'T2',
      repo: 'acme/demo',
      title: 'Empty',
      description: '',
      status: 'backlog',
      priority: 'normal',
      branch: 'task/t2-empty',
      baseBranch: 'main',
      tags: [],
      notes: [],
    };
    const rendered = renderTaskIssue(task, { repo: 'other/repo' });
    assert.match(rendered.body, /## Summary\n\n_No description yet\._/);
    assert.match(rendered.body, /## Notes\n\n_No notes yet\._/);
    assert.equal(parseTaskMeta(rendered.body).repo, 'other/repo');
  });

  it('parses only well-formed metadata blocks', () => {
    assert.equal(parseTaskMeta('no meta here'), null);
    assert.equal(parseTaskMeta(`${TASK_META_START}\n{broken\n-->`), null);
    assert.equal(parseTaskMeta(`${TASK_META_START}\n\n-->`), null);
    assert.equal(parseTaskMeta(`${TASK_META_START}\n[1,2]\n-->`), null);
    assert.deepEqual(
      parseTaskMeta(`prefix\n${TASK_META_START}\n{"taskId":"T9"}\n-->\ntail`),
      { taskId: 'T9' },
    );
  });

  it('strips the metadata block when importing a body', () => {
    const body = `<!-- github-orchestrator:task\n{"taskId":"T1"}\n-->\n\n## Summary\n\nDetails\n`;
    assert.equal(stripTaskMeta(body), '## Summary\n\nDetails');
    assert.equal(stripTaskMeta('plain text'), 'plain text');
  });

  it('renders a stable epic body with counts, task table and next-up list', () => {
    const tasks = [
      { id: 'T2', title: 'Second', status: 'ready', branch: 'task/t2-second', issueNumber: 12 },
      { id: 'T1', title: 'First', status: 'done', branch: 'task/t1-first' },
      { id: 'T3', title: 'Third', status: 'in_progress', branch: 'task/t3-third' },
    ];
    const opts = { repo: 'acme/demo', tasks, generatedAt: '2026-02-03T04:05:06.000Z' };
    const first = renderEpicIssue(opts);
    assert.deepEqual(first, renderEpicIssue(opts));
    assert.equal(first.title, '[Storyboard] acme/demo');
    assert.deepEqual(first.labels, ['gos:epic']);
    assert.ok(first.body.includes(EPIC_META));
    assert.match(first.body, /_Generated at 2026-02-03T04:05:06\.000Z_/);
    assert.match(first.body, /\| Status \| Count \|/);
    assert.match(first.body, /\| ready \| 1 \|/);
    assert.match(first.body, /\| done \| 1 \|/);
    assert.match(first.body, /\| \*\*Total\*\* \| 3 \|/);
    assert.match(first.body, /\| Task \| Status \| Branch \| Issue \|/);
    assert.match(first.body, /\| \[T2\] Second \| ready \| `task\/t2-second` \| #12 \|/);
    assert.match(first.body, /## Next up\n\n- \[T3\] Third \(in_progress\)\n- \[T2\] Second \(ready\)/);
  });

  it('renders an empty epic without throwing', () => {
    const rendered = renderEpicIssue({ repo: 'acme/demo', tasks: [], generatedAt: '2026-01-01T00:00:00.000Z' });
    assert.match(rendered.body, /_Nothing queued\._/);
    assert.match(rendered.body, /\| \*\*Total\*\* \| 0 \|/);
  });
});

describe('Storyboard with mock GitHub', () => {
  let startMockGitHub;
  let server;
  let client;
  let tmpDir;
  let tasks;
  let storyboard;

  before(async () => {
    ({ startMockGitHub } = await import('./helpers/mock-github.js'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-storyboard-'));
    server = await startMockGitHub();
    client = new TestGitHubClient(server.url);
    tasks = new TaskStore(path.join(tmpDir, 'tasks.json'));
    // No config: default `gos:*` labels apply.
    storyboard = new Storyboard({ client, tasks });
  });

  after(async () => {
    await server?.close?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function getIssue(repo, number) {
    return (await client.get(`/repos/${repo}/issues/${number}`)).data;
  }

  async function createIssue(repo, payload) {
    return (await client.post(`/repos/${repo}/issues`, payload)).data;
  }

  it('ensureLabels creates the storyboard labels once', async () => {
    const repo = 'acme/labels';
    await storyboard.ensureLabels(repo);
    const labels = (await client.get(`/repos/${repo}/labels`)).data;
    const names = labels.map((label) => label.name);
    assert.ok(names.includes('gos:task'));
    assert.ok(names.includes('gos:epic'));
    for (const status of ['backlog', 'ready', 'in_progress', 'review', 'done']) {
      assert.ok(names.includes(`gos:status/${status}`), `missing gos:status/${status}`);
    }

    const before = (await client.get(`/repos/${repo}/labels`)).data.length;
    await storyboard.ensureLabels(repo);
    const after = (await client.get(`/repos/${repo}/labels`)).data.length;
    assert.equal(after, before);
  });

  it('creates and updates a task issue', async () => {
    const repo = 'acme/issues';
    const task = tasks.create({ repo, title: 'Write docs', description: 'README first' });
    const created = await storyboard.createTaskIssue(repo, task);
    assert.equal(created.number > 0, true);
    assert.ok(created.url);

    const issue = await getIssue(repo, created.number);
    assert.equal(issue.title, `[${task.id}] Write docs`);
    assert.deepEqual(issue.labels.map((label) => (typeof label === 'string' ? label : label.name)).sort(), [
      'gos:status/backlog',
      'gos:task',
    ]);
    assert.ok(issue.body.startsWith(TASK_META_START));
    assert.equal(parseTaskMeta(issue.body).taskId, task.id);

    const updatedTask = tasks.update(task.id, {
      title: 'Write docs better',
      status: 'in_progress',
      note: 'started',
      issueNumber: created.number,
    });
    const updated = await storyboard.updateTaskIssue(updatedTask);
    assert.equal(updated.number, created.number);
    const patched = await getIssue(repo, created.number);
    assert.equal(patched.title, `[${task.id}] Write docs better`);
    assert.ok(patched.body.includes('- Status: `in_progress`'));
    assert.ok(patched.body.includes('started'));

    const noIssue = tasks.create({ repo, title: 'Nothing to update' });
    assert.equal(await storyboard.updateTaskIssue(noIssue), null);
  });

  it('comments on and closes a task issue', async () => {
    const repo = 'acme/comments';
    const task = tasks.create({ repo, title: 'Comment target' });
    const created = await storyboard.createTaskIssue(repo, task);
    const withIssue = tasks.update(task.id, { issueNumber: created.number });

    await storyboard.commentTask(withIssue, 'Looking into this');
    const commentRequest = client.requests.find(
      (request) =>
        request.method === 'POST' && request.path.endsWith(`/issues/${created.number}/comments`),
    );
    assert.ok(commentRequest);
    assert.equal(commentRequest.body.body, 'Looking into this');

    await storyboard.closeTaskIssue(withIssue, 'Done in v1');
    const closed = await getIssue(repo, created.number);
    assert.equal(closed.state, 'closed');
  });

  it('creates the epic once and then updates it', async () => {
    const repo = 'acme/epic';
    tasks.create({ repo, title: 'Epic task one', status: 'ready' });
    tasks.create({ repo, title: 'Epic task two', status: 'done' });

    const first = await storyboard.syncEpic(repo);
    assert.ok(first.number > 0);
    const issue = await getIssue(repo, first.number);
    assert.equal(issue.title, '[Storyboard] acme/epic');
    assert.ok(issue.body.includes(EPIC_META));
    assert.ok(issue.body.includes('Epic task one'));
    assert.ok(issue.body.includes('# Storyboard — acme/epic'));

    const second = await storyboard.syncEpic(repo);
    assert.equal(second.number, first.number);
    const patched = await getIssue(repo, first.number);
    assert.equal(patched.title, '[Storyboard] acme/epic');
  });

  it('reuses and reopens a closed epic instead of creating a second one', async () => {
    const repo = 'acme/epic-closed';
    tasks.create({ repo, title: 'Closed epic task', status: 'ready' });
    const first = await storyboard.syncEpic(repo);
    await client.patch(`/repos/${repo}/issues/${first.number}`, { state: 'closed' });

    const second = await storyboard.syncEpic(repo);
    assert.equal(second.number, first.number);
    assert.equal((await getIssue(repo, first.number)).state, 'open');
    const all = (await client.get(`/repos/${repo}/issues`, { query: { state: 'all' } })).data;
    const epics = all.filter((issue) => issue.title === `[Storyboard] ${repo}`);
    assert.equal(epics.length, 1, 'a closed epic must be reused, not duplicated');
  });

  it('closes duplicate storyboard epics and keeps the oldest', async () => {
    const repo = 'acme/epic-dupes';
    await createIssue(repo, { title: `[Storyboard] ${repo}`, body: 'duplicate one', labels: ['gos:epic'] });
    await createIssue(repo, { title: `[Storyboard] ${repo}`, body: 'duplicate two', labels: ['gos:epic'] });
    tasks.create({ repo, title: 'Dedupe task', status: 'ready' });

    const result = await storyboard.syncEpic(repo);
    const all = (await client.get(`/repos/${repo}/issues`, { query: { state: 'all' } })).data;
    const epics = all.filter((issue) => issue.title === `[Storyboard] ${repo}`);
    assert.equal(epics.length, 2);
    assert.equal(result.number, Math.min(...epics.map((issue) => issue.number)));
    const open = epics.filter((issue) => issue.state === 'open');
    assert.equal(open.length, 1, 'only one storyboard epic stays open');
    assert.equal(open[0].number, result.number);
  });

  it('serializes concurrent epic syncs into a single issue', async () => {
    const repo = 'acme/epic-race';
    tasks.create({ repo, title: 'Race task', status: 'ready' });
    const [left, right] = await Promise.all([storyboard.syncEpic(repo), storyboard.syncEpic(repo)]);
    assert.equal(left.number, right.number);
    const all = (await client.get(`/repos/${repo}/issues`, { query: { state: 'all' } })).data;
    const epics = all.filter((issue) => issue.title === `[Storyboard] ${repo}`);
    assert.equal(epics.length, 1, 'concurrent syncs must create exactly one epic');
  });

  it('syncTask persists issue and epic numbers on the task', async () => {
    const repo = 'acme/sync';
    const task = tasks.create({ repo, title: 'Sync me', status: 'ready' });
    const result = await storyboard.syncTask(task);
    assert.ok(result.issue.number > 0);
    assert.ok(result.epic.number > 0);

    const reloaded = tasks.get(task.id);
    assert.equal(reloaded.issueNumber, result.issue.number);
    assert.equal(reloaded.epicNumber, result.epic.number);

    const again = await storyboard.syncTask(reloaded);
    assert.equal(again.issue.number, result.issue.number);
    assert.equal(again.epic.number, result.epic.number);
    assert.equal((await getIssue(repo, result.issue.number)).title, `[${task.id}] Sync me`);
  });

  it('imports unknown open task issues and skips known ones', async () => {
    const repo = 'acme/import';
    const external = await createIssue(repo, {
      title: 'External bug report',
      body: '## Summary\n\nIt crashes on start.',
      labels: ['gos:task'],
    });
    const withMeta = tasks.create({ repo, title: 'Local task' });
    const metaIssue = await createIssue(repo, {
      title: `[${withMeta.id}] Local task`,
      body: `${TASK_META_START}\n${JSON.stringify(metaOf(withMeta, repo))}\n-->\n`,
      labels: ['gos:task'],
    });

    const result = await storyboard.importIssues(repo);
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);

    const imported = tasks.findBy({ repo, issueNumber: external.number });
    assert.ok(imported, 'external issue should be imported');
    assert.equal(imported.title, 'External bug report');
    assert.equal(imported.status, 'ready');
    assert.ok(imported.branch.startsWith('task/'));
    assert.match(imported.description, /It crashes on start/);
    assert.equal(tasks.findBy({ repo, issueNumber: metaIssue.number }), undefined);

    const repeat = await storyboard.importIssues(repo);
    assert.equal(repeat.imported, 0);
    assert.equal(repeat.skipped, 2);
  });

  it('bootstrap ensures labels, imports issues and creates the epic', async () => {
    const repo = 'acme/bootstrap';
    await createIssue(repo, { title: 'Bootstrap task', body: 'Do the thing', labels: ['gos:task'] });
    const result = await storyboard.bootstrap(repo);
    assert.ok(result.epic.number > 0);
    assert.equal(result.imported.imported, 1);
    assert.equal(result.imported.skipped, 0);
    const epicBody = (await getIssue(repo, result.epic.number)).body;
    assert.ok(epicBody.includes('Bootstrap task'));
    const labels = (await client.get(`/repos/${repo}/labels`)).data.map((label) => label.name);
    assert.ok(labels.includes('gos:task'));
  });
});
