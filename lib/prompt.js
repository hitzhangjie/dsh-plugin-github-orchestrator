/**
 * Runtime context contribution: a compact storyboard snapshot the model sees
 * on every step, so unread GitHub activity and active worktrees are never a
 * surprise.
 */

export const CONTEXT_NAME = 'github-orchestrator';
export const CONTEXT_ORDER = 860;

/** @param {object} runtime */
export function buildOrchestratorContext(runtime) {
  try {
    const config = runtime.getConfig();
    if (config.repos.length === 0) {
      return [
        '## GitHub orchestrator',
        `Workspace root: ${config.workspaceRoot} (no repositories configured yet).`,
        'Use github_repos action=add to watch a repository, then github_repos action=clone.',
      ].join('\n');
    }

    const lines = ['## GitHub orchestrator', `Workspace root: ${config.workspaceRoot}`];

    const tasks = runtime.tasks.list({ includeClosed: false });
    const active = tasks.filter((task) => task.status === 'in_progress' || task.status === 'review');
    if (active.length > 0) {
      lines.push(`Active tasks (${active.length}):`);
      for (const task of active.slice(0, 8)) {
        const worktree = task.worktreePath ? ` worktree=${task.worktreePath}` : ' (no worktree)';
        lines.push(
          `- ${task.id} [${task.status}] ${task.repo} ${task.branch}${worktree} — ${task.title}`,
        );
      }
      if (active.length > 8) lines.push(`- … ${active.length - 8} more`);
    } else {
      lines.push('Active tasks: none');
    }

    const stats = runtime.events.stats();
    if (stats.unread > 0) {
      const unreadEvents = runtime.events.list({ unreadOnly: true, limit: 500 });
      const byRepo = new Map();
      const byKind = new Map();
      for (const event of unreadEvents) {
        byRepo.set(event.repo, (byRepo.get(event.repo) ?? 0) + 1);
        byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
      }
      const repoText = [...byRepo.entries()]
        .slice(0, 6)
        .map(([repo, count]) => `${repo}:${count}`)
        .join(', ');
      const kindText = [...byKind.entries()]
        .slice(0, 6)
        .map(([kind, count]) => `${kind}:${count}`)
        .join(', ');
      lines.push(`Unread GitHub events: ${stats.unread}${repoText ? ` (${repoText})` : ''}`);
      if (kindText) lines.push(`Unread by kind: ${kindText}`);
      lines.push('Read them with github_events action=list unreadOnly=true; mark handled with github_events action=mark.');
    } else {
      lines.push('Unread GitHub events: 0');
    }

    if (config.autoDispatch) {
      const dispatch = runtime.dispatchStatus ? runtime.dispatchStatus() : null;
      lines.push(
        `Auto-dispatch: ON${dispatch?.sessionId ? ` (watcher session ${dispatch.sessionId})` : ''} — new ${config.autoDispatchKinds.join('/')} events become tasks and prompt the watcher session automatically.`,
      );
      if (dispatch?.lastError) lines.push(`Last automatic dispatch error: ${dispatch.lastError}`);
    } else {
      lines.push('Auto-dispatch: OFF (enable with github_config action=set autoDispatch=true, or the Automation tab in the panel).');
    }

    const poller = runtime.pollerStatus();
    if (!poller.token) {
      lines.push('GitHub token: NOT resolved (set GITHUB_TOKEN, use gh auth login, or github_config action=set). Reads may be rate-limited; issue creation is disabled.');
    }
    return lines.join('\n');
  } catch (error) {
    return `## GitHub orchestrator\nState unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** @param {object} runtime */
export function promptContext(runtime) {
  return {
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: () => buildOrchestratorContext(runtime),
  };
}
