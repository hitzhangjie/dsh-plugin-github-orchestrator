/**
 * Offline unit tests for lib/events.js: event creation, the persisted store and
 * the poller (baseline priming plus issue/PR/review/push deltas).
 *
 * The poller talks to test/helpers/mock-github.js only; no real network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { normalizeConfig, parseRepoSpec } from '../lib/config.js';
import { EventPoller, EventStore, createEvent } from '../lib/events.js';
import { GitHubClient } from '../lib/github.js';
import { startMockGitHub } from './helpers/mock-github.js';

const REPO = 'acme/widgets';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function testConfig(dir, repos = [REPO]) {
  const config = normalizeConfig({}, {}, { env: { DSH_HOME: dir }, homeDir: dir });
  config.repos = repos.map((repo) => parseRepoSpec(repo));
  return config;
}

function makePoller(t, { dir, mock, store, config, now }) {
  const client = new GitHubClient({ token: 'test-token', apiBase: mock.url });
  const eventStore = store ?? new EventStore(path.join(dir, 'events.json'));
  const poller = new EventPoller({
    client,
    store: eventStore,
    config: config ?? testConfig(dir),
    watermarksPath: path.join(dir, 'events-watermarks.json'),
    now,
  });
  return { client, store: eventStore, poller };
}

function isoShift(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

test('createEvent fills defaults and is deterministic', () => {
  const at = '2026-01-02T03:04:05.000Z';
  const first = createEvent({ repo: REPO, kind: 'issue', action: 'opened', number: 3, title: 'Broken thing', at });
  assert.match(first.id, /^evt_/);
  assert.equal(first.repo, REPO);
  assert.equal(first.kind, 'issue');
  assert.equal(first.action, 'opened');
  assert.equal(first.number, 3);
  assert.equal(first.title, 'Broken thing');
  assert.equal(first.at, at);
  assert.equal(first.read, false);
  assert.match(first.summary, /Issue #3 opened: Broken thing/);

  const second = createEvent({ repo: REPO, kind: 'issue', action: 'opened', number: 3, title: 'Broken thing', at });
  assert.equal(second.id, first.id);

  const other = createEvent({ repo: REPO, kind: 'issue', action: 'opened', number: 4, title: 'Broken thing', at });
  assert.notEqual(other.id, first.id);
});

test('createEvent keeps explicit id and optional fields, truncates summary', () => {
  const event = createEvent({
    id: 'custom-id',
    repo: REPO,
    kind: 'push',
    action: 'pushed',
    branch: 'main',
    sha: 'abcdef1234567890',
    at: '2026-01-02T03:04:05.000Z',
    baseline: true,
    taskId: 'T1',
    url: 'https://example.test/x',
    actor: 'alice',
    summary: 'x'.repeat(500),
  });
  assert.equal(event.id, 'custom-id');
  assert.equal(event.branch, 'main');
  assert.equal(event.sha, 'abcdef1234567890');
  assert.equal(event.baseline, true);
  assert.equal(event.taskId, 'T1');
  assert.equal(event.url, 'https://example.test/x');
  assert.equal(event.actor, 'alice');
  assert.equal(event.summary.length, 300);

  const pushSummary = createEvent({ repo: REPO, kind: 'push', action: 'pushed', branch: 'main', sha: 'abcdef1234567890' });
  assert.match(pushSummary.summary, /Push to main \(abcdef1\)/);
});

test('EventStore starts empty and requires a file path', () => {
  assert.throws(() => new EventStore(''), /requires a file path/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-events-store-'));
  try {
    const store = new EventStore(path.join(dir, 'events.json'));
    assert.deepEqual(store.list(), []);
    assert.equal(store.unreadCount(), 0);
    assert.deepEqual(store.stats(), { total: 0, unread: 0, byRepo: {}, byKind: {}, lastEventAt: null });
    assert.deepEqual(store.add([]), { added: 0, duplicates: 0 });
    assert.equal(store.markRead(['missing']), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EventStore add dedupes by id and persists atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-events-store-'));
  try {
    const file = path.join(dir, 'events.json');
    const store = new EventStore(file);
    const issue = createEvent({ repo: REPO, kind: 'issue', action: 'opened', number: 1, title: 'One', at: '2026-01-01T00:00:00.000Z' });
    const pull = createEvent({ repo: 'acme/other', kind: 'pr', action: 'opened', number: 2, title: 'Two', at: '2026-01-01T00:01:00.000Z' });

    assert.deepEqual(store.add([issue, pull]), { added: 2, duplicates: 0 });
    assert.deepEqual(store.add([issue, pull]), { added: 0, duplicates: 2 });
    assert.deepEqual(store.add([issue, issue]), { added: 0, duplicates: 2 });
    assert.equal(store.list().length, 2);

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.events.length, 2);
    assert.equal(onDisk.events[0].id, issue.id);

    const reopened = new EventStore(file);
    assert.deepEqual(reopened.list().map((event) => event.id), [pull.id, issue.id]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EventStore list filters by repo, kinds, unread, since and limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-events-store-'));
  try {
    const store = new EventStore(path.join(dir, 'events.json'));
    const events = [
      createEvent({ repo: REPO, kind: 'issue', action: 'opened', number: 1, at: '2026-01-01T00:00:00.000Z' }),
      createEvent({ repo: REPO, kind: 'pr', action: 'opened', number: 2, at: '2026-01-02T00:00:00.000Z' }),
      createEvent({ repo: 'acme/other', kind: 'push', action: 'pushed', branch: 'main', sha: 'abc', at: '2026-01-03T00:00:00.000Z' }),
    ];
    store.add(events);

    assert.deepEqual(store.list({ repo: REPO }).map((event) => event.number), [2, 1]);
    assert.deepEqual(store.list({ kinds: ['push'] }).map((event) => event.kind), ['push']);
    assert.deepEqual(store.list({ kinds: 'issue' }).map((event) => event.number), [1]);
    assert.equal(store.list({ since: '2026-01-02T00:00:00.000Z' }).length, 2);
    assert.equal(store.list({ since: new Date('2026-01-03T00:00:00.000Z') }).length, 1);
    assert.equal(store.list({ limit: 1 })[0].number, undefined);
    assert.equal(store.list({ limit: 2 }).length, 2);

    assert.equal(store.markRead([events[0].id]), 1);
    assert.equal(store.unreadCount(), 2);
    assert.deepEqual(store.list({ unreadOnly: true }).map((event) => event.kind), ['push', 'pr']);
    assert.equal(store.markRead(undefined, { all: true, repo: REPO }), 1);
    assert.equal(store.unreadCount({ repo: REPO }), 0);
    assert.equal(store.markRead(undefined, { all: true }), 1);
    assert.equal(store.unreadCount(), 0);
    assert.equal(store.markRead(undefined, { all: true }), 0);
    assert.equal(store.markRead(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EventStore stats, prune and maxEvents cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-events-store-'));
  try {
    const file = path.join(dir, 'events.json');
    const store = new EventStore(file, { maxEvents: 3 });
    for (let number = 1; number <= 5; number += 1) {
      store.add([
        createEvent({ repo: REPO, kind: 'issue', action: 'opened', number, at: `2026-01-0${number}T00:00:00.000Z` }),
      ]);
    }
    assert.equal(store.list().length, 3);
    assert.deepEqual(store.list().map((event) => event.number), [5, 4, 3]);
    assert.equal(store.stats().lastEventAt, '2026-01-05T00:00:00.000Z');

    const mixed = new EventStore(path.join(dir, 'mixed.json'));
    const events = [
      createEvent({ repo: REPO, kind: 'issue', action: 'opened', number: 1, at: '2026-01-01T00:00:00.000Z', read: true }),
      createEvent({ repo: REPO, kind: 'pr', action: 'opened', number: 2, at: '2026-01-02T00:00:00.000Z' }),
      createEvent({ repo: 'acme/other', kind: 'push', action: 'pushed', branch: 'main', sha: 'abc', at: '2026-01-03T00:00:00.000Z' }),
    ];
    mixed.add(events);
    const stats = mixed.stats();
    assert.equal(stats.total, 3);
    assert.equal(stats.unread, 2);
    assert.deepEqual(stats.byRepo, { [REPO]: 2, 'acme/other': 1 });
    assert.deepEqual(stats.byKind, { issue: 1, pr: 1, push: 1 });

    mixed.prune({ max: 1 });
    assert.equal(mixed.list().length, 1);
    assert.equal(mixed.list()[0].kind, 'push');
    mixed.prune({ max: 10 });
    assert.equal(mixed.list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('poller primes state and emits bounded baseline events on the first poll', async (t) => {
  const dir = tempDir(t);
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  mock.seedIssue(REPO, { number: 1, title: 'Open issue', state: 'open', updated_at: recent });
  mock.seedIssue(REPO, { number: 2, title: 'Another open issue', state: 'open', updated_at: recent });
  mock.seedIssue(REPO, { number: 3, title: 'Closed issue', state: 'closed', updated_at: recent });
  mock.seedPull(REPO, { number: 10, title: 'Open pull', state: 'open', updated_at: recent });
  mock.seedBranch(REPO, { name: 'main', sha: 'sha-main-1' });

  const { poller, store } = makePoller(t, { dir, mock });
  const first = await poller.pollOnce();

  assert.deepEqual(first.errors, []);
  assert.equal(first.repos, 1);
  assert.equal(first.added, 3);
  const events = store.list();
  assert.equal(events.length, 3);
  assert.equal(events.every((event) => event.baseline === true), true);
  assert.deepEqual(events.map((event) => event.kind).sort(), ['issue', 'issue', 'pr']);
  assert.equal(events.every((event) => event.read === false), true);

  const watermarks = poller.watermarks();
  assert.equal(watermarks.repos[REPO].primed, true);
  assert.equal(watermarks.repos[REPO].branches.main, 'sha-main-1');
  assert.equal(watermarks.repos[REPO].issues['1'], recent);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'events-watermarks.json'), 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.repos[REPO].primed, true);

  const second = await poller.pollOnce();
  assert.equal(second.added, 0);
  assert.equal(store.list().length, 3);
});

test('poller baseline:false primes without emitting events and caps baseline at 25', async (t) => {
  const dir = tempDir(t);
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (let number = 1; number <= 30; number += 1) {
    mock.seedIssue(REPO, { number, title: `Issue ${number}`, state: 'open', updated_at: recent });
  }

  const silent = makePoller(t, { dir, mock });
  const primed = await silent.poller.pollOnce({ baseline: false });
  assert.equal(primed.added, 0);
  assert.equal(silent.store.list().length, 0);
  assert.equal(silent.poller.watermarks().repos[REPO].primed, true);

  const dir2 = tempDir(t);
  const baseline = makePoller(t, { dir: dir2, mock });
  const capped = await baseline.poller.pollOnce();
  assert.equal(capped.added, 25);
  assert.equal(baseline.store.list().length, 25);
});

test('poller emits issue events only when updated_at changes', async (t) => {
  const dir = tempDir(t);
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const startedAt = '2026-02-01T00:00:00.000Z';
  mock.seedIssue(REPO, { number: 1, title: 'First', state: 'open', updated_at: startedAt });

  const { poller, store } = makePoller(t, { dir, mock });
  await poller.pollOnce({ baseline: false });
  assert.equal(store.list().length, 0);

  mock.updateIssue(REPO, 1, { title: 'First (edited)', updated_at: isoShift(startedAt, 60_000) });
  const delta = await poller.pollOnce();
  assert.equal(delta.added, 1);
  const [event] = store.list();
  assert.equal(event.kind, 'issue');
  assert.equal(event.action, 'updated');
  assert.equal(event.number, 1);
  assert.equal(event.title, 'First (edited)');
  assert.equal(event.at, isoShift(startedAt, 60_000));
  assert.equal(event.repo, REPO);
  assert.equal(event.read, false);

  const repeat = await poller.pollOnce();
  assert.equal(repeat.added, 0);
  assert.equal(store.list().length, 1);

  mock.updateIssue(REPO, 1, { state: 'closed', updated_at: isoShift(startedAt, 120_000) });
  const closed = await poller.pollOnce();
  assert.equal(closed.added, 1);
  assert.equal(store.list({ kinds: 'issue' })[0].action, 'closed');
});

test('poller emits pr, review and push events for post-baseline changes', async (t) => {
  const dir = tempDir(t);
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const startedAt = '2026-03-01T00:00:00.000Z';
  mock.seedPull(REPO, { number: 10, title: 'Feature', state: 'open', updated_at: startedAt });
  mock.seedBranch(REPO, { name: 'main', sha: 'sha-main-1' });

  const { poller, store } = makePoller(t, { dir, mock });
  await poller.pollOnce({ baseline: false });
  assert.equal(store.list().length, 0);

  // A PR update produces a pr event; its reviews are inspected on each change.
  mock.updatePull(REPO, 10, { updated_at: isoShift(startedAt, 60_000) });
  mock.seedReview(REPO, 10, { state: 'APPROVED', user: { login: 'alice' }, submitted_at: '2026-03-01T00:01:00.000Z' });
  const reviewPoll = await poller.pollOnce();
  assert.equal(reviewPoll.added, 2);
  const kinds = store.list().map((event) => event.kind);
  assert.deepEqual(kinds.sort(), ['pr', 'review']);
  const review = store.list().find((event) => event.kind === 'review');
  assert.equal(review.action, 'approved');
  assert.equal(review.number, 10);
  assert.equal(review.actor, 'alice');

  // A branch whose tip moves emits a push event.
  mock.seedBranch(REPO, { name: 'main', sha: 'sha-main-2' });
  const pushPoll = await poller.pollOnce();
  assert.equal(pushPoll.added, 1);
  const push = store.list().find((event) => event.kind === 'push');
  assert.equal(push.action, 'pushed');
  assert.equal(push.branch, 'main');
  assert.equal(push.sha, 'sha-main-2');
  assert.match(push.summary, /Push to main \(sha-mai\)/);

  // Newly discovered branches were never seen before: recorded, not emitted.
  mock.seedBranch(REPO, { name: 'feature/new', sha: 'sha-feature-1' });
  const newBranchPoll = await poller.pollOnce();
  assert.equal(newBranchPoll.added, 0);
  assert.equal(poller.watermarks().repos[REPO].branches['feature/new'], 'sha-feature-1');

  // A new PR after priming is reported as opened.
  mock.seedPull(REPO, { number: 11, title: 'Later PR', state: 'open', updated_at: '2026-03-02T00:00:00.000Z' });
  const openedPoll = await poller.pollOnce();
  assert.equal(openedPoll.added, 1);
  const opened = store.list({ kinds: 'pr' })[0];
  assert.equal(opened.action, 'opened');
  assert.equal(opened.number, 11);
});

test('poller survives a per-repo API failure and continues with other repos', async (t) => {
  const dir = tempDir(t);
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  mock.seedIssue('acme/good', { number: 1, title: 'Good issue', state: 'open', updated_at: recent });
  mock.setHandler((info) => {
    if (info.path.startsWith('/repos/acme/broken/')) return { status: 500, body: { message: 'boom' } };
    return undefined;
  });

  const config = testConfig(dir, ['acme/good', 'acme/broken']);
  const { poller, store } = makePoller(t, { dir, mock, config });
  const result = await poller.pollOnce({ baseline: false });

  assert.equal(result.repos, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].repo, 'acme/broken');
  assert.match(result.errors[0].error, /status 500/);
  assert.equal(poller.watermarks().repos['acme/good'].primed, true);
  assert.equal(poller.watermarks().repos['acme/broken']?.primed ?? false, false);
  assert.equal(store.list().length, 0);

  const filtered = await poller.pollOnce({ repo: 'acme/good', baseline: false });
  assert.equal(filtered.repos, 1);
  assert.deepEqual(filtered.errors, []);
});

test('poller persists watermarks across instances, so re-priming is skipped', async (t) => {
  const dir = tempDir(t);
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  mock.seedIssue(REPO, { number: 1, title: 'Persisted', state: 'open', updated_at: recent });
  mock.seedBranch(REPO, { name: 'main', sha: 'sha-main-1' });

  const firstRun = makePoller(t, { dir, mock });
  const primed = await firstRun.poller.pollOnce();
  assert.equal(primed.added, 1);
  assert.equal(firstRun.store.list().length, 1);

  const secondRun = makePoller(t, { dir, mock });
  assert.equal(secondRun.poller.watermarks().repos[REPO].primed, true);
  const again = await secondRun.poller.pollOnce();
  assert.equal(again.added, 0);
  assert.equal(secondRun.store.list().length, 1);
});

test('poller start/stop are idempotent and updateConfig swaps repositories', async (t) => {
  const dir = tempDir(t);
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedBranch('acme/good', { name: 'main', sha: 'sha-good-1' });
  mock.seedBranch('acme/other', { name: 'main', sha: 'sha-other-1' });

  const config = testConfig(dir, ['acme/good']);
  const { poller } = makePoller(t, { dir, mock, config });
  poller.start();
  const timer = poller._timer;
  assert.notEqual(timer, null);
  poller.start();
  assert.equal(poller._timer, timer);
  poller.stop();
  assert.equal(poller._timer, null);
  poller.stop();

  await poller.pollOnce({ baseline: false });
  assert.equal(poller.watermarks().repos['acme/good'].primed, true);

  poller.updateConfig(testConfig(dir, ['acme/other']));
  await poller.pollOnce({ baseline: false });
  assert.equal(poller.watermarks().repos['acme/other'].primed, true);
  assert.equal(poller.watermarks().repos['acme/other'].branches.main, 'sha-other-1');
});

test('poller constructor validates required dependencies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-events-poll-'));
  try {
    assert.throws(
      () => new EventPoller({ store: new EventStore(path.join(dir, 'events.json')) }),
      /requires a GitHubClient/,
    );
    assert.throws(() => new EventPoller({ client: {} }), /requires an EventStore/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
