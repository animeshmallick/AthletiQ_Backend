/**
 * Data-scoping rules shared by every module:
 *  - Admins can see and manage everything.
 *  - Coaches can only touch batches they own and students currently enrolled in those batches
 *    (plus, for attendance on a given day, makeup students visiting their batch).
 *  - A substitute coach can run a batch's sessions on the days they cover it (approved
 *    substitutions only) — never its students' fees or details.
 */
import { and, eq, gte, inArray, isNull, lte, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import { batchSubstitutions, batches, enrollments } from '../../db/schema/index.js';
import { todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import type { AuthUser } from '../auth/auth.types.js';

export const isAdmin = (user: AuthUser) => user.role === 'admin';

export async function getBatchOrThrow(batchId: string) {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) throw AppError.notFound('Batch');
  return batch;
}

/**
 * Is `userId` an approved substitute for the batch — on `on`, or (without a date) for any
 * current or upcoming day?
 */
export async function isSubstituteFor(userId: string, batchId: string, on?: IsoDate) {
  const [row] = await db
    .select({ id: batchSubstitutions.id })
    .from(batchSubstitutions)
    .where(
      and(
        eq(batchSubstitutions.batchId, batchId),
        eq(batchSubstitutions.substituteCoachId, userId),
        eq(batchSubstitutions.status, 'approved'),
        on
          ? and(lte(batchSubstitutions.fromDate, on), gte(batchSubstitutions.toDate, on))
          : gte(batchSubstitutions.toDate, todayInAppTz()),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Loads a batch and checks the user may act on it: admins, the batch's coach, or its approved
 * substitute (on `on` when given). `mainOnly` keeps substitutes out (e.g. whole-history views).
 */
export async function assertBatchAccess(
  user: AuthUser,
  batchId: string,
  { on, mainOnly = false }: { on?: IsoDate; mainOnly?: boolean } = {},
) {
  const batch = await getBatchOrThrow(batchId);
  if (isAdmin(user) || batch.coachId === user.id) return batch;
  if (!mainOnly && (await isSubstituteFor(user.id, batchId, on))) return batch;
  throw AppError.notFound('Batch');
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
