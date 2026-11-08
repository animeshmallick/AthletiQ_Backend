import { describe, expect, it } from '@jest/globals';
import { hmac, randomToken, safeEqual, sha256 } from '../../src/lib/crypto';
import { AppError } from '../../src/lib/errors';
import { distanceMeters, isWithinGeofence } from '../../src/lib/geo';
import { created, noContent, ok, pageMeta } from '../../src/lib/http';
import { formatInr, formatInrAscii } from '../../src/lib/money';
import { mapPgError } from '../../src/lib/pg-errors';

describe('money', () => {
  it('formats paise as rupees', () => {
    expect(formatInr(250_000)).toBe('₹2,500.00');
    expect(formatInr(12_345_678)).toBe('₹1,23,456.78');
    expect(formatInrAscii(250_050)).toBe('Rs. 2,500.50');
  });
});

describe('geo', () => {
  it('computes haversine distances', () => {
    const blr = { lat: 12.9716, lng: 77.5946 };
    expect(distanceMeters(blr, blr)).toBe(0);
    // ~111 m per 0.001° latitude
    expect(distanceMeters(blr, { lat: 12.9726, lng: 77.5946 })).toBeCloseTo(111.2, 0);
    // Bengaluru → Chennai ≈ 290 km
    expect(distanceMeters(blr, { lat: 13.0827, lng: 80.2707 }) / 1000).toBeCloseTo(290, -1);
  });

  it('applies GPS accuracy tolerance with a cap', () => {
    expect(isWithinGeofence(150, 200)).toBe(true);
    expect(isWithinGeofence(250, 200)).toBe(false);
    expect(isWithinGeofence(250, 200, 60)).toBe(true);
    expect(isWithinGeofence(450, 200, 5000)).toBe(false); // capped at 100 m
    expect(isWithinGeofence(290, 200, 5000)).toBe(true);
    expect(isWithinGeofence(201, 200, -10)).toBe(false);
    expect(isWithinGeofence(200, 200, null)).toBe(true);
  });
});

describe('crypto', () => {
  it('creates unique url-safe tokens', () => {
    const a = randomToken();
    expect(a).toMatch(/^[\w-]+$/);
    expect(a).not.toBe(randomToken());
    expect(randomToken(8)).toHaveLength(11);
  });

  it('hashes and signs deterministically', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hmac('k', 'v')).toBe(hmac('k', 'v'));
    expect(hmac('k', 'v')).not.toBe(hmac('k2', 'v'));
  });

  it('compares in constant time and handles length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('AppError', () => {
  it('maps codes to HTTP statuses', () => {
    expect(AppError.badRequest('x').status).toBe(400);
    expect(AppError.unauthenticated().status).toBe(401);
    expect(AppError.forbidden().status).toBe(403);
    expect(AppError.notFound('Student')).toMatchObject({
      status: 404,
      message: 'Student not found',
    });
    expect(AppError.notFound().message).toBe('Resource not found');
    expect(AppError.conflict('x', { a: 1 })).toMatchObject({ status: 409, details: { a: 1 } });
    expect(AppError.unprocessable('x').status).toBe(422);
    expect(new AppError('RATE_LIMITED', 'slow').status).toBe(429);
    expect(new AppError('INTERNAL', 'boom').status).toBe(500);
    expect(new AppError('VALIDATION_ERROR', 'bad')).toBeInstanceOf(Error);
  });
});

describe('mapPgError', () => {
  const wrap = (code: string, constraint?: string) => ({ cause: { code, constraint } });

  it('maps unique violations to friendly conflicts', () => {
    expect(mapPgError(wrap('23505', 'users_email_lower_uq'))).toMatchObject({
      code: 'CONFLICT',
      message: 'A user with this email already exists',
    });
    expect(mapPgError(wrap('23505', 'something_else'))?.message).toBe('This record already exists');
    expect(mapPgError({ code: '23505' })?.code).toBe('CONFLICT');
  });

  it('maps FK, check and invalid-text errors', () => {
    expect(mapPgError(wrap('23503'))?.code).toBe('CONFLICT');
    expect(mapPgError(wrap('23514'))?.code).toBe('BAD_REQUEST');
    expect(mapPgError(wrap('22P02'))?.message).toBe('Invalid identifier');
  });

  it('ignores anything that is not a known pg error', () => {
    expect(mapPgError(wrap('40001'))).toBeUndefined();
    expect(mapPgError(new Error('x'))).toBeUndefined();
    expect(mapPgError(null)).toBeUndefined();
    expect(mapPgError('boom')).toBeUndefined();
  });
});

describe('http helpers', () => {
  const fakeRes = () => {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      ended: false,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(b: unknown) {
        res.body = b;
        return res;
      },
      end() {
        res.ended = true;
        return res;
      },
    };
    return res;
  };

  it('wraps payloads in envelopes', () => {
    const r1 = fakeRes();
    ok(r1 as never, { a: 1 });
    expect(r1).toMatchObject({ statusCode: 200, body: { data: { a: 1 } } });
    const r2 = fakeRes();
    ok(r2 as never, [1], { page: 1 });
    expect(r2.body).toEqual({ data: [1], meta: { page: 1 } });
    const r3 = fakeRes();
    created(r3 as never, { id: 'x' });
    expect(r3.statusCode).toBe(201);
    const r4 = fakeRes();
    noContent(r4 as never);
    expect(r4).toMatchObject({ statusCode: 204, ended: true });
  });

  it('computes page metadata', () => {
    expect(pageMeta(2, 20, 45)).toEqual({ page: 2, pageSize: 20, total: 45, totalPages: 3 });
    expect(pageMeta(1, 20, 0).totalPages).toBe(1);
  });
});
