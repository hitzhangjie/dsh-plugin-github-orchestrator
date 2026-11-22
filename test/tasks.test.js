import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { TaskStore } from '../lib/tasks.js';

let tmpDir;
let counter = 0;

function storePath(name = `tasks-${counter}.json`) {
  counter += 1;
  return path.join(tmpDir, name);
}

function sampleStore() {
  return new TaskStore(storePath());
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-tasks-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TaskStore', () => {
  it('starts empty and creates tasks with defaults', () => {
    const store = sampleStore();
    assert.deepEqual(store.list(), []);
    assert.equal(store.nextTaskId(), 'T1');

    const task = store.create({ repo: 'acme/widgets', title: 'Add widget cache' });
    assert.equal(task.id, 'T1');
    assert.equal(task.repo, 'acme/widgets');
    assert.equal(task.title, 'Add widget cache');
    assert.equal(task.description, '');
    assert.equal(task.status, 'backlog');
    assert.equal(task.priority, 'normal');
    assert.equal(task.branch, 'task/t1-add-widget-cache');
    assert.equal(task.baseBranch, 'main');
    assert.deepEqual(task.tags, []);
    assert.deepEqual(task.notes, []);
    assert.match(task.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(task.createdAt, task.updatedAt);
    assert.equal(store.nextTaskId(), 'T2');
  });

  it('persists tasks across store instances and stays valid JSON', () => {
    const file = storePath();
    const first = new TaskStore(file);
    first.create({ repo: 'acme/widgets', title: 'One' });
    first.create({ repo: 'acme/widgets', title: 'Two', status: 'ready', priority: 'high', tags: ['ui', 'ui', ' api '] });

    const second = new TaskStore(file);
    const tasks = second.list();
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1].status, 'ready');
    assert.equal(tasks[1].priority, 'high');
    assert.deepEqual(tasks[1].tags, ['ui', 'ui', 'api']);

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.nextId, 3);
    assert.equal(raw.tasks.length, 2);
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });

  it('recovers from a corrupt store file', () => {
    const file = storePath();
    fs.writeFileSync(file, '{not json', 'utf8');
    const store = new TaskStore(file);
    assert.deepEqual(store.list(), []);
    const task = store.create({ repo: 'acme/widgets', title: 'After corruption' });
    assert.equal(task.id, 'T1');
  });

  it('rejects invalid input', () => {
    const store = sampleStore();
    assert.throws(() => store.create({ title: 'no repo' }), /repo is required/);
    assert.throws(() => store.create({ repo: 'a/b' }), /title is required/);
    assert.throws(() => store.create({ repo: 'a/b', title: 'x', status: 'nope' }), /Invalid task status/);
    assert.throws(() => store.create({ repo: 'a/b', title: 'x', priority: 'urgent' }), /Invalid task priority/);
    store.create({ repo: 'a/b', title: 'x' });
    assert.throws(() => store.update('T99', { title: 'y' }), /not found/);
    assert.throws(() => store.close('T99'), /not found/);
  });

  it('lists with repo/status filters and hides closed tasks by default', () => {
    const store = sampleStore();
    store.create({ repo: 'acme/a', title: 'A1' });
    store.create({ repo: 'acme/a', title: 'A2', status: 'ready' });
    store.create({ repo: 'acme/b', title: 'B1' });
    const closed = store.create({ repo: 'acme/a', title: 'A3' });
    store.close(closed.id);

    assert.deepEqual(store.list().map((t) => t.id), ['T1', 'T2', 'T3']);
    assert.deepEqual(store.list({ repo: 'acme/a' }).map((t) => t.id), ['T1', 'T2']);
    assert.deepEqual(store.list({ repo: 'acme/a', includeClosed: true }).map((t) => t.id), ['T1', 'T2', 'T4']);
    assert.deepEqual(store.list({ status: 'ready' }).map((t) => t.id), ['T2']);
    assert.deepEqual(store.list({ status: 'done' }).map((t) => t.id), ['T4']);
    assert.deepEqual(store.list({ repo: 'acme/b' }).map((t) => t.id), ['T3']);
  });

  it('looks tasks up by id and stable criteria', () => {
    const store = sampleStore();
    const task = store.create({
      repo: 'acme/a',
      title: 'Find me',
      issueNumber: 42,
      branch: 'task/t1-find-me',
      worktreePath: 'C:/work/.worktrees/a__T1',
    });
    assert.equal(store.get('T1').id, task.id);
    assert.equal(store.get('t1').id, task.id);
    assert.equal(store.get('T9'), undefined);
    assert.equal(store.get(''), undefined);

    assert.equal(store.findBy({ repo: 'acme/a' }).id, task.id);
    assert.equal(store.findBy({ repo: 'acme/a', issueNumber: '42' }).id, task.id);
    assert.equal(store.findBy({ branch: 'task/t1-find-me' }).id, task.id);
    assert.equal(store.findBy({ worktreePath: 'C:/work/.worktrees/a__T1' }).id, task.id);
    assert.equal(store.findBy({ issueNumber: 43 }), undefined);
    assert.equal(store.findBy({}), undefined);
  });

  it('updates fields, appends notes and refreshes updatedAt', async () => {
    const store = sampleStore();
    const created = store.create({ repo: 'acme/a', title: 'Before' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = store.update(created.id, {
      title: 'After',
      description: 'Now with detail',
      status: 'in_progress',
      priority: 'high',
      tags: ['x'],
      issueNumber: 7,
      issueUrl: 'https://example.test/issues/7',
      note: 'started work',
    });
    assert.equal(updated.title, 'After');
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.priority, 'high');
    assert.deepEqual(updated.tags, ['x']);
    assert.equal(updated.issueNumber, 7);
    assert.equal(updated.notes.length, 1);
    assert.equal(updated.notes[0].text, 'started work');
    assert.match(updated.notes[0].at, /^\d{4}-\d{2}-\d{2}T/);
    assert.notEqual(updated.updatedAt, created.updatedAt);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.closedAt, undefined);

    const second = store.update(created.id, { note: 'still going', issueNumber: null });
    assert.deepEqual(second.notes.map((n) => n.text), ['started work', 'still going']);
    assert.equal(second.issueNumber, undefined);
  });

  it('closes tasks and preserves the first closedAt', async () => {
    const store = sampleStore();
    const task = store.create({ repo: 'acme/a', title: 'Close me' });
    const closed = store.close(task.id, { note: 'finished' });
    assert.equal(closed.status, 'done');
    assert.match(closed.closedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(closed.notes.at(-1).text, 'finished');

    const firstClosedAt = closed.closedAt;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const again = store.close(task.id);
    assert.equal(again.status, 'done');
    assert.equal(again.closedAt, firstClosedAt);
    assert.equal(store.list().length, 0);
  });

  it('removes tasks and reports stats', () => {
    const store = sampleStore();
    store.create({ repo: 'acme/a', title: 'A' });
    store.create({ repo: 'acme/a', title: 'B', status: 'ready' });
    const done = store.create({ repo: 'acme/b', title: 'C' });
    store.close(done.id);

    assert.deepEqual(store.stats(), {
      total: 3,
      byStatus: { backlog: 1, ready: 1, in_progress: 0, review: 0, done: 1 },
      byRepo: { 'acme/a': 2, 'acme/b': 1 },
      openTasks: 2,
    });

    assert.equal(store.remove('T2'), true);
    assert.equal(store.remove('T2'), false);
    assert.deepEqual(store.list({ includeClosed: true }).map((t) => t.id), ['T1', 'T3']);
    assert.equal(store.stats().total, 2);
    assert.equal(store.stats().openTasks, 1);
  });

  it('returns defensive copies so callers cannot mutate stored state', () => {
    const store = sampleStore();
    const task = store.create({ repo: 'acme/a', title: 'Copy', tags: ['one'] });
    task.tags.push('two');
    task.title = 'mutated';
    const reloaded = store.get(task.id);
    assert.deepEqual(reloaded.tags, ['one']);
    assert.equal(reloaded.title, 'Copy');
  });
});
