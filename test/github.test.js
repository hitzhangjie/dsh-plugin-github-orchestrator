/**
 * Offline unit tests for lib/github.js and lib/auth.js.
 *
 * HTTP behavior is exercised against the in-process mock GitHub server or a
 * stub `fetchImpl`; nothing here touches api.github.com.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GitHubClient,
  GitHubError,
  parseRepo,
  resolveGitHubToken,
  CREDENTIAL_KEY,
  readCredentialRecord,
  tokenFromRecord,
} from '../lib/github.js';
import { startMockGitHub } from './helpers/mock-github.js';

function jsonResponse(body, init = {}) {
  const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  return new Response(body === undefined ? null : JSON.stringify(body), { ...init, headers });
}

test('parseRepo normalizes owner/name, URLs and SSH remotes', () => {
  assert.deepEqual(parseRepo('acme/widgets'), { owner: 'acme', name: 'widgets', repo: 'acme/widgets' });
  assert.deepEqual(parseRepo('  acme/widgets  '), { owner: 'acme', name: 'widgets', repo: 'acme/widgets' });
  assert.deepEqual(parseRepo('https://github.com/acme/widgets'), { owner: 'acme', name: 'widgets', repo: 'acme/widgets' });
  assert.deepEqual(parseRepo('https://github.com/acme/widgets.git'), { owner: 'acme', name: 'widgets', repo: 'acme/widgets' });
  assert.deepEqual(parseRepo('git@github.com:acme/widgets.git'), { owner: 'acme', name: 'widgets', repo: 'acme/widgets' });
  assert.deepEqual(parseRepo('acme/widgets/tree/main'), { owner: 'acme', name: 'widgets', repo: 'acme/widgets' });
  assert.throws(() => parseRepo(''), /expected "owner\/name"/);
  assert.throws(() => parseRepo('acme'), /expected "owner\/name"/);
  assert.throws(() => parseRepo('acme/weird name'), /expected "owner\/name"/);
});

test('client sends auth and API headers and returns parsed JSON', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedIssue('acme/widgets', { number: 7, title: 'First issue' });

  const client = new GitHubClient({ token: 'test-token', apiBase: mock.url, userAgent: 'test-agent/1.0' });
  const response = await client.get('/repos/acme/widgets/issues', { query: { state: 'all', per_page: 5 } });

  assert.equal(response.status, 200);
  assert.equal(Array.isArray(response.data), true);
  assert.equal(response.data.length, 1);
  assert.equal(response.data[0].number, 7);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');

  const recorded = mock.requests[0];
  assert.equal(recorded.method, 'GET');
  assert.equal(recorded.path, '/repos/acme/widgets/issues');
  assert.equal(recorded.query.state, 'all');
  assert.equal(recorded.query.per_page, '5');
  assert.equal(recorded.headers.authorization, 'Bearer test-token');
  assert.equal(recorded.headers.accept, 'application/vnd.github+json');
  assert.equal(recorded.headers['x-github-api-version'], '2022-11-28');
  assert.equal(recorded.headers['user-agent'], 'test-agent/1.0');

  assert.equal(client.rateLimit().remaining, 5000);
  assert.match(client.rateLimit().resetAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('client omits Authorization when no token is configured', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const client = new GitHubClient({ apiBase: mock.url });
  await client.get('/repos/acme/widgets/issues');
  assert.equal(mock.requests[0].headers.authorization, undefined);
});

test('query parameters: booleans stringified, undefined skipped', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const client = new GitHubClient({ apiBase: mock.url });
  await client.get('/repos/acme/widgets/issues', { query: { state: 'all', draft: false, page: 2, missing: undefined } });
  const query = mock.requests[0].query;
  assert.equal(query.state, 'all');
  assert.equal(query.draft, 'false');
  assert.equal(query.page, '2');
  assert.equal('missing' in query, false);
});

test('post/patch/del helpers hit the right mock endpoints', async (t) => {
  const mock = await startMockGitHub({ token: 'secret-token' });
  t.after(() => mock.close());
  const client = new GitHubClient({ token: 'secret-token', apiBase: mock.url });

  const created = await client.post('/repos/acme/widgets/issues', { title: 'New issue', body: 'Hello' });
  assert.equal(created.status, 201);
  assert.equal(created.data.number, 1);
  assert.equal(created.data.title, 'New issue');

  const patched = await client.patch('/repos/acme/widgets/issues/1', { title: 'Renamed' });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.title, 'Renamed');

  const comment = await client.post('/repos/acme/widgets/issues/1/comments', { body: 'hi' });
  assert.equal(comment.status, 201);
  assert.equal(comment.data.body, 'hi');

  const label = await client.post('/repos/acme/widgets/labels', { name: 'gos:task', color: 'ff0000' });
  assert.equal(label.status, 201);
  assert.equal(label.data.name, 'gos:task');

  const labels = await client.get('/repos/acme/widgets/labels');
  assert.deepEqual(labels.data.map((entry) => entry.name), ['gos:task']);

  const deleted = await client.del('/repos/acme/widgets/labels/gos%3Atask');
  assert.equal(deleted.status, 204);

  assert.deepEqual(
    mock.requests.map((entry) => `${entry.method} ${entry.path}`),
    [
      'POST /repos/acme/widgets/issues',
      'PATCH /repos/acme/widgets/issues/1',
      'POST /repos/acme/widgets/issues/1/comments',
      'POST /repos/acme/widgets/labels',
      'GET /repos/acme/widgets/labels',
      'DELETE /repos/acme/widgets/labels/gos%3Atask',
    ],
  );
  assert.deepEqual(mock.requests[0].body, { title: 'New issue', body: 'Hello' });
});

test('paginate walks pages until a short page and honors maxPages', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  for (let number = 1; number <= 5; number += 1) {
    mock.seedIssue('acme/widgets', { number, title: `Issue ${number}` });
  }
  const client = new GitHubClient({ apiBase: mock.url });

  const all = await client.paginate('/repos/acme/widgets/issues', { perPage: 2 });
  assert.deepEqual(all.map((issue) => issue.number), [1, 2, 3, 4, 5]);
  assert.equal(mock.requests.length, 3);

  mock.requests.length = 0;
  const capped = await client.paginate('/repos/acme/widgets/issues', { perPage: 2, maxPages: 1 });
  assert.deepEqual(capped.map((issue) => issue.number), [1, 2]);
  assert.equal(mock.requests.length, 1);
});

test('non-2xx throws GitHubError; allowStatus returns the response instead', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const client = new GitHubClient({ apiBase: mock.url });

  await assert.rejects(
    () => client.get('/repos/acme/widgets/issues/999'),
    (error) => {
      assert.equal(error instanceof GitHubError, true);
      assert.equal(error.name, 'GitHubError');
      assert.equal(error.status, 404);
      assert.equal(error.code, 'http_error');
      assert.match(error.message, /failed with status 404/);
      assert.equal(error.body.message, 'Not Found');
      return true;
    },
  );

  const allowed = await client.get('/repos/acme/widgets/issues/999', { allowStatus: [404] });
  assert.equal(allowed.status, 404);
  assert.equal(allowed.data.message, 'Not Found');
});

test('304 responses and ETag conditional requests', async () => {
  let capturedInit = null;
  const client = new GitHubClient({
    token: 'etag-token',
    fetchImpl: async (url, init) => {
      capturedInit = { url, init };
      return new Response(null, { status: 304, headers: { etag: '"abc123"' } });
    },
  });

  const response = await client.get('/repos/acme/widgets/issues', { etag: '"abc123"' });
  assert.equal(response.status, 304);
  assert.equal(response.notModified, true);
  assert.equal(response.data, null);
  assert.equal(response.etag, '"abc123"');
  assert.equal(capturedInit.init.headers['If-None-Match'], '"abc123"');
  assert.equal(capturedInit.init.headers.Authorization, 'Bearer etag-token');
});

test('403 with exhausted rate limit throws a rate-limit GitHubError', async () => {
  const resetEpoch = Math.floor(Date.now() / 1000) + 120;
  const client = new GitHubClient({
    fetchImpl: async () =>
      jsonResponse(
        { message: 'API rate limit exceeded for 1.2.3.4', documentation_url: 'https://docs.github.com/rest' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpoch) },
        },
      ),
  });

  await assert.rejects(
    () => client.get('/repos/acme/widgets/issues'),
    (error) => {
      assert.equal(error instanceof GitHubError, true);
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.status, 403);
      assert.equal(error.rateLimitRemaining, 0);
      assert.equal(error.rateLimitReset, new Date(resetEpoch * 1000).toISOString());
      assert.match(error.message, /rate limit exceeded/);
      return true;
    },
  );
  assert.equal(client.rateLimit().remaining, 0);
});

test('429 Too Many Requests is treated as a rate-limit error even without a remaining header', async () => {
  const resetEpoch = Math.floor(Date.now() / 1000) + 60;
  const client = new GitHubClient({
    fetchImpl: async () =>
      jsonResponse(
        { message: 'You have exceeded a secondary rate limit' },
        { status: 429, headers: { 'x-ratelimit-reset': String(resetEpoch) } },
      ),
  });
  await assert.rejects(() => client.get('/repos/acme/widgets/issues'), (error) => {
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.status, 429);
    assert.equal(error.rateLimitReset, new Date(resetEpoch * 1000).toISOString());
    return true;
  });
});

test('403 without exhausted quota is a normal http_error', async () => {
  const client = new GitHubClient({
    fetchImpl: async () =>
      jsonResponse({ message: 'Forbidden' }, { status: 403, headers: { 'x-ratelimit-remaining': '42' } }),
  });
  await assert.rejects(() => client.get('/repos/acme/widgets'), (error) => {
    assert.equal(error.code, 'http_error');
    assert.equal(error.rateLimitRemaining, 42);
    return true;
  });
});

test('retries 502/503/504 twice with backoff, then succeeds', async () => {
  let calls = 0;
  const client = new GitHubClient({
    retryDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ message: 'bad gateway' }, { status: 502 });
      if (calls === 2) return jsonResponse({ message: 'unavailable' }, { status: 503 });
      return jsonResponse([{ number: 1 }], { status: 200 });
    },
  });

  const response = await client.get('/repos/acme/widgets/issues');
  assert.equal(calls, 3);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, [{ number: 1 }]);
});

test('retries network errors, then throws a network_error GitHubError', async () => {
  let calls = 0;
  const failing = new GitHubClient({
    retryDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(() => failing.get('/repos/acme/widgets'), (error) => {
    assert.equal(error instanceof GitHubError, true);
    assert.equal(error.code, 'network_error');
    assert.equal(error.status, 0);
    assert.match(error.message, /fetch failed/);
    return true;
  });
  assert.equal(calls, 3);

  let recoveredCalls = 0;
  const recovering = new GitHubClient({
    retryDelayMs: 1,
    fetchImpl: async () => {
      recoveredCalls += 1;
      if (recoveredCalls < 3) throw new TypeError('socket hang up');
      return jsonResponse({ full_name: 'acme/widgets' });
    },
  });
  const response = await recovering.get('/repos/acme/widgets');
  assert.equal(response.data.full_name, 'acme/widgets');
});

test('request timeout aborts and reports a timeout error', async () => {
  const client = new GitHubClient({
    timeoutMs: 20,
    maxRetries: 0,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });
  await assert.rejects(() => client.get('/repos/acme/widgets'), (error) => {
    assert.equal(error instanceof GitHubError, true);
    assert.equal(error.code, 'timeout');
    assert.match(error.message, /timed out after 20ms/);
    return true;
  });
});

test('resolveGitHubToken: explicit token wins over everything', async () => {
  const result = await resolveGitHubToken({
    explicit: '  ghp_explicit123  ',
    credentials: { readRecord: async () => ({ token: 'ghp_credentials' }) },
    env: { GITHUB_TOKEN: 'ghp_env' },
    execImpl: async () => 'ghp_cli',
  });
  assert.deepEqual(result, { token: 'ghp_explicit123', source: 'config' });
});

test('resolveGitHubToken: credentials record beats env and gh CLI', async () => {
  const seenKeys = [];
  const result = await resolveGitHubToken({
    explicit: '',
    credentials: {
      readRecord: async (key) => {
        seenKeys.push(key);
        return { token: 'ghp_from_record' };
      },
    },
    env: { GITHUB_TOKEN: 'ghp_env' },
    execImpl: async () => 'ghp_cli',
  });
  assert.deepEqual(result, { token: 'ghp_from_record', source: 'credentials' });
  assert.deepEqual(seenKeys, [CREDENTIAL_KEY]);
  assert.equal(CREDENTIAL_KEY, 'github-orchestrator');
});

test('resolveGitHubToken: GITHUB_TOKEN then GH_TOKEN when no higher source', async () => {
  const fromGithub = await resolveGitHubToken({
    credentials: { readRecord: async () => null },
    env: { GITHUB_TOKEN: 'ghp_env_first', GH_TOKEN: 'ghp_env_second' },
    execImpl: async () => 'ghp_cli',
  });
  assert.deepEqual(fromGithub, { token: 'ghp_env_first', source: 'env' });

  const fromGh = await resolveGitHubToken({
    credentials: {},
    env: { GH_TOKEN: 'ghp_gh_env' },
    execImpl: async () => 'ghp_cli',
  });
  assert.deepEqual(fromGh, { token: 'ghp_gh_env', source: 'env' });
});

test('resolveGitHubToken: falls back to gh auth token', async () => {
  const calls = [];
  const result = await resolveGitHubToken({
    env: {},
    execImpl: async (command, args) => {
      calls.push([command, ...args]);
      return 'ghp_from_cli\n';
    },
  });
  assert.deepEqual(result, { token: 'ghp_from_cli', source: 'gh-cli' });
  assert.deepEqual(calls, [['gh', 'auth', 'token']]);
});

test('resolveGitHubToken: none when every source is empty or broken', async () => {
  const result = await resolveGitHubToken({
    explicit: '   ',
    credentials: { readRecord: async () => ({}) },
    env: {},
    execImpl: async () => {
      throw new Error('gh: command not found');
    },
  });
  assert.deepEqual(result, { token: null, source: 'none' });
});

test('token helpers tolerate plain mapping credentials and string records', async () => {
  assert.equal(tokenFromRecord('ghp_string_record'), 'ghp_string_record');
  assert.equal(tokenFromRecord({ secret: ' ghp_secret ' }), 'ghp_secret');
  assert.equal(tokenFromRecord({}), null);
  assert.equal(tokenFromRecord(null), null);

  assert.deepEqual(await readCredentialRecord({ [CREDENTIAL_KEY]: { token: 'ghp_map' } }), { token: 'ghp_map' });
  assert.deepEqual(await readCredentialRecord({ get: async () => ({ token: 'ghp_get' }) }), { token: 'ghp_get' });
  assert.equal(await readCredentialRecord(null), null);
});
