/**
 * Wiring test for index.js: activation registers the six tools and the runtime
 * context section, and a tool executes against the real stores.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

import { apply } from '../index.js';

const tempRoots = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-index-'));
  tempRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeContext() {
  const registered = [];
  const contexts = [];
  const disposers = [];
  const credentials = {
    record: null,
    async readRecord() {
      return this.record;
    },
    async modifyRecord(_key, mutate) {
      this.record = await mutate(this.record);
      return this.record;
    },
    async deleteRecord() {
      this.record = null;
    },
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'systemPrompt') {
        return {
          context(contribution) {
            contexts.push(contribution);
            return () => {};
          },
        };
      }
      if (name === 'credentials') return credentials;
      return undefined;
    },
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    effect(factory) {
      disposers.push(factory());
    },
  };
  return { ctx, registered, contexts, credentials, disposeAll: () => disposers.splice(0).forEach((dispose) => dispose()) };
}

it('activates, registers tools and exposes a runtime context section', async () => {
  const root = tempDir();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_testtoken0123456789012345678901234567';
  try {
    const { ctx, registered, contexts, disposeAll } = fakeContext();
    await apply(ctx, {
      workspaceRoot: path.join(root, 'workspace'),
      repos: ['owner/name'],
      pollIntervalSec: 300,
    });

    assert.deepEqual(registered.map((tool) => tool.name).sort(), [
      'git_sync',
      'git_worktree',
      'github_auth',
      'github_config',
      'github_dispatch',
      'github_events',
      'github_issues',
      'github_repos',
      'github_tasks',
    ]);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].name, 'github-orchestrator');
    const text = contexts[0].text();
    assert.match(text, /## GitHub orchestrator/);
    assert.match(text, /workspace/);
    assert.match(text, /owner\/name|Active tasks|Unread GitHub events/);

    assert.equal(fs.existsSync(path.join(root, 'github-orchestrator')), true);

    const configTool = registered.find((tool) => tool.name === 'github_config');
    const shown = await configTool.execute({ action: 'show' }, {});
    assert.equal(shown.ok, true);
    assert.equal(shown.repos[0].repo, 'owner/name');
    assert.equal(shown.token.source, 'env');
    assert.equal(shown.poller.token, true);
    assert.equal(shown.auth.credentialsAvailable, true);
    assert.equal(typeof shown.auth.clientId, 'string');

    const authTool = registered.find((tool) => tool.name === 'github_auth');
    const status = await authTool.execute({ action: 'status' }, {});
    assert.equal(status.authenticated, true);
    assert.equal(status.source, 'env');
    assert.equal(status.pending, null);
    disposeAll();
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

it('activates without a token and without repositories', async () => {
  const root = tempDir();
  const previousHome = process.env.DSH_HOME;
  const previousToken = process.env.GITHUB_TOKEN;
  const previousGhToken = process.env.GH_TOKEN;
  process.env.DSH_HOME = root;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  // Avoid depending on a real `gh` login for this case: GH_CONFIG_DIR points at
  // an empty directory so the CLI has no authenticated host.
  const previousGhConfig = process.env.GH_CONFIG_DIR;
  process.env.GH_CONFIG_DIR = path.join(root, 'empty-gh-config');
  fs.mkdirSync(process.env.GH_CONFIG_DIR, { recursive: true });
  try {
    const { ctx, registered, contexts, disposeAll } = fakeContext();
    await apply(ctx, { workspaceRoot: path.join(root, 'workspace'), repos: [] });
    assert.equal(registered.length, 9);
    assert.match(contexts[0].text(), /no repositories configured yet/);
    const shown = await registered.find((tool) => tool.name === 'github_config').execute({ action: 'show' }, {});
    assert.equal(shown.poller.running, false);
    disposeAll();
  } finally {
    for (const [key, value] of Object.entries({
      DSH_HOME: previousHome,
      GITHUB_TOKEN: previousToken,
      GH_TOKEN: previousGhToken,
      GH_CONFIG_DIR: previousGhConfig,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
