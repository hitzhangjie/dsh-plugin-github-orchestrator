/**
 * Offline unit tests for lib/dispatch.js: message/prompt builders and the
 * always-on AutoDispatcher (filters, dedupe, throttle, task creation, watcher
 * session lifecycle, retry semantics and persisted state).
 *
 * Everything is local: a temp TaskStore, fake agents and a temp state file. No
 * DSH packages and no network are involved.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AutoDispatcher, buildDispatchPrompt, createUserMessage } from '../lib/dispatch.js';
import { TaskStore } from '../lib/tasks.js';

const REPO = 'acme/widgets';
const START = '2026-01-01T00:00:00.000Z';

// --- helpers ---------------------------------------------------------------

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dispatch-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function tempDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'));
}

function baseConfig(overrides = {}) {
  return {
    workspaceRoot: 'C:/work/github',
    repos: [{ repo: REPO, owner: 'acme', name: 'widgets' }],
    autoDispatch: true,
    autoDispatchKinds: ['issue', 'pr', 'review'],
    autoDispatchMinIntervalSec: 0,
    autoDispatchMaxEvents: 5,
    autoDispatchCreateTasks: true,
    autoDispatchTaskStatus: 'ready',
    ...overrides,
  };
}

let eventCounter = 0;

function makeEvent(overrides = {}) {
  eventCounter += 1;
  return {
    id: `evt_${eventCounter}`,
    repo: REPO,
    kind: 'issue',
    action: 'opened',
    at: START,
    summary: `Issue #${eventCounter} opened`,
    read: false,
    ...overrides,
  };
}

/** A recording fake agent. `failCount` makes that many followups throw. */
function makeAgent(id, opts = {}) {
  const agent = {
    id,
    followups: [],
    failCount: opts.failCount ?? 0,
    failMessage: opts.failMessage ?? 'followup failed',
    async followup(message) {
      if (agent.failCount > 0) {
        agent.failCount -= 1;
        throw new Error(agent.failMessage);
      }
      agent.followups.push(message);
      return { ok: true };
    },
  };
  return agent;
}

/** Fake agents service with the shape the Lead injects. Mutate `options` to toggle failures. */
function makeAgents(opts = {}) {
  const live = new Map();
  for (const [id, agent] of Object.entries(opts.live ?? {})) live.set(id, agent);
  const calls = { get: [], resume: [], create: [] };
  const agents = {
    get(id) {
      calls.get.push(id);
      return live.get(id) ?? null;
    },
    async resume({ resumeSessionId } = {}) {
      calls.resume.push(resumeSessionId);
      if (opts.resumeError) throw opts.resumeError;
      const agent = opts.resumeAgent ?? null;
      if (agent) live.set(resumeSessionId, agent);
      return agent;
    },
    async create({ sessionId, meta } = {}) {
      calls.create.push({ sessionId, meta });
      if (opts.createError) throw opts.createError;
      const agent = opts.createAgent ?? makeAgent(sessionId);
      live.set(sessionId, agent);
      return agent;
    },
  };
  return { agents, calls, live, options: opts };
}

function readStateFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Build a dispatcher over a fresh temp dir. `opts.state` is written to the
 * state file before construction so tests can simulate a previous run.
 */
function makeDispatcher(opts = {}) {
  const dir = opts.dir ?? tempDir();
  const statePath = opts.statePath ?? path.join(dir, 'dispatch.json');
  const tasksPath = opts.tasksPath ?? path.join(dir, 'tasks.json');
  if (opts.state !== undefined) fs.writeFileSync(statePath, JSON.stringify(opts.state), 'utf8');
  const tasks = opts.tasks ?? new TaskStore(tasksPath);
  const fake = opts.fake ?? makeAgents();
  const dispatcher = new AutoDispatcher({
    config: baseConfig(opts.config),
    tasks,
    agents: fake.agents,
    statePath,
    now: opts.now ?? (() => Date.parse(START)),
    logger: opts.logger,
  });
  return { dispatcher, tasks, statePath, tasksPath, dir, ...fake };
}

function clock(startIso = START) {
  let time = Date.parse(startIso);
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

function liveDispatcher(opts = {}) {
  const agent = opts.agent ?? makeAgent(opts.sessionId ?? 'session-live');
  const sessionId = agent.id;
  const fake = makeAgents({ live: { [sessionId]: agent } });
  return { agent, ...makeDispatcher({ ...opts, config: { autoDispatchSessionId: sessionId, ...(opts.config ?? {}) }, fake }) };
}

// --- createUserMessage -----------------------------------------------------

describe('createUserMessage', () => {
  it('builds a DSH user message with a generated id', () => {
    const message = createUserMessage('hello watcher');
    assert.equal(message.role, 'user');
    assert.deepEqual(message.source, { kind: 'user' });
    assert.deepEqual(message.content, [{ type: 'text', text: 'hello watcher' }]);
    assert.match(message.id, /^[0-9a-f-]{36}$/);
  });

  it('uses a provided id and coerces text', () => {
    const message = createUserMessage('text', 'message-1');
    assert.equal(message.id, 'message-1');
    assert.equal(message.content[0].text, 'text');
    assert.equal(createUserMessage(undefined, 'm2').content[0].text, '');
    assert.notEqual(createUserMessage('a').id, createUserMessage('a').id);
  });
});

// --- buildDispatchPrompt ---------------------------------------------------

describe('buildDispatchPrompt', () => {
  it('names the repo/number, task ids and standing instructions', () => {
    const event = makeEvent({
      kind: 'pr',
      number: 7,
      title: 'Fix login bug',
      summary: 'PR #7 opened: Fix login bug',
      url: 'https://github.test/acme/widgets/pull/7',
    });
    const prompt = buildDispatchPrompt({
      repo: REPO,
      events: [event],
      taskIds: ['T1'],
      workspaceRoot: 'C:/work/github',
    });
    assert.match(prompt, /## GitHub auto-dispatch/);
    assert.match(prompt, /acme\/widgets#7/);
    assert.ok(prompt.includes('Fix login bug'));
    assert.ok(prompt.includes('T1'));
    assert.ok(prompt.includes('C:/work/github'));
    assert.ok(prompt.includes('https://github.test/acme/widgets/pull/7'));
    assert.ok(prompt.includes('Instructions:'));
    assert.ok(prompt.includes('github_worktrees'));
    assert.ok(prompt.includes('do not wait for the human'));
    assert.ok(!prompt.includes('undefined'));
    assert.ok(!prompt.includes('null'));
  });

  it('derives the repo from events and describes push targets', () => {
    const prompt = buildDispatchPrompt({
      events: [
        makeEvent({ kind: 'push', branch: 'main', summary: 'Push to main (abc1234)' }),
        makeEvent({ kind: 'issue', number: 9, title: 'Crash on boot' }),
      ],
      taskIds: ['T1', 'T2'],
      workspaceRoot: 'C:/w',
    });
    assert.ok(prompt.includes('Repository: acme/widgets'));
    assert.ok(prompt.includes('acme/widgets push main'));
    assert.ok(prompt.includes('acme/widgets#9'));
    assert.ok(prompt.includes('T1 → acme/widgets push main'));
    assert.ok(prompt.includes('T2 → acme/widgets#9'));
    assert.ok(prompt.includes('2 events'));
  });

  it('notes when no local tasks were created', () => {
    const prompt = buildDispatchPrompt({
      repo: REPO,
      events: [makeEvent({ number: 1 })],
      taskIds: [],
      workspaceRoot: 'C:/w',
    });
    assert.ok(prompt.includes('No local storyboard tasks were created'));
    assert.ok(prompt.includes('1 event)'));
  });
});

// --- AutoDispatcher: configuration and filters -----------------------------

describe('AutoDispatcher', () => {
  it('requires a TaskStore, an agents service and a state path', () => {
    assert.throws(() => new AutoDispatcher({}), /TaskStore/);
    assert.throws(() => new AutoDispatcher({ tasks: { create() {} } }), /agents service/);
    assert.throws(() => new AutoDispatcher({ tasks: { create() {} }, agents: {} }), /statePath/);
  });

  it('does nothing while auto dispatch is disabled', async () => {
    const agent = makeAgent('session-live');
    const { dispatcher, tasks, calls } = makeDispatcher({
      config: { autoDispatch: false },
      fake: makeAgents({ live: { 'session-live': agent } }),
    });
    const result = await dispatcher.handleEvents([makeEvent()]);
    assert.deepEqual(result, { dispatched: false, reason: 'disabled' });
    assert.equal(tasks.list().length, 0);
    assert.equal(agent.followups.length, 0);
    assert.equal(dispatcher.status().enabled, false);
    assert.equal(dispatcher.status().sessionId, null);
    assert.deepEqual(calls.create, []);
  });

  it('filters baseline, read, unconfigured kinds, unwatched repos and seen ids', async () => {
    const seenEvent = makeEvent({ id: 'evt-already-seen' });
    const liveEvent = makeEvent({ number: 5 });
    const { dispatcher, tasks } = makeDispatcher({
      state: { version: 1, seen: ['evt-already-seen'] },
    });
    const result = await dispatcher.handleEvents([
      makeEvent({ baseline: true }),
      makeEvent({ read: true }),
      makeEvent({ kind: 'push', branch: 'main' }),
      makeEvent({ repo: 'other/repo' }),
      seenEvent,
      liveEvent,
    ]);
    assert.equal(result.dispatched, true);
    assert.deepEqual(result.eventIds, [liveEvent.id]);
    assert.equal(tasks.list().length, 1);
    const status = dispatcher.status();
    assert.equal(status.skipped, 5);
    assert.equal(status.seen, 2); // the pre-seeded id plus the dispatched one
    assert.equal(status.lastEventAt, liveEvent.at);
  });

  it('treats an empty or non-array batch as no events', async () => {
    const { dispatcher } = makeDispatcher();
    assert.deepEqual(await dispatcher.handleEvents([]), { dispatched: false, reason: 'no-events' });
    assert.deepEqual(await dispatcher.handleEvents(undefined), { dispatched: false, reason: 'no-events' });
  });

  it('does not dispatch events for unwatched repositories', async () => {
    const { dispatcher, tasks } = makeDispatcher({ config: { repos: [] } });
    const result = await dispatcher.handleEvents([makeEvent()]);
    assert.deepEqual(result, { dispatched: false, reason: 'no-events' });
    assert.equal(tasks.list().length, 0);
  });

  it('dedupes already dispatched events', async () => {
    const { dispatcher, agent, tasks } = liveDispatcher();
    const event = makeEvent();
    assert.equal((await dispatcher.handleEvents([event])).dispatched, true);
    assert.deepEqual(await dispatcher.handleEvents([event]), { dispatched: false, reason: 'no-events' });
    assert.equal(agent.followups.length, 1);
    assert.equal(tasks.list().length, 1);
    assert.equal(dispatcher.status().seen, 1);
  });

  it('caps the persisted seen list at 1000 ids, keeping the newest', async () => {
    const seen = Array.from({ length: 1000 }, (_, index) => `old-${index}`);
    const { dispatcher, statePath } = makeDispatcher({ state: { version: 1, seen } });
    const event = makeEvent();
    assert.equal((await dispatcher.handleEvents([event])).dispatched, true);
    const state = readStateFile(statePath);
    assert.equal(state.seen.length, 1000);
    assert.equal(state.seen.at(-1), event.id);
    assert.ok(!state.seen.includes('old-0'));
    assert.ok(state.seen.includes('old-999'));
    assert.equal(dispatcher.status().seen, 1000);
  });

  it('throttles dispatches and retries the same events later', async () => {
    const time = clock();
    const agent = makeAgent('session-live');
    const { dispatcher, tasks } = makeDispatcher({
      config: { autoDispatchMinIntervalSec: 120, autoDispatchSessionId: 'session-live' },
      fake: makeAgents({ live: { 'session-live': agent } }),
      now: time.now,
    });
    const first = makeEvent();
    assert.equal((await dispatcher.handleEvents([first])).dispatched, true);

    time.advance(30_000);
    const second = makeEvent();
    assert.deepEqual(await dispatcher.handleEvents([second]), { dispatched: false, reason: 'throttled' });
    assert.equal(agent.followups.length, 1);
    assert.equal(tasks.list().length, 1);
    // The throttled event was NOT marked seen, so it is retried.
    assert.equal(dispatcher.status().seen, 1);

    time.advance(91_000);
    const result = await dispatcher.handleEvents([second]);
    assert.equal(result.dispatched, true);
    assert.deepEqual(result.eventIds, [second.id]);
    assert.equal(agent.followups.length, 2);
    assert.equal(tasks.list().length, 2);
    assert.equal(dispatcher.status().seen, 2);
  });

  it('applies updateConfig immediately', async () => {
    const live = { 'session-live': makeAgent('session-live') };
    const { dispatcher } = makeDispatcher({ config: { autoDispatch: false }, fake: makeAgents({ live }) });
    assert.equal((await dispatcher.handleEvents([makeEvent({ kind: 'pr', number: 1 })])).reason, 'disabled');

    dispatcher.updateConfig(baseConfig({ autoDispatch: true, autoDispatchKinds: ['pr'] }));
    assert.deepEqual(await dispatcher.handleEvents([makeEvent({ kind: 'issue', number: 2 })]), {
      dispatched: false,
      reason: 'no-events',
    });
    assert.equal((await dispatcher.handleEvents([makeEvent({ kind: 'pr', number: 3 })])).dispatched, true);
  });
});

// --- AutoDispatcher: task creation -----------------------------------------

describe('AutoDispatcher task creation', () => {
  it('creates one storyboard task per event with the documented fields', async () => {
    const agent = makeAgent('session-live');
    const { dispatcher, tasks } = makeDispatcher({
      config: { autoDispatchSessionId: 'session-live', autoDispatchKinds: ['issue', 'pr', 'push'] },
      fake: makeAgents({ live: { 'session-live': agent } }),
    });
    const pr = makeEvent({
      kind: 'pr',
      number: 7,
      title: 'Fix login bug',
      action: 'opened',
      at: '2026-01-01T00:00:05.000Z',
      summary: 'PR #7 opened: Fix login bug',
    });
    const issue = makeEvent({
      kind: 'issue',
      number: 9,
      title: 'Crash on boot',
      at: '2026-01-01T00:00:04.000Z',
      summary: 'Issue #9 updated: Crash on boot',
    });
    const push = makeEvent({
      kind: 'push',
      branch: 'main',
      sha: 'abc1234567890',
      at: '2026-01-01T00:00:03.000Z',
      summary: 'Push to main (abc1234)',
    });

    const result = await dispatcher.handleEvents([push, issue, pr]);
    assert.equal(result.dispatched, true);
    assert.deepEqual(result.taskIds, ['T1', 'T2', 'T3']);

    const [first, second, third] = tasks.list();
    assert.equal(first.id, 'T1');
    assert.equal(first.repo, REPO);
    assert.equal(first.title, '[GitHub] acme/widgets#7 Fix login bug');
    assert.equal(first.description, 'PR #7 opened: Fix login bug');
    assert.equal(first.status, 'ready');
    assert.equal(first.prNumber, 7);
    assert.deepEqual(first.tags, ['auto-dispatch', 'pr']);
    assert.match(first.notes[0].text, /^Auto-dispatched to session session-live$/);

    assert.equal(second.title, '[GitHub] acme/widgets#9 Crash on boot');
    assert.equal(second.issueNumber, 9);
    assert.equal(second.prNumber, undefined);
    assert.deepEqual(second.tags, ['auto-dispatch', 'issue']);

    assert.equal(third.title, '[GitHub] acme/widgets push main');
    assert.equal(third.issueNumber, undefined);
    assert.equal(third.prNumber, undefined);
    assert.deepEqual(third.tags, ['auto-dispatch', 'push']);
  });

  it('honours autoDispatchTaskStatus and autoDispatchCreateTasks', async () => {
    const live = { 'session-live': makeAgent('session-live') };
    const { dispatcher, tasks } = makeDispatcher({
      config: {
        autoDispatchSessionId: 'session-live',
        autoDispatchTaskStatus: 'backlog',
        autoDispatchCreateTasks: false,
      },
      fake: makeAgents({ live }),
    });
    const result = await dispatcher.handleEvents([makeEvent({ number: 11 })]);
    assert.equal(result.dispatched, true);
    assert.deepEqual(result.taskIds, []);
    assert.equal(tasks.list().length, 0);
    const prompt = live['session-live'].followups[0].content[0].text;
    assert.ok(prompt.includes('No local storyboard tasks were created'));

    dispatcher.updateConfig(
      baseConfig({ autoDispatchSessionId: 'session-live', autoDispatchTaskStatus: 'backlog' }),
    );
    await dispatcher.handleEvents([makeEvent({ number: 12 })]);
    assert.equal(tasks.list()[0].status, 'backlog');
  });
});

// --- AutoDispatcher: watcher sessions --------------------------------------

describe('AutoDispatcher watcher session', () => {
  it('delivers the prompt to a live session without resuming or creating', async () => {
    const { dispatcher, agent, calls, statePath } = liveDispatcher();
    const event = makeEvent({ kind: 'pr', number: 21, title: 'Review me', summary: 'PR #21 opened: Review me' });
    const result = await dispatcher.handleEvents([event]);

    assert.equal(result.dispatched, true);
    assert.equal(result.sessionId, 'session-live');
    assert.deepEqual(calls.get, ['session-live']);
    assert.deepEqual(calls.resume, []);
    assert.deepEqual(calls.create, []);
    assert.equal(agent.followups.length, 1);

    const message = agent.followups[0];
    assert.equal(message.role, 'user');
    assert.deepEqual(message.source, { kind: 'user' });
    assert.equal(message.content[0].type, 'text');
    const text = message.content[0].text;
    assert.ok(text.includes('acme/widgets#21'));
    assert.ok(text.includes('Review me'));
    assert.ok(text.includes('T1'));
    assert.ok(text.includes('C:/work/github'));
    assert.ok(text.includes('Instructions:'));

    assert.equal(readStateFile(statePath).sessionId, 'session-live');
    assert.equal(dispatcher.status().sessionId, 'session-live');
  });

  it('resumes a persisted watcher session when it is not live', async () => {
    const resumed = makeAgent('session-resumed');
    const fake = makeAgents({ resumeAgent: resumed });
    const { dispatcher, calls } = makeDispatcher({
      config: { autoDispatchSessionId: 'session-resumed' },
      fake,
    });
    const result = await dispatcher.handleEvents([makeEvent()]);
    assert.equal(result.dispatched, true);
    assert.equal(result.sessionId, 'session-resumed');
    assert.deepEqual(calls.get, ['session-resumed']);
    assert.deepEqual(calls.resume, ['session-resumed']);
    assert.deepEqual(calls.create, []);
    assert.equal(resumed.followups.length, 1);
  });

  it('creates a watcher session when resume fails', async () => {
    const fake = makeAgents({ resumeError: new Error('resume failed') });
    const { dispatcher, calls } = makeDispatcher({
      config: { autoDispatchSessionId: 'session-created' },
      fake,
    });
    const result = await dispatcher.handleEvents([makeEvent()]);
    assert.equal(result.dispatched, true);
    assert.equal(result.sessionId, 'session-created');
    assert.deepEqual(calls.get, ['session-created']);
    assert.deepEqual(calls.resume, ['session-created']);
    assert.deepEqual(calls.create, [{ sessionId: 'session-created', meta: { cwd: 'C:/work/github' } }]);
    const created = fake.live.get('session-created');
    assert.equal(created.followups.length, 1);
  });

  it('generates a session-<uuid> watcher when no id is configured', async () => {
    const fake = makeAgents();
    const { dispatcher, statePath } = makeDispatcher({ fake });
    const result = await dispatcher.handleEvents([makeEvent()]);
    assert.equal(result.dispatched, true);
    assert.match(result.sessionId, /^session-[0-9a-f-]{36}$/);
    assert.equal(fake.calls.create[0].sessionId, result.sessionId);
    assert.equal(dispatcher.status().sessionId, result.sessionId);
    assert.equal(readStateFile(statePath).sessionId, result.sessionId);
  });

  it('records a session failure without marking events seen', async () => {
    const fake = makeAgents({ createError: new Error('no session manager') });
    const event = makeEvent();
    const { dispatcher, tasks } = makeDispatcher({ fake });
    const first = await dispatcher.handleEvents([event]);
    assert.equal(first.dispatched, false);
    assert.equal(first.reason, 'session-unavailable');
    assert.equal(dispatcher.status().lastError, 'no session manager');
    assert.equal(dispatcher.status().seen, 0);
    assert.equal(tasks.list().length, 1);

    // Drop the failure: the unread event is retried and dispatched.
    fake.options.createError = null;
    const second = await dispatcher.handleEvents([event]);
    assert.equal(second.dispatched, true);
    assert.equal(dispatcher.status().lastError, null);
  });
});

// --- AutoDispatcher: failure, persistence and manual sends -----------------

describe('AutoDispatcher failures and persistence', () => {
  it('leaves events unseen and records lastError when followup fails', async () => {
    const agent = makeAgent('session-live', { failCount: 1 });
    const event = makeEvent();
    const { dispatcher, statePath, tasks } = makeDispatcher({
      config: { autoDispatchSessionId: 'session-live' },
      fake: makeAgents({ live: { 'session-live': agent } }),
    });
    const failed = await dispatcher.handleEvents([event]);
    assert.equal(failed.dispatched, false);
    assert.equal(failed.reason, 'followup-failed');
    assert.equal(failed.sessionId, 'session-live');
    assert.equal(dispatcher.status().lastError, 'followup failed');
    assert.equal(dispatcher.status().seen, 0);
    assert.equal(dispatcher.status().lastDispatchAt, null);
    assert.equal(readStateFile(statePath).seen.length, 0);
    assert.equal(tasks.list().length, 1);

    // The retry succeeds because the event was never marked seen.
    const retried = await dispatcher.handleEvents([event]);
    assert.equal(retried.dispatched, true);
    assert.equal(agent.followups.length, 1);
    assert.equal(dispatcher.status().lastError, null);
    assert.equal(dispatcher.status().count, 1);
    assert.equal(dispatcher.status().seen, 1);
  });

  it('reports task creation failures without dispatching', async () => {
    const { dispatcher, agent, tasks } = liveDispatcher();
    const original = tasks.create.bind(tasks);
    tasks.create = () => {
      throw new Error('disk full');
    };
    const result = await dispatcher.handleEvents([makeEvent()]);
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'task-create-failed');
    assert.equal(dispatcher.status().lastError, 'disk full');
    assert.equal(dispatcher.status().seen, 0);
    assert.equal(agent.followups.length, 0);
    tasks.create = original;
  });

  it('persists state across dispatcher instances and reuses the watcher', async () => {
    const first = makeDispatcher();
    const event = makeEvent({ number: 31 });
    assert.equal((await first.dispatcher.handleEvents([event])).dispatched, true);
    const saved = readStateFile(first.statePath);
    assert.equal(saved.count, 1);
    assert.match(saved.sessionId, /^session-/);
    assert.deepEqual(saved.seen, [event.id]);

    const agent = makeAgent(saved.sessionId);
    const second = makeDispatcher({
      dir: first.dir,
      tasks: new TaskStore(first.tasksPath),
      fake: makeAgents({ live: { [saved.sessionId]: agent } }),
    });
    const status = second.dispatcher.status();
    assert.equal(status.count, 1);
    assert.equal(status.sessionId, saved.sessionId);
    assert.equal(status.seen, 1);
    assert.deepEqual(await second.dispatcher.handleEvents([event]), { dispatched: false, reason: 'no-events' });

    const sent = await second.dispatcher.sendToWatcher('check the storyboard');
    assert.deepEqual(sent, { sessionId: saved.sessionId, sent: true });
    assert.equal(agent.followups.length, 1);
    assert.equal(agent.followups[0].content[0].text, 'check the storyboard');
  });

  it('recovers from a corrupt state file', async () => {
    const { dispatcher, statePath } = makeDispatcher();
    fs.writeFileSync(statePath, '{not json', 'utf8');
    const fresh = new AutoDispatcher({
      config: baseConfig(),
      tasks: new TaskStore(path.join(path.dirname(statePath), 'tasks-corrupt.json')),
      agents: makeAgents().agents,
      statePath,
    });
    assert.deepEqual(fresh.status(), {
      enabled: true,
      sessionId: null,
      lastDispatchAt: null,
      count: 0,
      lastError: null,
      lastEventAt: null,
      seen: 0,
      skipped: 0,
    });
    const result = await fresh.handleEvents([makeEvent()]);
    assert.equal(result.dispatched, true);
    assert.equal(readStateFile(statePath).count, 1);
    assert.equal(dispatcher.status().count, 0);
  });

  it('sendToWatcher reuses the configured session across calls', async () => {
    const { dispatcher, agent, calls } = liveDispatcher();
    assert.deepEqual(await dispatcher.sendToWatcher('first'), { sessionId: 'session-live', sent: true });
    assert.deepEqual(await dispatcher.sendToWatcher('second'), { sessionId: 'session-live', sent: true });
    assert.equal(agent.followups.length, 2);
    assert.equal(agent.followups[0].content[0].text, 'first');
    assert.equal(agent.followups[1].content[0].text, 'second');
    assert.deepEqual(calls.get, ['session-live', 'session-live']);
    assert.deepEqual(calls.create, []);
  });

  it('sendToWatcher works while auto dispatch is disabled and creates a session', async () => {
    const fake = makeAgents();
    const { dispatcher } = makeDispatcher({ config: { autoDispatch: false }, fake });
    const result = await dispatcher.sendToWatcher('manual nudge');
    assert.equal(result.sent, true);
    assert.match(result.sessionId, /^session-/);
    const created = fake.live.get(result.sessionId);
    assert.equal(created.followups[0].content[0].text, 'manual nudge');
    assert.equal(dispatcher.status().enabled, false);
  });
});

// --- AutoDispatcher: ordering, max events and status -----------------------

describe('AutoDispatcher ordering and status', () => {
  it('prioritises review > pr > issue > push and caps the batch', async () => {
    const { dispatcher } = liveDispatcher({
      config: {
        autoDispatchKinds: ['issue', 'pr', 'review', 'push'],
        autoDispatchMaxEvents: 2,
      },
    });
    const push = makeEvent({ kind: 'push', branch: 'main', at: '2026-01-01T00:00:10.000Z' });
    const issue = makeEvent({ kind: 'issue', number: 1, at: '2026-01-01T00:00:03.000Z' });
    const pr = makeEvent({ kind: 'pr', number: 2, at: '2026-01-01T00:00:01.000Z' });
    const review = makeEvent({ kind: 'review', number: 2, at: '2026-01-01T00:00:02.000Z' });
    const result = await dispatcher.handleEvents([push, issue, pr, review]);
    assert.equal(result.dispatched, true);
    assert.deepEqual(result.eventIds, [review.id, pr.id]);
    assert.deepEqual(result.taskIds, ['T1', 'T2']);
  });

  it('prefers the newest event within the same kind', async () => {
    const { dispatcher } = liveDispatcher({ config: { autoDispatchMaxEvents: 1 } });
    const older = makeEvent({ number: 1, at: '2026-01-01T00:00:01.000Z' });
    const newer = makeEvent({ number: 2, at: '2026-01-01T00:00:09.000Z' });
    const result = await dispatcher.handleEvents([older, newer]);
    assert.deepEqual(result.eventIds, [newer.id]);
  });

  it('reports full status after a dispatch', async () => {
    const { dispatcher } = liveDispatcher();
    const event = makeEvent({ at: '2026-01-01T00:00:42.000Z' });
    await dispatcher.handleEvents([event, makeEvent({ baseline: true, at: '2026-01-01T00:00:50.000Z' })]);
    assert.deepEqual(dispatcher.status(), {
      enabled: true,
      sessionId: 'session-live',
      lastDispatchAt: START,
      count: 1,
      lastError: null,
      lastEventAt: '2026-01-01T00:00:50.000Z',
      seen: 1,
      skipped: 1,
    });
  });

  it('tick() is a documented no-op', async () => {
    const { dispatcher } = makeDispatcher();
    assert.deepEqual(await dispatcher.tick(), { dispatched: false, reason: 'no-events' });
  });
});
