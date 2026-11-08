import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  monitoringEnabled,
  reportError,
  scrubEvent,
  setErrorReporter,
} from '../../src/lib/monitoring';
import { runSafely } from '../../src/jobs/alerts';
import { AppError } from '../../src/lib/errors';
import { errorHandler } from '../../src/middleware/error-handler';

afterEach(() => setErrorReporter(null));

describe('error reporting', () => {
  it('is a no-op until a reporter is set, and never throws', () => {
    expect(monitoringEnabled()).toBe(false);
    expect(() => reportError(new Error('x'), { where: 'test' })).not.toThrow();
    setErrorReporter(() => {
      throw new Error('reporter down');
    });
    expect(monitoringEnabled()).toBe(true);
    expect(() => reportError(new Error('x'), { where: 'test' })).not.toThrow();
  });

  it('reports failed background jobs', async () => {
    const seen = jest.fn();
    setErrorReporter(seen);
    runSafely('Nightly thing', () => Promise.reject(new Error('boom')));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveBeenCalledWith(expect.any(Error), { where: 'job:Nightly thing' });
  });

  it('strips secrets and personal data from events', () => {
    const event = scrubEvent({
      request: {
        url: 'https://api.example.com/api/v1/auth/reset?token=abc',
        data: { password: 'hunter2' },
        cookies: { refresh: 'r' },
        query_string: 'token=abc',
        headers: { authorization: 'Bearer x', cookie: 'a=b', 'user-agent': 'UA' },
      },
      user: { id: 'u1', email: 'parent@example.com', ip_address: '1.2.3.4' },
      extra: { otp: '1234', batchId: 'b1' },
    });
    expect(event).toEqual({
      request: {
        url: 'https://api.example.com/api/v1/auth/reset',
        headers: { 'user-agent': 'UA' },
      },
      user: { id: 'u1' },
      extra: { batchId: 'b1' },
    });
    expect(scrubEvent({ user: { email: 'x@y.z' } })).toEqual({ user: {} });
    expect(scrubEvent({ request: {} })).toEqual({ request: {} });
  });
});

describe('error handler', () => {
  function run(err: unknown, req: Record<string, unknown>) {
    const res = {
      headersSent: false,
      status: jest.fn(function (this: unknown) {
        return this;
      }),
      json: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (errorHandler as any)(
      err,
      { id: 'req-1', method: 'GET', path: '/x', baseUrl: '', ...req },
      res,
      () => {},
    );
    return res;
  }

  it('reports unexpected errors with route and user, but not client errors', () => {
    const seen = jest.fn();
    setErrorReporter(seen);
    run(new Error('db exploded'), {
      method: 'POST',
      baseUrl: '/api/v1/students',
      route: { path: '/:id/leave' },
      path: '/abc/leave',
      user: { id: 'u1', role: 'admin' },
    });
    expect(seen).toHaveBeenCalledWith(expect.any(Error), {
      where: 'http',
      requestId: 'req-1',
      method: 'POST',
      path: '/api/v1/students/:id/leave',
      userId: 'u1',
      role: 'admin',
    });
    run(new Error('no route info'), {});
    expect(seen).toHaveBeenLastCalledWith(
      expect.any(Error),
      expect.objectContaining({ path: '/x', userId: undefined }),
    );
    seen.mockClear();
    run(AppError.badRequest('nope'), {});
    expect(seen).not.toHaveBeenCalled();
  });
});
