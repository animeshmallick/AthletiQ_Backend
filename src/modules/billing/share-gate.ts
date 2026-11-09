/**
 * Shared links (reports, invoices) open only after the parent types the student's registration
 * number. Five wrong numbers in a row lock that link for 30 minutes, so the 4-digit number can't
 * simply be guessed.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { shareLinkAttempts, students } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';

export const MAX_ATTEMPTS = 5;
export const LOCK_MINUTES = 30;

export async function checkRegistrationNo(
  key: string,
  studentId: string,
  registrationNo: string,
  now: Date = new Date(),
): Promise<void> {
  const attempt = await db.query.shareLinkAttempts.findFirst({
    where: eq(shareLinkAttempts.key, key),
  });
  if (attempt?.lockedUntil && attempt.lockedUntil > now) {
    const mins = Math.ceil((attempt.lockedUntil.getTime() - now.getTime()) / 60_000);
    throw new AppError(
      'RATE_LIMITED',
      `Too many wrong registration numbers. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
    );
  }
  const student = await db.query.students.findFirst({
    columns: { registrationNo: true },
    where: eq(students.id, studentId),
  });
  if (student && String(student.registrationNo) === registrationNo.trim()) {
    if (attempt) await db.delete(shareLinkAttempts).where(eq(shareLinkAttempts.key, key));
    return;
  }

  // Wrong: count it (atomically), and lock after too many.
  const [row] = await db
    .insert(shareLinkAttempts)
    .values({ key, failures: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: shareLinkAttempts.key,
      set: {
        // A lock that has expired starts a fresh count.
        failures: sql`case when ${shareLinkAttempts.lockedUntil} is not null then 1 else ${shareLinkAttempts.failures} + 1 end`,
        lockedUntil: null,
        updatedAt: now,
      },
    })
    .returning();
  const failures = row?.failures ?? 1;
  if (failures >= MAX_ATTEMPTS) {
    await db
      .update(shareLinkAttempts)
      .set({ lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000), failures: 0 })
      .where(eq(shareLinkAttempts.key, key));
    throw new AppError(
      'RATE_LIMITED',
      `Too many wrong registration numbers. Try again in ${LOCK_MINUTES} minutes.`,
    );
  }
  const left = MAX_ATTEMPTS - failures;
  throw new AppError(
    'FORBIDDEN',
    `That registration number doesn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
  );
}
