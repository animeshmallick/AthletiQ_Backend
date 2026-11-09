import { describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { db } from '../../src/db/client';
import { users } from '../../src/db/schema';
import { AppError } from '../../src/lib/errors';
import {
  currentUser,
  requireAdmin,
  requireAuth,
  requireCoach,
  requireRole,
} from '../../src/middleware/auth';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler';
import { rateLimitHandler } from '../../src/middleware/rate-limit';
import {
  assertBatchAccess,
  assertStudentAccess,
  getBatchOrThrow,
  isAdmin,
  studentScope,
} from '../../src/modules/access/access';
import { students } from '../../src/db/schema';
import { getApp, makeAcademy, makeStudent, tokenFor } from '../helpers/factories';

const ZERO_ID = '00000000-0000-4000-8000-000000000000';

function mockRes(headersSent = false) {
  const res = {
    headersSent,
    locals: {} as Record<string, unknown>,
    statusCode: 0,
    body: undefined as unknown,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const req = (extra: Partial<Request> = {}) =>
  ({ id: 'req-1', path: '/x', method: 'GET', headers: {}, ...extra }) as unknown as Request;

function handle(err: unknown, headersSent = false) {
  const res = mockRes(headersSent);
  errorHandler(err, req(), res as unknown as Response, (() => {}) as NextFunction);
  return res as { statusCode: number; body: { error: Record<string, unknown> } | undefined };
}

describe('requireRole / currentUser', () => {
  it('rejects requests without an authenticated user', () => {
    const next = jest.fn();
    expect(() => requireRole('admin')(req(), {} as Response, next)).toThrow(AppError);
    expect(() => currentUser(req())).toThrow('Authentication required');
    expect(next).not.toHaveBeenCalled();
  });

  it('allows matching roles and forbids the rest', () => {
    const coach = req({ user: { id: 'c', role: 'coach', name: 'C', email: 'c@x' } });
    const next = jest.fn();
    requireCoach(coach, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    try {
      requireAdmin(coach, {} as Response, next);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('FORBIDDEN');
    }
    requireRole('admin', 'coach')(coach, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(currentUser(coach).id).toBe('c');
  });
});

describe('requireAuth', () => {
  const call = async (authorization?: string) => {
    const r = req({ headers: authorization ? { authorization } : {} });
    const next = jest.fn();
    try {
      await requireAuth(r, {} as Response, next);
      return { next, user: r.user, error: undefined as AppError | undefined };
    } catch (error) {
      return { next, user: undefined, error: error as AppError };
    }
  };

  it('needs a well-formed bearer token', async () => {
    expect((await call()).error?.code).toBe('UNAUTHENTICATED');
    expect((await call('Basic abc')).error?.code).toBe('UNAUTHENTICATED');
    expect((await call('Bearer    ')).error?.code).toBe('UNAUTHENTICATED');
    expect((await call('Bearer not-a-jwt')).error?.message).toBe('Your session has expired');
  });

  it('accepts active users and rejects disabled or rotated sessions', async () => {
    const { coach } = await makeAcademy();
    const token = await tokenFor(coach);
    const okCall = await call(`Bearer ${token}`);
    expect(okCall.error).toBeUndefined();
    expect(okCall.next).toHaveBeenCalled();
    expect(okCall.user).toMatchObject({ id: coach.id, role: 'coach' });

    await db.update(users).set({ tokenVersion: 5 }).where(eq(users.id, coach.id));
    expect((await call(`Bearer ${token}`)).error?.message).toBe('Your session has expired');

    await db
      .update(users)
      .set({ tokenVersion: 0, status: 'disabled' })
      .where(eq(users.id, coach.id));
    expect((await call(`Bearer ${await tokenFor(coach)}`)).error?.code).toBe('UNAUTHENTICATED');

    await db
      .delete(users)
      .where(eq(users.id, coach.id))
      .catch(() => undefined);
  });
});

describe('errorHandler', () => {
  it('maps app, validation, body-parser, database and unknown errors', () => {
    const app = handle(new AppError('CONFLICT', 'Nope', { field: 'x' }));
    expect(app.statusCode).toBe(409);
    expect(app.body!.error).toEqual({
      code: 'CONFLICT',
      message: 'Nope',
      details: { field: 'x' },
      requestId: 'req-1',
    });

    const zodErr = z.object({ a: z.string() }).safeParse({}).error!;
    expect(handle(zodErr).statusCode).toBe(400);

    expect(handle({ type: 'entity.too.large', status: 413 }).body!.error.code).toBe(
      'PAYLOAD_TOO_LARGE',
    );
    expect(handle({ type: 'entity.parse.failed', status: 400 }).body!.error.message).toBe(
      'Malformed request body',
    );

    const dup = handle({ cause: { code: '23505', constraint: 'users_email_lower_uq' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.body!.error.message).toBe('A user with this email already exists');

    const boom = handle(new Error('kaboom'));
    expect(boom.statusCode).toBe(500);
    expect(boom.body!.error.message).toBe('Something went wrong. Please try again.');
    expect(handle('string error').statusCode).toBe(500);

    expect(handle(AppError.notFound('Thing')).statusCode).toBe(404);
    expect(handle(AppError.unauthenticated()).statusCode).toBe(401);
  });

  it('does not write a response twice', () => {
    const res = handle(new Error('late'), true);
    expect(res.statusCode).toBe(0);
    expect(res.body).toBeUndefined();
  });

  it('turns unknown routes into 404s', async () => {
    const next = jest.fn();
    notFoundHandler(req({ method: 'POST', path: '/nope' }), {} as Response, next);
    expect((next.mock.calls[0]![0] as AppError).message).toBe('Route POST /nope not found');
    const res = await request(getApp()).get('/definitely-not-here').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('rate limiting', () => {
  it('answers 429 with a friendly message', () => {
    const res = mockRes();
    rateLimitHandler({}, res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please slow down and try again shortly.',
      },
    });
  });
});

describe('access rules', () => {
  it('scopes batches and students to the coach', async () => {
    const a = await makeAcademy();
    const admin = { ...a.admin, role: 'admin' as const };
    const coach = { ...a.coach, role: 'coach' as const };
    const s = await makeStudent({ batchId: a.batch.id, feePlanId: a.plan.id }, a.admin.id);
    const other = await makeStudent({ batchId: a.otherBatch.id, feePlanId: a.plan.id }, a.admin.id);

    expect(isAdmin(admin)).toBe(true);
    expect(isAdmin(coach)).toBe(false);

    await expect(getBatchOrThrow(ZERO_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(assertBatchAccess(coach, a.batch.id)).resolves.toMatchObject({ id: a.batch.id });
    await expect(assertBatchAccess(coach, a.otherBatch.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(assertBatchAccess(admin, a.otherBatch.id)).resolves.toBeTruthy();

    await expect(assertStudentAccess(admin, other.id)).resolves.toBeUndefined();
    await expect(assertStudentAccess(coach, s.id)).resolves.toBeUndefined();
    await expect(assertStudentAccess(coach, other.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect(studentScope(admin, students.id)).toBeUndefined();
    const visible = await db
      .select({ id: students.id })
      .from(students)
      .where(studentScope(coach, students.id));
    expect(visible.map((r) => r.id)).toEqual([s.id]);
  });
});
