import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  coachSessions,
  sessionCancellations,
  studentAttendance,
  users,
} from '../../db/schema/index.js';
import { addDays, diffDays, isoWeekday, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { created, noContent, ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zIsoDate } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { assertBatchAccess } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { noticeSessionCancelled } from '../push/coach-notices.js';
import { notifyInBackground } from '../push/push.service.js';

/** Cancellation for one session, or null. */
export async function getCancellation(batchId: string, date: IsoDate) {
  const row = await db.query.sessionCancellations.findFirst({
    where: and(eq(sessionCancellations.batchId, batchId), eq(sessionCancellations.date, date)),
  });
  return row ? { reason: row.reason, cancelledAt: row.createdAt } : null;
}

/** Map of `${batchId}:${date}` → reason for the given batches and range. */
export async function cancellationsIn(
  batchIds: string[],
  from: IsoDate,
  to: IsoDate,
): Promise<Map<string, string>> {
  if (!batchIds.length) return new Map();
  const rows = await db
    .select({
      batchId: sessionCancellations.batchId,
      date: sessionCancellations.date,
      reason: sessionCancellations.reason,
    })
    .from(sessionCancellations)
    .where(
      and(
        inArray(sessionCancellations.batchId, batchIds),
        gte(sessionCancellations.date, from),
        lte(sessionCancellations.date, to),
      ),
    );
  return new Map(rows.map((r) => [`${r.batchId}:${r.date}`, r.reason]));
}

export async function assertNotCancelled(batchId: string, date: IsoDate) {
  const c = await getCancellation(batchId, date);
  if (c) throw AppError.unprocessable(`This session was cancelled (${c.reason})`);
}

/** Mounted at /batches. Admins and the batch's coach can cancel or restore sessions. */
export const cancellationsRouter = Router();

/** How far ahead a session can be cancelled (e.g. announced holidays). */
const MAX_DAYS_AHEAD = 90;
/** Coaches can cancel up to a week back (e.g. forgot to record a rain-out); admins anytime. */
const COACH_DAYS_BACK = 7;

cancellationsRouter.get('/:id/cancellations', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const q = parse(z.object({ from: zIsoDate.optional(), to: zIsoDate.optional() }), req.query);
  await assertBatchAccess(currentUser(req), id);
  const from = q.from ?? addDays(todayInAppTz(), -30);
  const to = q.to ?? addDays(todayInAppTz(), MAX_DAYS_AHEAD);
  const rows = await db
    .select({
      id: sessionCancellations.id,
      date: sessionCancellations.date,
      reason: sessionCancellations.reason,
      createdAt: sessionCancellations.createdAt,
      cancelledBy: { id: users.id, name: users.name },
    })
    .from(sessionCancellations)
    .leftJoin(users, eq(users.id, sessionCancellations.cancelledById))
    .where(
      and(
        eq(sessionCancellations.batchId, id),
        gte(sessionCancellations.date, from),
        lte(sessionCancellations.date, to),
      ),
    )
    .orderBy(asc(sessionCancellations.date));
  ok(res, rows);
});

const CancelBody = z.object({
  date: zIsoDate,
  reason: z.string().trim().min(3, 'Please give a reason').max(300),
});

cancellationsRouter.post('/:id/cancellations', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(CancelBody, req.body);
  const user = currentUser(req);
  const batch = await assertBatchAccess(user, id, { on: body.date });
  const today = todayInAppTz();

  if (!batch.weekdays.includes(isoWeekday(body.date))) {
    throw AppError.unprocessable(`${batch.name} does not run on that day`);
  }
  if (diffDays(today, body.date) > MAX_DAYS_AHEAD) {
    throw AppError.unprocessable(`Sessions can be cancelled up to ${MAX_DAYS_AHEAD} days ahead`);
  }
  if (user.role === 'coach' && diffDays(body.date, today) > COACH_DAYS_BACK) {
    throw AppError.unprocessable(
      `Coaches can cancel sessions up to ${COACH_DAYS_BACK} days back. Ask an admin for older dates.`,
    );
  }

  const [marks, checkIns] = await Promise.all([
    db.$count(
      studentAttendance,
      and(eq(studentAttendance.batchId, id), eq(studentAttendance.date, body.date)),
    ),
    db.$count(coachSessions, and(eq(coachSessions.batchId, id), eq(coachSessions.date, body.date))),
  ]);
  if (marks > 0 || checkIns > 0) {
    throw AppError.unprocessable(
      'Attendance or a coach check-in is already recorded for this session, so it happened. Correct those records instead of cancelling.',
      { attendance: marks, checkIns },
    );
  }

  const [row] = await db
    .insert(sessionCancellations)
    .values({ batchId: id, date: body.date, reason: body.reason, cancelledById: user.id })
    .returning();
  await audit({
    ...auditCtx(req),
    action: 'session.cancelled',
    entityType: 'batch',
    entityId: id,
    metadata: body,
  });
  notifyInBackground(() => noticeSessionCancelled(id, body.date, user.id, body.reason));
  created(res, row);
});

cancellationsRouter.delete('/:id/cancellations/:date', async (req, res) => {
  const { id, date } = parse(z.object({ id: zId, date: zIsoDate }), req.params);
  const user = currentUser(req);
  await assertBatchAccess(user, id, { on: date });
  const [row] = await db
    .delete(sessionCancellations)
    .where(and(eq(sessionCancellations.batchId, id), eq(sessionCancellations.date, date)))
    .returning();
  if (!row) throw AppError.notFound('Cancellation');
  await audit({
    ...auditCtx(req),
    action: 'session.restored',
    entityType: 'batch',
    entityId: id,
    metadata: { date, reason: row.reason },
  });
  notifyInBackground(() => noticeSessionCancelled(id, date, user.id, row.reason, true));
  noContent(res);
});
