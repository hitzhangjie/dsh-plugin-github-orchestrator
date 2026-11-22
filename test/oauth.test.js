/**
 * Offline tests for lib/oauth.js. All HTTP is served by injectable mock fetch
 * implementations; the real network is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_SCOPES,
  DeviceFlowError,
  fetchGitHubUser,
  pollDeviceFlow,
  resolveOAuthClientId,
  startDeviceFlow,
} from '../lib/oauth.js';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Minimal fetch Response stand-in with JSON body and headers. */
function mockResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function scriptedFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (queue.length === 0) throw new Error(`unexpected fetch call to ${url}`);
    const next = queue.shift();
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  return { fetchImpl, calls };
}

function deviceCodeBody(overrides = {}) {
  return {
    device_code: 'device-code-123',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
    ...overrides,
  };
}

function bodyOf(call) {
  assert.equal(typeof call.init.body, 'string');
  return JSON.parse(call.init.body);
}

function rejectsWith(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof DeviceFlowError, `expected DeviceFlowError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.name, 'DeviceFlowError');
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// constants and DeviceFlowError
// ---------------------------------------------------------------------------

test('exports the documented constants', () => {
  assert.equal(DEFAULT_OAUTH_SCOPES, 'repo read:user');
  assert.equal(DEFAULT_OAUTH_CLIENT_ID, '178c6fc778ccc68e1d6a');
});

test('DeviceFlowError carries name, code, description and status', () => {
  const error = new DeviceFlowError('nope', {
    code: 'access_denied',
    description: 'user said no',
    status: 400,
  });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'DeviceFlowError');
  assert.equal(error.code, 'access_denied');
  assert.equal(error.description, 'user said no');
  assert.equal(error.status, 400);
  assert.equal(error.message, 'nope');
});

// ---------------------------------------------------------------------------
// resolveOAuthClientId
// ---------------------------------------------------------------------------

test('resolveOAuthClientId prefers config over env over builtin', () => {
  assert.deepEqual(
    resolveOAuthClientId({
      config: { oauthClientId: 'config-id' },
      env: { GITHUB_OAUTH_CLIENT_ID: 'env-id' },
    }),
    { clientId: 'config-id', source: 'config' },
  );
  assert.deepEqual(
    resolveOAuthClientId({ config: {}, env: { GITHUB_OAUTH_CLIENT_ID: 'env-id' } }),
    { clientId: 'env-id', source: 'env' },
  );
  assert.deepEqual(resolveOAuthClientId({ env: {} }), {
    clientId: DEFAULT_OAUTH_CLIENT_ID,
    source: 'builtin',
  });
});

test('resolveOAuthClientId ignores blank overrides and tolerates missing input', () => {
  assert.deepEqual(resolveOAuthClientId(), {
    clientId: DEFAULT_OAUTH_CLIENT_ID,
    source: 'builtin',
  });
  assert.deepEqual(
    resolveOAuthClientId({ config: { oauthClientId: '   ' }, env: { GITHUB_OAUTH_CLIENT_ID: '' } }),
    { clientId: DEFAULT_OAUTH_CLIENT_ID, source: 'builtin' },
  );
  assert.deepEqual(
    resolveOAuthClientId({ config: { oauthClientId: '  padded-id  ' } }),
    { clientId: 'padded-id', source: 'config' },
  );
});

test('resolveOAuthClientId defaults env to process.env', () => {
  const key = 'GITHUB_OAUTH_CLIENT_ID';
  const previous = process.env[key];
  process.env[key] = 'from-process-env';
  try {
    assert.deepEqual(resolveOAuthClientId({ config: null }), {
      clientId: 'from-process-env',
      source: 'env',
    });
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

// ---------------------------------------------------------------------------
// startDeviceFlow
// ---------------------------------------------------------------------------

test('startDeviceFlow posts the expected request and maps the response', async () => {
  const { fetchImpl, calls } = scriptedFetch([mockResponse(deviceCodeBody())]);
  const flow = await startDeviceFlow({ clientId: 'cid-1', fetchImpl });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, DEVICE_CODE_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Accept, 'application/json');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(bodyOf(call), { client_id: 'cid-1', scope: DEFAULT_OAUTH_SCOPES });

  assert.deepEqual(flow, {
    deviceCode: 'device-code-123',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    expiresIn: 900,
    interval: 5,
    clientId: 'cid-1',
    scopes: DEFAULT_OAUTH_SCOPES,
  });
});

test('startDeviceFlow honours a custom baseUrl and scopes', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    mockResponse(deviceCodeBody({ interval: 3, expires_in: 600 })),
  ]);
  const flow = await startDeviceFlow({
    clientId: 'cid-2',
    scopes: 'read:user',
    baseUrl: 'http://127.0.0.1:8123/oauth/',
    fetchImpl,
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:8123/oauth/login/device/code');
  assert.deepEqual(bodyOf(calls[0]), { client_id: 'cid-2', scope: 'read:user' });
  assert.equal(flow.interval, 3);
  assert.equal(flow.expiresIn, 600);
  assert.equal(flow.clientId, 'cid-2');
  assert.equal(flow.scopes, 'read:user');
});

test('startDeviceFlow throws DeviceFlowError for an OAuth error payload', async () => {
  const { fetchImpl } = scriptedFetch([
    mockResponse({ error: 'invalid_client', error_description: 'bad client id' }),
  ]);
  await assert.rejects(startDeviceFlow({ clientId: 'cid', fetchImpl }), (error) => {
    assert.ok(error instanceof DeviceFlowError);
    assert.equal(error.code, 'invalid_client');
    assert.equal(error.description, 'bad client id');
    assert.equal(error.status, 200);
    assert.match(error.message, /invalid_client/);
    return true;
  });
});

test('startDeviceFlow maps a non-JSON HTTP failure to network_error', async () => {
  const { fetchImpl } = scriptedFetch([mockResponse(null, { status: 500 })]);
  await assert.rejects(startDeviceFlow({ clientId: 'cid', fetchImpl }), (error) => {
    assert.ok(error instanceof DeviceFlowError);
    assert.equal(error.code, 'network_error');
    assert.equal(error.status, 500);
    return true;
  });
});

test('startDeviceFlow maps a rejected fetch to network_error', async () => {
  const { fetchImpl } = scriptedFetch([
    () => {
      throw new Error('socket hang up');
    },
  ]);
  await assert.rejects(startDeviceFlow({ clientId: 'cid', fetchImpl }), (error) => {
    assert.ok(error instanceof DeviceFlowError);
    assert.equal(error.code, 'network_error');
    assert.match(error.message, /socket hang up/);
    return true;
  });
});

test('startDeviceFlow rejects a malformed success payload', async () => {
  const { fetchImpl } = scriptedFetch([mockResponse({ user_code: 'ONLY-CODE' })]);
  await rejectsWith(startDeviceFlow({ clientId: 'cid', fetchImpl }), 'network_error');
});

test('startDeviceFlow requires a clientId', async () => {
  await assert.rejects(startDeviceFlow({ fetchImpl: async () => mockResponse({}) }), /clientId/);
});

// ---------------------------------------------------------------------------
// pollDeviceFlow
// ---------------------------------------------------------------------------

test('pollDeviceFlow polls through authorization_pending to success', async () => {
  const pending = mockResponse({ error: 'authorization_pending' });
  const success = mockResponse({
    access_token: 'gho_test-token',
    token_type: 'bearer',
    scope: 'repo read:user',
  });
  const { fetchImpl, calls } = scriptedFetch([pending, pending, success]);
  const sleeps = [];

  const result = await pollDeviceFlow({
    clientId: 'cid',
    deviceCode: 'device-code-123',
    intervalSec: 2,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.deepEqual(result, {
    accessToken: 'gho_test-token',
    tokenType: 'bearer',
    scope: 'repo read:user',
  });
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, TOKEN_URL);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Accept, 'application/json');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(bodyOf(call), {
      client_id: 'cid',
      device_code: 'device-code-123',
      grant_type: GRANT_TYPE,
    });
  }
});

test('pollDeviceFlow increases the interval by five seconds on slow_down', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    mockResponse({ error: 'slow_down' }),
    mockResponse({ access_token: 'tok', token_type: 'bearer', scope: '' }),
  ]);
  const sleeps = [];
  const result = await pollDeviceFlow({
    clientId: 'cid',
    deviceCode: 'device-code-123',
    intervalSec: 3,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(result.accessToken, 'tok');
  assert.deepEqual(sleeps, [8000]);
  assert.equal(calls.length, 2);
});

test('pollDeviceFlow uses the documented default interval', async () => {
  const { fetchImpl } = scriptedFetch([
    mockResponse({ error: 'authorization_pending' }),
    mockResponse({ access_token: 'tok', token_type: 'bearer', scope: 'repo' }),
  ]);
  const sleeps = [];
  await pollDeviceFlow({
    clientId: 'cid',
    deviceCode: 'device-code-123',
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(sleeps, [5000]);
});

test('pollDeviceFlow throws for terminal OAuth errors', async () => {
  for (const code of ['expired_token', 'access_denied', 'incorrect_device_code', 'invalid_client']) {
    const { fetchImpl } = scriptedFetch([
      mockResponse({ error: code, error_description: `detail for ${code}` }),
    ]);
    await assert.rejects(pollDeviceFlow({ clientId: 'cid', deviceCode: 'dc', fetchImpl }), (error) => {
      assert.ok(error instanceof DeviceFlowError);
      assert.equal(error.code, code);
      assert.equal(error.description, `detail for ${code}`);
      return true;
    });
  }
});

test('pollDeviceFlow times out when the device code expires', async () => {
  const times = [0, 11_000];
  let index = 0;
  const { fetchImpl, calls } = scriptedFetch([
    mockResponse({ error: 'authorization_pending' }),
    mockResponse({ access_token: 'never' }),
  ]);

  await assert.rejects(
    pollDeviceFlow({
      clientId: 'cid',
      deviceCode: 'dc',
      expiresInSec: 10,
      fetchImpl,
      now: () => times[Math.min(index++, times.length - 1)],
      sleep: async () => {},
    }),
    (error) => {
      assert.ok(error instanceof DeviceFlowError);
      assert.equal(error.code, 'timeout');
      assert.equal(error.description, 'device code expired');
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('pollDeviceFlow respects maxWaitMs as a hard cap', async () => {
  const times = [0, 0, 600];
  let index = 0;
  const { fetchImpl, calls } = scriptedFetch([mockResponse({ error: 'authorization_pending' })]);
  const sleeps = [];

  await assert.rejects(
    pollDeviceFlow({
      clientId: 'cid',
      deviceCode: 'dc',
      maxWaitMs: 500,
      fetchImpl,
      now: () => times[Math.min(index++, times.length - 1)],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }),
    (error) => {
      assert.ok(error instanceof DeviceFlowError);
      assert.equal(error.code, 'timeout');
      assert.equal(error.description, 'max wait exceeded');
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, [5000]);
});

test('pollDeviceFlow throws aborted for an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl, calls } = scriptedFetch([mockResponse({ access_token: 'tok' })]);

  await rejectsWith(
    pollDeviceFlow({ clientId: 'cid', deviceCode: 'dc', fetchImpl, signal: controller.signal }),
    'aborted',
  );
  assert.equal(calls.length, 0);
});

test('pollDeviceFlow stops polling when aborted between attempts', async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scriptedFetch([mockResponse({ error: 'authorization_pending' })]);

  await rejectsWith(
    pollDeviceFlow({
      clientId: 'cid',
      deviceCode: 'dc',
      fetchImpl,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    }),
    'aborted',
  );
  assert.equal(calls.length, 1);
});

test('pollDeviceFlow maps an abort during fetch to aborted', async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scriptedFetch([
    () => {
      controller.abort();
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    },
  ]);

  await rejectsWith(
    pollDeviceFlow({ clientId: 'cid', deviceCode: 'dc', fetchImpl, signal: controller.signal }),
    'aborted',
  );
  assert.equal(calls.length, 1);
});

test('pollDeviceFlow maps a rejected fetch to network_error', async () => {
  const { fetchImpl } = scriptedFetch([
    () => {
      throw new Error('ECONNREFUSED');
    },
  ]);
  await assert.rejects(pollDeviceFlow({ clientId: 'cid', deviceCode: 'dc', fetchImpl }), (error) => {
    assert.ok(error instanceof DeviceFlowError);
    assert.equal(error.code, 'network_error');
    assert.match(error.message, /ECONNREFUSED/);
    return true;
  });
});

test('pollDeviceFlow rejects a success response without an access token', async () => {
  const { fetchImpl } = scriptedFetch([mockResponse({ token_type: 'bearer' })]);
  await rejectsWith(pollDeviceFlow({ clientId: 'cid', deviceCode: 'dc', fetchImpl }), 'network_error');
});

test('pollDeviceFlow requires clientId and deviceCode', async () => {
  const fetchImpl = async () => mockResponse({});
  await assert.rejects(pollDeviceFlow({ deviceCode: 'dc', fetchImpl }), /clientId/);
  await assert.rejects(pollDeviceFlow({ clientId: 'cid', fetchImpl }), /deviceCode/);
});

// ---------------------------------------------------------------------------
// fetchGitHubUser
// ---------------------------------------------------------------------------

test('fetchGitHubUser reads the user and scopes header', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    mockResponse(
      { login: 'octocat', id: 42, name: 'The Octocat' },
      { headers: { 'x-oauth-scopes': 'repo, read:user' } },
    ),
  ]);

  const user = await fetchGitHubUser({ token: 'gho_tok', fetchImpl });

  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gho_tok');
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.ok(calls[0].init.headers['User-Agent']);

  assert.deepEqual(user, {
    login: 'octocat',
    id: 42,
    name: 'The Octocat',
    scopes: ['repo', 'read:user'],
  });
});

test('fetchGitHubUser tolerates missing name, id and scopes', async () => {
  const { fetchImpl } = scriptedFetch([mockResponse({ login: 'solo' })]);
  assert.deepEqual(await fetchGitHubUser({ token: 't', fetchImpl }), {
    login: 'solo',
    id: null,
    name: null,
    scopes: [],
  });
});

test('fetchGitHubUser honours a custom apiBase', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    mockResponse({ login: 'octocat', id: 1, name: null }, { headers: { 'x-oauth-scopes': '' } }),
  ]);
  await fetchGitHubUser({ token: 't', fetchImpl, apiBase: 'http://127.0.0.1:9999/api/' });
  assert.equal(calls[0].url, 'http://127.0.0.1:9999/api/user');
});

test('fetchGitHubUser throws with the HTTP status for a rejected token', async () => {
  const { fetchImpl } = scriptedFetch([
    mockResponse({ message: 'Bad credentials' }, { status: 401 }),
  ]);
  await assert.rejects(fetchGitHubUser({ token: 'bad', fetchImpl }), (error) => {
    assert.match(error.message, /401/);
    assert.match(error.message, /Bad credentials/);
    assert.equal(error.status, 401);
    return true;
  });
});

test('fetchGitHubUser requires a token', async () => {
  await assert.rejects(fetchGitHubUser({ fetchImpl: async () => mockResponse({}) }), /token/);
});
