import { describe, expect, it } from '@jest/globals';
import { instantAt } from '../../src/lib/dates';
import {
  belongsTo,
  buildSessions,
  isRegularDay,
  rosterDay,
  sessionOrigin,
  type BatchTiming,
  type ChangeRow,
} from '../../src/modules/schedule/schedule';

// Mon / Wed / Fri 06:00–08:00, Fridays 07:00–09:00. 2026-03-09 is a Monday.
const batch: BatchTiming = {
  id: 'b1',
  weekdays: [1, 3, 5],
  startTime: '06:00:00',
  endTime: '08:00:00',
  dayTimes: { '5': { start: '07:00:00', end: '09:00:00' } },
};
const change = (c: Partial<ChangeRow>): ChangeRow => ({
  id: 'c1',
  batchId: 'b1',
  kind: 'reschedule',
  originalDate: '2026-03-11',
  date: '2026-03-12',
  startTime: '17:00:00',
  endTime: '18:00:00',
  ...c,
});

describe('buildSessions', () => {
  it('lists the regular days at their own times', () => {
    const s = buildSessions(batch, [], '2026-03-09', '2026-03-15');
    expect(s.map((x) => [x.date, x.startTime, x.kind])).toEqual([
      ['2026-03-09', '06:00:00', 'regular'],
      ['2026-03-11', '06:00:00', 'regular'],
      ['2026-03-13', '07:00:00', 'regular'],
    ]);
    expect(s[0]).toMatchObject({ originalDate: null, changeId: null });
  });

  it('moves a session to another day and drops it from its regular day', () => {
    const s = buildSessions(batch, [change({})], '2026-03-09', '2026-03-15');
    expect(s.map((x) => x.date)).toEqual(['2026-03-09', '2026-03-12', '2026-03-13']);
    expect(s[1]).toMatchObject({
      kind: 'moved',
      originalDate: '2026-03-11',
      startTime: '17:00:00',
      changeId: 'c1',
    });
  });

  it('drops the regular day even when the new day is outside the range (and vice versa)', () => {
    const away = buildSessions(batch, [change({ date: '2026-03-17' })], '2026-03-09', '2026-03-15');
    expect(away.map((x) => x.date)).toEqual(['2026-03-09', '2026-03-13']);
    const into = buildSessions(
      batch,
      [change({ originalDate: '2026-03-06', date: '2026-03-10' })],
      '2026-03-09',
      '2026-03-15',
    );
    expect(into.map((x) => x.date)).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-13',
    ]);
  });

  it('keeps a same-day time change on its day at the new time', () => {
    const s = buildSessions(
      batch,
      [change({ date: '2026-03-11', startTime: '18:00:00', endTime: '19:30:00' })],
      '2026-03-11',
      '2026-03-11',
    );
    expect(s).toEqual([
      expect.objectContaining({
        date: '2026-03-11',
        kind: 'moved',
        startTime: '18:00:00',
        endTime: '19:30:00',
      }),
    ]);
  });

  it('adds extra sessions and ignores other batches’ changes', () => {
    const s = buildSessions(
      batch,
      [
        change({ id: 'x', kind: 'extra', originalDate: null, date: '2026-03-15' }),
        change({ id: 'y', batchId: 'other' }),
      ],
      '2026-03-09',
      '2026-03-15',
    );
    expect(s.map((x) => [x.date, x.kind])).toEqual([
      ['2026-03-09', 'regular'],
      ['2026-03-11', 'regular'],
      ['2026-03-13', 'regular'],
      ['2026-03-15', 'extra'],
    ]);
    expect(sessionOrigin(s[3]!)).toEqual({ kind: 'extra', originalDate: null, changeId: 'x' });
  });

  it('knows regular days', () => {
    expect(isRegularDay(batch, '2026-03-09')).toBe(true);
    expect(isRegularDay(batch, '2026-03-10')).toBe(false);
  });
});

describe('who belongs to a session', () => {
  const member = {
    batchId: 'b1',
    effectiveFrom: '2026-03-01',
    effectiveTo: null as string | null,
    trainingDays: [1, 3, 5],
  };
  const [moved] = buildSessions(batch, [change({})], '2026-03-12', '2026-03-12');
  const [extra] = buildSessions(
    batch,
    [change({ kind: 'extra', originalDate: null, date: '2026-03-15' })],
    '2026-03-15',
    '2026-03-15',
  );

  it('uses the original day for a moved session', () => {
    expect(rosterDay(moved!)).toBe('2026-03-11');
    expect(belongsTo(member, moved!)).toBe(true);
    // Left the day before the original day → not expected, even if the new day is later.
    expect(belongsTo({ ...member, effectiveTo: '2026-03-10' }, moved!)).toBe(false);
    // Joined after the original day.
    expect(belongsTo({ ...member, effectiveFrom: '2026-03-12' }, moved!)).toBe(false);
  });

  it('expects every member at an extra session', () => {
    expect(rosterDay(extra!)).toBe('2026-03-15');
    expect(belongsTo({ ...member, trainingDays: [1] }, extra!)).toBe(true);
    expect(belongsTo({ ...member, batchId: 'other' }, extra!)).toBe(false);
    expect(belongsTo({ ...member, effectiveFrom: '2026-03-16' }, extra!)).toBe(false);
  });
});

describe('instantAt', () => {
  it('reads wall-clock times in IST (UTC+05:30)', () => {
    expect(instantAt('2026-03-09', '06:00:00').toISOString()).toBe('2026-03-09T00:30:00.000Z');
    expect(instantAt('2026-03-09', '00:15').toISOString()).toBe('2026-03-08T18:45:00.000Z');
    expect(instantAt('2026-12-31', '23:59:59').toISOString()).toBe('2026-12-31T18:29:59.000Z');
  });
});
