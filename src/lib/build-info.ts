/**
 * What is running and how it got there, for /ready. Build facts are baked into the Docker image
 * (Dockerfile build args); deployment facts are passed to the container by scripts/deploy.sh.
 * Everything is optional so local runs and tests work without them.
 */
const startedAt = new Date();

const orNull = (v: string | undefined) => (v && v !== 'unknown' ? v : null);

export type DeployKind = 'deploy' | 'rollback' | 'redeploy';

export function buildInfo(e: NodeJS.ProcessEnv = process.env, now = new Date()) {
  const kind = orNull(e.DEPLOY_KIND) as DeployKind | null;
  const uptimeSeconds = Math.floor((now.getTime() - startedAt.getTime()) / 1000);
  return {
    version: {
      commit: orNull(e.GIT_SHA),
      commitMessage: orNull(e.GIT_COMMIT_MESSAGE),
      committedAt: orNull(e.GIT_COMMIT_TIME),
      builtAt: orNull(e.BUILD_TIME),
    },
    deployment: {
      deployedAt: orNull(e.DEPLOYED_AT),
      kind,
      /** True when this version replaced a newer one (automatic or manual rollback). */
      rollback: kind === 'rollback',
      previousVersion: orNull(e.DEPLOY_PREVIOUS),
    },
    server: {
      startedAt: startedAt.toISOString(),
      uptimeSeconds,
      uptime: formatUptime(uptimeSeconds),
      node: process.version,
      environment: e.NODE_ENV ?? 'development',
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };
}

export function formatUptime(total: number) {
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
