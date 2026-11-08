import { buildInfo, formatUptime } from '../../src/lib/build-info.js';

describe('buildInfo', () => {
  it('reports version, deployment and server state from the environment', () => {
    const info = buildInfo({
      NODE_ENV: 'production',
      GIT_SHA: 'abc1234',
      GIT_COMMIT_MESSAGE: 'Add feature',
      GIT_COMMIT_TIME: '2026-11-08T10:00:00+05:30',
      BUILD_TIME: '2026-11-08T05:00:00Z',
      DEPLOYED_AT: '2026-11-08T05:01:00Z',
      DEPLOY_KIND: 'rollback',
      DEPLOY_PREVIOUS: 'def5678',
    });
    expect(info.version).toEqual({
      commit: 'abc1234',
      commitMessage: 'Add feature',
      committedAt: '2026-11-08T10:00:00+05:30',
      builtAt: '2026-11-08T05:00:00Z',
    });
    expect(info.deployment).toEqual({
      deployedAt: '2026-11-08T05:01:00Z',
      kind: 'rollback',
      rollback: true,
      previousVersion: 'def5678',
    });
    expect(info.server.environment).toBe('production');
    expect(info.server.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns nulls when not built or deployed by the scripts', () => {
    const info = buildInfo({ GIT_SHA: 'unknown' });
    expect(info.version.commit).toBeNull();
    expect(info.deployment).toEqual({
      deployedAt: null,
      kind: null,
      rollback: false,
      previousVersion: null,
    });
    expect(info.server.environment).toBe('development');
  });

  it('formats uptime readably', () => {
    expect(formatUptime(42)).toBe('42s');
    expect(formatUptime(125)).toBe('2m 5s');
    expect(formatUptime(3 * 3600 + 120)).toBe('3h 2m');
    expect(formatUptime(2 * 86400 + 3600 + 60)).toBe('2d 1h 1m');
  });
});
