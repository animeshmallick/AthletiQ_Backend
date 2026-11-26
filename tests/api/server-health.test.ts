import { describe, expect, it } from '@jest/globals';
import { db } from '../../src/db/client';
import { serverHealth } from '../../src/db/schema';
import {
  cpuBetween,
  healthProblems,
  healthScore,
  parseCpu,
  parseMemory,
  flushHealth,
  readHealth,
  sampleHealth,
} from '../../src/modules/activity/server-health';
import { as, makeUser } from '../helpers/factories';

describe('server health', () => {
  it('reads Linux CPU and memory', () => {
    const a = parseCpu('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 1 1 1')!;
    const b = parseCpu('cpu  150 0 100 850 50 0 0 50 0 0')!;
    expect(cpuBetween(a, b)).toEqual({ cpu: 50, steal: 25 });
    expect(cpuBetween(a, a)).toBeNull();
    expect(parseCpu('')).toBeNull();
    expect(
      parseMemory(
        'MemTotal: 1024000 kB\nMemAvailable: 256000 kB\nSwapTotal: 2048000 kB\nSwapFree: 2000000 kB\n',
      ),
    ).toEqual({ total: 1000, used: 750, swapTotal: 2000, swapUsed: 47 });
    expect(parseMemory('')).toBeNull();
  });

  it('warns about a filling disk at once, and the rest after ten minutes', async () => {
    const base = {
      ...(await readHealth()),
      cpu: 10,
      steal: 0,
      memTotal: 1000,
      memUsed: 400,
      diskTotal: 1000,
      diskFree: 500,
      appMem: 100,
      appLimit: 512,
      dbMs: 40,
    };
    const keys = (n: number, x: object) =>
      healthProblems(Array.from({ length: n }, () => ({ ...base, ...x }))).map((p) => p.key);
    expect(keys(10, {})).toEqual([]);
    expect(keys(1, { diskFree: 100 })).toEqual(['disk']);
    expect(keys(9, { cpu: 99 })).toEqual([]);
    expect(keys(10, { cpu: 99, steal: 30, memUsed: 950, appMem: 500, dbMs: null })).toEqual([
      'memory',
      'app-memory',
      'cpu',
      'steal',
      'database',
    ]);
    expect(healthProblems([])).toEqual([]);
    expect(healthScore({ ...base, swapUsed: 0, dbWaiting: 0 })).toBe(100);
    expect(healthScore({ ...base, swapUsed: 0, dbWaiting: 0, diskFree: 30, dbMs: null })).toBe(0);
  });

  it('keeps readings and shows admins the server over a period', async () => {
    await sampleHealth();
    await sampleHealth();
    // The database was checked a moment ago: readings wait in memory, then go in one trip.
    expect(await db.$count(serverHealth)).toBe(0);
    await flushHealth();
    expect(await db.$count(serverHealth)).toBe(2);
    await flushHealth();
    expect(await db.$count(serverHealth)).toBe(2);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const url = `/api/v1/activity/server?from=${day}&to=${day}`;
    const r = (await (await as(await makeUser('admin'))).get(url).expect(200)).body.data;
    expect(r.summary.readings).toBe(2);
    expect(r.series.length).toBeGreaterThan(0);
    expect(r.byHour).toHaveLength(24);
    expect(r.outages).toEqual([]);
    expect(r.availability).toBeNull(); // too soon to say
    // A gap in the readings is reported.
    const [one] = await db.select().from(serverHealth).limit(1);
    await db
      .insert(serverHealth)
      .values({ ...one!, at: new Date(one!.at.getTime() - 20 * 60_000) });
    const gap = (
      await (
        await as(await makeUser('admin'))
      )
        .get(`${url}&since=${new Date(Date.now() - 3_600_000).toISOString()}`)
        .expect(200)
    ).body.data;
    expect(gap.outages).toEqual([expect.objectContaining({ minutes: 20 })]);
    expect(gap.availability).toBeLessThan(50);
    expect(r.now.memTotal).toBeGreaterThan(0);
    expect(r.build.server.node).toMatch(/^v/);
    await (await as(await makeUser('coach'))).get(url).expect(403);
  });
});
