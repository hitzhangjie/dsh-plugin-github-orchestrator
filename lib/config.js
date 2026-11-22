/**
 * Configuration normalization. The profile patch carries initial values; the
 * plugin's own settings file (written by the github_config tool) overrides
 * them at runtime without restarting the plugin.
 */
import os from 'node:os';
import path from 'node:path';

import { ensureDir, readJson, writeJsonAtomic } from './util.js';

export const DEFAULT_CONFIG = {
  /** Absolute workspace root that holds clones and the .worktrees directory. */
  workspaceRoot: '',
  /** Repositories watched by default, each "owner/name" or an object. */
  repos: [],
  /** Poll interval for GitHub event discovery, seconds. */
  pollIntervalSec: 120,
  /** GitHub REST base URL (override for GitHub Enterprise). */
  githubApiBase: 'https://api.github.com',
  /** Git executable; a bare name resolves on PATH, an absolute path is also accepted. */
  gitBinary: 'git',
  /** Default base branch for repositories without an explicit branch. */
  defaultBaseBranch: 'main',
  /** Prefix of task branches. */
  branchPrefix: 'task/',
  /** Git remote used for fetch/push. */
  remote: 'origin',
  /** OAuth App client id used by the in-plugin device-flow sign-in. Empty uses GITHUB_OAUTH_CLIENT_ID or the documented built-in fallback. */
  oauthClientId: '',
  /** Scopes requested by the device-flow sign-in. */
  oauthScopes: 'repo read:user',
  /** Directory (under workspaceRoot) that holds generated worktrees. */
  worktreesSubdir: '.worktrees',
  /** Open issues/PRs newer than this generate baseline inbox events on first poll. */
  baselineDays: 14,
  /** Maximum inbox events retained on disk. */
  maxEvents: 2000,
  /** HTTP timeout for GitHub requests. */
  requestTimeoutMs: 20000,
  /** Issue label names used by the storyboard. */
  labels: {
    task: 'gos:task',
    epic: 'gos:epic',
    statusPrefix: 'gos:status/',
  },
};

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** @param {string|object} spec */
export function parseRepoSpec(spec) {
  const raw = typeof spec === 'string' ? { repo: spec } : { ...(spec ?? {}) };
  const repo = String(raw.repo ?? '').trim();
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid repository "${repo}": expected "owner/name"`);
  }
  const [owner, name] = repo.split('/');
  const local = String(raw.local ?? '').trim() || `${owner}__${name}`;
  if (/[\\/:*?"<>|]/.test(local) || local === '.' || local === '..') {
    throw new Error(`Invalid local directory "${local}" for ${repo}`);
  }
  const result = { repo, owner, name, local };
  if (raw.baseBranch) result.baseBranch = String(raw.baseBranch);
  if (raw.issueLabel) result.issueLabel = String(raw.issueLabel);
  return result;
}

/** @param {unknown} input */
export function normalizeRepos(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const repos = [];
  for (const entry of input) {
    const spec = parseRepoSpec(entry);
    if (seen.has(spec.repo)) continue;
    seen.add(spec.repo);
    repos.push(spec);
  }
  return repos;
}

function numberIn(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * Merge patch config, persisted settings and defaults into one resolved config.
 * @param {object|undefined} rawConfig config from the cordis patch row
 * @param {object|undefined} settings persisted overrides
 * @param {{ env?: object, homeDir?: string }} context
 */
export function normalizeConfig(rawConfig, settings, context = {}) {
  const env = context.env ?? process.env;
  const homeDir = context.homeDir ?? os.homedir();
  const raw = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) };
  const saved = settings ?? {};
  const dshHome = env.DSH_HOME || path.join(homeDir, '.dsh');
  const stateDir = path.join(dshHome, 'github-orchestrator');
  const workspaceRoot = path.resolve(
    String(saved.workspaceRoot ?? raw.workspaceRoot ?? '').trim() || path.join(dshHome, 'github-work'),
  );
  const repoInput = saved.repos !== undefined ? saved.repos : raw.repos;
  return {
    workspaceRoot,
    stateDir,
    dataDir: stateDir,
    repos: normalizeRepos(repoInput),
    pollIntervalSec: numberIn(saved.pollIntervalSec ?? raw.pollIntervalSec, DEFAULT_CONFIG.pollIntervalSec, 15, 3600),
    githubApiBase: String(raw.githubApiBase || DEFAULT_CONFIG.githubApiBase),
    gitBinary: String(raw.gitBinary || DEFAULT_CONFIG.gitBinary),
    defaultBaseBranch: String(saved.defaultBaseBranch ?? raw.defaultBaseBranch ?? DEFAULT_CONFIG.defaultBaseBranch),
    branchPrefix: String(saved.branchPrefix ?? raw.branchPrefix ?? DEFAULT_CONFIG.branchPrefix),
    remote: String(saved.remote ?? raw.remote ?? DEFAULT_CONFIG.remote),
    oauthClientId: String(saved.oauthClientId ?? raw.oauthClientId ?? DEFAULT_CONFIG.oauthClientId).trim(),
    oauthScopes: String(saved.oauthScopes ?? raw.oauthScopes ?? DEFAULT_CONFIG.oauthScopes).trim() || DEFAULT_CONFIG.oauthScopes,
    worktreesSubdir: String(raw.worktreesSubdir || DEFAULT_CONFIG.worktreesSubdir),
    baselineDays: numberIn(raw.baselineDays, DEFAULT_CONFIG.baselineDays, 0, 365),
    maxEvents: numberIn(raw.maxEvents, DEFAULT_CONFIG.maxEvents, 100, 100000),
    requestTimeoutMs: numberIn(raw.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 1000, 120000),
    labels: { ...DEFAULT_CONFIG.labels, ...(raw.labels ?? {}) },
  };
}

/** @param {ReturnType<typeof normalizeConfig>} config @param {ReturnType<typeof parseRepoSpec>} spec */
export function repoDirOf(config, spec) {
  return path.resolve(config.workspaceRoot, spec.local);
}

/** @param {ReturnType<typeof normalizeConfig>} config @param {ReturnType<typeof parseRepoSpec>} spec @param {string} taskId */
export function worktreePathOf(config, spec, taskId) {
  return path.resolve(config.workspaceRoot, config.worktreesSubdir, `${spec.local}__${taskId}`);
}

/** Persisted settings for one plugin installation. */
export class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  read() {
    const value = readJson(this.filePath, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  patch(partial) {
    const current = this.read();
    const next = { ...current, ...(partial ?? {}) };
    ensureDir(path.dirname(this.filePath));
    writeJsonAtomic(this.filePath, next);
    return next;
  }

  replace(next) {
    ensureDir(path.dirname(this.filePath));
    writeJsonAtomic(this.filePath, next ?? {});
    return next ?? {};
  }
}
