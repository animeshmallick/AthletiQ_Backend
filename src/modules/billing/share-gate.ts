/**
 * Shared links (reports, invoices) open only after the parent types the student's registration
 * number. Five wrong numbers in a row lock that link for 30 minutes, so the 4-digit number can't
 * simply be guessed.
 */
import { eq } from 'drizzle-orm';
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
  // One attempt at a time per link, so many guesses sent together can't slip past the lock.
  const result = await db.transaction(async (tx) => {
    await tx.insert(shareLinkAttempts).values({ key, updatedAt: now }).onConflictDoNothing();
    const [attempt] = await tx
      .select()
      .from(shareLinkAttempts)
      .where(eq(shareLinkAttempts.key, key))
      .for('update');
    if (attempt?.lockedUntil && attempt.lockedUntil > now)
      return {
        locked: Math.ceil((attempt.lockedUntil.getTime() - now.getTime()) / 60_000),
      };
    const student = await tx.query.students.findFirst({
      columns: { registrationNo: true },
      where: eq(students.id, studentId),
    });
    if (student && String(student.registrationNo) === registrationNo.trim()) {
      await tx.delete(shareLinkAttempts).where(eq(shareLinkAttempts.key, key));
      return { ok: true };
    }
    // Wrong: count it, and lock after too many. A lock that has expired starts a fresh count.
    const failures = (attempt?.lockedUntil ? 0 : (attempt?.failures ?? 0)) + 1;
    const lock = failures >= MAX_ATTEMPTS;
    await tx
      .update(shareLinkAttempts)
      .set({
        failures: lock ? 0 : failures,
        lockedUntil: lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null,
        updatedAt: now,
      })
      .where(eq(shareLinkAttempts.key, key));
    return lock ? { locked: LOCK_MINUTES } : { left: MAX_ATTEMPTS - failures };
  });
  // Thrown outside, so the count above is kept.
  if (result.ok) return;
  if (result.locked)
    throw new AppError(
      'RATE_LIMITED',
      `Too many wrong registration numbers. Try again in ${result.locked} minute${result.locked === 1 ? '' : 's'}.`,
    );
  throw new AppError(
    'FORBIDDEN',
    `That registration number doesn't match. ${result.left} ${result.left === 1 ? 'try' : 'tries'} left.`,
  );
}
