import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { getApp } from '../helpers/factories';

describe('app shell', () => {
  it('reports liveness and readiness', async () => {
    await request(getApp()).get('/health').expect(200, { status: 'ok' });
    const ready = await request(getApp()).get('/ready').expect(200);
    expect(ready.body).toMatchObject({
      status: 'ready',
      database: true,
      push: 'disabled',
      version: { commit: null },
      deployment: { rollback: false },
      server: { uptimeSeconds: expect.any(Number) },
    });
  });

  it('sets a request id and echoes a valid incoming one', async () => {
    const res = await request(getApp()).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[\w-]{8,64}$/);
    const echoed = await request(getApp()).get('/health').set('X-Request-Id', 'abc12345-trace');
    expect(echoed.headers['x-request-id']).toBe('abc12345-trace');
    const replaced = await request(getApp()).get('/health').set('X-Request-Id', 'bad id!');
    expect(replaced.headers['x-request-id']).not.toBe('bad id!');
  });

  it('rejects oversized and malformed bodies with clear errors', async () => {
    const big = await request(getApp())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send(JSON.stringify({ email: 'x@example.com', password: 'a'.repeat(2_000_000) }))
      .expect(413);
    expect(big.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    const bad = await request(getApp())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send('{"email":')
      .expect(400);
    expect(bad.body.error.message).toBe('Malformed request body');
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(getApp()).get('/nope').expect(404);
    expect(res.body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Route GET /nope not found',
    });
    expect(res.body.error.requestId).toBeDefined();
  });

  it('requires authentication for protected API routes', async () => {
    const res = await request(getApp()).get('/api/v1/students').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects malformed JSON bodies with 400', async () => {
    const res = await request(getApp())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Malformed request body',
    });
  });

  it('allows configured CORS origins only', async () => {
    const ok = await request(getApp()).get('/health').set('Origin', 'https://app.test');
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.test');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const blocked = await request(getApp()).get('/health').set('Origin', 'https://evil.test');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('applies security headers', async () => {
    const res = await request(getApp()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
