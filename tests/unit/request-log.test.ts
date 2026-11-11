/**
 * The request log, without a database: which requests are noted, what each entry holds, and how
 * the queue is saved (timer, full batches, overlapping flushes, failures, the memory cap).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';

type Mod = typeof import('../../src/modules/activity/request-log');
type Row = Record<string, unknown>;

/** A fresh copy of the module (its queue is module state) with a fake db, env and logger. */
function load({
  nodeEnv = 'production',
  insert = async (_rows: Row | Row[]) => {},
}: {
  nodeEnv?: string;
  insert?: (rows: Row | Row[]) => Promise<void>;
} = {}) {
  const inserted: (Row | Row[])[] = [];
  const values = jest.fn((rows: Row | Row[]) => {
    inserted.push(rows);
    return insert(rows);
  });
  const where = jest.fn(async () => {});
  const db = { insert: jest.fn(() => ({ values })), delete: jest.fn(() => ({ where })) };
  const warn = jest.fn();
  let mod!: Mod;
  jest.isolateModules(() => {
    jest.doMock('../../src/db/client', () => ({ db }));
    jest.doMock('../../src/config/env', () => ({ env: { NODE_ENV: nodeEnv } }));
    jest.doMock('../../src/lib/logger', () => ({ logger: { warn } }));
    mod = require('../../src/modules/activity/request-log') as Mod;
  });
  return { mod, db, values, where, warn, inserted };
}

/** Runs a request through the middleware and "sends" the response. */
function hit(
  mod: Mod,
  {
    method = 'POST',
    url = '/api/v1/students',
    status = 200,
    locals = {},
    user,
    id = 'req-1',
    ua = 'jest',
    get,
  }: {
    method?: string;
    url?: string;
    status?: number;
    locals?: Record<string, unknown>;
    user?: { id: string };
    id?: unknown;
    ua?: string;
    get?: () => string;
  } = {},
) {
  const req = {
    method,
    originalUrl: url,
    user,
    id,
    ip: '10.0.0.1',
    get: get ?? ((h: string) => (h === 'user-agent' ? ua : undefined)),
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode: status,
    locals,
  }) as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  mod.requestLog(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  (res as unknown as EventEmitter).emit('finish');
  return { res };
}

const rowsOf = (inserted: (Row | Row[])[]) => inserted.flatMap((r) => (Array.isArray(r) ? r : [r]));

beforeEach(() => {
  jest.useRealTimers();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('routeOf', () => {
  it('groups ids, numbers and query strings into one route', () => {
    const { mod } = load();
    expect(mod.routeOf('/api/v1/invoices/3f2504e0-4f89-11d3-9a0c-0305e82c3301/pdf?x=1')).toBe(
      '/api/v1/invoices/:id/pdf',
    );
    expect(mod.routeOf('/api/v1/feedback/12/weeks/2026')).toBe('/api/v1/feedback/:n/weeks/:n');
    expect(mod.routeOf('/api/v1/students?q=a/1')).toBe('/api/v1/students');
    // Numbers inside a segment aren't ids.
    expect(mod.routeOf('/api/v1/v2report')).toBe('/api/v1/v2report');
    expect(mod.routeOf('/x' + 'a'.repeat(300))).toHaveLength(200);
  });
});

describe('what gets noted', () => {
  it('skips everything on a developer machine', async () => {
    const { mod, values } = load({ nodeEnv: 'development' });
    hit(mod, { status: 500 });
    await mod.flushRequestLog();
    expect(values).not.toHaveBeenCalled();
  });

  it('notes writes and failures, not successful reads or preflights', async () => {
    const { mod, inserted } = load();
    hit(mod, { method: 'GET', status: 200 });
    hit(mod, { method: 'HEAD', status: 304 });
    hit(mod, { method: 'OPTIONS', status: 404 });
    hit(mod, { method: 'GET', url: '/api/v1/batches/7', status: 404 });
    hit(mod, { method: 'DELETE', status: 204 });
    await mod.flushRequestLog();
    expect(rowsOf(inserted).map((r) => `${String(r.method)} ${String(r.status)}`)).toEqual([
      'GET 404',
      'DELETE 204',
    ]);
  });

  it('records who, where, how long and the error, trimmed to size', async () => {
    const { mod, inserted } = load();
    hit(mod, {
      method: 'PUT',
      url: '/api/v1/students/3f2504e0-4f89-11d3-9a0c-0305e82c3301?x=1',
      status: 409,
      user: { id: 'u1' },
      locals: { apiError: { code: 'CONFLICT', message: 'm'.repeat(600) } },
      ua: 'u'.repeat(400),
    });
    hit(mod, { id: 42 }); // a non-string request id isn't stored
    await mod.flushRequestLog();
    const [first, second] = rowsOf(inserted);
    expect(first).toMatchObject({
      method: 'PUT',
      route: '/api/v1/students/:id',
      status: 409,
      code: 'CONFLICT',
      userId: 'u1',
      requestId: 'req-1',
      ipAddress: '10.0.0.1',
    });
    expect((first!.message as string).length).toBe(500);
    expect((first!.userAgent as string).length).toBe(300);
    expect(first!.durationMs).toEqual(expect.any(Number));
    expect(first!.createdAt).toBeInstanceOf(Date);
    expect(second).toMatchObject({ code: null, message: null, userId: null, requestId: null });
  });

  it('leaves out expected noise but keeps real failures on the same paths', async () => {
    const { mod, inserted } = load();
    hit(mod, { method: 'GET', status: 401, locals: { accessTokenExpired: true } });
    hit(mod, { url: '/api/v1/auth/refresh', status: 401 });
    hit(mod, { url: '/api/v1/auth/refresh', status: 500 });
    hit(mod, { method: 'GET', status: 401 }); // a real 401
    await mod.flushRequestLog();
    expect(rowsOf(inserted).map((r) => `${String(r.route)} ${String(r.status)}`)).toEqual([
      '/api/v1/auth/refresh 500',
      '/api/v1/students 401',
    ]);
  });

  it('never fails a request when an entry cannot be built', async () => {
    const { mod, values, warn } = load();
    hit(mod, {
      get: () => {
        throw new Error('bad header');
      },
    });
    await mod.flushRequestLog();
    expect(values).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'Request log entry skipped');
  });
});

describe('saving the queue', () => {
  it('saves in one insert a few seconds later, not on the request path', async () => {
    jest.useFakeTimers();
    const { mod, values } = load();
    hit(mod);
    hit(mod);
    expect(values).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(values).toHaveBeenCalledTimes(1);
    expect((values.mock.calls[0]![0] as Row[]).length).toBe(2);
    // Nothing left: the next flush is a no-op.
    await mod.flushRequestLog();
    expect(values).toHaveBeenCalledTimes(1);
  });

  it('flushes at once when a batch fills, 200 rows per insert', async () => {
    const { mod, values } = load();
    for (let i = 0; i < 450; i++) hit(mod);
    await mod.flushRequestLog();
    const sizes = values.mock.calls.map((c) => (c[0] as Row[]).length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(450);
    expect(Math.max(...sizes)).toBe(200);
  });

  it('waits for a save in progress instead of inserting twice at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let running = 0;
    let overlap = false;
    const { mod, values } = load({
      insert: async () => {
        running++;
        if (running > 1) overlap = true;
        await gate;
        running--;
      },
    });
    hit(mod);
    const first = mod.flushRequestLog();
    hit(mod);
    const second = mod.flushRequestLog();
    release();
    await Promise.all([first, second]);
    expect(overlap).toBe(false);
    expect(values).toHaveBeenCalledTimes(2);
  });

  it('now and then prunes rows older than 90 days', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.001);
    const { mod, db, where } = load();
    hit(mod);
    await mod.flushRequestLog();
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('retries one by one when the batch fails, dropping the user, then the row', async () => {
    const { mod, inserted, warn } = load({
      insert: async (rows) => {
        if (Array.isArray(rows)) throw new Error('batch failed');
        if (rows.requestId === 'bad') throw new Error('always fails');
        if (rows.userId === 'gone') throw new Error('user deleted');
      },
    });
    hit(mod, { user: { id: 'u1' }, id: 'ok' });
    hit(mod, { user: { id: 'gone' }, id: 'no-user' });
    hit(mod, { id: 'bad' });
    await mod.flushRequestLog();
    const singles = inserted.filter((r): r is Row => !Array.isArray(r));
    // ok: saved; no-user: saved without the user; bad: given up.
    expect(
      singles.map((r) => `${String(r.requestId)}:${(r.userId as string | null) ?? '-'}`),
    ).toEqual(['ok:u1', 'no-user:gone', 'no-user:-', 'bad:-', 'bad:-']);
    expect(warn).toHaveBeenCalledWith({ dropped: 1 }, 'Some request log entries were not saved');
  });

  it('stops queueing when the database is stuck, so memory stays bounded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { mod, values } = load({ insert: () => gate });
    // The first full batch starts a save that hangs; the rest queue up to the cap.
    for (let i = 0; i < 5_400; i++) hit(mod);
    release();
    await mod.flushRequestLog();
    const saved = values.mock.calls.reduce((n, c) => n + (c[0] as Row[]).length, 0);
    expect(saved).toBe(200 + 5_000);
  });
});
