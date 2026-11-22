/**
 * Offline unit tests for lib/issues.js.
 *
 * Everything runs against the in-process mock GitHub server
 * (test/helpers/mock-github.js); no request ever reaches api.github.com.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitHubClient } from '../lib/github.js';
import {
  IssuesApiError,
  commentOnIssue,
  createIssue,
  getIssue,
  getPullRequest,
  listIssues,
  listPullRequests,
  listReviews,
  listWorkItems,
} from '../lib/issues.js';
import { startMockGitHub } from './helpers/mock-github.js';

const REPO = 'acme/widgets';

function makeClient(mock, options = {}) {
  return new GitHubClient({ token: 'test-token', apiBase: mock.url, ...options });
}

function matchingRequests(mock, method, pathPart) {
  return mock.requests.filter((entry) => entry.method === method && entry.path.includes(pathPart));
}

test('listIssues normalizes fields, omits bodies and excludes pull requests', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedIssue(REPO, {
    number: 1,
    title: 'Bug: crash on start',
    body: 'a body that list results must not carry',
    labels: ['bug'],
    user: { login: 'alice' },
    comments: 3,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-03T00:00:00Z',
  });
  mock.seedIssue(REPO, {
    number: 2,
    title: 'Actually a PR',
    pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/2` },
  });
  mock.updateIssue(REPO, 1, {
    assignees: [{ login: 'alice' }, { login: 'bob' }],
    updated_at: '2026-01-03T00:00:00Z',
  });

  const client = makeClient(mock);
  const items = await listIssues({ client, repo: REPO });

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    kind: 'issue',
    number: 1,
    title: 'Bug: crash on start',
    state: 'open',
    url: `https://github.com/${REPO}/issues/1`,
    author: 'alice',
    labels: ['bug'],
    assignees: ['alice', 'bob'],
    comments: 3,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-03T00:00:00Z',
    isPull: false,
  });
  assert.equal('body' in items[0], false);

  const recorded = matchingRequests(mock, 'GET', `/repos/${REPO}/issues`)[0];
  assert.equal(recorded.query.state, 'open');
  assert.equal(recorded.query.sort, 'updated');
  assert.equal(recorded.query.direction, 'desc');
  assert.equal(recorded.query.per_page, '30');
});

test('listIssues applies state, label, sort and clamped limit filters', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedIssue(REPO, {
    number: 1,
    labels: ['bug'],
    created_at: '2025-12-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  mock.seedIssue(REPO, {
    number: 2,
    state: 'closed',
    labels: ['bug', 'help wanted'],
    created_at: '2025-12-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  });
  mock.seedIssue(REPO, {
    number: 3,
    labels: ['docs'],
    created_at: '2025-12-03T00:00:00Z',
    updated_at: '2026-01-03T00:00:00Z',
  });
  mock.seedIssue(REPO, {
    number: 4,
    labels: ['bug', 'help wanted'],
    created_at: '2025-12-04T00:00:00Z',
    updated_at: '2026-01-04T00:00:00Z',
  });
  const client = makeClient(mock);

  const all = await listIssues({ client, repo: REPO, state: 'all' });
  assert.deepEqual(all.map((item) => item.number), [4, 3, 2, 1]);

  const closed = await listIssues({ client, repo: REPO, state: 'closed' });
  assert.deepEqual(closed.map((item) => item.number), [2]);
  assert.equal(closed[0].state, 'closed');

  const labelled = await listIssues({ client, repo: REPO, state: 'all', labels: 'bug,help wanted' });
  assert.deepEqual(labelled.map((item) => item.number), [4, 2]);

  const limited = await listIssues({ client, repo: REPO, limit: 2, sort: 'created' });
  assert.deepEqual(limited.map((item) => item.number), [4, 3]);

  const clampedLow = await listIssues({ client, repo: REPO, limit: 0 });
  const clampedHigh = await listIssues({ client, repo: REPO, limit: 5000 });
  assert.equal(clampedLow.length, 1);
  assert.equal(clampedHigh.length, 3);

  const recorded = matchingRequests(mock, 'GET', `/repos/${REPO}/issues`);
  assert.equal(recorded[2].query.labels, 'bug,help wanted');
  assert.equal(recorded[3].query.sort, 'created');
  assert.equal(recorded[4].query.per_page, '1');
  assert.equal(recorded[5].query.per_page, '100');

  await assert.rejects(listIssues({ client, repo: REPO, state: 'wat' }), /Invalid state/);
  await assert.rejects(listIssues({ client, repo: REPO, sort: 'age' }), /Invalid sort/);
});

test('listIssues accepts repository URLs and SSH remotes', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedIssue(REPO, { number: 1, title: 'From URL' });
  const client = makeClient(mock);

  const fromUrl = await listIssues({ client, repo: `https://github.com/${REPO}.git` });
  const fromSsh = await listIssues({ client, repo: `git@github.com:${REPO}.git` });
  assert.deepEqual(fromUrl.map((item) => item.number), [1]);
  assert.deepEqual(fromSsh.map((item) => item.number), [1]);
  assert.equal(mock.requests[0].path, `/repos/${REPO}/issues`);
  assert.equal(mock.requests[1].path, `/repos/${REPO}/issues`);
  await assert.rejects(listIssues({ client, repo: 'not-a-repo' }), /expected "owner\/name"/);
});

test('listPullRequests normalizes merged PRs, drafts and review requests', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedPull(REPO, {
    number: 1,
    title: 'Open PR',
    user: { login: 'carol' },
    head: { ref: 'feature/login' },
    base: { ref: 'main' },
    draft: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-05T00:00:00Z',
  });
  mock.seedPull(REPO, {
    number: 2,
    title: 'Merged PR',
    user: { login: 'dave' },
    state: 'closed',
    merged_at: '2026-01-06T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-06T00:00:00Z',
  });
  mock.seedPull(REPO, {
    number: 3,
    title: 'Closed, unmerged',
    state: 'closed',
    updated_at: '2026-01-02T00:00:00Z',
  });
  mock.updatePull(REPO, 1, {
    labels: [{ name: 'enhancement' }],
    assignees: [{ login: 'carol' }],
    requested_reviewers: [{ login: 'erin' }],
  });
  mock.updatePull(REPO, 2, { labels: [{ name: 'merged' }] });

  const client = makeClient(mock);
  const open = await listPullRequests({ client, repo: REPO });
  assert.equal(open.length, 1);
  assert.equal(open[0].number, 1);
  assert.equal(open[0].kind, 'pr');
  assert.equal(open[0].isPull, true);
  assert.equal(open[0].author, 'carol');
  assert.equal(open[0].draft, true);
  assert.equal(open[0].merged, false);
  assert.equal(open[0].mergedAt, null);
  assert.equal(open[0].headRef, 'feature/login');
  assert.equal(open[0].baseRef, 'main');
  assert.deepEqual(open[0].labels, ['enhancement']);
  assert.deepEqual(open[0].assignees, ['carol']);
  assert.deepEqual(open[0].requestedReviewers, ['erin']);
  assert.equal('body' in open[0], false);

  const closed = await listPullRequests({ client, repo: REPO, state: 'closed' });
  assert.deepEqual(closed.map((item) => item.number), [2, 3]);
  const merged = closed.find((item) => item.number === 2);
  assert.equal(merged.state, 'merged');
  assert.equal(merged.merged, true);
  assert.equal(merged.mergedAt, '2026-01-06T00:00:00Z');
  const unmerged = closed.find((item) => item.number === 3);
  assert.equal(unmerged.state, 'closed');
  assert.equal(unmerged.merged, false);
  assert.equal(unmerged.mergedAt, null);

  const recorded = matchingRequests(mock, 'GET', `/repos/${REPO}/pulls`)[0];
  assert.equal(recorded.query.direction, 'desc');
  assert.equal(recorded.query.per_page, '30');
  await assert.rejects(listPullRequests({ client, repo: REPO, sort: 'comments' }), /Invalid sort/);
});

test('listWorkItems merges issues and PRs sorted by updatedAt desc', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedIssue(REPO, { number: 1, title: 'old issue', updated_at: '2026-01-01T00:00:00Z' });
  mock.seedIssue(REPO, { number: 2, title: 'new issue', updated_at: '2026-01-04T00:00:00Z' });
  mock.seedPull(REPO, { number: 1, title: 'middle PR', updated_at: '2026-01-03T00:00:00Z' });
  mock.seedPull(REPO, { number: 2, title: 'older PR', updated_at: '2026-01-02T00:00:00Z' });
  const client = makeClient(mock);

  const items = await listWorkItems({ client, repo: REPO, state: 'all' });
  assert.deepEqual(
    items.map((item) => `${item.kind}:${item.number}`),
    ['issue:2', 'pr:1', 'pr:2', 'issue:1'],
  );

  const issuesOnly = await listWorkItems({ client, repo: REPO, kind: 'issue', state: 'all' });
  assert.equal(issuesOnly.length, 2);
  assert.equal(issuesOnly.every((item) => item.kind === 'issue'), true);

  const prsOnly = await listWorkItems({ client, repo: REPO, kind: 'pr', state: 'all' });
  assert.equal(prsOnly.length, 2);
  assert.equal(prsOnly.every((item) => item.kind === 'pr'), true);

  const limited = await listWorkItems({ client, repo: REPO, state: 'all', limit: 2 });
  assert.deepEqual(limited.map((item) => item.number), [2, 1]);

  await assert.rejects(listWorkItems({ client, repo: REPO, kind: 'discussion' }), /Invalid kind/);
});

test('getIssue returns the body and truncates oversized bodies', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedIssue(REPO, {
    number: 42,
    title: 'Detailed issue',
    body: 'line one\nline two',
    labels: ['docs'],
    comments: 2,
    updated_at: '2026-01-02T00:00:00Z',
  });
  mock.seedIssue(REPO, { number: 43, body: `${'x'.repeat(100 * 1024)}TAIL` });
  const client = makeClient(mock);

  const issue = await getIssue({ client, repo: REPO, number: 42 });
  assert.equal(issue.kind, 'issue');
  assert.equal(issue.number, 42);
  assert.equal(issue.title, 'Detailed issue');
  assert.equal(issue.body, 'line one\nline two');
  assert.deepEqual(issue.labels, ['docs']);
  assert.equal(issue.comments, 2);

  const huge = await getIssue({ client, repo: REPO, number: 43 });
  assert.equal(huge.body.length, 100 * 1024);
  assert.equal(huge.body.endsWith('…'), true);
  assert.equal(huge.body.includes('TAIL'), false);

  await assert.rejects(getIssue({ client, repo: REPO, number: 0 }), /positive integer/);
});

test('getPullRequest returns body plus merge and change metadata', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedPull(REPO, {
    number: 5,
    title: 'Feature',
    body: 'PR description',
    user: { login: 'frank' },
    head: { ref: 'feature/x' },
    base: { ref: 'main' },
    draft: true,
  });
  mock.updatePull(REPO, 5, {
    state: 'closed',
    merged_at: '2026-02-01T00:00:00Z',
    merged: true,
    mergeable: true,
    additions: 10,
    deletions: 3,
    changed_files: 4,
    review_comments: 2,
    labels: [{ name: 'ready' }],
    assignees: [{ login: 'frank' }],
  });
  const client = makeClient(mock);

  const pull = await getPullRequest({ client, repo: REPO, number: 5 });
  assert.equal(pull.kind, 'pr');
  assert.equal(pull.isPull, true);
  assert.equal(pull.body, 'PR description');
  assert.equal(pull.mergeable, true);
  assert.equal(pull.merged, true);
  assert.equal(pull.state, 'merged');
  assert.equal(pull.mergedAt, '2026-02-01T00:00:00Z');
  assert.equal(pull.additions, 10);
  assert.equal(pull.deletions, 3);
  assert.equal(pull.changedFiles, 4);
  assert.equal(pull.reviewComments, 2);
  assert.equal(pull.draft, true);
  assert.equal(pull.headRef, 'feature/x');
  assert.equal(pull.baseRef, 'main');
  assert.deepEqual(pull.labels, ['ready']);
  assert.deepEqual(pull.assignees, ['frank']);
  assert.equal(pull.author, 'frank');
});

test('missing issues and pull requests produce clear 404 errors', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const client = makeClient(mock);

  await assert.rejects(getIssue({ client, repo: REPO, number: 99 }), (error) => {
    assert.ok(error instanceof IssuesApiError);
    assert.ok(error instanceof Error);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'not_found');
    assert.match(error.message, /Issue #99 not found in acme\/widgets/);
    return true;
  });

  await assert.rejects(getPullRequest({ client, repo: REPO, number: 77 }), (error) => {
    assert.ok(error instanceof IssuesApiError);
    assert.equal(error.status, 404);
    assert.match(error.message, /Pull request #77 not found in acme\/widgets/);
    return true;
  });

  await assert.rejects(listReviews({ client, repo: REPO, number: 55 }), /not found in acme\/widgets/);
});

test('listReviews normalizes reviews and omits empty bodies', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedPull(REPO, { number: 3, title: 'Reviewed PR' });
  mock.seedPull(REPO, { number: 4, title: 'Unreviewed PR' });
  mock.seedReview(REPO, 3, {
    id: 11,
    state: 'APPROVED',
    user: { login: 'reviewer-one' },
    body: 'LGTM',
    submitted_at: '2026-03-01T00:00:00Z',
  });
  mock.seedReview(REPO, 3, {
    id: 12,
    state: 'CHANGES_REQUESTED',
    user: { login: 'reviewer-two' },
    body: '',
    submitted_at: '2026-03-02T00:00:00Z',
  });
  const client = makeClient(mock);

  const reviews = await listReviews({ client, repo: REPO, number: 3 });
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews[0], {
    id: 11,
    author: 'reviewer-one',
    state: 'APPROVED',
    submittedAt: '2026-03-01T00:00:00Z',
    body: 'LGTM',
  });
  assert.equal(reviews[1].state, 'CHANGES_REQUESTED');
  assert.equal(reviews[1].author, 'reviewer-two');
  assert.equal('body' in reviews[1], false);

  const empty = await listReviews({ client, repo: REPO, number: 4 });
  assert.deepEqual(empty, []);

  const recorded = matchingRequests(mock, 'GET', `/repos/${REPO}/pulls/3/reviews`)[0];
  assert.equal(recorded.query.per_page, '100');
});

test('createIssue posts the expected payload and returns a normalized issue', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  const client = makeClient(mock);

  const created = await createIssue({
    client,
    repo: REPO,
    title: '  New issue  ',
    body: 'Hello\nworld',
    labels: ['bug', 'help wanted'],
  });
  assert.equal(created.kind, 'issue');
  assert.equal(created.number, 1);
  assert.equal(created.title, 'New issue');
  assert.deepEqual(created.labels, ['bug', 'help wanted']);
  assert.equal(created.author, 'mock-user');
  assert.equal(created.state, 'open');
  assert.equal(created.isPull, false);
  assert.equal('body' in created, false);

  const posts = matchingRequests(mock, 'POST', `/repos/${REPO}/issues`);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { title: 'New issue', body: 'Hello\nworld', labels: ['bug', 'help wanted'] });

  const minimal = await createIssue({ client, repo: REPO, title: 'Only title' });
  assert.equal(minimal.number, 2);
  const minimalPost = matchingRequests(mock, 'POST', `/repos/${REPO}/issues`)[1];
  assert.deepEqual(minimalPost.body, { title: 'Only title' });

  await assert.rejects(createIssue({ client, repo: REPO, title: '   ' }), /non-empty title/);
  assert.equal(matchingRequests(mock, 'POST', `/repos/${REPO}/issues`).length, 2);
});

test('commentOnIssue posts the comment and returns id/url', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.seedIssue(REPO, { number: 7, title: 'Needs a reply' });
  const client = makeClient(mock);

  const comment = await commentOnIssue({ client, repo: REPO, number: 7, body: 'Thanks for the report!' });
  assert.equal(typeof comment.id, 'number');
  assert.match(comment.url, new RegExp(`/repos/${REPO}/issues/7|#issuecomment-`));

  const posts = matchingRequests(mock, 'POST', `/repos/${REPO}/issues/7/comments`);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { body: 'Thanks for the report!' });

  await assert.rejects(commentOnIssue({ client, repo: REPO, number: 7, body: '  ' }), /non-empty body/);
  assert.equal(matchingRequests(mock, 'POST', `/repos/${REPO}/issues/7/comments`).length, 1);
});

test('401 responses from write and read endpoints propagate as GitHubError', async (t) => {
  const mock = await startMockGitHub({ token: 'the-real-token' });
  t.after(() => mock.close());
  const client = makeClient(mock, { token: 'wrong-token' });

  await assert.rejects(createIssue({ client, repo: REPO, title: 'Denied' }), (error) => {
    assert.equal(error.name, 'GitHubError');
    assert.equal(error.status, 401);
    return true;
  });
  await assert.rejects(commentOnIssue({ client, repo: REPO, number: 1, body: 'Denied' }), (error) => {
    assert.equal(error.name, 'GitHubError');
    assert.equal(error.status, 401);
    return true;
  });
  await assert.rejects(listIssues({ client, repo: REPO }), (error) => {
    assert.equal(error.status, 401);
    return true;
  });
});

test('404 on a list endpoint is reported with a clear message', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.setHandler((info) =>
    info.method === 'GET' && info.path === `/repos/${REPO}/issues`
      ? { status: 404, body: { message: 'Not Found' } }
      : undefined,
  );
  const client = makeClient(mock);

  await assert.rejects(listIssues({ client, repo: REPO }), (error) => {
    assert.ok(error instanceof IssuesApiError);
    assert.equal(error.status, 404);
    assert.match(error.message, /was not found or is not accessible/);
    return true;
  });
});

test('partial and malformed GitHub payloads do not break listing', async (t) => {
  const mock = await startMockGitHub();
  t.after(() => mock.close());
  mock.setHandler((info) => {
    if (info.method === 'GET' && info.path === `/repos/${REPO}/pulls`) {
      return {
        status: 200,
        body: [
          {
            number: 9,
            title: 'No user, no labels, no assignees',
            state: 'open',
            merged_at: null,
            head: { ref: 'topic' },
            base: { ref: 'main' },
            comments: null,
            created_at: '2026-01-01T00:00:00Z',
          },
          { title: 'Missing number' },
          null,
          {
            number: 10,
            title: 'Merged via merged_at only',
            state: 'closed',
            merged_at: '2026-01-02T00:00:00Z',
            user: { login: 'ghost' },
            labels: null,
            assignees: null,
          },
        ],
      };
    }
    if (info.method === 'GET' && info.path === `/repos/${REPO}/issues`) {
      return { status: 200, body: { message: 'unexpected shape' } };
    }
    return undefined;
  });
  const client = makeClient(mock);

  const pulls = await listPullRequests({ client, repo: REPO, state: 'all' });
  assert.equal(pulls.length, 2);
  const bare = pulls[0];
  assert.equal(bare.number, 9);
  assert.equal(bare.author, null);
  assert.deepEqual(bare.labels, []);
  assert.deepEqual(bare.assignees, []);
  assert.deepEqual(bare.requestedReviewers, []);
  assert.equal(bare.comments, 0);
  assert.equal(bare.draft, false);
  assert.equal(bare.merged, false);
  assert.equal(bare.state, 'open');
  assert.equal(bare.updatedAt, bare.createdAt);
  assert.equal(bare.headRef, 'topic');
  assert.equal(bare.baseRef, 'main');

  const merged = pulls[1];
  assert.equal(merged.state, 'merged');
  assert.equal(merged.merged, true);
  assert.equal(merged.author, 'ghost');

  const issues = await listIssues({ client, repo: REPO });
  assert.deepEqual(issues, []);
});
