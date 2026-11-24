/**
 * Course rounds: counting, completion (with its billing consequences), undo, replay, decisions.
 *
 * Money rules (see PLAN-course-rounds.md §7):
 *  - A round completes on the day of the session that reaches the target. The membership ends
 *    that day, so no later month is billed.
 *  - Months already invoiced that start after that day: unpaid → cancelled; paid → credited in full.
 *  - The month the completion falls in, when it is an extension month (past the course length):
 *    the sessions of it not needed are given back: unpaid → the invoice is reduced; paid → credit.
 *  - Credits wait (held) for the admin's decision: re-admit / move → the new membership's first
 *    invoice(s); leave → refund due or forfeited.
 *  - Every money step is recorded on the round so an attendance correction can undo it exactly.
 *    If it can't be undone exactly (paid since, credit used), nothing changes and admins are told.
 *
 * All changes run in one transaction per round, serialised by an advisory lock.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import {
  batches,
  courseRounds,
  enrollments,
  invoices,
  makeupSessions,
  payments,
  studentAttendance,
  studentCredits,
  students,
  type RoundAdjustment,
} from '../../db/schema/index.js';
import {
  addDays,
  formatDisplayDate,
  maxDate,
  minDate,
  todayInAppTz,
  type IsoDate,
} from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatInr } from '../../lib/money.js';
import { audit } from '../audit/audit.service.js';
import { billOnAcceptance } from '../billing/invoice-generator.js';
import {
  notifyAdmins,
  notifyInBackground,
  notifyOnce,
  notifyUsers,
  activeAdminIds,
} from '../push/push.service.js';
import { assertJoinable } from '../students/students.service.js';
import { releaseApplied } from './credits.js';
import {
  courseTarget,
  reachedOn,
  replayRounds,
  roundMonth,
  sessionsPerMonth,
  unusedValue,
} from './course-math.js';

export const LOCK = 0x43525345; // "CRSE"
/** Days an admin has to decide before the student is left automatically. */
export const DECISION_DAYS = 30;
/** How far ahead a re-admission / move can start. */
export const START_DAYS_AHEAD = 30;

type Enrollment = typeof enrollments.$inferSelect;
type Batch = typeof batches.$inferSelect;
type Round = typeof courseRounds.$inferSelect;

const anchorOf = (e: Pick<Enrollment, 'billingAnchorDate' | 'effectiveFrom'>) =>
  e.billingAnchorDate ?? e.effectiveFrom;
const ATTENDED = ['present', 'late'] as const;

async function lock(tx: DbOrTx) {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
}

// ─── Counting ────────────────────────────────────────────────────────────────

/**
 * Days of the sessions that count for a membership from `from` (to `to`), oldest first: present
 * or late in the batch itself, plus makeups attended elsewhere for it. One entry per session.
 */
export async function countedDates(
  tx: DbOrTx,
  e: Pick<Enrollment, 'studentId' | 'batchId' | 'effectiveFrom' | 'effectiveTo'>,
  from: IsoDate,
  to?: IsoDate | null,
): Promise<IsoDate[]> {
  const lo = maxDate(from, e.effectiveFrom);
  const ends = [to, e.effectiveTo].filter((d): d is IsoDate => !!d);
  const hi = ends.length ? ends.reduce(minDate) : null;
  if (hi && hi < lo) return [];
  const range = (col: typeof studentAttendance.date) =>
    and(gte(col, lo), hi ? lte(col, hi) : undefined);
  const [own, away] = await Promise.all([
    tx
      .select({ date: studentAttendance.date })
      .from(studentAttendance)
      .where(
        and(
          eq(studentAttendance.studentId, e.studentId),
          eq(studentAttendance.batchId, e.batchId),
          inArray(studentAttendance.status, [...ATTENDED]),
          range(studentAttendance.date),
        ),
      ),
    tx
      .select({ date: studentAttendance.date })
      .from(studentAttendance)
      .innerJoin(
        makeupSessions,
        and(
          eq(makeupSessions.studentId, studentAttendance.studentId),
          eq(makeupSessions.batchId, studentAttendance.batchId),
          eq(makeupSessions.date, studentAttendance.date),
        ),
      )
      .where(
        and(
          eq(studentAttendance.studentId, e.studentId),
          ne(studentAttendance.batchId, e.batchId),
          eq(makeupSessions.homeBatchId, e.batchId),
          inArray(studentAttendance.status, [...ATTENDED]),
          range(studentAttendance.date),
        ),
      ),
  ]);
  return [...own, ...away].map((r) => r.date).sort();
}

// ─── Opening rounds ──────────────────────────────────────────────────────────

/** Starts round `roundNo` for a membership of a batch that has a course. */
export async function openRound(
  tx: DbOrTx,
  e: Pick<Enrollment, 'id' | 'studentId' | 'batchId'>,
  startedOn: IsoDate,
  roundNo = 1,
) {
  const [b] = await tx
    .select({ courseMonths: batches.courseMonths })
    .from(batches)
    .where(eq(batches.id, e.batchId));
  if (!b?.courseMonths) return null;
  const [r] = await tx
    .insert(courseRounds)
    .values({
      enrollmentId: e.id,
      studentId: e.studentId,
      batchId: e.batchId,
      roundNo,
      startedOn,
    })
    .returning();
  return r!;
}

/**
 * First time a batch gets a course: each current member's attendance is replayed month by month.
 * Past completions are recorded as automatically re-admitted (history only, billing untouched);
 * the round in progress continues from the day after the last one.
 */
export async function replayBatch(tx: DbOrTx, batch: Batch, today: IsoDate) {
  if (!batch.courseMonths) return { members: 0, historical: 0 };
  const target = courseTarget(batch.weekdays, batch.courseMonths);
  const members = await tx
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.batchId, batch.id), isNull(enrollments.effectiveTo)));
  let historical = 0;
  for (const e of members) {
    const has = await tx.$count(courseRounds, eq(courseRounds.enrollmentId, e.id));
    if (has) continue;
    const dates = await countedDates(tx, e, e.effectiveFrom, today);
    const { completed, openFrom } = replayRounds(dates, target, e.effectiveFrom, (d) =>
      addDays(d, 1),
    );
    if (completed.length)
      await tx.insert(courseRounds).values(
        completed.map((c, i) => ({
          enrollmentId: e.id,
          studentId: e.studentId,
          batchId: batch.id,
          roundNo: i + 1,
          startedOn: c.startedOn,
          status: 'readmitted' as const,
          completedOn: c.completedOn,
          attended: target,
          target,
          historical: true,
          note: 'Completed before the course was set up (re-admitted automatically)',
        })),
      );
    historical += completed.length;
    await tx.insert(courseRounds).values({
      enrollmentId: e.id,
      studentId: e.studentId,
      batchId: batch.id,
      roundNo: completed.length + 1,
      startedOn: openFrom,
    });
  }
  return { members: members.length, historical };
}

// ─── Completion ──────────────────────────────────────────────────────────────

async function hasCompletedPayment(tx: DbOrTx, invoiceId: string) {
  return (
    (await tx.$count(
      payments,
      and(eq(payments.invoiceId, invoiceId), eq(payments.status, 'completed')),
    )) > 0
  );
}

async function holdCredit(
  tx: DbOrTx,
  round: Round,
  amount: number,
  sourceInvoiceId: string,
  reason: string,
) {
  const [c] = await tx
    .insert(studentCredits)
    .values({
      studentId: round.studentId,
      kind: 'course_unused',
      amount,
      status: 'held',
      enrollmentId: round.enrollmentId,
      roundId: round.id,
      sourceInvoiceId,
      reason,
    })
    .returning({ id: studentCredits.id });
  return c!.id;
}

const appendNote = (notes: string | null, line: string) => (notes ? `${notes}\n${line}` : line);

/** Applies the money rules for a completion on `completedOn`; returns the steps taken. */
async function settleInvoices(
  tx: DbOrTx,
  round: Round,
  e: Enrollment,
  b: Batch,
  dates: IsoDate[],
  completedOn: IsoDate,
): Promise<RoundAdjustment[]> {
  const perMonth = sessionsPerMonth(b.weekdays);
  const steps: RoundAdjustment[] = [];
  const list = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.enrollmentId, e.id),
        inArray(invoices.status, ['due', 'paid']),
        gte(invoices.periodEnd, completedOn),
      ),
    )
    .orderBy(asc(invoices.periodStart))
    .for('update');
  for (const inv of list) {
    const before = {
      status: inv.status,
      discountAmount: inv.discountAmount,
      totalAmount: inv.totalAmount,
      paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
    };
    const period = `${formatDisplayDate(inv.periodStart)} – ${formatDisplayDate(inv.periodEnd)}`;
    // What the month was worth to the family: what they pay plus any credit used on it.
    const monthValue = inv.totalAmount + inv.creditAmount;
    const paid = inv.status === 'paid';

    if (inv.periodStart > completedOn) {
      // A whole month after the course ended.
      if (!paid) {
        const released = await releaseApplied(tx, inv.id, { status: 'held', roundId: round.id });
        await tx
          .update(invoices)
          .set({
            status: 'cancelled',
            cancelledReason: `Course completed on ${formatDisplayDate(completedOn)}`,
          })
          .where(eq(invoices.id, inv.id));
        steps.push({
          invoiceId: inv.id,
          action: 'cancelled',
          amount: inv.totalAmount,
          before,
          after: {
            status: 'cancelled',
            discountAmount: inv.discountAmount,
            totalAmount: inv.totalAmount,
          },
          createdCreditIds: [],
          releasedCreditIds: released,
        });
      } else if (monthValue > 0) {
        const id = await holdCredit(
          tx,
          round,
          monthValue,
          inv.id,
          `${inv.number}: month ${period} not needed (course completed ${formatDisplayDate(completedOn)})`,
        );
        steps.push({
          invoiceId: inv.id,
          action: 'credited',
          amount: monthValue,
          before,
          after: {
            status: inv.status,
            discountAmount: inv.discountAmount,
            totalAmount: inv.totalAmount,
          },
          createdCreditIds: [id],
          releasedCreditIds: [],
        });
      }
      continue;
    }

    // The month the course completed in: only an extension month gives sessions back.
    if (roundMonth(anchorOf(e), round.startedOn, completedOn) <= (b.courseMonths ?? 0)) continue;
    const used = dates.filter((d) => d >= inv.periodStart && d <= completedOn).length;
    const back = unusedValue(monthValue, perMonth, used);
    if (back <= 0) continue;
    const unused = Math.max(0, perMonth - used);
    const why = `${unused} of ${perMonth} sessions of ${period} not needed (course completed ${formatDisplayDate(completedOn)})`;
    if (!paid) {
      const cut = Math.min(back, inv.totalAmount);
      const totalAmount = inv.totalAmount - cut;
      const discountAmount = inv.discountAmount + cut;
      const status = totalAmount === 0 ? ('paid' as const) : ('due' as const);
      await tx
        .update(invoices)
        .set({
          discountAmount,
          totalAmount,
          status,
          paidAt: status === 'paid' ? new Date() : null,
          notes: appendNote(inv.notes, `Reduced by ${formatInr(cut)}: ${why}`),
        })
        .where(eq(invoices.id, inv.id));
      const created =
        back > cut
          ? [await holdCredit(tx, round, back - cut, inv.id, `${inv.number}: ${why}`)]
          : [];
      steps.push({
        invoiceId: inv.id,
        action: 'reduced',
        amount: back,
        before,
        after: { status, discountAmount, totalAmount },
        createdCreditIds: created,
        releasedCreditIds: [],
      });
    } else {
      const id = await holdCredit(tx, round, back, inv.id, `${inv.number}: ${why}`);
      steps.push({
        invoiceId: inv.id,
        action: 'credited',
        amount: back,
        before,
        after: {
          status: inv.status,
          discountAmount: inv.discountAmount,
          totalAmount: inv.totalAmount,
        },
        createdCreditIds: [id],
        releasedCreditIds: [],
      });
    }
  }
  return steps;
}

/** Can every money step of a completion still be reversed exactly? Returns why not, or null. */
async function undoBlocker(tx: DbOrTx, round: Round): Promise<string | null> {
  for (const a of round.adjustments) {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, a.invoiceId))
      .for('update');
    if (!inv) return 'An invoice it changed no longer exists';
    if (
      inv.status !== a.after.status ||
      inv.discountAmount !== a.after.discountAmount ||
      inv.totalAmount !== a.after.totalAmount
    )
      return `${inv.number} was changed since`;
    if (a.action === 'reduced' && (await hasCompletedPayment(tx, inv.id)))
      return `${inv.number} was paid since`;
    const ids = [...a.createdCreditIds, ...a.releasedCreditIds];
    if (ids.length) {
      const held = await tx.$count(
        studentCredits,
        and(inArray(studentCredits.id, ids), eq(studentCredits.status, 'held')),
      );
      if (held !== ids.length) return 'A credit from it was already used or settled';
    }
  }
  return null;
}

/** Reverses a completion exactly (the caller checked `undoBlocker`). */
async function reverse(tx: DbOrTx, round: Round, actorId: string | null) {
  for (const a of round.adjustments) {
    if (a.action === 'cancelled') {
      await tx
        .update(invoices)
        .set({ status: 'due', cancelledReason: null })
        .where(eq(invoices.id, a.invoiceId));
      if (a.releasedCreditIds.length)
        await tx
          .update(studentCredits)
          .set({ status: 'applied', appliedInvoiceId: a.invoiceId })
          .where(inArray(studentCredits.id, a.releasedCreditIds));
    } else if (a.action === 'reduced') {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, a.invoiceId));
      await tx
        .update(invoices)
        .set({
          status: a.before.status as 'due' | 'paid',
          discountAmount: a.before.discountAmount,
          totalAmount: a.before.totalAmount,
          paidAt: a.before.paidAt ? new Date(a.before.paidAt) : null,
          notes: appendNote(inv!.notes, 'Reduction undone: course completion was undone'),
        })
        .where(eq(invoices.id, a.invoiceId));
    }
    if (a.createdCreditIds.length)
      await tx
        .update(studentCredits)
        .set({ status: 'void', note: 'Course completion was undone' })
        .where(inArray(studentCredits.id, a.createdCreditIds));
  }
  await tx
    .update(enrollments)
    .set({ effectiveTo: null })
    .where(
      and(eq(enrollments.id, round.enrollmentId), eq(enrollments.effectiveTo, round.completedOn!)),
    );
  const [r] = await tx
    .update(courseRounds)
    .set({ status: 'active', completedOn: null, attended: null, target: null, adjustments: [] })
    .where(eq(courseRounds.id, round.id))
    .returning();
  await audit(
    {
      actorId,
      action: 'course.completion_undone',
      entityType: 'student',
      entityId: round.studentId,
      metadata: {
        roundId: round.id,
        completedOn: round.completedOn,
        adjustments: round.adjustments,
      },
    },
    tx,
  );
  return r!;
}

export type EvaluationResult =
  | { result: 'none' }
  | { result: 'completed'; round: Round; adjustments: RoundAdjustment[] }
  | { result: 'undone'; round: Round }
  | { result: 'stuck'; round: Round; why: string };

/**
 * Brings one round in line with attendance: completes it when the target is reached, undoes a
 * completion that no longer holds (and re-completes it on the right day if needed).
 */
export async function evaluateRound(
  tx: DbOrTx,
  roundId: string,
  today: IsoDate,
  actorId: string | null = null,
): Promise<EvaluationResult> {
  let [round] = await tx
    .select()
    .from(courseRounds)
    .where(eq(courseRounds.id, roundId))
    .for('update');
  if (!round || !['active', 'awaiting'].includes(round.status)) return { result: 'none' };
  const [b] = await tx.select().from(batches).where(eq(batches.id, round.batchId));
  const [e] = await tx
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, round.enrollmentId))
    .for('update');
  if (!b?.courseMonths || !e) return { result: 'none' };

  let undone = false;
  if (round.status === 'awaiting') {
    const held = await countedDates(tx, e, round.startedOn, round.completedOn);
    if (held.length >= (round.target ?? 0)) return { result: 'none' };
    const why = await undoBlocker(tx, round);
    if (why) return { result: 'stuck', round, why };
    round = await reverse(tx, round, actorId);
    e.effectiveTo = null;
    undone = true;
  }

  const target = courseTarget(b.weekdays, b.courseMonths);
  const dates = await countedDates(tx, e, round.startedOn, today);
  const reached = reachedOn(dates, target);
  if (!reached) return undone ? { result: 'undone', round } : { result: 'none' };
  let completedOn = b.courseSetOn && b.courseSetOn > reached ? b.courseSetOn : reached;
  if (completedOn > today) completedOn = today;
  if (e.effectiveTo && completedOn > e.effectiveTo) return { result: 'none' };

  const counted = dates.filter((d) => d <= completedOn);
  const adjustments = await settleInvoices(tx, round, e, b, counted, completedOn);
  await tx
    .update(enrollments)
    .set({ effectiveTo: completedOn })
    .where(
      and(
        eq(enrollments.id, e.id),
        or(isNull(enrollments.effectiveTo), sql`${enrollments.effectiveTo} > ${completedOn}`),
      ),
    );
  // Makeups booked to count for this batch after it ended are no longer needed.
  const dropped = await tx
    .delete(makeupSessions)
    .where(
      and(
        eq(makeupSessions.studentId, e.studentId),
        eq(makeupSessions.homeBatchId, b.id),
        sql`${makeupSessions.date} > ${completedOn}`,
        inArray(makeupSessions.status, ['pending', 'approved']),
      ),
    )
    .returning({ id: makeupSessions.id });
  const [done] = await tx
    .update(courseRounds)
    .set({
      status: 'awaiting',
      completedOn,
      attended: counted.length,
      target,
      adjustments,
    })
    .where(eq(courseRounds.id, round.id))
    .returning();
  await audit(
    {
      actorId,
      action: 'course.completed',
      entityType: 'student',
      entityId: e.studentId,
      metadata: {
        roundId: round.id,
        batchId: b.id,
        roundNo: round.roundNo,
        completedOn,
        attended: counted.length,
        target,
        adjustments,
        makeupsDropped: dropped.length,
      },
    },
    tx,
  );
  return { result: 'completed', round: done!, adjustments };
}

// ─── Running evaluations ─────────────────────────────────────────────────────

async function noticeCompleted(round: Round, adjustments: RoundAdjustment[]) {
  const [row] = await db
    .select({ name: students.fullName, batch: batches.name, coachId: batches.coachId })
    .from(students)
    .innerJoin(batches, eq(batches.id, round.batchId))
    .where(eq(students.id, round.studentId));
  if (!row) return;
  const back = adjustments.reduce((n, a) => n + (a.action === 'cancelled' ? 0 : a.amount), 0);
  const cancelled = adjustments.filter((a) => a.action === 'cancelled').length;
  const money = [
    cancelled ? `${cancelled} later invoice${cancelled === 1 ? '' : 's'} cancelled` : '',
    back ? `${formatInr(back)} to credit` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  await notifyAdmins({
    category: 'approvals',
    icon: '🎓',
    actions: [{ label: 'Decide', link: '/courses' }],
    title: `Course completed · ${row.name}`,
    body: `${row.batch} · round ${round.roundNo} (${round.attended}/${round.target}). Re-admit, move or leave?${money ? ` ${money}.` : ''}`,
    link: '/courses',
    tag: `course-${round.id}`,
  });
  await notifyUsers([row.coachId], {
    category: 'sessions',
    icon: '🎓',
    title: `${row.name} completed the course`,
    body: `${row.batch} · round ${round.roundNo}. Paused from your roster until an admin decides.`,
    link: '/',
    tag: `course-${round.id}`,
  });
}

async function noticeStuck(round: Round, why: string) {
  const [s] = await db
    .select({ name: students.fullName })
    .from(students)
    .where(eq(students.id, round.studentId));
  await notifyOnce(`course-stuck:${round.id}:${round.completedOn}`, await activeAdminIds(), {
    category: 'approvals',
    icon: '⚠️',
    title: `Check ${s?.name ?? 'a student'}'s course completion`,
    body: `Attendance changed and the course is no longer complete, but it can't be undone automatically: ${why}.`,
    link: `/students/${round.studentId}`,
    tag: `course-stuck-${round.id}`,
  });
}

/** Decided completions (re-admitted / moved / left) that attendance no longer supports. */
async function checkDecided(roundIds: string[]) {
  if (!roundIds.length) return;
  const rows = await db
    .select({ round: courseRounds, e: enrollments })
    .from(courseRounds)
    .innerJoin(enrollments, eq(enrollments.id, courseRounds.enrollmentId))
    .where(inArray(courseRounds.id, roundIds));
  for (const { round, e } of rows) {
    const held = await countedDates(db, e, round.startedOn, round.completedOn);
    if (held.length < (round.target ?? 0))
      await noticeStuck(round, 'a decision was already made for it');
  }
}

/**
 * Evaluates rounds (each in its own transaction, so one problem can't block the rest): every open
 * round of batches with a course, or only those of the given students. Never throws.
 */
export async function evaluateCourses(
  today: IsoDate = todayInAppTz(),
  opts: { studentIds?: string[]; batchId?: string; actorId?: string | null } = {},
) {
  const scope = and(
    opts.studentIds ? inArray(courseRounds.studentId, opts.studentIds) : undefined,
    opts.batchId ? eq(courseRounds.batchId, opts.batchId) : undefined,
  );
  const open = await db
    .select({ id: courseRounds.id })
    .from(courseRounds)
    .innerJoin(batches, eq(batches.id, courseRounds.batchId))
    .where(
      and(
        scope,
        inArray(courseRounds.status, ['active', 'awaiting']),
        isNotNull(batches.courseMonths),
      ),
    );
  const stats = { evaluated: open.length, completed: 0, undone: 0, stuck: 0, failed: 0 };
  for (const { id } of open) {
    try {
      const r = await db.transaction(async (tx) => {
        await lock(tx);
        return evaluateRound(tx, id, today, opts.actorId ?? null);
      });
      if (r.result === 'completed') {
        stats.completed++;
        notifyInBackground(() => noticeCompleted(r.round, r.adjustments));
      } else if (r.result === 'undone') {
        stats.undone++;
        notifyInBackground(() => billOnAcceptance(r.round.studentId));
      } else if (r.result === 'stuck') {
        stats.stuck++;
        notifyInBackground(() => noticeStuck(r.round, r.why));
      }
    } catch (err) {
      stats.failed++;
      logger.error({ err, roundId: id }, 'Course evaluation failed');
    }
  }
  // Recent decisions whose basis changed are flagged for admins (never changed automatically).
  if (opts.studentIds?.length) {
    const decided = await db
      .select({ id: courseRounds.id })
      .from(courseRounds)
      .where(
        and(
          scope,
          inArray(courseRounds.status, ['readmitted', 'moved', 'left']),
          eq(courseRounds.historical, false),
          isNotNull(courseRounds.completedOn),
          gte(courseRounds.completedOn, addDays(today, -90)),
        ),
      );
    await checkDecided(decided.map((d) => d.id)).catch((err: unknown) =>
      logger.warn({ err }, 'Course decision check failed'),
    );
  }
  return stats;
}

// ─── Decisions ───────────────────────────────────────────────────────────────

export interface Decision {
  action: 'readmit' | 'move' | 'leave';
  /** readmit / move: first day in the batch (billing restarts that day). */
  startsOn?: IsoDate;
  /** move: the batch to continue in. */
  batchId?: string;
  customMonthlyFee?: number | null;
  monthlyDiscount?: number;
  /** leave, when credit is waiting: pay it back, or keep it. */
  credit?: 'refund' | 'forfeit';
  /** The admin saw the outstanding dues and goes ahead. */
  confirmDues?: boolean;
  note?: string | null;
}

/** Unpaid invoices of a student (all batches). */
export async function outstandingDues(tx: DbOrTx, studentId: string) {
  const [row] = await tx
    .select({
      amount: sql<number>`coalesce(sum(${invoices.totalAmount}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(invoices)
    .where(and(eq(invoices.studentId, studentId), eq(invoices.status, 'due')));
  return row ?? { amount: 0, count: 0 };
}

/** Credits that follow this round's decision: held for it, or still assigned to its membership. */
function creditsOf(round: Round) {
  return or(
    and(eq(studentCredits.roundId, round.id), eq(studentCredits.status, 'held')),
    and(
      eq(studentCredits.enrollmentId, round.enrollmentId),
      inArray(studentCredits.status, ['held', 'assigned']),
    ),
  );
}

export async function decide(
  roundId: string,
  d: Decision,
  actorId: string | null,
  today: IsoDate = todayInAppTz(),
  opts: { auto?: boolean } = {},
) {
  const out = await db.transaction(async (tx) => {
    await lock(tx);
    const [round] = await tx
      .select()
      .from(courseRounds)
      .where(eq(courseRounds.id, roundId))
      .for('update');
    if (!round) throw AppError.notFound('Course round');
    if (round.status !== 'awaiting')
      throw AppError.conflict(
        `This course was already ${round.status === 'active' ? 'reopened' : 'decided'}`,
      );
    const [e] = await tx.select().from(enrollments).where(eq(enrollments.id, round.enrollmentId));
    const [s] = await tx
      .select()
      .from(students)
      .where(eq(students.id, round.studentId))
      .for('update');
    if (!e || !s) throw AppError.notFound('Student');

    const dues = await outstandingDues(tx, s.id);
    if (dues.amount > 0 && !d.confirmDues && !opts.auto)
      throw AppError.conflict(
        `${s.fullName} has ${formatInr(dues.amount)} unpaid (${dues.count} invoice${dues.count === 1 ? '' : 's'}). Confirm to go ahead.`,
        { dues },
      );
    const credits = await tx.select().from(studentCredits).where(creditsOf(round)).for('update');
    const creditTotal = credits.reduce((n, c) => n + c.amount, 0);
    const base = {
      decidedById: actorId,
      decidedAt: new Date(),
      note: d.note ?? round.note ?? null,
    };

    if (d.action === 'leave') {
      if (credits.length && !d.credit)
        throw new AppError(
          'VALIDATION_ERROR',
          `Choose what happens to the ${formatInr(creditTotal)} credit`,
          {
            fields: [{ path: 'credit', message: 'Refund or forfeit' }],
          },
        );
      if (credits.length)
        await tx
          .update(studentCredits)
          .set(
            d.credit === 'refund'
              ? { status: 'refund_due' }
              : {
                  status: 'forfeited',
                  settledById: actorId,
                  settledAt: new Date(),
                  note: d.note ?? null,
                },
          )
          .where(
            inArray(
              studentCredits.id,
              credits.map((c) => c.id),
            ),
          );
      await tx
        .update(courseRounds)
        .set({ ...base, status: 'left', autoLeft: !!opts.auto })
        .where(eq(courseRounds.id, round.id));
      // The academy, when this was their last batch (and nothing else is waiting on a decision).
      const [openCount, waiting] = await Promise.all([
        tx.$count(
          enrollments,
          and(eq(enrollments.studentId, s.id), isNull(enrollments.effectiveTo)),
        ),
        tx.$count(
          courseRounds,
          and(
            eq(courseRounds.studentId, s.id),
            eq(courseRounds.status, 'awaiting'),
            ne(courseRounds.id, round.id),
          ),
        ),
      ]);
      const leftAcademy = !openCount && !waiting && s.status === 'active';
      if (leftAcademy) {
        await tx
          .update(students)
          .set({
            status: 'left',
            leftOn: maxDate(round.completedOn!, s.joiningDate),
            leftReason: opts.auto
              ? 'Course completed (no decision in 30 days)'
              : 'Course completed',
          })
          .where(eq(students.id, s.id));
        await tx
          .delete(makeupSessions)
          .where(
            and(
              eq(makeupSessions.studentId, s.id),
              sql`${makeupSessions.date} > ${round.completedOn}`,
            ),
          );
      }
      await audit(
        {
          actorId,
          action: opts.auto ? 'course.auto_left' : 'course.left',
          entityType: 'student',
          entityId: s.id,
          metadata: { roundId: round.id, credit: d.credit ?? null, creditTotal, leftAcademy, dues },
        },
        tx,
      );
      return { studentId: s.id, enrollmentId: null as string | null, leftAcademy, creditTotal };
    }

    // Re-admit / move: a new membership whose billing starts on its first day.
    if (s.status !== 'active') throw AppError.unprocessable(`${s.fullName} has left the academy`);
    const startsOn = d.startsOn ?? maxDate(today, addDays(round.completedOn!, 1));
    if (startsOn <= round.completedOn!)
      throw AppError.badRequest(
        `Choose a day after the course ended (${formatDisplayDate(round.completedOn!)})`,
      );
    if (startsOn > addDays(today, START_DAYS_AHEAD))
      throw AppError.badRequest(`Choose a day within the next ${START_DAYS_AHEAD} days`);
    const toBatchId = d.action === 'readmit' ? round.batchId : d.batchId;
    if (!toBatchId) throw AppError.badRequest('Choose the batch to move to');
    if (d.action === 'move' && toBatchId === round.batchId)
      throw AppError.badRequest('Choose a different batch (or re-admit to the same one)');
    // Their own reserved seat is free for a re-admission.
    const batch = await assertJoinable(toBatchId, tx, {
      studentId: s.id,
      excludeStudentId: d.action === 'readmit' ? s.id : undefined,
    });
    const [next] = await tx
      .insert(enrollments)
      .values({
        studentId: s.id,
        batchId: batch.id,
        trainingDays: [...batch.weekdays].sort((x, y) => x - y),
        effectiveFrom: startsOn,
        reason:
          d.action === 'readmit'
            ? `Re-admitted (round ${round.roundNo + 1})`
            : 'Moved after completing the course',
        customMonthlyFee:
          d.customMonthlyFee !== undefined ? d.customMonthlyFee : e.customMonthlyFee,
        monthlyDiscount: d.monthlyDiscount ?? e.monthlyDiscount,
        billingStartsOn: startsOn,
        createdById: actorId,
      })
      .returning();
    const nextRound = await openRound(
      tx,
      next!,
      startsOn,
      d.action === 'readmit' ? round.roundNo + 1 : 1,
    );
    if (credits.length)
      await tx
        .update(studentCredits)
        .set({ status: 'assigned', enrollmentId: next!.id })
        .where(
          inArray(
            studentCredits.id,
            credits.map((c) => c.id),
          ),
        );
    await tx
      .update(courseRounds)
      .set({
        ...base,
        status: d.action === 'readmit' ? 'readmitted' : 'moved',
        nextEnrollmentId: next!.id,
      })
      .where(eq(courseRounds.id, round.id));
    await audit(
      {
        actorId,
        action: d.action === 'readmit' ? 'course.readmitted' : 'course.moved',
        entityType: 'student',
        entityId: s.id,
        metadata: {
          roundId: round.id,
          fromBatchId: round.batchId,
          toBatchId: batch.id,
          startsOn,
          enrollmentId: next!.id,
          nextRoundId: nextRound?.id ?? null,
          creditTotal,
          dues,
        },
      },
      tx,
    );
    return { studentId: s.id, enrollmentId: next!.id, leftAcademy: false, creditTotal };
  });
  if (out.enrollmentId) await billOnAcceptance(out.studentId);
  return out;
}

/** Awaiting decisions older than 30 days: the student leaves (credit owed back). */
export async function autoLeave(today: IsoDate = todayInAppTz()) {
  const stale = await db
    .select({ id: courseRounds.id })
    .from(courseRounds)
    .where(
      and(
        eq(courseRounds.status, 'awaiting'),
        lte(courseRounds.completedOn, addDays(today, -DECISION_DAYS)),
      ),
    );
  let left = 0;
  for (const { id } of stale) {
    try {
      await decide(id, { action: 'leave', credit: 'refund' }, null, today, { auto: true });
      left++;
    } catch (err) {
      logger.error({ err, roundId: id }, 'Automatic course leave failed');
    }
  }
  return { autoLeft: left };
}

/** Once a day: admins hear how many course decisions are waiting. */
export async function remindDecisions(today: IsoDate = todayInAppTz()) {
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      oldest: sql<IsoDate | null>`min(${courseRounds.completedOn})`,
    })
    .from(courseRounds)
    .where(eq(courseRounds.status, 'awaiting'));
  if (!row?.n) return { waiting: 0 };
  await notifyOnce(`course-decisions:${today}`, await activeAdminIds(), {
    category: 'approvals',
    icon: '🎓',
    actions: [{ label: 'Decide', link: '/courses' }],
    title: `${row.n} course decision${row.n === 1 ? '' : 's'} waiting`,
    body: `Students who completed their course are paused. Undecided after ${DECISION_DAYS} days, they leave automatically${row.oldest ? ` (oldest: ${formatDisplayDate(addDays(row.oldest, DECISION_DAYS))})` : ''}.`,
    link: '/courses',
    tag: 'course-decisions',
  });
  return { waiting: row.n };
}

// ─── Membership guards and leaving ───────────────────────────────────────────

/**
 * Memberships ending (leaving a batch or the academy): open rounds end as left, a waiting
 * completion counts as a decision to leave (its credit is owed back), and credit assigned to
 * these memberships is owed back.
 */
export async function closeRounds(
  tx: DbOrTx,
  input: {
    studentId: string;
    enrollmentIds: string[];
    leftOn: IsoDate;
    actorId: string | null;
    academy: boolean;
  },
) {
  const { studentId, enrollmentIds, leftOn, actorId } = input;
  if (enrollmentIds.length)
    await tx
      .update(courseRounds)
      .set({
        status: 'left',
        completedOn: leftOn,
        decidedById: actorId,
        decidedAt: new Date(),
        note: 'Left mid-course',
      })
      .where(
        and(inArray(courseRounds.enrollmentId, enrollmentIds), eq(courseRounds.status, 'active')),
      );
  // Leaving the academy also ends completions still waiting on a decision (any batch).
  const waiting = input.academy
    ? await tx
        .select({ id: courseRounds.id, enrollmentId: courseRounds.enrollmentId })
        .from(courseRounds)
        .where(and(eq(courseRounds.studentId, studentId), eq(courseRounds.status, 'awaiting')))
    : [];
  if (waiting.length) {
    await tx
      .update(courseRounds)
      .set({ status: 'left', decidedById: actorId, decidedAt: new Date() })
      .where(
        inArray(
          courseRounds.id,
          waiting.map((w) => w.id),
        ),
      );
    await tx
      .update(studentCredits)
      .set({ status: 'refund_due' })
      .where(
        and(
          inArray(
            studentCredits.roundId,
            waiting.map((w) => w.id),
          ),
          eq(studentCredits.status, 'held'),
        ),
      );
  }
  const ids = [...enrollmentIds, ...waiting.map((w) => w.enrollmentId)];
  if (ids.length)
    await tx
      .update(studentCredits)
      .set({ status: 'refund_due' })
      .where(
        and(
          inArray(studentCredits.enrollmentId, ids),
          inArray(studentCredits.status, ['assigned', 'held']),
        ),
      );
}
