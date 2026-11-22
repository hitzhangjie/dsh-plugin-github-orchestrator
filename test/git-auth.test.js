/**
 * Tests for token-authenticated Git HTTPS support in lib/git.js.
 *
 * Everything runs offline against a real temporary repository under
 * os.tmpdir(). The OAuth token is observable through git's own config view
 * (`git config --get http.https://github.com/.extraheader`) and through the
 * environment git reports, so no network remote is needed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGitAuthEnv, gitOk, runGit, setGitAuthProvider } from '../lib/git.js';

const EXTRAHEADER_KEY = 'http.https://github.com/.extraheader';
const TOKEN = 'gho_offline-test-token';

const FIXTURE_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_AUTHOR_NAME: 'Auth Test',
  GIT_AUTHOR_EMAIL: 'auth-test@example.com',
  GIT_COMMITTER_NAME: 'Auth Test',
  GIT_COMMITTER_EMAIL: 'auth-test@example.com',
};

/** Direct git invocation used only to build the fixture repository. */
function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: FIXTURE_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let tempDir = null;
let repoDir = null;
let savedGlobal = undefined;
let savedNoSystem = undefined;

before(() => {
  // Keep the host's git config out of the assertions below.
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-git-auth-'));
  process.env.GIT_CONFIG_GLOBAL = path.join(tempDir, 'no-such-global-config');
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  repoDir = path.join(tempDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '-q');
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'fixture\n', 'utf8');
  git(repoDir, 'add', 'README.md');
  git(repoDir, 'commit', '-q', '-m', 'initial commit');
});

after(() => {
  setGitAuthProvider(null);
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // A lingering git process on Windows is not a test failure.
    }
  }
});

/** Install a provider for the duration of one test. */
async function withAuthProvider(provider, fn) {
  setGitAuthProvider(provider);
  try {
    return await fn();
  } finally {
    setGitAuthProvider(null);
  }
}

function decodeBasic(headerValue) {
  const prefix = 'AUTHORIZATION: basic ';
  assert.ok(headerValue.startsWith(prefix), `unexpected header: ${headerValue}`);
  return Buffer.from(headerValue.slice(prefix.length), 'base64').toString('utf8');
}

async function childConfigValue() {
  return runGit(['config', '--get', EXTRAHEADER_KEY], { cwd: repoDir });
}

// ---------------------------------------------------------------------------
// buildGitAuthEnv
// ---------------------------------------------------------------------------

test('buildGitAuthEnv returns an empty object without a token', () => {
  for (const auth of [undefined, null, {}, { token: null }, { token: '' }, { token: '   ' }, { token: 42 }]) {
    assert.deepEqual(buildGitAuthEnv(auth), {});
  }
});

test('buildGitAuthEnv builds the github.com extraheader env', () => {
  const env = buildGitAuthEnv({ token: TOKEN });
  assert.deepEqual(Object.keys(env).sort(), [
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
  ]);
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, EXTRAHEADER_KEY);
  assert.equal(decodeBasic(env.GIT_CONFIG_VALUE_0), `x-access-token:${TOKEN}`);
  // The base64 payload really is base64, not the raw token.
  assert.doesNotMatch(env.GIT_CONFIG_VALUE_0, /gho_/);
});

test('buildGitAuthEnv ignores unrelated auth fields and trims the token', () => {
  const env = buildGitAuthEnv({ token: '  gho_trimmed  ', source: 'oauth', extra: 1 });
  assert.equal(decodeBasic(env.GIT_CONFIG_VALUE_0), 'x-access-token:gho_trimmed');
});

// ---------------------------------------------------------------------------
// runGit merges the provider auth env
// ---------------------------------------------------------------------------

test('runGit passes the provider token to child git processes', async () => {
  const calls = [];
  await withAuthProvider(
    () => {
      calls.push(1);
      return { token: TOKEN };
    },
    async () => {
      const result = await childConfigValue();
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout.trim(), buildGitAuthEnv({ token: TOKEN }).GIT_CONFIG_VALUE_0);
      assert.equal(decodeBasic(result.stdout.trim()), `x-access-token:${TOKEN}`);
    },
  );
  assert.equal(calls.length, 1);
});

test('runGit asks the provider on every invocation', async () => {
  let count = 0;
  await withAuthProvider(
    () => {
      count += 1;
      return { token: `${TOKEN}-${count}` };
    },
    async () => {
      await childConfigValue();
      const second = await childConfigValue();
      assert.equal(decodeBasic(second.stdout.trim()), `x-access-token:${TOKEN}-2`);
    },
  );
  assert.equal(count, 2);
});

test('runGit works normally in a real repository with a provider installed', async () => {
  await withAuthProvider(
    () => ({ token: TOKEN }),
    async () => {
      const isWorkTree = await gitOk(['rev-parse', '--is-inside-work-tree'], { cwd: repoDir });
      assert.equal(isWorkTree, 'true');

      const head = await gitOk(['rev-parse', 'HEAD'], { cwd: repoDir });
      assert.match(head, /^[0-9a-f]{40}$/);

      const status = await runGit(['status', '--porcelain'], { cwd: repoDir });
      assert.equal(status.exitCode, 0, status.stderr);
      assert.equal(status.stdout.trim(), '');

      const commit = await runGit(['add', '-A'], { cwd: repoDir });
      assert.equal(commit.exitCode, 0, commit.stderr);
    },
  );
});

test('the token is never written into .git/config', async () => {
  await withAuthProvider(
    () => ({ token: TOKEN }),
    async () => {
      await childConfigValue();
    },
  );
  const configPath = path.join(repoDir, '.git', 'config');
  const configText = fs.readFileSync(configPath, 'utf8');
  assert.doesNotMatch(configText, /extraheader/i);
  assert.doesNotMatch(configText, new RegExp(TOKEN));
});

test('the auth header only targets https://github.com URLs', async () => {
  await withAuthProvider(
    () => ({ token: TOKEN }),
    async () => {
      const github = await childConfigValue();
      assert.equal(github.exitCode, 0);
      const gitlab = await runGit(['config', '--get', 'http.https://gitlab.com/.extraheader'], {
        cwd: repoDir,
      });
      assert.notEqual(gitlab.exitCode, 0);
      assert.equal(gitlab.stdout.trim(), '');
    },
  );
});

// ---------------------------------------------------------------------------
// provider lifecycle and edge cases
// ---------------------------------------------------------------------------

test('setGitAuthProvider(null) removes the credential from child git env', async () => {
  setGitAuthProvider(() => ({ token: TOKEN }));
  try {
    const withToken = await childConfigValue();
    assert.equal(withToken.exitCode, 0);
  } finally {
    setGitAuthProvider(null);
  }
  const afterReset = await childConfigValue();
  assert.notEqual(afterReset.exitCode, 0);
  assert.equal(afterReset.stdout.trim(), '');
});

test('setGitAuthProvider ignores non-function values', async () => {
  setGitAuthProvider(() => ({ token: TOKEN }));
  try {
    assert.equal((await childConfigValue()).exitCode, 0);
    setGitAuthProvider('not-a-provider');
    assert.notEqual((await childConfigValue()).exitCode, 0);
  } finally {
    setGitAuthProvider(null);
  }
  assert.notEqual((await childConfigValue()).exitCode, 0);
});

test('a throwing provider is ignored and git still runs', async () => {
  await withAuthProvider(
    () => {
      throw new Error('token store exploded');
    },
    async () => {
      const missing = await childConfigValue();
      assert.notEqual(missing.exitCode, 0);
      const status = await runGit(['status', '--porcelain'], { cwd: repoDir });
      assert.equal(status.exitCode, 0, status.stderr);
    },
  );
});

test('a provider returning no token produces no auth env', async () => {
  for (const value of [null, undefined, {}, { token: null }, { token: '' }]) {
    await withAuthProvider(
      () => value,
      async () => {
        const result = await childConfigValue();
        assert.notEqual(result.exitCode, 0);
        assert.equal(result.stdout.trim(), '');
      },
    );
  }
});

test('explicit opts.env overrides the provider auth env', async () => {
  const overrideToken = 'gho_explicit-override';
  const overrideHeader = buildGitAuthEnv({ token: overrideToken }).GIT_CONFIG_VALUE_0;
  await withAuthProvider(
    () => ({ token: TOKEN }),
    async () => {
      const result = await runGit(['config', '--get', EXTRAHEADER_KEY], {
        cwd: repoDir,
        env: { GIT_CONFIG_VALUE_0: overrideHeader },
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), overrideHeader);
      assert.equal(decodeBasic(result.stdout.trim()), `x-access-token:${overrideToken}`);
    },
  );
});

test('runGit still rejects for non-string arguments', async () => {
  await assert.rejects(runGit(['status', 42]), TypeError);
});
