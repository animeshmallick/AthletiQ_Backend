/**
 * Admin review of makeup requests made by coaches. Mounted at /api/v1/makeups (admin only).
 */
import { and, asc, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { batches, enrollments, makeupSessions, students, users } from '../../db/schema/index.js';
import { onDay, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zIdParam } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { getCancellation } from '../attendance/cancellations.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { notifyInBackground, notifyUsers } from '../push/push.service.js';

export const makeupsRouter = Router();

const batchCoach = alias(users, 'batch_coach');
const homeBatch = alias(batches, 'home_batch');
const homeCoach = alias(users, 'home_coach');
const requester = alias(users, 'requester');

const ListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
});

makeupsRouter.get('/', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [];
  if (q.status !== 'all') filters.push(eq(makeupSessions.status, q.status));
  const rows = await db
    .select({
      id: makeupSessions.id,
      date: makeupSessions.date,
      missedDate: makeupSessions.missedDate,
      reason: makeupSessions.reason,
      status: makeupSessions.status,
      createdAt: makeupSessions.createdAt,
      reviewedAt: makeupSessions.reviewedAt,
      reviewNote: makeupSessions.reviewNote,
      student: { id: students.id, code: students.code, fullName: students.fullName },
      batch: {
        id: batches.id,
        name: batches.name,
        startTime: batches.startTime,
        endTime: batches.endTime,
      },
      batchCoach: { id: batchCoach.id, name: batchCoach.name },
      homeBatch: { id: homeBatch.id, name: homeBatch.name },
      homeCoach: { id: homeCoach.id, name: homeCoach.name },
      requestedBy: { id: requester.id, name: requester.name },
    })
    .from(makeupSessions)
    .innerJoin(students, eq(students.id, makeupSessions.studentId))
    .innerJoin(batches, eq(batches.id, makeupSessions.batchId))
    .innerJoin(batchCoach, eq(batchCoach.id, batches.coachId))
    .leftJoin(
      enrollments,
      and(eq(enrollments.studentId, students.id), isNull(enrollments.effectiveTo)),
    )
    .leftJoin(homeBatch, eq(homeBatch.id, enrollments.batchId))
    .leftJoin(homeCoach, eq(homeCoach.id, homeBatch.coachId))
    .leftJoin(requester, eq(requester.id, makeupSessions.createdById))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(q.status === 'pending' ? asc(makeupSessions.date) : desc(makeupSessions.createdAt))
    .limit(200);
  ok(
    res,
    rows.map((r) => ({
      ...r,
      // The session is with a different coach than the student's regular one.
      otherCoach: !!r.homeCoach?.id && r.homeCoach.id !== r.batchCoach.id,
    })),
  );
});

async function loadPending(id: string) {
  const m = await db.query.makeupSessions.findFirst({ where: eq(makeupSessions.id, id) });
  if (!m) throw AppError.notFound('Makeup request');
  if (m.status !== 'pending') throw AppError.conflict(`This request was already ${m.status}`);
  return m;
}

makeupsRouter.post('/:id/approve', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const user = currentUser(req);
  const m = await loadPending(id);
  if (m.date < todayInAppTz()) throw AppError.unprocessable('This session date has already passed');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, m.batchId) });
  if (!batch?.isActive) throw AppError.unprocessable('That batch is no longer active');
  const cancelled = await getCancellation(m.batchId, m.date);
  if (cancelled) throw AppError.unprocessable(`That session was cancelled (${cancelled.reason})`);

  const [saved] = await db
    .update(makeupSessions)
    .set({ status: 'approved', reviewedById: user.id, reviewedAt: new Date() })
    .where(and(eq(makeupSessions.id, id), eq(makeupSessions.status, 'pending')))
    .returning();
  if (!saved) throw AppError.conflict('This request was just reviewed by someone else');
  await audit({
    ...auditCtx(req),
    action: 'student.makeup_approved',
    entityType: 'student',
    entityId: m.studentId,
    metadata: { makeupId: id, date: m.date, batchId: m.batchId },
  });
  const student = await db.query.students.findFirst({ where: eq(students.id, m.studentId) });
  notifyInBackground(() =>
    notifyUsers(
      [m.createdById, batch.coachId].filter((x): x is string => !!x),
      {
        title: 'Makeup approved',
        body: `${student?.fullName ?? 'Student'} · ${batch.name} ${onDay(m.date)}`,
        link: `/attendance?batch=${batch.id}&date=${m.date}`,
        tag: `makeup-${id}`,
      },
    ),
  );
  ok(res, saved);
});

makeupsRouter.post('/:id/reject', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { reason } = parse(
    z.object({ reason: z.string().trim().min(3, 'Please give a reason').max(500) }),
    req.body,
  );
  const user = currentUser(req);
  const m = await loadPending(id);
  const [saved] = await db
    .update(makeupSessions)
    .set({ status: 'rejected', reviewedById: user.id, reviewedAt: new Date(), reviewNote: reason })
    .where(and(eq(makeupSessions.id, id), eq(makeupSessions.status, 'pending')))
    .returning();
  if (!saved) throw AppError.conflict('This request was just reviewed by someone else');
  await audit({
    ...auditCtx(req),
    action: 'student.makeup_rejected',
    entityType: 'student',
    entityId: m.studentId,
    metadata: { makeupId: id, reason },
  });
  const student = await db.query.students.findFirst({ where: eq(students.id, m.studentId) });
  if (m.createdById) {
    const to = m.createdById;
    notifyInBackground(() =>
      notifyUsers([to], {
        title: 'Makeup not approved',
        body: `${student?.fullName ?? 'Student'} ${onDay(m.date)}: ${reason}`,
        link: `/students/${m.studentId}`,
        tag: `makeup-${id}`,
      }),
    );
  }
  ok(res, saved);
});
