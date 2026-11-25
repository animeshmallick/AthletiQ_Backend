/**
 * Memberships ending: planned (a stopped renewal or a future leaving date, applied by the nightly
 * job) or now (an admin exits the student, deciding what happens to unpaid invoices).
 *
 * Money: paid invoices are never touched. Nothing is credited or refunded. Unpaid invoices are
 * cancelled (months after the last day, or the running month when nothing was attended), marked
 * lost (when an admin picks them) or stay due.
 */
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import {
  batches,
  enrollments,
  invoices,
  makeupSessions,
  studentAttendance,
  students,
} from '../../db/schema/index.js';
import {
  addDays,
  formatDisplayDate,
  maxDate,
  todayInAppTz,
  type IsoDate,
} from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatInr } from '../../lib/money.js';
import { audit } from '../audit/audit.service.js';
import { noticeStudentJoined, noticeStudentLeft } from '../push/coach-notices.js';
import { notifyAdmins, notifyInBackground } from '../push/push.service.js';
import { dropMakeups } from '../schedule/makeups.js';
import { assertJoinable, moveEnrollment, NO_PLAN } from '../students/students.service.js';
import { syncCycles } from './cycles.js';

type Enrollment = typeof enrollments.$inferSelect;

/** Adds a dated line to the student's notes. */
export async function appendNote(tx: DbOrTx, studentId: string, line: string, on: IsoDate) {
  const entry = `[${formatDisplayDate(on)}] ${line}`;
  await tx
    .update(students)
    .set({
      notes: sql`case when coalesce(${students.notes}, '') = '' then ${entry}::text else ${students.notes} || E'\n' || ${entry}::text end`,
    })
    .where(eq(students.id, studentId));
}

/** Unpaid invoices for months that start after the last day are never owed. */
export async function cancelLaterInvoices(tx: DbOrTx, enrollmentIds: string[], lastDay: IsoDate) {
  if (!enrollmentIds.length) return [];
  return tx
    .update(invoices)
    .set({ status: 'cancelled', cancelledReason: `Left on ${formatDisplayDate(lastDay)}` })
    .where(
      and(
        inArray(invoices.enrollmentId, enrollmentIds),
        eq(invoices.status, 'due'),
        gt(invoices.periodStart, lastDay),
      ),
    )
    .returning({ id: invoices.id, number: invoices.number });
}

/** The student has no membership left: they leave the academy as of `lastDay`. */
async function leaveIfLast(tx: DbOrTx, studentId: string, lastDay: IsoDate, reason: string | null) {
  const open = await tx.$count(
    enrollments,
    and(eq(enrollments.studentId, studentId), isNull(enrollments.effectiveTo)),
  );
  if (open) return false;
  await tx
    .update(students)
    .set({ status: 'left', leftOn: lastDay, leftReason: reason })
    .where(and(eq(students.id, studentId), eq(students.status, 'active')));
  await tx
    .delete(makeupSessions)
    .where(and(eq(makeupSessions.studentId, studentId), gt(makeupSessions.date, lastDay)));
  return true;
}

/** Ends a membership on `lastDay` (today or earlier): cycles closed, later invoices cancelled. */
export async function endMembership(
  tx: DbOrTx,
  e: Enrollment,
  lastDay: IsoDate,
  reason: string | null,
  today: IsoDate,
) {
  await tx
    .update(enrollments)
    .set({ effectiveTo: lastDay, ...NO_PLAN })
    .where(eq(enrollments.id, e.id));
  await dropMakeups(tx, e.studentId, e.batchId, lastDay);
  const cancelled = await cancelLaterInvoices(tx, [e.id], lastDay);
  await syncCycles(tx, e.id, today);
  const leftAcademy = await leaveIfLast(tx, e.studentId, lastDay, reason);
  return { cancelled, leftAcademy };
}

/** Nightly: planned ends whose day has passed. Each is its own transaction; safe to repeat. */
export async function applyPlannedEnds(today: IsoDate = todayInAppTz()) {
  const due = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(isNull(enrollments.effectiveTo), lt(enrollments.plannedEndOn, today)))
    .orderBy(asc(enrollments.plannedEndOn));
  const stats = { ended: 0, moved: 0, failed: 0 };
  for (const { id } of due) {
    try {
      const done = await db.transaction((tx) => applyPlannedEnd(tx, id, today));
      if (!done) continue;
      if (done.movedTo) {
        stats.moved++;
        notifyInBackground(() => noticeStudentJoined(done.studentId, done.movedTo));
      } else stats.ended++;
      notifyInBackground(() =>
        noticeStudentLeft(done.studentId, done.batchId, done.lastDay, done.leftAcademy),
      );
      if (done.problem)
        notifyInBackground(() =>
          notifyAdmins({
            category: 'approvals',
            icon: '⚠️',
            title: 'A planned batch move could not be made',
            body: `${done.problem} The student has no batch from ${formatDisplayDate(addDays(done.lastDay, 1))}; nothing is billed.`,
            link: `/students/${done.studentId}`,
            tag: `move-${id}`,
          }),
        );
    } catch (err) {
      stats.failed++;
      logger.error({ err, enrollmentId: id }, 'Planned end failed');
    }
  }
  return stats;
}

async function applyPlannedEnd(tx: DbOrTx, id: string, today: IsoDate) {
  const [e] = await tx.select().from(enrollments).where(eq(enrollments.id, id)).for('update');
  if (!e?.plannedEndOn || e.effectiveTo || e.plannedEndOn >= today) return null;
  const base = { studentId: e.studentId, batchId: e.batchId, lastDay: e.plannedEndOn };
  if (e.plannedMoveToId) {
    let problem: string | null = null;
    try {
      await assertJoinable(e.plannedMoveToId, tx, { studentId: e.studentId });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      problem = err.message;
    }
    if (!problem) {
      const movedTo = e.plannedMoveToId;
      await moveEnrollment(tx, {
        studentId: e.studentId,
        enrollmentId: e.id,
        toBatchId: movedTo,
        effectiveFrom: addDays(e.plannedEndOn, 1),
        reason: e.plannedReason ?? 'Moved at the end of the cycle',
        actorId: e.plannedById,
      });
      await cancelLaterInvoices(tx, [e.id], e.plannedEndOn);
      return { ...base, movedTo, leftAcademy: false, problem: null };
    }
    // The destination closed meanwhile: end here, keep the student active for an admin to place.
    await tx
      .update(enrollments)
      .set({ effectiveTo: e.plannedEndOn, ...NO_PLAN })
      .where(eq(enrollments.id, e.id));
    await dropMakeups(tx, e.studentId, e.batchId, e.plannedEndOn);
    await cancelLaterInvoices(tx, [e.id], e.plannedEndOn);
    await syncCycles(tx, e.id, today);
    return { ...base, movedTo: null, leftAcademy: false, problem };
  }
  const { leftAcademy } = await endMembership(tx, e, e.plannedEndOn, e.plannedReason, today);
  await audit(
    {
      actorId: e.plannedById,
      action: 'renewal.ended',
      entityType: 'student',
      entityId: e.studentId,
      metadata: { enrollmentId: e.id, batchId: e.batchId, lastDay: e.plannedEndOn, leftAcademy },
    },
    tx,
  );
  return { ...base, movedTo: null, leftAcademy, problem: null };
}

// ─── Exit now ────────────────────────────────────────────────────────────────

export interface ExitInvoice {
  id: string;
  number: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  amount: number;
  running: boolean;
  /** Present or late in that month (in this batch). */
  attended: number;
  /** cancel: nothing used, always cancelled. lost: ticked as lost by default. due: stays due. */
  suggestion: 'cancel' | 'lost' | 'due';
}

/** What an exit on `lastDay` would do to each unpaid invoice of the membership. */
export async function exitInvoices(
  tx: DbOrTx,
  e: Enrollment,
  lastDay: IsoDate,
  lock = false,
): Promise<ExitInvoice[]> {
  const q = tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.enrollmentId, e.id), eq(invoices.status, 'due')))
    .orderBy(asc(invoices.periodStart));
  const rows = lock ? await q.for('update') : await q;
  const out: ExitInvoice[] = [];
  for (const i of rows) {
    const running = i.periodStart <= lastDay && i.periodEnd >= lastDay;
    const attended = await tx.$count(
      studentAttendance,
      and(
        eq(studentAttendance.studentId, e.studentId),
        eq(studentAttendance.batchId, e.batchId),
        inArray(studentAttendance.status, ['present', 'late']),
        gte(studentAttendance.date, i.periodStart),
        lte(studentAttendance.date, i.periodEnd),
      ),
    );
    const later = i.periodStart > lastDay;
    out.push({
      id: i.id,
      number: i.number,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      amount: i.totalAmount,
      running,
      attended,
      suggestion: later || (running && !attended) ? 'cancel' : running ? 'lost' : 'due',
    });
  }
  return out;
}

export interface ExitInput {
  enrollmentId: string;
  reason: string;
  /** Move to this batch from tomorrow; otherwise they leave. */
  moveToBatchId?: string | null;
  lostInvoiceIds: string[];
}

/** Exits a student today. One transaction: a payment arriving at the same moment wins. */
export async function exitNow(
  input: ExitInput,
  ctx: { actorId: string; ipAddress: string | null },
  today: IsoDate = todayInAppTz(),
) {
  return db.transaction(async (tx) => {
    const [e] = await tx
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, input.enrollmentId))
      .for('update');
    if (!e) throw AppError.notFound('Membership');
    if (e.effectiveTo) throw AppError.conflict('That membership has already ended');
    const [b] = await tx.select().from(batches).where(eq(batches.id, e.batchId));
    const lastDay = maxDate(today, e.effectiveFrom);
    if (input.moveToBatchId && e.effectiveFrom > today)
      throw AppError.unprocessable(
        'They haven’t started yet. Exit them, then add the other batch.',
      );

    const list = await exitInvoices(tx, e, lastDay, true);
    const known = new Map(list.map((i) => [i.id, i]));
    for (const id of input.lostInvoiceIds) {
      const inv = known.get(id);
      // Not due any more (e.g. just paid), or not this membership's.
      if (!inv) throw AppError.conflict('One of those invoices is no longer unpaid. Check again.');
      if (inv.suggestion === 'cancel')
        throw AppError.badRequest(`${inv.number} is cancelled, so it can’t be marked lost`);
    }
    const lost = list.filter((i) => input.lostInvoiceIds.includes(i.id));
    const cancel = list.filter((i) => i.suggestion === 'cancel');
    if (lost.length)
      await tx
        .update(invoices)
        .set({
          status: 'lost',
          lostReason: input.reason,
          lostAt: new Date(),
          lostById: ctx.actorId,
        })
        .where(
          inArray(
            invoices.id,
            lost.map((i) => i.id),
          ),
        );
    if (cancel.length)
      await tx
        .update(invoices)
        .set({ status: 'cancelled', cancelledReason: `Exited on ${formatDisplayDate(lastDay)}` })
        .where(
          inArray(
            invoices.id,
            cancel.map((i) => i.id),
          ),
        );

    let leftAcademy = false;
    if (input.moveToBatchId) {
      await moveEnrollment(tx, {
        studentId: e.studentId,
        enrollmentId: e.id,
        toBatchId: input.moveToBatchId,
        effectiveFrom: addDays(lastDay, 1),
        reason: input.reason,
        actorId: ctx.actorId,
      });
    } else ({ leftAcademy } = await endMembership(tx, e, lastDay, input.reason, today));

    const lostTotal = lost.reduce((n, i) => n + i.amount, 0);
    await appendNote(
      tx,
      e.studentId,
      `${input.moveToBatchId ? 'Moved out of' : 'Exited'} ${b?.name ?? 'batch'}: ${input.reason}.${
        lost.length
          ? ` ${formatInr(lostTotal)} written off as lost (${lost.map((i) => i.number).join(', ')}).`
          : ''
      }`,
      today,
    );
    await audit(
      {
        ...ctx,
        action: 'renewal.exited',
        entityType: 'student',
        entityId: e.studentId,
        metadata: {
          enrollmentId: e.id,
          batchId: e.batchId,
          lastDay,
          reason: input.reason,
          moveToBatchId: input.moveToBatchId ?? null,
          lost: lost.map((i) => ({ id: i.id, amount: i.amount })),
          cancelled: cancel.map((i) => i.id),
          leftAcademy,
        },
      },
      tx,
    );
    return {
      studentId: e.studentId,
      batchId: e.batchId,
      lastDay,
      lost: lost.length,
      lostTotal,
      cancelled: cancel.length,
      leftAcademy,
    };
  });
}

/** Plans the last day of a membership (and where they go next, holding that seat). */
export async function planEnd(
  tx: DbOrTx,
  e: Enrollment,
  input: { on: IsoDate; reason: string | null; actorId: string; moveToId?: string | null },
) {
  if (input.moveToId) {
    if (input.moveToId === e.batchId) throw AppError.badRequest('Pick a different batch');
    await assertJoinable(input.moveToId, tx, { studentId: e.studentId });
  }
  await tx
    .update(enrollments)
    .set({
      plannedEndOn: input.on,
      plannedReason: input.reason,
      plannedById: input.actorId,
      plannedAt: new Date(),
      plannedMoveToId: input.moveToId ?? null,
    })
    .where(and(eq(enrollments.id, e.id), isNull(enrollments.effectiveTo)));
}
