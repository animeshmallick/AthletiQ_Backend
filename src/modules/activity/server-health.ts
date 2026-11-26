/**
 * Health of the machine and the API process, read once a minute (no AWS setup needed: the
 * container sees the host's CPU and memory). Kept 30 days; admins are told when something stays
 * bad or the disk is filling up.
 *
 *  - cpu: the machine's, in percent. steal: CPU the machine wanted but AWS held back (a small
 *    instance out of CPU credits).
 *  - memory / swap / disk: the machine's. app memory: the API container's, against its limit.
 *  - event loop: how long the API waits for its turn. Database: one trip, and waiting requests.
 */
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { lt, sql } from 'drizzle-orm';
import { db, pool } from '../../db/client.js';
import { serverHealth } from '../../db/schema/index.js';
import { todayInAppTz } from '../../lib/dates.js';
import { logger } from '../../lib/logger.js';
import { activeAdminIds, notifyOnce } from '../push/push.service.js';

const EVERY_MS = 60_000;
const KEEP_DAYS = 30;
const MB = 1024 * 1024;

export interface CpuTimes {
  busy: number;
  idle: number;
  steal: number;
}

/** The machine's CPU time so far, from /proc/stat (jiffies). */
export function parseCpu(stat: string): CpuTimes | null {
  const line = /^cpu\s+(.+)$/m.exec(stat)?.[1];
  if (!line) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, wait = 0, irq = 0, soft = 0, steal = 0] = line
    .trim()
    .split(/\s+/)
    .map(Number);
  return { busy: user + nice + system + irq + soft, idle: idle + wait, steal };
}

/** Share of the time between two readings. */
export function cpuBetween(a: CpuTimes, b: CpuTimes) {
  const busy = b.busy - a.busy;
  const steal = b.steal - a.steal;
  const total = busy + steal + (b.idle - a.idle);
  if (total <= 0) return null;
  const pct = (n: number) => Math.round((Math.max(0, n) * 1000) / total) / 10;
  return { cpu: pct(busy), steal: pct(steal) };
}

/** Megabytes by name, from /proc/meminfo. */
export function parseMemory(info: string) {
  const mb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(info);
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  };
  const total = mb('MemTotal');
  if (!total) return null;
  return {
    total,
    used: Math.max(0, total - mb('MemAvailable')),
    swapTotal: mb('SwapTotal'),
    swapUsed: Math.max(0, mb('SwapTotal') - mb('SwapFree')),
  };
}

const read = (file: string) => readFile(file, 'utf8').catch(() => null);

async function cpuTimes(): Promise<CpuTimes> {
  const stat = await read('/proc/stat');
  const parsed = stat ? parseCpu(stat) : null;
  if (parsed) return parsed;
  // Not Linux (a developer's machine).
  return os.cpus().reduce<CpuTimes>(
    (t, { times }) => ({
      busy: t.busy + times.user + times.nice + times.sys + times.irq,
      idle: t.idle + times.idle,
      steal: 0,
    }),
    { busy: 0, idle: 0, steal: 0 },
  );
}

async function memory() {
  const info = await read('/proc/meminfo');
  const parsed = info ? parseMemory(info) : null;
  if (parsed) return parsed;
  const total = Math.round(os.totalmem() / MB);
  return { total, used: total - Math.round(os.freemem() / MB), swapTotal: 0, swapUsed: 0 };
}

async function appMemory() {
  const [now, max] = await Promise.all([
    read('/sys/fs/cgroup/memory.current'),
    read('/sys/fs/cgroup/memory.max'),
  ]);
  const limit = Number(max);
  return {
    used: Math.round((Number(now) || process.memoryUsage().rss) / MB),
    limit: Number.isFinite(limit) && limit > 0 ? Math.round(limit / MB) : null,
  };
}

async function disk() {
  try {
    const s = await statfs('/');
    const total = s.blocks * s.bsize;
    // Like df: what's reserved for the system isn't available to us.
    const used = (s.blocks - s.bfree) * s.bsize;
    return {
      total: Math.round(total / MB),
      used: Math.round(used / MB),
      free: Math.round((s.bavail * s.bsize) / MB),
    };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}

async function databaseMs(): Promise<number | null> {
  const started = performance.now();
  try {
    await pool.query('select 1');
    return Math.round(performance.now() - started);
  } catch {
    return null;
  }
}

const delay = monitorEventLoopDelay({ resolution: 20 });
let last: CpuTimes | null = null;

/** One reading now. CPU covers the time since the previous reading. */
export async function readHealth() {
  const before = last;
  const [times, mem, app, space, dbMs] = await Promise.all([
    cpuTimes(),
    memory(),
    appMemory(),
    disk(),
    databaseMs(),
  ]);
  last = times;
  const cpu = before ? cpuBetween(before, times) : null;
  const lag = delay.percentile(99) / 1e6;
  delay.reset();
  return {
    at: new Date(),
    cpu: cpu?.cpu ?? 0,
    steal: cpu?.steal ?? 0,
    load: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
    cores: os.cpus().length,
    memTotal: mem.total,
    memUsed: mem.used,
    swapTotal: mem.swapTotal,
    swapUsed: mem.swapUsed,
    diskTotal: space.total,
    diskUsed: space.used,
    diskFree: space.free,
    appMem: app.used,
    appLimit: app.limit,
    lagMs: Number.isFinite(lag) ? Math.round(lag) : 0,
    dbMs,
    dbConnections: pool.totalCount ?? 0,
    dbWaiting: pool.waitingCount ?? 0,
    uptime: Math.round(os.uptime()),
  };
}
export type HealthReading = Awaited<ReturnType<typeof readHealth>>;

const share = (used: number, total: number) => (total ? Math.round((used * 100) / total) : 0);

/** What needs attention in the latest readings (oldest first), worst first. */
export function healthProblems(recent: HealthReading[]) {
  const now = recent.at(-1);
  if (!now) return [];
  const out: { key: string; level: 'critical' | 'warning'; title: string; detail: string }[] = [];
  const disk = share(now.diskTotal - now.diskFree, now.diskTotal);
  if (disk >= 85)
    out.push({
      key: 'disk',
      level: disk >= 95 ? 'critical' : 'warning',
      title: `Server disk is ${disk}% full`,
      detail: `${(now.diskFree / 1024).toFixed(1)} GB left. Deploys and logs stop when it is full.`,
    });
  // Ten minutes in a row, so a busy moment doesn't alarm anyone.
  const ten = recent.slice(-10);
  const all = (f: (r: HealthReading) => boolean) => ten.length === 10 && ten.every(f);
  if (all((r) => share(r.memUsed, r.memTotal) >= 90))
    out.push({
      key: 'memory',
      level: 'critical',
      title: `Server memory is ${share(now.memUsed, now.memTotal)}% used`,
      detail: 'For 10 minutes. The app may slow down or restart.',
    });
  if (all((r) => !!r.appLimit && share(r.appMem, r.appLimit) >= 90))
    out.push({
      key: 'app-memory',
      level: 'critical',
      title: 'The app is close to its memory limit',
      detail: `${now.appMem} of ${now.appLimit} MB for 10 minutes. It restarts if it goes over.`,
    });
  if (all((r) => r.cpu >= 90))
    out.push({
      key: 'cpu',
      level: 'warning',
      title: `Server CPU is ${Math.round(now.cpu)}% busy`,
      detail: 'For 10 minutes.',
    });
  if (all((r) => r.steal >= 20))
    out.push({
      key: 'steal',
      level: 'warning',
      title: 'AWS is limiting the server’s CPU',
      detail: `${Math.round(now.steal)}% held back for 10 minutes: the instance is out of CPU credits.`,
    });
  if (all((r) => r.dbMs === null))
    out.push({
      key: 'database',
      level: 'critical',
      title: 'The database can’t be reached',
      detail: 'For 10 minutes.',
    });
  return out;
}

/** 100 when everything has room to spare; each shortage takes points off. */
export function healthScore(
  r: Pick<
    HealthReading,
    | 'cpu'
    | 'steal'
    | 'memUsed'
    | 'memTotal'
    | 'swapUsed'
    | 'diskTotal'
    | 'diskFree'
    | 'appMem'
    | 'appLimit'
    | 'dbMs'
    | 'dbWaiting'
  >,
): number {
  const off = (value: number, ...steps: [number, number][]) =>
    steps.reduce((worst, [from, points]) => (value >= from ? points : worst), 0);
  const lost =
    off(r.cpu, [70, 8], [85, 18], [95, 30]) +
    off(r.steal, [10, 10], [25, 20]) +
    off(share(r.memUsed, r.memTotal), [80, 8], [90, 25], [96, 40]) +
    off(r.memTotal ? (r.swapUsed * 100) / r.memTotal : 0, [25, 8], [60, 15]) +
    off(share(r.diskTotal - r.diskFree, r.diskTotal), [80, 8], [85, 18], [95, 45]) +
    off(r.appLimit ? share(r.appMem, r.appLimit) : 0, [75, 8], [90, 25]) +
    off(r.dbWaiting, [5, 10]) +
    (r.dbMs === null ? 60 : off(r.dbMs, [150, 8], [400, 20]));
  return Math.max(0, 100 - lost);
}

const recent: HealthReading[] = [];
export const recentReadings = () => recent;

export async function sampleHealth() {
  const r = await readHealth();
  recent.push(r);
  if (recent.length > 60) recent.shift();
  const { cores: _c, uptime: _u, ...row } = r;
  await db.insert(serverHealth).values(row);
  if (Math.random() < 0.001)
    await db
      .delete(serverHealth)
      .where(lt(serverHealth.at, sql`now() - make_interval(days => ${KEEP_DAYS})`));
  for (const p of healthProblems(recent))
    // Once a day for each problem.
    await notifyOnce(`server:${p.key}:${todayInAppTz()}`, await activeAdminIds(), {
      category: 'approvals',
      icon: p.level === 'critical' ? '🔴' : '🟠',
      title: p.title,
      body: p.detail,
      link: '/audit-log?tab=server',
      tag: `server-${p.key}`,
    });
  return r;
}

let timer: NodeJS.Timeout | null = null;
export function startHealthMonitor() {
  delay.enable();
  void cpuTimes().then((t) => (last = t));
  timer = setInterval(() => {
    sampleHealth().catch((err: unknown) => logger.warn({ err }, 'Server health was not saved'));
  }, EVERY_MS);
  timer.unref();
}
export function stopHealthMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}
