/**
 * In-process mock GitHub REST API server for fully offline tests.
 *
 * No external packages and no real network: it listens on 127.0.0.1 with a
 * random port and keeps all state in memory. Every endpoint returns JSON with
 * the status codes the real API uses for the same situation.
 *
 * Usage:
 *   import { startMockGitHub } from './helpers/mock-github.js';
 *
 *   const mock = await startMockGitHub();          // -> { url, close, requests, ... }
 *   mock.seedIssue('acme/widgets', { number: 1, title: 'Hello' });
 *   mock.seedPull('acme/widgets', { number: 1, title: 'Add feature' });
 *   mock.seedBranch('acme/widgets', { name: 'main', sha: 'deadbeef' });
 *   mock.seedReview('acme/widgets', 1, { state: 'APPROVED' });
 *
 *   const client = new GitHubClient({ token: 'test-token', apiBase: mock.url });
 *   // ... use the client or plain fetch(`${mock.url}/repos/acme/widgets/issues`)
 *
 *   mock.requests   // [{ method, path, query, headers, body, status }, ...]
 *   await mock.close();
 *
 * Options:
 *   token                enforce `Authorization: Bearer <token>` (401 otherwise)
 *   handler(info, state) custom override; return { status?, body?, headers? }
 *                        (or nothing) to bypass the default routing
 *   rateLimitRemaining   value reported in x-ratelimit-remaining (default 5000)
 *
 * Implemented endpoints:
 *   GET       /repos/:owner/:name
 *   GET|POST  /repos/:owner/:name/issues
 *   GET|PATCH /repos/:owner/:name/issues/:number
 *   GET|POST  /repos/:owner/:name/issues/:number/comments
 *   GET|POST  /repos/:owner/:name/labels
 *   DELETE    /repos/:owner/:name/labels/:name
 *   GET|POST  /repos/:owner/:name/pulls
 *   GET       /repos/:owner/:name/pulls/:number
 *   GET|POST  /repos/:owner/:name/pulls/:number/reviews
 *   GET       /repos/:owner/:name/branches
 *   GET       /rate_limit
 */
import crypto from 'node:crypto';
import http from 'node:http';

const INVALID_BODY = Symbol('invalid-body');

function nowIso() {
  return new Date().toISOString();
}

function randomSha() {
  return crypto.createHash('sha1').update(`mock-sha-${crypto.randomUUID()}`).digest('hex');
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Normalize labels from strings, objects or a comma separated string. */
function normalizeLabels(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(',');
  return list
    .map((label) => {
      if (typeof label === 'string') return { name: label.trim(), color: 'ededed', description: null };
      if (label && typeof label === 'object' && label.name) {
        return { name: String(label.name), color: label.color ?? 'ededed', description: label.description ?? null };
      }
      return null;
    })
    .filter((label) => label && label.name.length > 0);
}

function normalizeUser(user) {
  if (!user) return { login: 'mock-user', id: 1, type: 'User' };
  if (typeof user === 'string') return { login: user, id: 1, type: 'User' };
  return { login: String(user.login ?? 'mock-user'), id: user.id ?? 1, type: user.type ?? 'User' };
}

function filterByState(items, query) {
  const state = query.state ?? 'open';
  if (state === 'all') return items.slice();
  return items.filter((item) => item.state === state);
}

function sortItems(items, query) {
  const sort = query.sort;
  if (!sort) return items.slice();
  const direction = query.direction === 'asc' ? 1 : -1;
  const keyOf = (item) => {
    if (sort === 'updated') return Date.parse(item.updated_at ?? item.created_at ?? 0) || 0;
    if (sort === 'created') return Date.parse(item.created_at ?? 0) || 0;
    if (sort === 'comments') return item.comments ?? 0;
    return 0;
  };
  return items.slice().sort((a, b) => direction * (keyOf(a) - keyOf(b)));
}

function paginate(items, query) {
  const perPage = Math.max(1, toNumber(query.per_page, 30));
  const page = Math.max(1, toNumber(query.page, 1));
  return items.slice((page - 1) * perPage, page * perPage);
}

function matchesLabels(items, query) {
  if (!query.labels) return items;
  const wanted = String(query.labels)
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  if (wanted.length === 0) return items;
  return items.filter((item) => {
    const names = new Set((item.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)));
    return wanted.every((name) => names.has(name));
  });
}

/**
 * Start the mock server.
 * @param {{ token?: string, handler?: Function, rateLimitRemaining?: number }} [options]
 * @returns {Promise<object>} handle with { url, close, requests, state, seeds... }
 */
export async function startMockGitHub(options = {}) {
  const state = { repos: new Map() };
  const requests = [];
  let customHandler = options.handler ?? null;
  let shaCounter = 0;

  function rateHeaders() {
    return {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': String(toNumber(options.rateLimitRemaining, 5000)),
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'x-ratelimit-used': '0',
      'x-ratelimit-resource': 'core',
    };
  }

  function createRepoState() {
    return {
      issues: [],
      pulls: [],
      reviews: new Map(), // prNumber -> review[]
      comments: new Map(), // issue|pr number -> comment[]
      labels: [],
      branches: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextReviewId: 1,
      nextCommentId: 1,
    };
  }

  function ensureRepo(repo) {
    let repoState = state.repos.get(repo);
    if (!repoState) {
      repoState = createRepoState();
      state.repos.set(repo, repoState);
    }
    return repoState;
  }

  function send(res, entry, status, body, extraHeaders = {}) {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      ...rateHeaders(),
      ...extraHeaders,
    };
    entry.status = status;
    if (status === 204 || body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    headers['content-length'] = Buffer.byteLength(payload);
    res.writeHead(status, headers);
    res.end(payload);
  }

  function notFound(res, entry) {
    send(res, entry, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return { value: undefined, raw: '' };
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return { value: undefined, raw };
    try {
      return { value: JSON.parse(raw), raw };
    } catch {
      return { value: INVALID_BODY, raw };
    }
  }

  function handleIssues(repoState, repo, method, segments, body, query, res, entry) {
    if (segments.length === 1) {
      if (method === 'GET') {
        let items = filterByState(repoState.issues, query);
        items = matchesLabels(items, query);
        items = sortItems(items, query);
        send(res, entry, 200, paginate(items, query));
        return true;
      }
      if (method === 'POST') {
        if (!body || typeof body !== 'object') {
          send(res, entry, 400, { message: 'Invalid issue payload' });
          return true;
        }
        const number = repoState.nextIssueNumber++;
        const at = nowIso();
        const issue = {
          id: 100000 + number,
          number,
          title: String(body.title ?? ''),
          body: String(body.body ?? ''),
          state: 'open',
          labels: normalizeLabels(body.labels),
          user: normalizeUser(body.user),
          assignee: body.assignee ? normalizeUser(body.assignee) : null,
          comments: 0,
          created_at: at,
          updated_at: at,
          html_url: `https://github.com/${repo}/issues/${number}`,
        };
        repoState.issues.push(issue);
        send(res, entry, 201, issue);
        return true;
      }
      return false;
    }
    if (segments.length >= 2) {
      const number = Number(segments[1]);
      const issue = repoState.issues.find((item) => item.number === number);
      if (segments.length === 2) {
        if (!issue) {
          notFound(res, entry);
          return true;
        }
        if (method === 'GET') {
          send(res, entry, 200, issue);
          return true;
        }
        if (method === 'PATCH') {
          const patch = body ?? {};
          if (patch.title !== undefined) issue.title = String(patch.title);
          if (patch.body !== undefined) issue.body = String(patch.body);
          if (patch.labels !== undefined) issue.labels = normalizeLabels(patch.labels);
          if (patch.assignee !== undefined) issue.assignee = patch.assignee ? normalizeUser(patch.assignee) : null;
          if (patch.state !== undefined) {
            issue.state = String(patch.state);
            issue.closed_at = issue.state === 'closed' ? nowIso() : null;
          }
          issue.updated_at = patch.updated_at ?? nowIso();
          send(res, entry, 200, issue);
          return true;
        }
        return false;
      }
      if (segments[2] === 'comments') {
        if (!issue) {
          notFound(res, entry);
          return true;
        }
        const list = repoState.comments.get(number) ?? [];
        if (segments.length === 3) {
          if (method === 'GET') {
            send(res, entry, 200, list);
            return true;
          }
          if (method === 'POST') {
            const comment = {
              id: repoState.nextCommentId++,
              body: String(body?.body ?? ''),
              user: normalizeUser(body?.user),
              created_at: nowIso(),
              updated_at: nowIso(),
              html_url: `https://github.com/${repo}/issues/${number}#issuecomment-${repoState.nextCommentId}`,
            };
            list.push(comment);
            repoState.comments.set(number, list);
            issue.comments = list.length;
            issue.updated_at = nowIso();
            send(res, entry, 201, comment);
            return true;
          }
        }
      }
    }
    return false;
  }

  function handlePulls(repoState, repo, method, segments, body, query, res, entry) {
    if (segments.length === 1) {
      if (method === 'GET') {
        let items = filterByState(repoState.pulls, query);
        items = sortItems(items, query);
        send(res, entry, 200, paginate(items, query));
        return true;
      }
      if (method === 'POST') {
        if (!body || typeof body !== 'object') {
          send(res, entry, 400, { message: 'Invalid pull payload' });
          return true;
        }
        const number = repoState.nextPullNumber++;
        const at = nowIso();
        const pull = {
          id: 200000 + number,
          number,
          title: String(body.title ?? ''),
          body: String(body.body ?? ''),
          state: 'open',
          merged_at: null,
          merged: false,
          user: normalizeUser(body.user),
          head: { ref: String(body.head ?? 'feature'), sha: randomSha(), label: 'mock:feature' },
          base: { ref: String(body.base ?? 'main'), sha: randomSha() },
          draft: Boolean(body.draft),
          created_at: at,
          updated_at: at,
          html_url: `https://github.com/${repo}/pull/${number}`,
        };
        repoState.pulls.push(pull);
        send(res, entry, 201, pull);
        return true;
      }
      return false;
    }
    const number = Number(segments[1]);
    const pull = repoState.pulls.find((item) => item.number === number);
    if (segments.length === 2) {
      if (method === 'GET') {
        if (!pull) {
          notFound(res, entry);
          return true;
        }
        send(res, entry, 200, pull);
        return true;
      }
      return false;
    }
    if (segments[2] === 'reviews') {
      const list = repoState.reviews.get(number) ?? [];
      if (segments.length === 3) {
        if (method === 'GET') {
          if (!pull && list.length === 0) {
            notFound(res, entry);
            return true;
          }
          send(res, entry, 200, list);
          return true;
        }
        if (method === 'POST') {
          if (!pull) {
            notFound(res, entry);
            return true;
          }
          const event = String(body?.event ?? '').toUpperCase();
          const stateName =
            body?.state ??
            (event === 'APPROVE' ? 'APPROVED' : event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED');
          const review = {
            id: repoState.nextReviewId++,
            user: normalizeUser(body?.user),
            body: String(body?.body ?? ''),
            state: stateName,
            submitted_at: nowIso(),
            html_url: `https://github.com/${repo}/pull/${number}#pullrequestreview-${repoState.nextReviewId}`,
          };
          list.push(review);
          repoState.reviews.set(number, list);
          pull.updated_at = nowIso();
          send(res, entry, 201, review);
          return true;
        }
      }
    }
    return false;
  }

  function handleLabels(repoState, method, segments, body, res, entry) {
    if (segments.length === 1) {
      if (method === 'GET') {
        send(res, entry, 200, repoState.labels.slice());
        return true;
      }
      if (method === 'POST') {
        const name = String(body?.name ?? '').trim();
        if (!name) {
          send(res, entry, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'missing_field', field: 'name' }] });
          return true;
        }
        const existing = repoState.labels.find((label) => label.name === name);
        if (existing) {
          send(res, entry, 200, existing);
          return true;
        }
        const label = { name, color: body?.color ?? 'ededed', description: body?.description ?? null };
        repoState.labels.push(label);
        send(res, entry, 201, label);
        return true;
      }
      return false;
    }
    if (segments.length === 2 && method === 'DELETE') {
      const name = String(segments[1]);
      const index = repoState.labels.findIndex((label) => label.name === name);
      if (index >= 0) repoState.labels.splice(index, 1);
      send(res, entry, 204);
      return true;
    }
    return false;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = String(req.method ?? 'GET').toUpperCase();
    const pathname = url.pathname;
    const query = {};
    for (const [key, value] of url.searchParams) {
      query[key] = value;
    }
    const { value: body, raw } = await readBody(req);
    const entry = {
      method,
      path: pathname,
      url: req.url,
      query,
      headers: req.headers,
      body,
      rawBody: raw,
      status: 0,
    };
    requests.push(entry);

    if (body === INVALID_BODY) {
      send(res, entry, 400, { message: 'Problems parsing JSON' });
      return;
    }
    if (options.token) {
      const authorization = String(req.headers.authorization ?? '');
      const valid = authorization === `Bearer ${options.token}` || authorization === `token ${options.token}`;
      if (!valid) {
        send(res, entry, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
        return;
      }
    }
    if (customHandler) {
      const override = await customHandler(
        { method, path: pathname, url, query, headers: req.headers, body, rawBody: raw, state },
        state,
      );
      if (override) {
        send(res, entry, override.status ?? 200, override.body, override.headers ?? {});
        return;
      }
    }

    if (method === 'GET' && pathname === '/rate_limit') {
      send(res, entry, 200, {
        resources: { core: { limit: 5000, remaining: toNumber(options.rateLimitRemaining, 5000), reset: Math.floor(Date.now() / 1000) + 3600, used: 0 } },
        rate: { limit: 5000, remaining: toNumber(options.rateLimitRemaining, 5000), reset: Math.floor(Date.now() / 1000) + 3600, used: 0 },
      });
      return;
    }
    if (method === 'GET' && pathname === '/') {
      send(res, entry, 200, { message: 'mock GitHub API' });
      return;
    }

    const repoMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!repoMatch) {
      notFound(res, entry);
      return;
    }
    const owner = decodeURIComponent(repoMatch[1]);
    const name = decodeURIComponent(repoMatch[2]);
    const repo = `${owner}/${name}`;
    const segments = (repoMatch[3] ?? '')
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    const repoState = ensureRepo(repo);

    if (segments.length === 0) {
      if (method === 'GET') {
        send(res, entry, 200, {
          id: 1,
          name,
          full_name: repo,
          owner: { login: owner, type: 'User' },
          private: false,
          default_branch: 'main',
          html_url: `https://github.com/${repo}`,
        });
        return;
      }
      notFound(res, entry);
      return;
    }

    const handlers = {
      issues: () => handleIssues(repoState, repo, method, segments, body, query, res, entry),
      pulls: () => handlePulls(repoState, repo, method, segments, body, query, res, entry),
      labels: () => handleLabels(repoState, method, segments, body, res, entry),
      branches: () => {
        if (segments.length !== 1) return false;
        if (method === 'GET') {
          send(res, entry, 200, paginate(repoState.branches, query));
          return true;
        }
        return false;
      },
    };
    const handler = handlers[segments[0]];
    if (handler && handler()) return;
    notFound(res, entry);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const entry = requests[requests.length - 1];
      if (entry && entry.status === 0) entry.status = 500;
      try {
        send(res, entry ?? { status: 0 }, 500, { message: error instanceof Error ? error.message : String(error) });
      } catch {
        res.destroy();
      }
    });
  });
  server.keepAliveTimeout = 1000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  function seedIssue(repo, input = {}) {
    const repoState = ensureRepo(repo);
    const number = toNumber(input.number, repoState.nextIssueNumber);
    repoState.nextIssueNumber = Math.max(repoState.nextIssueNumber, number + 1);
    const at = input.created_at ?? nowIso();
    const issue = {
      id: 100000 + number,
      number,
      title: String(input.title ?? `Issue ${number}`),
      body: String(input.body ?? ''),
      state: input.state ?? 'open',
      labels: normalizeLabels(input.labels),
      user: normalizeUser(input.user),
      assignee: input.assignee ? normalizeUser(input.assignee) : null,
      comments: input.comments ?? 0,
      created_at: at,
      updated_at: input.updated_at ?? at,
      html_url: input.html_url ?? `https://github.com/${repo}/issues/${number}`,
    };
    if (input.pull_request) issue.pull_request = input.pull_request;
    repoState.issues.push(issue);
    return issue;
  }

  function seedPull(repo, input = {}) {
    const repoState = ensureRepo(repo);
    const number = toNumber(input.number, repoState.nextPullNumber);
    repoState.nextPullNumber = Math.max(repoState.nextPullNumber, number + 1);
    const at = input.created_at ?? nowIso();
    const head = input.head ?? {};
    const base = input.base ?? {};
    const pull = {
      id: 200000 + number,
      number,
      title: String(input.title ?? `Pull ${number}`),
      body: String(input.body ?? ''),
      state: input.state ?? 'open',
      merged_at: input.merged_at ?? null,
      merged: Boolean(input.merged_at),
      user: normalizeUser(input.user),
      head: { ref: String(head.ref ?? 'feature'), sha: String(head.sha ?? randomSha()), label: head.label ?? 'mock:feature' },
      base: { ref: String(base.ref ?? 'main'), sha: String(base.sha ?? randomSha()) },
      draft: Boolean(input.draft),
      created_at: at,
      updated_at: input.updated_at ?? at,
      html_url: input.html_url ?? `https://github.com/${repo}/pull/${number}`,
    };
    repoState.pulls.push(pull);
    return pull;
  }

  function seedBranch(repo, input = {}) {
    const repoState = ensureRepo(repo);
    const name = input.name ?? input.branch;
    if (!name) throw new Error('seedBranch requires a branch name');
    shaCounter += 1;
    const sha = String(input.sha ?? input.commit?.sha ?? crypto.createHash('sha1').update(`mock-sha-${shaCounter}`).digest('hex'));
    const branch = {
      name: String(name),
      commit: { sha, url: `https://api.github.com/repos/${repo}/commits/${sha}` },
      protected: Boolean(input.protected),
    };
    const index = repoState.branches.findIndex((item) => item.name === branch.name);
    if (index >= 0) repoState.branches[index] = branch;
    else repoState.branches.push(branch);
    return branch;
  }

  function seedReview(repo, prNumber, input = {}) {
    const repoState = ensureRepo(repo);
    const number = Number(prNumber);
    const id = toNumber(input.id, repoState.nextReviewId);
    repoState.nextReviewId = Math.max(repoState.nextReviewId, id + 1);
    const review = {
      id,
      node_id: `PRR_${id}`,
      user: normalizeUser(input.user ?? { login: 'reviewer' }),
      body: String(input.body ?? ''),
      state: input.state ?? 'COMMENTED',
      submitted_at: input.submitted_at ?? nowIso(),
      html_url: input.html_url ?? `https://github.com/${repo}/pull/${number}#pullrequestreview-${id}`,
    };
    const list = repoState.reviews.get(number) ?? [];
    list.push(review);
    repoState.reviews.set(number, list);
    return review;
  }

  function seedLabel(repo, input = {}) {
    const repoState = ensureRepo(repo);
    const label = typeof input === 'string'
      ? { name: input, color: 'ededed', description: null }
      : { name: String(input.name ?? ''), color: input.color ?? 'ededed', description: input.description ?? null };
    if (!label.name) throw new Error('seedLabel requires a name');
    if (!repoState.labels.some((item) => item.name === label.name)) repoState.labels.push(label);
    return label;
  }

  function seedComment(repo, number, input = {}) {
    const repoState = ensureRepo(repo);
    const key = Number(number);
    const comment = {
      id: repoState.nextCommentId++,
      body: String(input.body ?? ''),
      user: normalizeUser(input.user),
      created_at: input.created_at ?? nowIso(),
      updated_at: input.created_at ?? nowIso(),
      html_url: `https://github.com/${repo}/issues/${key}#issuecomment-${repoState.nextCommentId}`,
    };
    const list = repoState.comments.get(key) ?? [];
    list.push(comment);
    repoState.comments.set(key, list);
    const issue = repoState.issues.find((item) => item.number === key);
    if (issue) issue.comments = list.length;
    return comment;
  }

  function updateIssue(repo, number, patch = {}) {
    const repoState = ensureRepo(repo);
    const issue = repoState.issues.find((item) => item.number === Number(number));
    if (!issue) throw new Error(`No mock issue #${number} in ${repo}`);
    Object.assign(issue, patch);
    issue.updated_at = patch.updated_at ?? nowIso();
    return issue;
  }

  function updatePull(repo, number, patch = {}) {
    const repoState = ensureRepo(repo);
    const pull = repoState.pulls.find((item) => item.number === Number(number));
    if (!pull) throw new Error(`No mock pull #${number} in ${repo}`);
    Object.assign(pull, patch);
    pull.updated_at = patch.updated_at ?? nowIso();
    return pull;
  }

  async function close() {
    if (!server.listening) return;
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    await closed;
  }

  return {
    url,
    baseUrl: url,
    port,
    server,
    state,
    requests,
    repoState: (repo) => ensureRepo(repo),
    seedIssue,
    seedPull,
    seedBranch,
    seedReview,
    seedLabel,
    seedComment,
    updateIssue,
    updatePull,
    setHandler(fn) {
      customHandler = fn;
    },
    reset() {
      state.repos.clear();
      requests.length = 0;
      customHandler = options.handler ?? null;
    },
    close,
  };
}
