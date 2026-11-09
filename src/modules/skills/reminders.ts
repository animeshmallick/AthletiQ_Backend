import { and, count, eq, isNull, notExists } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { batches, enrollments, skillAssessments } from '../../db/schema/index.js';
import { monthStart } from './framework.js';

/** Students in a coach's own (active) batches without an assessment for the month of `day`. */
export async function pendingAssessments(coachId: string, day: string): Promise<number> {
  const month = monthStart(day);
  const [row] = await db
    .select({ n: count() })
    .from(enrollments)
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .where(
      and(
        eq(batches.coachId, coachId),
        eq(batches.isActive, true),
        isNull(enrollments.effectiveTo),
        notExists(
          db
            .select({ one: skillAssessments.id })
            .from(skillAssessments)
            .where(
              and(
                eq(skillAssessments.studentId, enrollments.studentId),
                eq(skillAssessments.batchId, batches.id),
                eq(skillAssessments.month, month),
              ),
            ),
        ),
      ),
    );
  return row?.n ?? 0;
}
