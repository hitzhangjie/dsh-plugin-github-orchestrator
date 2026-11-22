/**
 * @hitzhangjie/dsh-plugin-github-orchestrator — Host half.
 *
 * Registers seven agent tools, one runtime-context contribution, the OAuth
 * device-flow sign-in, token-authenticated HTTPS Git, and the loopback HTTP API
 * used by the Web UI panel:
 *   github_config, github_auth, github_repos, github_events, github_tasks,
 *   git_worktree, git_sync
 *
 * State lives under <DSH_HOME>/github-orchestrator:
 *   settings.json            runtime overrides written by github_config
 *   events.json              normalized GitHub event inbox
 *   events-watermarks.json   per-repository polling watermarks
 *   tasks.json               local storyboard task store
 *
 * The OAuth token (when the user signs in through the panel or the tool) is
 * stored in the Harness credentials service under the `github-orchestrator`
 * record; it is never written to this plugin's own state files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig, SettingsStore } from './lib/config.js';
import { ensureDir } from './lib/util.js';
import { GitHubClient, resolveGitHubToken, CREDENTIAL_KEY } from './lib/github.js';
import { EventStore, EventPoller } from './lib/events.js';
import { TaskStore } from './lib/tasks.js';
import { Storyboard } from './lib/storyboard.js';
import { createToolDefinitions } from './lib/tools.js';
import { promptContext } from './lib/prompt.js';
import { resolveOAuthClientId, startDeviceFlow, pollDeviceFlow, fetchGitHubUser, DeviceFlowError } from './lib/oauth.js';
import { setGitAuthProvider } from './lib/git.js';
import { registerWebRoutes } from './lib/web.js';

export const inject = ['tools'];

export const name = 'github-orchestrator';

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export async function apply(ctx, rawConfig = {}) {
  const env = process.env;
  const homeDir = os.homedir();
  const dshHome = env.DSH_HOME || path.join(homeDir, '.dsh');
  const stateDir = path.join(dshHome, 'github-orchestrator');
  ensureDir(stateDir);

  const settings = new SettingsStore(path.join(stateDir, 'settings.json'));
  let config = normalizeConfig(rawConfig, settings.read(), { env, homeDir });

  let credentials;
  try {
    credentials = ctx.get('credentials');
  } catch {
    credentials = undefined;
  }

  let tokenInfo = { token: null, source: 'none' };
  try {
    tokenInfo = await resolveGitHubToken({
      explicit: rawConfig.githubToken,
      env,
      credentials,
      homeDir,
    });
  } catch (error) {
    ctx.logger?.warn?.(`[github-orchestrator] token resolution failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const client = new GitHubClient({
    token: tokenInfo.token ?? undefined,
    apiBase: config.githubApiBase,
    timeoutMs: config.requestTimeoutMs,
  });
  const events = new EventStore(path.join(stateDir, 'events.json'), { maxEvents: config.maxEvents });
  const tasks = new TaskStore(path.join(stateDir, 'tasks.json'));
  const storyboard = new Storyboard({ client, tasks, config, logger: ctx.logger });
  const poller = new EventPoller({
    client,
    store: events,
    config,
    logger: ctx.logger,
    pollIntervalSec: config.pollIntervalSec,
    watermarksPath: path.join(stateDir, 'events-watermarks.json'),
  });

  /** Current token and the metadata recorded when it was obtained via OAuth. */
  let tokenState = { token: tokenInfo.token ?? null, source: tokenInfo.source };
  let tokenMeta = null;

  const applyToken = (token, source, meta) => {
    tokenState = { token: token ?? null, source: token ? source : 'none' };
    tokenMeta = token ? (meta ?? null) : null;
    client.token = tokenState.token;
    setGitAuthProvider(() => ({ token: tokenState.token }));
  };
  applyToken(tokenInfo.token, tokenInfo.source, null);

  let pendingOAuth = null;

  const resolvedOAuthClientId = () => resolveOAuthClientId({ config, env });

  const oauthStatus = () => {
    const resolved = resolvedOAuthClientId();
    return {
      authenticated: Boolean(tokenState.token),
      source: tokenState.source,
      login: tokenMeta?.login ?? null,
      scopes: tokenMeta?.scopes ?? null,
      clientId: resolved.clientId,
      clientIdSource: resolved.source,
      credentialsAvailable: Boolean(credentials && typeof credentials.modifyRecord === 'function'),
      pending: pendingOAuth
        ? {
            userCode: pendingOAuth.userCode,
            verificationUri: pendingOAuth.verificationUri,
            expiresAt: new Date(pendingOAuth.expiresAt).toISOString(),
            intervalSec: pendingOAuth.interval,
            scopes: pendingOAuth.scopes,
            clientId: pendingOAuth.clientId,
            clientIdSource: pendingOAuth.clientIdSource,
          }
        : null,
    };
  };

  const oauthStart = async ({ scopes, clientId } = {}) => {
    const resolved = resolvedOAuthClientId();
    const chosenClientId = clientId || resolved.clientId;
    const flow = await startDeviceFlow({
      clientId: chosenClientId,
      scopes: scopes || config.oauthScopes,
      timeoutMs: config.requestTimeoutMs,
    });
    pendingOAuth = {
      ...flow,
      clientIdSource: clientId ? 'override' : resolved.source,
      startedAt: Date.now(),
      expiresAt: Date.now() + flow.expiresIn * 1000,
    };
    return {
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresIn: flow.expiresIn,
      intervalSec: flow.interval,
      scopes: flow.scopes,
      clientId: flow.clientId,
      clientIdSource: pendingOAuth.clientIdSource,
    };
  };

  const oauthPoll = async ({ timeoutSec = 120 } = {}) => {
    if (!pendingOAuth) {
      throw new Error('No pending GitHub device-flow sign-in. Call github_auth action=start first.');
    }
    const pending = pendingOAuth;
    try {
      const result = await pollDeviceFlow({
        clientId: pending.clientId,
        deviceCode: pending.deviceCode,
        intervalSec: pending.interval,
        expiresInSec: pending.expiresIn,
        maxWaitMs: Math.max(5, timeoutSec) * 1000,
        timeoutMs: config.requestTimeoutMs,
      });
      let user = { login: null, scopes: [] };
      try {
        user = await fetchGitHubUser({ token: result.accessToken, apiBase: config.githubApiBase, timeoutMs: config.requestTimeoutMs });
      } catch (error) {
        ctx.logger?.warn?.(`[github-orchestrator] could not read OAuth user profile: ${error instanceof Error ? error.message : String(error)}`);
      }
      let stored = false;
      if (credentials && typeof credentials.modifyRecord === 'function') {
        try {
          await credentials.modifyRecord(CREDENTIAL_KEY, () => ({
            token: result.accessToken,
            kind: 'oauth',
            scope: result.scope,
            login: user.login ?? undefined,
            obtainedAt: new Date().toISOString(),
          }));
          stored = true;
        } catch (error) {
          ctx.logger?.warn?.(`[github-orchestrator] could not store OAuth credential: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      applyToken(result.accessToken, 'oauth', { login: user.login ?? null, scopes: user.scopes ?? [] });
      pendingOAuth = null;
      return {
        authenticated: true,
        source: 'oauth',
        login: user.login ?? null,
        scopes: user.scopes ?? [],
        scope: result.scope,
        stored,
        credentialsAvailable: Boolean(credentials && typeof credentials.modifyRecord === 'function'),
      };
    } catch (error) {
      const code = error instanceof DeviceFlowError ? error.code : undefined;
      if (code === 'timeout' || code === 'aborted') {
        return {
          authenticated: false,
          pending: true,
          code,
          error: error instanceof Error ? error.message : String(error),
          hint: 'The authorization has not been completed yet. Open the verification URI, approve the scopes, then call github_auth action=poll again.',
          status: oauthStatus(),
        };
      }
      pendingOAuth = null;
      throw error;
    }
  };

  const oauthCancel = () => {
    pendingOAuth = null;
  };

  const oauthLogout = async () => {
    let deleted = false;
    if (credentials && typeof credentials.deleteRecord === 'function') {
      try {
        await credentials.deleteRecord(CREDENTIAL_KEY);
        deleted = true;
      } catch (error) {
        ctx.logger?.warn?.(`[github-orchestrator] could not delete OAuth credential: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    pendingOAuth = null;
    applyToken(null, 'none', null);
    return { loggedOut: true, credentialDeleted: deleted };
  };

  let pollerRunning = false;
  const startPoller = () => {
    if (pollerRunning) return;
    if (config.repos.length === 0) return;
    if (!tokenState.token) return;
    try {
      poller.start();
      pollerRunning = true;
    } catch (error) {
      ctx.logger?.warn?.(`[github-orchestrator] poller failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const stopPoller = () => {
    if (!pollerRunning) return;
    try {
      poller.stop();
    } finally {
      pollerRunning = false;
    }
  };

  const pollerStatus = () => ({
    running: pollerRunning,
    intervalSec: config.pollIntervalSec,
    token: Boolean(tokenState.token),
    tokenSource: tokenState.source,
    watermarks: poller.watermarks(),
  });

  const toolMap = {};
  let runtime;
  const invokeTool = async (toolName, args) => {
    const tool = toolMap[toolName];
    if (!tool) throw new Error(`Unknown plugin tool "${toolName}"`);
    return tool.execute(args ?? {}, {});
  };

  const snapshot = async () => {
    const settle = async (promise) => {
      try {
        return await promise;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };
    const [repos, eventsResult, tasksResult, worktrees] = await Promise.all([
      settle(invokeTool('github_repos', { action: 'list' })),
      settle(invokeTool('github_events', { action: 'list', unreadOnly: true, limit: 50 })),
      settle(invokeTool('github_tasks', { action: 'list', includeClosed: true })),
      settle(invokeTool('git_worktree', { action: 'list' })),
    ]);
    const pollerSnapshot = { ...pollerStatus(), lastPollAt: poller.watermarks()?.updatedAt ?? null };
    const taskStats = tasksResult?.stats ?? { total: 0, byStatus: {}, byRepo: {}, openTasks: 0 };
    if (typeof taskStats.active !== 'number') taskStats.active = taskStats.openTasks ?? 0;
    return {
      generatedAt: new Date().toISOString(),
      workspaceRoot: config.workspaceRoot,
      workspaceExists: fs.existsSync(config.workspaceRoot),
      stateDir,
      pollIntervalSec: config.pollIntervalSec,
      defaultBaseBranch: config.defaultBaseBranch,
      branchPrefix: config.branchPrefix,
      remote: config.remote,
      gitBinary: config.gitBinary,
      token: {
        available: Boolean(tokenState.token),
        source: tokenState.source,
        login: tokenMeta?.login ?? null,
        scopes: tokenMeta?.scopes ?? null,
      },
      repos: Array.isArray(repos?.repos) ? repos.repos : [],
      events: Array.isArray(eventsResult?.events) ? eventsResult.events : [],
      eventStats: eventsResult?.stats ?? { total: 0, unread: 0, byRepo: {}, byKind: {}, lastEventAt: null },
      tasks: Array.isArray(tasksResult?.tasks) ? tasksResult.tasks : [],
      taskStats,
      worktrees: Array.isArray(worktrees?.repos) ? worktrees.repos : [],
      auth: oauthStatus(),
      web: runtime.webStatus(),
      poller: pollerSnapshot,
    };
  };

  runtime = {
    getConfig: () => config,
    updateSettings(patch) {
      const saved = settings.patch(patch);
      config = normalizeConfig(rawConfig, saved, { env, homeDir });
      poller.updateConfig(config);
      storyboard.updateConfig(config);
      startPoller();
      return config;
    },
    client,
    events,
    tasks,
    storyboard,
    poller,
    tokenInfo: () => ({ hasToken: Boolean(tokenState.token), source: tokenState.source }),
    pollerStatus,
    oauthStatus,
    oauthStart,
    oauthPoll,
    oauthCancel,
    oauthLogout,
    snapshot,
    invokeTool,
  };

  const toolDisposers = [];
  for (const tool of createToolDefinitions(runtime)) {
    toolMap[tool.name] = tool;
    toolDisposers.push(ctx.tools.register(tool));
  }
  ctx.effect(
    () => () => {
      for (const dispose of toolDisposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* already disposed */
        }
      }
    },
    'github-orchestrator: tools',
  );

  let systemPrompt;
  try {
    systemPrompt = ctx.get('systemPrompt');
  } catch {
    systemPrompt = undefined;
  }
  if (systemPrompt?.context) {
    const disposeContext = systemPrompt.context(promptContext(runtime));
    ctx.effect(() => disposeContext, 'github-orchestrator: runtime context');
  }

  let webServerAvailable = false;
  let webRoutesRegistered = false;
  let webError = null;
  try {
    // `webServer` is optional: the plugin must also activate in profiles without
    // a browser surface. A scoped inject keeps the Host tools working there.
    ctx.inject(['webServer'], (webCtx) => {
      webServerAvailable = true;
      try {
        const disposeRoutes = registerWebRoutes(webCtx, runtime);
        ctx.effect(() => disposeRoutes, 'github-orchestrator: web routes');
        webRoutesRegistered = true;
      } catch (error) {
        webError = error instanceof Error ? error.message : String(error);
        ctx.logger?.warn?.(`[github-orchestrator] web routes failed to register: ${webError}`);
      }
    });
  } catch (error) {
    webError = error instanceof Error ? error.message : String(error);
  }
  runtime.webStatus = () => ({
    available: webServerAvailable,
    registered: webRoutesRegistered,
    error: webError,
  });

  startPoller();
  ctx.effect(
    () => () => {
      stopPoller();
      setGitAuthProvider(null);
    },
    'github-orchestrator: poller',
  );

  ctx.logger?.info?.(
    `[github-orchestrator] ready: workspace=${config.workspaceRoot} repos=${config.repos.length} token=${tokenState.source} poller=${pollerRunning ? 'on' : 'off'} ui=${webRoutesRegistered ? 'on' : 'off'}`,
  );
  // Cordis treats a plugin's return value as an effect; the runtime is kept
  // alive by the registered tools/effects, so nothing is returned here.
}
