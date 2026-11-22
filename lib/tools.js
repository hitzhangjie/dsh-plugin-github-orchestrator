/**
 * Agent-facing tools. Every tool is a thin, explicit orchestration layer over
 * the Git engine, the GitHub client, the event inbox and the storyboard.
 *
 * Design rules:
 * - Destructive Git operations happen only through an explicit action; merge
 *   and cleanup report what they did, and dry-run where it matters.
 * - Publishing to GitHub (issue create/update/close, push) is best effort: a
 *   failed publication becomes a warning, the local task/worktree state stays
 *   authoritative.
 * - Expected workflow conditions (rebase conflict, dirty repository) return
 *   `{ ok: false, ... }` instead of throwing; invalid arguments throw.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseRepoSpec, repoDirOf, worktreePathOf } from './config.js';
import {
  isGitRepo,
  repoStatus,
  fetchAll,
  cloneRepo,
  resolveDefaultBranch,
  aheadBehind,
  gitOk,
  deleteBranch,
  listWorktrees,
  pruneWorktrees,
  rebaseAbort,
  rebaseContinue,
} from './git.js';
import { createTaskWorktree, removeTaskWorktree, listTaskWorktrees, rebaseWorktree, mergeTaskBranch } from './worktrees.js';
import { slugify, shortHash, splitLines } from './util.js';
import {
  listIssues,
  listPullRequests,
  listWorkItems,
  getIssue,
  getPullRequest,
  listReviews,
  createIssue,
  commentOnIssue,
} from './issues.js';

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  },
};

function definition(schema) {
  return { ...schema, output: OUTPUT };
}

function fail(message, extra = {}) {
  return { ok: false, error: message, ...extra };
}

function requireString(args, name) {
  const value = args?.[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`"${name}" is required`);
  }
  return value.trim();
}

function optionalString(args, name) {
  const value = args?.[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function boolArg(args, name, fallback) {
  const value = args?.[name];
  return typeof value === 'boolean' ? value : fallback;
}

function numberArg(args, name) {
  const value = args?.[name];
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`"${name}" must be a number`);
  return parsed;
}

function stringArray(args, name) {
  const value = args?.[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`"${name}" must be an array of strings`);
  return value.map((item) => String(item)).filter((item) => item.length > 0);
}

function repoPlain(spec) {
  const plain = { repo: spec.repo, local: spec.local };
  if (spec.baseBranch) plain.baseBranch = spec.baseBranch;
  if (spec.issueLabel) plain.issueLabel = spec.issueLabel;
  return plain;
}

/** @param {object} runtime @param {string|undefined} ref */
function resolveRepo(runtime, ref) {
  const config = runtime.getConfig();
  if (!ref) {
    if (config.repos.length === 1) return config.repos[0];
    if (config.repos.length === 0) {
      throw new Error('No repositories configured. Use github_repos action=add first.');
    }
    throw new Error(`"repo" is required when more than one repository is configured: ${config.repos.map((s) => s.repo).join(', ')}`);
  }
  const text = String(ref).trim();
  const spec = config.repos.find(
    (entry) => entry.repo === text || entry.local === text || entry.name === text || entry.repo.toLowerCase() === text.toLowerCase(),
  );
  if (!spec) {
    throw new Error(`Repository "${text}" is not configured. Configured: ${config.repos.map((s) => s.repo).join(', ') || '(none)'}`);
  }
  return spec;
}

function repoDirFor(runtime, spec) {
  return repoDirOf(runtime.getConfig(), spec);
}

async function assertCloned(runtime, spec) {
  const dir = repoDirFor(runtime, spec);
  if (!fs.existsSync(dir) || !(await isGitRepo(dir))) {
    throw new Error(`Repository ${spec.repo} is not cloned at ${dir}. Use github_repos action=clone.`);
  }
  return dir;
}

async function ensureCloned(runtime, spec) {
  const config = runtime.getConfig();
  const dir = repoDirFor(runtime, spec);
  if (fs.existsSync(dir) && (await isGitRepo(dir))) {
    return { dir, cloned: false };
  }
  fs.mkdirSync(config.workspaceRoot, { recursive: true });
  await cloneRepo({ url: `https://github.com/${spec.repo}.git`, dir, gitBinary: config.gitBinary });
  return { dir, cloned: true };
}

function effectiveBase(runtime, spec, task, requested) {
  const config = runtime.getConfig();
  return requested || task?.baseBranch || spec.baseBranch || config.defaultBaseBranch;
}

async function worktreeOfTask(runtime, task) {
  if (!task) return undefined;
  if (task.worktreePath) return task.worktreePath;
  const spec = resolveRepo(runtime, task.repo);
  return worktreePathOf(runtime.getConfig(), spec, task.id);
}

function collectWarnings() {
  const warnings = [];
  return {
    warnings,
    capture(error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    },
  };
}

/** The worktree list includes the clone's own working tree; tools expose only task worktrees. */
function onlyTaskWorktrees(config, worktrees) {
  const root = path.resolve(config.workspaceRoot, config.worktreesSubdir);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return worktrees.filter((worktree) => {
    if (worktree.taskId) return true;
    const resolved = path.resolve(String(worktree.path ?? '')).toLowerCase();
    return resolved.startsWith(prefix.toLowerCase());
  });
}

/**
 * Remove a task worktree and force-delete its branch. Used only after the
 * caller proved the branch is merged: `git branch -d` refuses when the branch
 * has an upstream that does not contain the local merge commit.
 */
async function removeMergedWorktree({ repoDir, worktreePath, branch, remote, gitBinary, forceWorktree = false }) {
  const removal = await removeTaskWorktree({
    repoDir,
    worktreePath,
    force: forceWorktree,
    deleteBranch: false,
    branch,
    gitBinary,
  });
  const warnings = [...(removal.warnings ?? [])];
  let branchDeleted = false;
  let remoteDeleted = false;
  if (removal.removed && branch) {
    try {
      const deleted = await deleteBranch(repoDir, branch, {
        force: true,
        remote: remote ?? false,
        gitBinary,
      });
      branchDeleted = deleted.deleted;
      remoteDeleted = deleted.remoteDeleted;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { ...removal, branchDeleted, remoteDeleted, warnings };
}

async function syncEpicSafe(runtime, repo, sink) {
  try {
    return await runtime.storyboard.syncEpic(repo);
  } catch (error) {
    if (sink) sink.capture(error);
    return undefined;
  }
}

async function updateIssueSafe(runtime, task, sink) {
  if (!task?.issueNumber) return undefined;
  try {
    return await runtime.storyboard.updateTaskIssue(task);
  } catch (error) {
    if (sink) sink.capture(error);
    return undefined;
  }
}

function configSummary(runtime) {
  const config = runtime.getConfig();
  const token = runtime.tokenInfo();
  const status = runtime.pollerStatus();
  return {
    ok: true,
    workspaceRoot: config.workspaceRoot,
    workspaceExists: fs.existsSync(config.workspaceRoot),
    stateDir: config.stateDir,
    repos: config.repos.map(repoPlain),
    pollIntervalSec: config.pollIntervalSec,
    defaultBaseBranch: config.defaultBaseBranch,
    branchPrefix: config.branchPrefix,
    remote: config.remote,
    gitBinary: config.gitBinary,
    githubApiBase: config.githubApiBase,
    oauthClientId: config.oauthClientId || null,
    oauthScopes: config.oauthScopes,
    token: { available: token.hasToken, source: token.source },
    auth: runtime.oauthStatus ? runtime.oauthStatus() : null,
    web: runtime.webStatus ? runtime.webStatus() : null,
    autoDispatch: {
      enabled: config.autoDispatch,
      kinds: config.autoDispatchKinds,
      minIntervalSec: config.autoDispatchMinIntervalSec,
      maxEvents: config.autoDispatchMaxEvents,
      createTasks: config.autoDispatchCreateTasks,
      taskStatus: config.autoDispatchTaskStatus,
      agentPreset: config.autoDispatchAgentPreset || null,
      sessionId: config.autoDispatchSessionId || null,
    },
    dispatch: runtime.dispatchStatus ? runtime.dispatchStatus() : null,
    poller: status,
    taskCounts: runtime.tasks.stats(),
  };
}

/** @param {object} runtime */
export function createToolDefinitions(runtime) {
  const tools = [];

  tools.push(
    definition({
      name: 'github_config',
      description:
        'Show or change the GitHub orchestrator runtime settings. The plugin runs against one workspace directory that holds repository clones and generated Git worktrees. action=show returns the effective configuration, GitHub token status, OAuth client id and automation state. action=set persists overrides for workspaceRoot, pollIntervalSec, defaultBaseBranch, branchPrefix, remote, gitBinary, oauthClientId, oauthScopes and the autoDispatch* automation fields without restarting the plugin; the workspace directory is created if missing.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'set'], description: 'show (default) or set.' },
          workspaceRoot: { type: 'string', description: 'Absolute directory for clones and worktrees.' },
          pollIntervalSec: { type: 'number', description: 'GitHub polling interval in seconds (15-3600).' },
          defaultBaseBranch: { type: 'string', description: 'Base branch used when a repository has none configured.' },
          branchPrefix: { type: 'string', description: 'Prefix for task branches, e.g. "task/".' },
          remote: { type: 'string', description: 'Git remote name, default "origin".' },
          gitBinary: { type: 'string', description: 'Git executable name or absolute path.' },
          oauthClientId: { type: 'string', description: 'OAuth App client id for device-flow sign-in; empty uses GITHUB_OAUTH_CLIENT_ID or the built-in fallback.' },
          oauthScopes: { type: 'string', description: 'OAuth scopes for device-flow sign-in, default "repo read:user".' },
          autoDispatch: { type: 'boolean', description: 'Enable always-on automatic dispatch of new GitHub events into agent work.' },
          autoDispatchKinds: {
            type: 'array',
            items: { type: 'string', enum: ['issue', 'pr', 'review', 'push', 'comment'] },
            description: 'Event kinds that may trigger automatic dispatch.',
          },
          autoDispatchMinIntervalSec: { type: 'number', description: 'Minimum seconds between automatic dispatches (30-3600).' },
          autoDispatchMaxEvents: { type: 'number', description: 'Maximum events bundled into one dispatch prompt (1-20).' },
          autoDispatchCreateTasks: { type: 'boolean', description: 'Create a local storyboard task for every dispatched event.' },
          autoDispatchTaskStatus: {
            type: 'string',
            enum: ['backlog', 'ready', 'in_progress', 'review', 'done'],
            description: 'Status of auto-created tasks.',
          },
          autoDispatchAgentPreset: { type: 'string', description: 'Agent preset mounted into the watcher session, e.g. "standard" or "cordis"; empty uses the registry default.' },
          autoDispatchSessionId: { type: 'string', description: 'Watcher session id (normally managed by the dispatcher).' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = optionalString(args, 'action') ?? 'show';
        if (action === 'show') return configSummary(runtime);
        if (action !== 'set') throw new Error(`Unknown action "${action}"`);

        const patch = {};
        for (const key of [
          'workspaceRoot',
          'defaultBaseBranch',
          'branchPrefix',
          'remote',
          'gitBinary',
          'oauthClientId',
          'oauthScopes',
          'autoDispatchSessionId',
          'autoDispatchTaskStatus',
          'autoDispatchAgentPreset',
        ]) {
          const value = optionalString(args, key);
          if (value !== undefined) patch[key] = value;
        }
        const interval = numberArg(args, 'pollIntervalSec');
        if (interval !== undefined) patch.pollIntervalSec = interval;
        for (const key of ['autoDispatch', 'autoDispatchCreateTasks']) {
          if (typeof args?.[key] === 'boolean') patch[key] = args[key];
        }
        for (const key of ['autoDispatchMinIntervalSec', 'autoDispatchMaxEvents']) {
          const value = numberArg(args, key);
          if (value !== undefined) patch[key] = value;
        }
        if (Array.isArray(args?.autoDispatchKinds)) {
          patch.autoDispatchKinds = args.autoDispatchKinds.map((item) => String(item));
        }
        if (Object.keys(patch).length === 0) {
          throw new Error('action=set needs at least one setting');
        }
        if (patch.workspaceRoot) {
          fs.mkdirSync(patch.workspaceRoot, { recursive: true });
        }
        runtime.updateSettings(patch);
        return configSummary(runtime);
      },
    }),
  );

  tools.push(
    definition({
      name: 'github_auth',
      description:
        'Sign in to GitHub with the OAuth device flow, without SSH keys or a personal credential helper. action=status shows whether a token is resolved, where it came from, the OAuth client id in use and any pending sign-in. action=start begins the device flow and returns a user code plus verification URI; the human opens the URI, enters the code on GitHub and approves the requested scopes. action=poll waits for that approval (up to timeoutSec) and stores the token in the Harness credentials service, after which private HTTPS clones/fetches/pushes and GitHub issue writes work. action=cancel abandons a pending sign-in; action=logout deletes the stored credential. Tokens are never returned in tool output.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'start', 'poll', 'cancel', 'logout'], description: 'Operation to perform.' },
          scopes: { type: 'string', description: 'Space-separated OAuth scopes for action=start (default from config, normally "repo read:user").' },
          clientId: { type: 'string', description: 'OAuth App client id override for action=start.' },
          timeoutSec: { type: 'number', description: 'action=poll: how long to wait for approval (default 120, max 900).' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = optionalString(args, 'action') ?? 'status';
        if (typeof runtime.oauthStatus !== 'function') throw new Error('OAuth support is not available in this plugin instance');
        if (action === 'status') return { ok: true, ...runtime.oauthStatus() };
        if (action === 'start') {
          const result = await runtime.oauthStart({
            scopes: optionalString(args, 'scopes'),
            clientId: optionalString(args, 'clientId'),
          });
          return {
            ok: true,
            ...result,
            hint: `Open ${result.verificationUri} and enter ${result.userCode}, approve the requested scopes, then call github_auth action=poll.`,
          };
        }
        if (action === 'poll') {
          const timeoutSec = Math.min(900, Math.max(5, numberArg(args, 'timeoutSec') ?? 120));
          const result = await runtime.oauthPoll({ timeoutSec });
          return { ok: result.authenticated === true, ...result };
        }
        if (action === 'cancel') {
          runtime.oauthCancel();
          return { ok: true, cancelled: true, ...runtime.oauthStatus() };
        }
        if (action === 'logout') {
          const result = await runtime.oauthLogout();
          return { ok: true, ...result, ...runtime.oauthStatus() };
        }
        throw new Error(`Unknown action "${action}"`);
      },
    }),
  );

  tools.push(
    definition({
      name: 'github_dispatch',
      description:
        'Control the always-on GitHub event dispatcher and its persistent watcher session. action=status reports whether automation is enabled, the watcher session id, last dispatch time/count and the last error. action=tick runs one dispatch pass over unread GitHub events now (this is what the background automation timer calls). action=send posts free-form text to the watcher session, which is how a chat-triggered task reaches the same always-on agent. Automatic dispatch turns new issue/PR/review events into local storyboard tasks and sends an instruction prompt to the watcher session so it starts working without the human asking.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'tick', 'send'], description: 'Operation to perform.' },
          text: { type: 'string', description: 'action=send: prompt text for the watcher session.' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = optionalString(args, 'action') ?? 'status';
        if (typeof runtime.dispatchStatus !== 'function') throw new Error('The event dispatcher is not available in this plugin instance');
        if (action === 'status') return { ok: true, ...runtime.dispatchStatus() };
        if (action === 'tick') {
          const result = await runtime.dispatchTick();
          return { ok: true, ...result };
        }
        if (action === 'send') {
          const text = requireString(args, 'text');
          const result = await runtime.dispatchSend(text);
          return { ok: true, ...result };
        }
        throw new Error(`Unknown action "${action}"`);
      },
    }),
  );

  tools.push(
    definition({
      name: 'github_repos',
      description:
        'Manage the watched GitHub repositories and their local clones. action=list shows each configured repository with clone state, base branch and worktree/task counts. action=add|remove persists watch configuration (it never deletes files). action=clone clones into the workspace directory (or fetches when already cloned), action=fetch updates all configured clones, action=status inspects one repository including dirty files and ahead/behind counts against its remote base branch.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove', 'clone', 'fetch', 'status'], description: 'Operation to perform.' },
          repo: { type: 'string', description: 'Repository as "owner/name" (or its local directory name). Optional when one repository is configured.' },
          local: { type: 'string', description: 'Local directory name under workspaceRoot for action=add.' },
          baseBranch: { type: 'string', description: 'Base branch override for action=add.' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = optionalString(args, 'action') ?? 'list';
        const config = runtime.getConfig();

        if (action === 'list') {
          const repos = [];
          for (const spec of config.repos) {
            const dir = repoDirOf(config, spec);
            const entry = {
              repo: spec.repo,
              local: spec.local,
              dir,
              baseBranch: spec.baseBranch ?? config.defaultBaseBranch,
              cloned: false,
            };
            if (fs.existsSync(dir) && (await isGitRepo(dir))) {
              entry.cloned = true;
              try {
                const status = await repoStatus(dir, { gitBinary: config.gitBinary });
                entry.currentBranch = status.branch;
                entry.dirty = status.dirty;
                const base = spec.baseBranch ?? (await resolveDefaultBranch(dir, { remote: config.remote, gitBinary: config.gitBinary }));
                entry.baseBranch = base;
                entry.aheadBehind = await aheadBehind(dir, `${config.remote}/${base}`, 'HEAD', { gitBinary: config.gitBinary }).catch(() => null);
              } catch (error) {
                entry.error = error instanceof Error ? error.message : String(error);
              }
              try {
                entry.worktrees = onlyTaskWorktrees(config, await listTaskWorktrees(dir, { gitBinary: config.gitBinary })).length;
              } catch {
                entry.worktrees = null;
              }
            }
            entry.activeTasks = runtime.tasks.list({ repo: spec.repo, includeClosed: false }).length;
            const watermark = runtime.pollerStatus().watermarks?.[spec.repo];
            entry.lastPollAt = watermark?.lastPollAt ?? null;
            repos.push(entry);
          }
          return { ok: true, workspaceRoot: config.workspaceRoot, repos };
        }

        if (action === 'add') {
          const repo = requireString(args, 'repo');
          if (config.repos.some((spec) => spec.repo === repo)) {
            throw new Error(`Repository ${repo} is already configured`);
          }
          const spec = parseRepoSpec({ repo, local: optionalString(args, 'local'), baseBranch: optionalString(args, 'baseBranch') });
          runtime.updateSettings({ repos: [...config.repos.map(repoPlain), repoPlain(spec)] });
          return { ok: true, added: repoPlain(spec), repos: runtime.getConfig().repos.map(repoPlain) };
        }

        if (action === 'remove') {
          const spec = resolveRepo(runtime, requireString(args, 'repo'));
          runtime.updateSettings({
            repos: config.repos.filter((entry) => entry.repo !== spec.repo).map(repoPlain),
          });
          return { ok: true, removed: spec.repo, repos: runtime.getConfig().repos.map(repoPlain) };
        }

        if (action === 'clone') {
          const spec = resolveRepo(runtime, optionalString(args, 'repo'));
          const result = await ensureCloned(runtime, spec);
          let defaultBranch = null;
          try {
            defaultBranch = await resolveDefaultBranch(result.dir, { remote: runtime.getConfig().remote, gitBinary: runtime.getConfig().gitBinary });
          } catch {
            /* a repository without origin/HEAD still clones fine */
          }
          return { ok: true, repo: spec.repo, dir: result.dir, cloned: result.cloned, defaultBranch };
        }

        if (action === 'fetch') {
          const only = optionalString(args, 'repo');
          const specs = only ? [resolveRepo(runtime, only)] : config.repos;
          if (specs.length === 0) throw new Error('No repositories configured');
          const results = [];
          for (const spec of specs) {
            try {
              const dir = await assertCloned(runtime, spec);
              const fetched = await fetchAll(dir, { remote: config.remote, prune: true, gitBinary: config.gitBinary });
              results.push({ repo: spec.repo, dir, ...fetched });
            } catch (error) {
              results.push({ repo: spec.repo, error: error instanceof Error ? error.message : String(error) });
            }
          }
          return { ok: results.every((entry) => !entry.error), repos: results };
        }

        if (action === 'status') {
          const spec = resolveRepo(runtime, optionalString(args, 'repo'));
          const dir = await assertCloned(runtime, spec);
          const status = await repoStatus(dir, { gitBinary: config.gitBinary });
          const base = spec.baseBranch ?? (await resolveDefaultBranch(dir, { remote: config.remote, gitBinary: config.gitBinary }));
          const diff = await aheadBehind(dir, `${config.remote}/${base}`, 'HEAD', { gitBinary: config.gitBinary });
          const worktrees = onlyTaskWorktrees(config, await listTaskWorktrees(dir, { gitBinary: config.gitBinary }));
          return { ok: true, repo: spec.repo, dir, baseBranch: base, status, aheadOfBase: diff.behind, behindBase: diff.ahead, worktrees };
        }

        throw new Error(`Unknown action "${action}"`);
      },
    }),
  );

  tools.push(
    definition({
      name: 'github_issues',
      description:
        'List, inspect and update GitHub issues and pull requests. action=list returns open/closed issues or pull requests (compact normalized fields, no bodies); action=show returns one issue or pull request with its body and, for pull requests, its reviews; action=create opens a new issue; action=comment posts a comment. Use this when you need the current backlog (not just event deltas) before choosing what to work on.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show', 'create', 'comment'], description: 'Operation to perform.' },
          repo: { type: 'string', description: 'Configured repository "owner/name".' },
          kind: { type: 'string', enum: ['all', 'issue', 'pr'], description: 'action=list: item kind (default all).' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'action=list: state filter (default open).' },
          number: { type: 'number', description: 'Issue or pull request number for show/comment.' },
          title: { type: 'string', description: 'action=create: issue title.' },
          body: { type: 'string', description: 'action=create/comment: markdown body.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'action=list/create: label filter or labels for the new issue.' },
          limit: { type: 'number', description: 'Maximum items (default 30, max 100).' },
          sort: { type: 'string', description: 'Sort field: updated|created|comments.' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = optionalString(args, 'action') ?? 'list';
        const spec = resolveRepo(runtime, optionalString(args, 'repo'));
        const client = runtime.client;
        const labels = args?.labels === undefined ? undefined : stringArray(args, 'labels');
        const limit = Math.min(100, Math.max(1, numberArg(args, 'limit') ?? 30));
        const state = optionalString(args, 'state') ?? 'open';
        if (action === 'list') {
          const kind = optionalString(args, 'kind') ?? 'all';
          const sort = optionalString(args, 'sort');
          let items;
          if (kind === 'issue') {
            items = await listIssues({ client, repo: spec.repo, state, limit, labels, sort });
          } else if (kind === 'pr') {
            // GitHub's pull list sort vocabulary differs from the issue list.
            const prSort = sort === 'created' || sort === 'popularity' ? sort : 'updated';
            items = await listPullRequests({ client, repo: spec.repo, state, limit, sort: prSort });
          } else {
            items = await listWorkItems({ client, repo: spec.repo, kind: 'all', state, limit });
          }
          return { ok: true, repo: spec.repo, kind, state, count: items.length, items };
        }
        if (action === 'show') {
          const number = numberArg(args, 'number');
          if (!number) throw new Error('"number" is required');
          const kind = optionalString(args, 'kind');
          if (kind === 'pr') {
            const pull = await getPullRequest({ client, repo: spec.repo, number });
            const reviews = await listReviews({ client, repo: spec.repo, number }).catch(() => []);
            return { ok: true, repo: spec.repo, item: { ...pull, reviews } };
          }
          if (kind === 'issue') {
            return { ok: true, repo: spec.repo, item: await getIssue({ client, repo: spec.repo, number }) };
          }
          try {
            const pull = await getPullRequest({ client, repo: spec.repo, number });
            const reviews = await listReviews({ client, repo: spec.repo, number }).catch(() => []);
            return { ok: true, repo: spec.repo, item: { ...pull, reviews } };
          } catch (error) {
            if (error?.status !== 404) throw error;
            return { ok: true, repo: spec.repo, item: await getIssue({ client, repo: spec.repo, number }) };
          }
        }
        if (action === 'create') {
          if (!runtime.tokenInfo().hasToken) throw new Error('A GitHub token is required to create issues');
          const title = requireString(args, 'title');
          const item = await createIssue({
            client,
            repo: spec.repo,
            title,
            body: optionalString(args, 'body'),
            labels,
          });
          return { ok: true, repo: spec.repo, item };
        }
        if (action === 'comment') {
          if (!runtime.tokenInfo().hasToken) throw new Error('A GitHub token is required to comment on issues');
          const number = numberArg(args, 'number');
          if (!number) throw new Error('"number" is required');
          const body = requireString(args, 'body');
          const comment = await commentOnIssue({ client, repo: spec.repo, number, body });
          return { ok: true, repo: spec.repo, number, comment };
        }
        throw new Error(`Unknown action "${action}"`);
      },
    }),
  );

  tools.push(
    definition({
      name: 'github_events',
      description:
        'Read and control the GitHub event inbox. The plugin polls watched repositories for opened/updated/closed issues, pull requests (including merged), reviews and branch pushes. action=list returns normalized events newest first; action=poll forces an immediate poll; action=mark marks events read; action=stats returns unread counts; action=watch shows poller state and per-repository watermarks. Use this to follow up review requests, failing CI pushes or new issues.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'poll', 'mark', 'stats', 'watch'], description: 'Operation to perform.' },
          repo: { type: 'string', description: 'Limit to one configured repository.' },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: ['issue', 'pr', 'review', 'push', 'comment'] },
            description: 'Event kinds for action=list.',
          },
          unreadOnly: { type: 'boolean', description: 'Only unread events for action=list.' },
          limit: { type: 'number', description: 'Maximum events to return (default 30, max 200).' },
          since: { type: 'string', description: 'ISO timestamp lower bound for action=list.' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Event ids for action=mark.' },
          all: { type: 'boolean', description: 'action=mark: mark every event (optionally limited by repo).' },
          baseline: { type: 'boolean', description: 'action=poll: emit baseline events for existing open issues/PRs.' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = optionalString(args, 'action') ?? 'list';
        if (action === 'list') {
          const repo = optionalString(args, 'repo');
          const spec = repo ? resolveRepo(runtime, repo) : undefined;
          const events = runtime.events.list({
            repo: spec?.repo,
            kinds: stringArray(args, 'kinds'),
            unreadOnly: args?.unreadOnly === true,
            since: optionalString(args, 'since'),
            limit: Math.min(200, Math.max(1, numberArg(args, 'limit') ?? 30)),
          });
          // Annotate events with the task they most plausibly belong to, so the
          // model can jump from an upstream review/push straight to the storyboard.
          const tasks = runtime.tasks.list({ includeClosed: true });
          const byBranch = new Map();
          const byNumber = new Map();
          for (const task of tasks) {
            if (task.branch) byBranch.set(task.branch, task.id);
            if (task.issueNumber) byNumber.set(task.issueNumber, task.id);
            if (task.prNumber) byNumber.set(task.prNumber, task.id);
          }
          const linked = events.map((event) => {
            const taskId = event.taskId ?? (event.branch ? byBranch.get(event.branch) : undefined) ?? byNumber.get(event.number);
            return taskId ? { ...event, taskId } : event;
          });
          return { ok: true, count: linked.length, events: linked, stats: runtime.events.stats() };
        }
        if (action === 'poll') {
          const repo = optionalString(args, 'repo');
          const spec = repo ? resolveRepo(runtime, repo) : undefined;
          const result = await runtime.poller.pollOnce({ repo: spec?.repo, baseline: args?.baseline });
          return { ok: result.errors.length === 0, ...result };
        }
        if (action === 'mark') {
          const repo = optionalString(args, 'repo');
          const spec = repo ? resolveRepo(runtime, repo) : undefined;
          const ids = stringArray(args, 'ids');
          const count = runtime.events.markRead(ids, { all: args?.all === true, repo: spec?.repo });
          return { ok: true, marked: count, stats: runtime.events.stats() };
        }
        if (action === 'stats') {
          return { ok: true, ...runtime.events.stats() };
        }
        if (action === 'watch') {
          return { ok: true, ...runtime.pollerStatus(), repos: runtime.getConfig().repos.map(repoPlain) };
        }
        throw new Error(`Unknown action "${action}"`);
      },
    }),
  );

  tools.push(
    definition({
      name: 'github_tasks',
      description:
        'Storyboard memory for project work, stored locally and mirrored to GitHub issues. A task owns a branch, an optional worktree and an optional issue. action=create creates a task (and a GitHub issue unless createIssue=false); action=list|show inspect tasks; action=update changes status/fields or appends a note; action=close finishes a task and closes its issue; action=sync republishes one task or a repository storyboard; action=import adopts existing issues labelled as storyboard tasks; action=bootstrap creates the repository epic issue and imports issues. Statuses: backlog, ready, in_progress, review, done.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'show', 'update', 'close', 'sync', 'import', 'bootstrap'], description: 'Operation to perform.' },
          id: { type: 'string', description: 'Task id such as T1.' },
          repo: { type: 'string', description: 'Configured repository "owner/name".' },
          title: { type: 'string', description: 'Task title.' },
          description: { type: 'string', description: 'Task description / goal.' },
          status: { type: 'string', enum: ['backlog', 'ready', 'in_progress', 'review', 'done'], description: 'Task status.' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Task priority.' },
          branch: { type: 'string', description: 'Explicit branch name (default task/<id>-<slug>).' },
          baseBranch: { type: 'string', description: 'Base branch for this task.' },
          prNumber: { type: 'number', description: 'Associated pull request number.' },
          note: { type: 'string', description: 'Progress note appended to the task timeline.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags.' },
          createIssue: { type: 'boolean', description: 'action=create: mirror the task to a GitHub issue (default true when a token exists).' },
          closeIssue: { type: 'boolean', description: 'action=close: close the mirrored issue (default true).' },
          label: { type: 'string', description: 'action=import: issue label to import (default gos:task).' },
          limit: { type: 'number', description: 'action=import: maximum issues to import (default 50).' },
          includeClosed: { type: 'boolean', description: 'action=list: include done tasks.' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = optionalString(args, 'action') ?? 'list';
        const config = runtime.getConfig();

        if (action === 'create') {
          const spec = resolveRepo(runtime, optionalString(args, 'repo'));
          const title = requireString(args, 'title');
          const nextId = runtime.tasks.nextTaskId();
          const branch = optionalString(args, 'branch') ?? `${config.branchPrefix}${nextId}-${slugify(title)}`;
          const task = runtime.tasks.create({
            repo: spec.repo,
            title,
            description: optionalString(args, 'description'),
            status: optionalString(args, 'status') ?? 'ready',
            priority: optionalString(args, 'priority') ?? 'normal',
            branch,
            baseBranch: effectiveBase(runtime, spec, undefined, optionalString(args, 'baseBranch')),
            tags: stringArray(args, 'tags') ?? [],
            prNumber: numberArg(args, 'prNumber'),
          });

          const sink = collectWarnings();
          const wantsIssue = args?.createIssue !== false;
          if (wantsIssue && !runtime.tokenInfo().hasToken) {
            sink.capture('No GitHub token resolved: task created without a GitHub issue.');
          } else if (wantsIssue) {
            try {
              const issue = await runtime.storyboard.createTaskIssue(spec.repo, task);
              runtime.tasks.update(task.id, { issueNumber: issue.number, issueUrl: issue.url });
            } catch (error) {
              sink.capture(error);
            }
            await syncEpicSafe(runtime, spec.repo, sink);
          }
          return { ok: true, task: runtime.tasks.get(task.id), warnings: sink.warnings };
        }

        if (action === 'list') {
          const repo = optionalString(args, 'repo');
          const spec = repo ? resolveRepo(runtime, repo) : undefined;
          const tasks = runtime.tasks.list({
            repo: spec?.repo,
            status: optionalString(args, 'status'),
            includeClosed: args?.includeClosed === true,
          });
          return { ok: true, count: tasks.length, tasks, stats: runtime.tasks.stats() };
        }

        if (action === 'show') {
          const task = runtime.tasks.get(requireString(args, 'id'));
          if (!task) throw new Error(`Task ${requireString(args, 'id')} not found`);
          return { ok: true, task };
        }

        if (action === 'update') {
          const id = requireString(args, 'id');
          const current = runtime.tasks.get(id);
          if (!current) throw new Error(`Task ${id} not found`);
          const patch = {};
          for (const key of ['title', 'description', 'status', 'priority', 'branch', 'baseBranch']) {
            const value = optionalString(args, key);
            if (value !== undefined) patch[key] = value;
          }
          const prNumber = numberArg(args, 'prNumber');
          if (prNumber !== undefined) patch.prNumber = prNumber;
          const tags = stringArray(args, 'tags');
          if (tags !== undefined) patch.tags = tags;
          const note = optionalString(args, 'note');
          if (note !== undefined) patch.note = note;
          if (Object.keys(patch).length === 0) throw new Error('action=update needs at least one field');

          const statusChanged = patch.status !== undefined && patch.status !== current.status;
          const task = runtime.tasks.update(id, patch);
          const sink = collectWarnings();
          await updateIssueSafe(runtime, task, sink);
          if (statusChanged) {
            const spec = resolveRepo(runtime, task.repo);
            await syncEpicSafe(runtime, spec.repo, sink);
          }
          return { ok: true, task: runtime.tasks.get(id), warnings: sink.warnings };
        }

        if (action === 'close') {
          const id = requireString(args, 'id');
          const current = runtime.tasks.get(id);
          if (!current) throw new Error(`Task ${id} not found`);
          const note = optionalString(args, 'note');
          const task = runtime.tasks.close(id, note ? { note } : {});
          const sink = collectWarnings();
          if (task.issueNumber && args?.closeIssue !== false) {
            try {
              await runtime.storyboard.closeTaskIssue(task, note);
            } catch (error) {
              sink.capture(error);
            }
          }
          const spec = resolveRepo(runtime, task.repo);
          await syncEpicSafe(runtime, spec.repo, sink);
          return { ok: true, task: runtime.tasks.get(id), warnings: sink.warnings };
        }

        if (action === 'sync') {
          const id = optionalString(args, 'id');
          const sink = collectWarnings();
          if (id) {
            const task = runtime.tasks.get(id);
            if (!task) throw new Error(`Task ${id} not found`);
            const result = await runtime.storyboard.syncTask(task);
            const spec = resolveRepo(runtime, task.repo);
            await syncEpicSafe(runtime, spec.repo, sink);
            return { ok: true, task, synced: result, warnings: sink.warnings };
          }
          const repo = optionalString(args, 'repo');
          const specs = repo ? [resolveRepo(runtime, repo)] : config.repos;
          const repos = [];
          for (const spec of specs) {
            try {
              const epic = await runtime.storyboard.syncEpic(spec.repo);
              repos.push({ repo: spec.repo, epic });
            } catch (error) {
              repos.push({ repo: spec.repo, error: error instanceof Error ? error.message : String(error) });
            }
          }
          return { ok: repos.every((entry) => !entry.error), repos, warnings: sink.warnings };
        }

        if (action === 'import') {
          const spec = resolveRepo(runtime, optionalString(args, 'repo'));
          const result = await runtime.storyboard.importIssues(spec.repo, {
            label: optionalString(args, 'label'),
            limit: numberArg(args, 'limit') ?? 50,
          });
          const sink = collectWarnings();
          await syncEpicSafe(runtime, spec.repo, sink);
          return { ok: true, repo: spec.repo, ...result, warnings: sink.warnings };
        }

        if (action === 'bootstrap') {
          const spec = resolveRepo(runtime, optionalString(args, 'repo'));
          const result = await runtime.storyboard.bootstrap(spec.repo);
          return { ok: true, repo: spec.repo, ...result };
        }

        throw new Error(`Unknown action "${action}"`);
      },
    }),
  );

  tools.push(
    definition({
      name: 'git_worktree',
      description:
        'Create, inspect and remove Git worktrees so several tasks can run concurrently in the same clone. action=create adds a worktree with its own task branch based on the remote base branch (fetch first by default); action=list shows every task worktree with branch, HEAD and dirty state; action=remove deletes a worktree (and optionally its branch); action=prune cleans stale worktree registrations. Worktrees live under <workspaceRoot>/.worktrees.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'remove', 'prune'], description: 'Operation to perform.' },
          repo: { type: 'string', description: 'Configured repository "owner/name".' },
          task: { type: 'string', description: 'Task id that owns the worktree.' },
          branch: { type: 'string', description: 'Branch name, required when no task is given.' },
          base: { type: 'string', description: 'Base branch override (default from task/repository).' },
          from: { type: 'string', description: 'Git revision to create the branch from (default <remote>/<base>).' },
          path: { type: 'string', description: 'Explicit absolute worktree path (default derived from workspace root).' },
          fetch: { type: 'boolean', description: 'Fetch the remote before creating (default true).' },
          createBranch: { type: 'boolean', description: 'Create the branch, false to check out an existing branch (default true).' },
          force: { type: 'boolean', description: 'Force worktree removal even with local modifications.' },
          deleteBranch: { type: 'boolean', description: 'action=remove: delete the local branch after removing the worktree.' },
          deleteRemoteBranch: { type: 'boolean', description: 'action=remove: also delete the branch on the remote.' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = optionalString(args, 'action') ?? 'list';
        const config = runtime.getConfig();

        if (action === 'create') {
          const taskId = optionalString(args, 'task');
          const task = taskId ? runtime.tasks.get(taskId) : undefined;
          if (taskId && !task) throw new Error(`Task ${taskId} not found`);
          const spec = resolveRepo(runtime, optionalString(args, 'repo') ?? task?.repo);
          const dir = await assertCloned(runtime, spec);
          const branch = optionalString(args, 'branch') ?? task?.branch;
          if (!branch) throw new Error('"branch" is required when no task is given');
          const baseBranch = effectiveBase(runtime, spec, task, optionalString(args, 'base'));
          if (args?.fetch !== false) {
            await fetchAll(dir, { remote: config.remote, gitBinary: config.gitBinary });
          }
          const createBranch = args?.createBranch !== false;
          const from = optionalString(args, 'from') ?? `${config.remote}/${baseBranch}`;
          const worktreePath =
            optionalString(args, 'path') ??
            (task
              ? worktreePathOf(config, spec, task.id)
              : path.resolve(config.workspaceRoot, config.worktreesSubdir, `${spec.local}__${slugify(branch, 30)}-${shortHash(branch, 4)}`));
          if (fs.existsSync(worktreePath)) {
            throw new Error(`Worktree path already exists: ${worktreePath}`);
          }
          const created = await createTaskWorktree({
            repoDir: dir,
            worktreePath,
            branch,
            baseBranch,
            remote: config.remote,
            createBranch,
            from,
            gitBinary: config.gitBinary,
          });
          if (task) {
            runtime.tasks.update(task.id, {
              worktreePath: created.worktreePath,
              status: task.status === 'done' ? 'done' : 'in_progress',
            });
            const sink = collectWarnings();
            await updateIssueSafe(runtime, runtime.tasks.get(task.id), sink);
            return { ok: true, ...created, task: runtime.tasks.get(task.id), warnings: sink.warnings };
          }
          return { ok: true, ...created };
        }

        if (action === 'list') {
          const only = optionalString(args, 'repo');
          const specs = only ? [resolveRepo(runtime, only)] : config.repos;
          const repos = [];
          for (const spec of specs) {
            const dir = repoDirOf(config, spec);
            if (!fs.existsSync(dir) || !(await isGitRepo(dir))) {
              repos.push({ repo: spec.repo, dir, cloned: false, worktrees: [] });
              continue;
            }
            const worktrees = onlyTaskWorktrees(config, await listTaskWorktrees(dir, { gitBinary: config.gitBinary }));
            const tasks = runtime.tasks.list({ repo: spec.repo, includeClosed: true });
            for (const worktree of worktrees) {
              const task = tasks.find(
                (entry) => entry.worktreePath === worktree.path || (worktree.taskId && entry.id === worktree.taskId),
              );
              worktree.task = task ? { id: task.id, title: task.title, status: task.status } : null;
            }
            repos.push({ repo: spec.repo, dir, cloned: true, worktrees });
          }
          return { ok: true, repos };
        }

        if (action === 'remove') {
          const taskId = optionalString(args, 'task');
          const task = taskId ? runtime.tasks.get(taskId) : undefined;
          if (taskId && !task) throw new Error(`Task ${taskId} not found`);
          const spec = resolveRepo(runtime, optionalString(args, 'repo') ?? task?.repo);
          const dir = await assertCloned(runtime, spec);
          const worktreePath = optionalString(args, 'path') ?? task?.worktreePath;
          if (!worktreePath) {
            throw new Error('A task with a recorded worktree or an explicit "path" is required');
          }
          const branch = optionalString(args, 'branch') ?? task?.branch;
          const result = await removeTaskWorktree({
            repoDir: dir,
            worktreePath,
            force: args?.force === true,
            deleteBranch: args?.deleteBranch === true,
            branch,
            remote: args?.deleteRemoteBranch === true ? config.remote : undefined,
            gitBinary: config.gitBinary,
          });
          if (task && result.removed) {
            runtime.tasks.update(task.id, { worktreePath: null });
          }
          return { ok: true, ...result };
        }

        if (action === 'prune') {
          const spec = resolveRepo(runtime, optionalString(args, 'repo'));
          const dir = await assertCloned(runtime, spec);
          await pruneWorktrees(dir, { gitBinary: config.gitBinary });
          return { ok: true, repo: spec.repo, dir, pruned: true };
        }

        throw new Error(`Unknown action "${action}"`);
      },
    }),
  );

  tools.push(
    definition({
      name: 'git_sync',
      description:
        'Keep task branches current and land finished work. action=rebase fetches the remote and rebases a task worktree onto <remote>/<base> (conflicts are reported, never forced); action=rebase_continue|rebase_abort resolves the rebase state; action=merge merges a task branch into its base branch in the main clone, optionally pushes, then removes the worktree, deletes the branch, closes the task issue and updates the storyboard; action=cleanup removes worktrees and deletes branches already merged into the remote base branch (dryRun supported); action=status reports ahead/behind/dirty state for the clone and its worktrees; action=fetch updates the configured remote for one repository.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['fetch', 'rebase', 'rebase_continue', 'rebase_abort', 'merge', 'cleanup', 'status'], description: 'Operation to perform.' },
          repo: { type: 'string', description: 'Configured repository "owner/name".' },
          task: { type: 'string', description: 'Task id. Recommended for rebase and merge.' },
          branch: { type: 'string', description: 'Branch name when no task is given.' },
          base: { type: 'string', description: 'Base branch override.' },
          worktreePath: { type: 'string', description: 'Explicit worktree path when no task is given.' },
          push: { type: 'boolean', description: 'action=merge: push the base branch after merging (default false).' },
          cleanup: { type: 'boolean', description: 'action=merge: remove the worktree and delete the branch after merging (default true).' },
          closeIssue: { type: 'boolean', description: 'action=merge: close the task issue (default true).' },
          message: { type: 'string', description: 'Merge commit message override.' },
          dryRun: { type: 'boolean', description: 'action=cleanup: only report what would be removed.' },
          closeTasks: { type: 'boolean', description: 'action=cleanup: also mark cleaned-up tasks done and close their issues (default false).' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = optionalString(args, 'action') ?? 'status';
        const config = runtime.getConfig();

        const resolveWorktree = async () => {
          const taskId = optionalString(args, 'task');
          if (taskId) {
            const task = runtime.tasks.get(taskId);
            if (!task) throw new Error(`Task ${taskId} not found`);
            const spec = resolveRepo(runtime, task.repo);
            const worktreePath = await worktreeOfTask(runtime, task);
            return { task, spec, worktreePath, baseBranch: effectiveBase(runtime, spec, task, optionalString(args, 'base')) };
          }
          const spec = resolveRepo(runtime, optionalString(args, 'repo'));
          const worktreePath = optionalString(args, 'worktreePath');
          const branch = optionalString(args, 'branch');
          if (!worktreePath) throw new Error('Provide "task" or "worktreePath"');
          return { task: undefined, spec, worktreePath, baseBranch: effectiveBase(runtime, spec, undefined, optionalString(args, 'base')), branch };
        };

        if (action === 'fetch') {
          const spec = resolveRepo(runtime, optionalString(args, 'repo'));
          const dir = await assertCloned(runtime, spec);
          return { ok: true, repo: spec.repo, ...(await fetchAll(dir, { remote: config.remote, prune: true, gitBinary: config.gitBinary })) };
        }

        if (action === 'rebase') {
          const { task, spec, worktreePath, baseBranch } = await resolveWorktree();
          if (!fs.existsSync(worktreePath)) {
            throw new Error(`Worktree not found: ${worktreePath}. Recreate it with git_worktree action=create.`);
          }
          const dir = await assertCloned(runtime, spec);
          await fetchAll(dir, { remote: config.remote, gitBinary: config.gitBinary });
          const result = await rebaseWorktree({
            worktreePath,
            repoDir: dir,
            baseBranch,
            remote: config.remote,
            gitBinary: config.gitBinary,
          });
          if (task) {
            runtime.tasks.update(task.id, {
              note: result.ok
                ? `Rebased ${task.branch} onto ${config.remote}/${baseBranch}${result.upToDate ? ' (already up to date)' : ''}`
                : `Rebase onto ${config.remote}/${baseBranch} stopped with ${result.conflicted.length} conflicted file(s)`,
            });
          }
          if (!result.ok) {
            return {
              ok: false,
              repo: spec.repo,
              worktreePath,
              baseBranch,
              conflicted: result.conflicted,
              hint: 'Resolve the conflicted files in the worktree, git add them, then call git_sync action=rebase_continue; or call action=rebase_abort.',
            };
          }
          const diff = await aheadBehind(worktreePath, 'HEAD', `${config.remote}/${baseBranch}`, { gitBinary: config.gitBinary });
          return { ok: true, repo: spec.repo, worktreePath, baseBranch, ...result, aheadOfBase: diff.ahead, behindBase: diff.behind };
        }

        if (action === 'rebase_continue' || action === 'rebase_abort') {
          const { task, spec, worktreePath, baseBranch } = await resolveWorktree();
          if (!fs.existsSync(worktreePath)) throw new Error(`Worktree not found: ${worktreePath}`);
          if (action === 'rebase_abort') {
            await rebaseAbort(worktreePath, { gitBinary: config.gitBinary });
            if (task) runtime.tasks.update(task.id, { note: `Rebase onto ${config.remote}/${baseBranch} aborted` });
            return { ok: true, repo: spec.repo, worktreePath, aborted: true };
          }
          const result = await rebaseContinue(worktreePath, { gitBinary: config.gitBinary });
          if (task && result.ok) {
            runtime.tasks.update(task.id, { note: `Rebase onto ${config.remote}/${baseBranch} continued to completion` });
          }
          return { ok: result.ok, repo: spec.repo, worktreePath, ...result };
        }

        if (action === 'merge') {
          const taskId = optionalString(args, 'task');
          const task = taskId ? runtime.tasks.get(taskId) : undefined;
          if (taskId && !task) throw new Error(`Task ${taskId} not found`);
          const spec = resolveRepo(runtime, optionalString(args, 'repo') ?? task?.repo);
          const dir = await assertCloned(runtime, spec);
          const branch = optionalString(args, 'branch') ?? task?.branch;
          if (!branch) throw new Error('"branch" or a task with a branch is required');
          const baseBranch = effectiveBase(runtime, spec, task, optionalString(args, 'base'));
          await fetchAll(dir, { remote: config.remote, gitBinary: config.gitBinary });
          const result = await mergeTaskBranch({
            repoDir: dir,
            branch,
            baseBranch,
            remote: config.remote,
            push: args?.push === true,
            noFf: true,
            message: optionalString(args, 'message'),
            gitBinary: config.gitBinary,
          });
          if (!result.merged) {
            return {
              ok: false,
              repo: spec.repo,
              branch,
              baseBranch,
              conflicted: result.conflicted,
              hint: 'Merge conflict in the main clone. Resolve it there manually or abort with git merge --abort; the task worktree and branch are untouched.',
            };
          }
          const sink = collectWarnings();
          let cleanupResult;
          if (args?.cleanup !== false) {
            const worktreePath = task ? await worktreeOfTask(runtime, task) : undefined;
            if (worktreePath && fs.existsSync(worktreePath)) {
              try {
                cleanupResult = await removeMergedWorktree({
                  repoDir: dir,
                  worktreePath,
                  branch,
                  gitBinary: config.gitBinary,
                });
              } catch (error) {
                sink.capture(error);
              }
            } else {
              try {
                await gitOk(['branch', '-D', branch], { cwd: dir, gitBinary: config.gitBinary });
                cleanupResult = { removed: false, branchDeleted: true };
              } catch (error) {
                sink.capture(error);
              }
            }
          }
          if (task) {
            runtime.tasks.update(task.id, {
              status: 'done',
              worktreePath: null,
              note: `Merged ${branch} into ${baseBranch} at ${result.commit}`,
            });
            if (task.issueNumber && args?.closeIssue !== false) {
              try {
                await runtime.storyboard.closeTaskIssue(runtime.tasks.get(task.id), `Merged into \`${baseBranch}\` at ${result.commit}.`);
              } catch (error) {
                sink.capture(error);
              }
            }
            await syncEpicSafe(runtime, spec.repo, sink);
          }
          return {
            ok: true,
            repo: spec.repo,
            branch,
            baseBranch,
            ...result,
            cleanup: cleanupResult,
            task: task ? runtime.tasks.get(task.id) : undefined,
            warnings: sink.warnings,
          };
        }

        if (action === 'cleanup') {
          const only = optionalString(args, 'repo');
          const specs = only ? [resolveRepo(runtime, only)] : config.repos;
          const dryRun = args?.dryRun === true;
          const repos = [];
          for (const spec of specs) {
            const dir = repoDirOf(config, spec);
            if (!fs.existsSync(dir) || !(await isGitRepo(dir))) {
              repos.push({ repo: spec.repo, skipped: 'not cloned' });
              continue;
            }
            try {
              await fetchAll(dir, { remote: config.remote, gitBinary: config.gitBinary });
              const baseBranch = spec.baseBranch ?? (await resolveDefaultBranch(dir, { remote: config.remote, gitBinary: config.gitBinary }));
              const mergedRaw = await gitOk(
                ['branch', '--format=%(refname:short)', '--merged', `${config.remote}/${baseBranch}`],
                { cwd: dir, gitBinary: config.gitBinary },
              );
              const merged = new Set(splitLines(mergedRaw));
              const worktrees = onlyTaskWorktrees(config, await listTaskWorktrees(dir, { gitBinary: config.gitBinary }));
              const tasks = runtime.tasks.list({ repo: spec.repo, includeClosed: true });
              const removed = [];
              for (const worktree of worktrees) {
                if (!worktree.branch || !merged.has(worktree.branch)) continue;
                const task = tasks.find(
                  (entry) => entry.worktreePath === worktree.path || (worktree.taskId && entry.id === worktree.taskId),
                );
                removed.push({ path: worktree.path, branch: worktree.branch, dirty: worktree.dirty, task: task?.id ?? null });
                if (dryRun) continue;
                if (worktree.dirty) {
                  removed[removed.length - 1].skipped = 'dirty worktree';
                  continue;
                }
                await removeMergedWorktree({
                  repoDir: dir,
                  worktreePath: worktree.path,
                  branch: worktree.branch,
                  gitBinary: config.gitBinary,
                });
                if (task) {
                  if (args?.closeTasks === true) {
                    runtime.tasks.close(task.id, { note: `Cleanup: branch ${worktree.branch} was already merged into ${baseBranch}` });
                    try {
                      await runtime.storyboard.closeTaskIssue(runtime.tasks.get(task.id), `Cleanup: merged into \`${baseBranch}\`.`);
                    } catch {
                      /* best effort */
                    }
                  } else {
                    runtime.tasks.update(task.id, { worktreePath: null, note: `Cleanup removed merged worktree for ${worktree.branch}` });
                  }
                }
              }
              if (!dryRun) await pruneWorktrees(dir, { gitBinary: config.gitBinary });
              if (!dryRun) await syncEpicSafe(runtime, spec.repo, collectWarnings());
              repos.push({ repo: spec.repo, baseBranch, removed, pruned: !dryRun });
            } catch (error) {
              repos.push({ repo: spec.repo, error: error instanceof Error ? error.message : String(error) });
            }
          }
          return { ok: repos.every((entry) => !entry.error), dryRun, repos };
        }

        if (action === 'status') {
          const only = optionalString(args, 'repo');
          const specs = only ? [resolveRepo(runtime, only)] : config.repos;
          const repos = [];
          for (const spec of specs) {
            const dir = repoDirOf(config, spec);
            if (!fs.existsSync(dir) || !(await isGitRepo(dir))) {
              repos.push({ repo: spec.repo, dir, cloned: false });
              continue;
            }
            const status = await repoStatus(dir, { gitBinary: config.gitBinary });
            const baseBranch = spec.baseBranch ?? (await resolveDefaultBranch(dir, { remote: config.remote, gitBinary: config.gitBinary }));
            const diff = await aheadBehind(dir, `${config.remote}/${baseBranch}`, 'HEAD', { gitBinary: config.gitBinary }).catch(() => null);
            const worktrees = onlyTaskWorktrees(config, await listTaskWorktrees(dir, { gitBinary: config.gitBinary }));
            for (const worktree of worktrees) {
              if (!worktree.branch) continue;
              try {
                const wtDiff = await aheadBehind(worktree.path, 'HEAD', `${config.remote}/${baseBranch}`, { gitBinary: config.gitBinary });
                worktree.aheadOfBase = wtDiff.ahead;
                worktree.behindBase = wtDiff.behind;
              } catch {
                /* detached or missing remote ref */
              }
            }
            const roots = await listWorktrees(dir, { gitBinary: config.gitBinary });
            repos.push({ repo: spec.repo, dir, baseBranch, status, aheadOfBase: diff?.behind, behindBase: diff?.ahead, worktrees, registrations: roots });
          }
          return { ok: true, repos };
        }

        throw new Error(`Unknown action "${action}"`);
      },
    }),
  );

  return tools;
}

/** Optional capability probe used by index.js for a friendly startup log. */
export function toolNames() {
  return [
    'github_config',
    'github_auth',
    'github_repos',
    'github_issues',
    'github_events',
    'github_tasks',
    'git_worktree',
    'git_sync',
    'github_dispatch',
  ];
}


