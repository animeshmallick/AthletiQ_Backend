/**
 * Data-scoping rules shared by every module:
 *  - Admins can see and manage everything.
 *  - Coaches can only touch batches they own and students currently enrolled in those batches
 *    (plus, for attendance on a given day, makeup students visiting their batch).
 */
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import { batches, enrollments } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import type { AuthUser } from '../auth/auth.types.js';

export const isAdmin = (user: AuthUser) => user.role === 'admin';

export async function getBatchOrThrow(batchId: string) {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) throw AppError.notFound('Batch');
  return batch;
}

/** Loads a batch and checks the user may act on it. */
export async function assertBatchAccess(user: AuthUser, batchId: string) {
  const batch = await getBatchOrThrow(batchId);
  if (!isAdmin(user) && batch.coachId !== user.id) throw AppError.notFound('Batch');
  return batch;
}

/** Throws 404 (not 403, to avoid leaking existence) if a coach does not currently coach the student. */
export async function assertStudentAccess(user: AuthUser, studentId: string): Promise<void> {
  if (isAdmin(user)) return;
  const [row] = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .where(
      and(
        eq(enrollments.studentId, studentId),
        isNull(enrollments.effectiveTo),
        eq(batches.coachId, user.id),
      ),
    )
    .limit(1);
  if (!row) throw AppError.notFound('Student');
}

/**
 * SQL predicate restricting a query over `students` to those the coach currently coaches.
 * Returns undefined for admins (no restriction).
 */
export function studentScope(user: AuthUser, studentIdColumn: AnyPgColumn): SQL | undefined {
  if (isAdmin(user)) return undefined;
  // Built with the query builder (not raw SQL) so column references are always table-qualified,
  // regardless of the shape of the outer query.
  const coached = db
    .select({ id: enrollments.studentId })
    .from(enrollments)
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .where(and(isNull(enrollments.effectiveTo), eq(batches.coachId, user.id)));
  return inArray(studentIdColumn, coached);
}
