import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { AppError } from '../../src/lib/errors';
import {
  parse,
  zBoolQuery,
  zEmail,
  zIsoDate,
  zOptionalText,
  zPagination,
  zPassword,
  zPhone,
  zTime,
  zTrainingDays,
  zWeekdays,
} from '../../src/lib/validation';

describe('parse', () => {
  it('returns parsed data on success', () => {
    expect(parse(z.object({ a: z.coerce.number() }), { a: '5' })).toEqual({ a: 5 });
  });

  it('throws a VALIDATION_ERROR with field paths', () => {
    try {
      parse(z.object({ user: z.object({ email: zEmail }) }), { user: { email: 'nope' } });
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('VALIDATION_ERROR');
      expect((err as AppError).details).toEqual({
        fields: [{ path: 'user.email', message: 'Must be a valid email' }],
      });
    }
  });
});

describe('field schemas', () => {
  it('normalises Indian and international phone numbers to E.164', () => {
    expect(zPhone.parse('98765 43210')).toBe('+919876543210');
    expect(zPhone.parse('+91-98765-43210')).toBe('+919876543210');
    expect(zPhone.parse('919876543210')).toBe('+919876543210');
    expect(zPhone.parse('+14155550123')).toBe('+14155550123');
    expect(zPhone.safeParse('12345').success).toBe(false);
    expect(zPhone.safeParse('5876543210').success).toBe(false);
  });

  it('validates and normalises times', () => {
    expect(zTime.parse('06:30')).toBe('06:30:00');
    expect(zTime.parse('18:45:30')).toBe('18:45:30');
    expect(zTime.safeParse('24:00').success).toBe(false);
  });

  it('validates ISO dates', () => {
    expect(zIsoDate.safeParse('2026-02-30').success).toBe(false);
    expect(zIsoDate.parse('2026-02-28')).toBe('2026-02-28');
  });

  it('dedupes and sorts weekdays', () => {
    expect(zWeekdays.parse([5, 1, 3, 1])).toEqual([1, 3, 5]);
    expect(zWeekdays.safeParse([]).success).toBe(false);
    expect(zWeekdays.safeParse([0]).success).toBe(false);
    expect(zWeekdays.safeParse([8]).success).toBe(false);
  });

  it('enforces 3–5 training days per week', () => {
    expect(zTrainingDays.parse([1, 3, 5])).toEqual([1, 3, 5]);
    expect(zTrainingDays.safeParse([1, 2]).success).toBe(false);
    expect(zTrainingDays.safeParse([1, 2, 3, 4, 5, 6]).success).toBe(false);
    expect(zTrainingDays.safeParse([1, 1, 2]).success).toBe(false); // dedupes to 2 days
  });

  it('requires reasonably strong passwords', () => {
    expect(zPassword.safeParse('abc12345').success).toBe(true);
    expect(zPassword.safeParse('short1').success).toBe(false);
    expect(zPassword.safeParse('allletters').success).toBe(false);
    expect(zPassword.safeParse('12345678').success).toBe(false);
  });

  it('lowercases emails', () => {
    expect(zEmail.parse('Coach@Example.COM')).toBe('coach@example.com');
  });

  it('turns empty optional text into null', () => {
    const s = zOptionalText(5);
    expect(s.parse('')).toBeNull();
    expect(s.parse(undefined)).toBeNull();
    expect(s.parse('  hi ')).toBe('hi');
    expect(s.safeParse('toolong').success).toBe(false);
  });

  it('coerces pagination and boolean query params', () => {
    expect(zPagination.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(zPagination.parse({ page: '3', pageSize: '50' })).toEqual({ page: 3, pageSize: 50 });
    expect(zPagination.safeParse({ pageSize: '500' }).success).toBe(false);
    expect(zBoolQuery.parse('true')).toBe(true);
    expect(zBoolQuery.parse('false')).toBe(false);
    expect(zBoolQuery.parse(undefined)).toBeUndefined();
  });
});
