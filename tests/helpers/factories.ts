import { jest } from '@jest/globals';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { db } from '../../src/db/client';
import { eq } from 'drizzle-orm';
import { batches, coachSessions, feePlans, locations, users } from '../../src/db/schema';
import { hashPassword } from '../../src/modules/auth/password';
import { signAccessToken } from '../../src/modules/auth/tokens';
import {
  createStudent,
  type CreateStudentInput,
} from '../../src/modules/students/students.service';

let app: Express | undefined;
export function getApp(): Express {
  return (app ??= createApp());
}

/**
 * Freezes only `Date` (timers keep running so the DB and HTTP stack work) at the given IST day.
 * 06:30 UTC = 12:00 IST, comfortably inside the same calendar day in both zones.
 */
export function setToday(isoDate: string, time = '06:30:00'): void {
  jest.useFakeTimers({
    now: new Date(`${isoDate}T${time}Z`),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export const PASSWORD = 'Passw0rd!123';

export async function makeUser(
  role: 'admin' | 'coach',
  overrides: Partial<typeof users.$inferInsert> & { withPassword?: boolean } = {},
) {
  const { withPassword = false, ...rest } = overrides;
  const [u] = await db
    .insert(users)
    .values({
      email: `${role}-${uniq()}@example.com`,
      name: role === 'admin' ? 'Admin User' : `Coach ${uniq()}`,
      role,
      status: 'active',
      passwordHash: withPassword ? await hashPassword(PASSWORD) : null,
      ...rest,
    })
    .returning();
  return u!;
}

export async function tokenFor(user: {
  id: string;
  role: 'admin' | 'coach';
  tokenVersion?: number;
}) {
  const { token } = await signAccessToken({
    sub: user.id,
    role: user.role,
    tv: user.tokenVersion ?? 0,
  });
  return token;
}

/** Authenticated supertest helpers. */
export async function as(user: { id: string; role: 'admin' | 'coach'; tokenVersion?: number }) {
  const token = await tokenFor(user);
  const auth = { Authorization: `Bearer ${token}` };
  const a = getApp();
  return {
    get: (url: string) => request(a).get(url).set(auth),
    post: (url: string, body?: object) => request(a).post(url).set(auth).send(body),
    put: (url: string, body?: object) => request(a).put(url).set(auth).send(body),
    patch: (url: string, body?: object) => request(a).patch(url).set(auth).send(body),
    delete: (url: string) => request(a).delete(url).set(auth),
  };
}

export async function makeLocation(overrides: Partial<typeof locations.$inferInsert> = {}) {
  const [l] = await db
    .insert(locations)
    .values({
      name: `Ground ${uniq()}`,
      latitude: 12.9716,
      longitude: 77.5946,
      radiusMeters: 200,
      ...overrides,
    })
    .returning();
  return l!;
}

export async function makeBatch(
  coachId: string,
  locationId: string,
  overrides: Partial<typeof batches.$inferInsert> = {},
) {
  const [b] = await db
    .insert(batches)
    .values({
      name: `Batch ${uniq()}`,
      coachId,
      locationId,
      weekdays: [1, 2, 3, 4, 5, 6],
      startTime: '06:00:00',
      endTime: '08:00:00',
      ...overrides,
    })
    .returning();
  return b!;
}

export async function makePlan(overrides: Partial<typeof feePlans.$inferInsert> = {}) {
  const [p] = await db
    .insert(feePlans)
    .values({ name: `Plan ${uniq()}`, daysPerWeek: 3, monthlyFee: 250_000, ...overrides })
    .returning();
  return p!;
}

export async function makeStudent(
  input: Pick<CreateStudentInput, 'batchId' | 'feePlanId'> & Partial<CreateStudentInput>,
  actorId: string,
) {
  return createStudent(
    db,
    {
      fullName: `Student ${uniq()}`,
      phone: '+919876543210',
      joiningDate: '2026-01-10',
      trainingDays: [1, 3, 5],
      billingStartsOn: input.joiningDate ?? '2026-01-10',
      ...input,
    },
    actorId,
  );
}

/** A ready-made academy: admin, coach, location, batch (Mon–Sat), 3-day plan. */
export async function makeAcademy() {
  const admin = await makeUser('admin');
  const coach = await makeUser('coach');
  const otherCoach = await makeUser('coach');
  const location = await makeLocation();
  const batch = await makeBatch(coach.id, location.id);
  const otherBatch = await makeBatch(otherCoach.id, location.id, {
    startTime: '17:00:00',
    endTime: '19:00:00',
  });
  const plan = await makePlan();
  return { admin, coach, otherCoach, location, batch, otherBatch, plan };
}

/** Records an on-site check-in so the coach may mark attendance for those sessions. */
export async function checkIn(coachId: string, batchId: string, ...dates: string[]) {
  const b = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  for (const date of dates) {
    await db
      .insert(coachSessions)
      .values({
        coachId,
        batchId,
        locationId: b!.locationId,
        date,
        checkInAt: new Date(`${date}T00:30:00Z`),
        checkInLat: 0,
        checkInLng: 0,
        checkInDistanceM: 0,
        checkInWithinFence: true,
      })
      .onConflictDoNothing();
  }
}
