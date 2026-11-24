/**
 * Monthly delivery: every student is owed `sessions per month` sessions in each billing month.
 * Sessions held = the batch's sessions in that month (moved / extra ones on their actual day)
 * that weren't cancelled. Only batches with a course are checked (nothing changes for a batch
 * until its course is set up).
 *
 *  - at_risk: as soon as held + still scheduled < sessions per month → coach and admins warned.
 *  - short:   the month ended short → final alert; an admin resolves it: pro-rata discount
 *             (fee ÷ sessions per month × missing, off the next unpaid invoice or held for the
 *             next one), an extra session, or dismiss with a reason. Nothing is automatic.
 *  - Weekly (Monday) digest of students behind course pace, to coaches and admins.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db, type DbOrTx } from '../../db/client.js';
import {
  batches,
  courseRounds,
  enrollments,
  invoices,
  sessionCancellations,
  sessionChanges,
  sessionShortfalls,
  studentCredits,
  students,
} from '../../db/schema/index.js';
import { addDays, formatDisplayDate, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { formatInr } from '../../lib/money.js';
import { parse, zId, zIdParam, zOptionalText } from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { assertBatchAccess, isAdmin } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { cycleFor } from '../billing/cycle.js';
import { activeAdminIds, notifyOnce } from '../push/push.service.js';
import { memberSessions, type Membership } from '../schedule/schedule.js';
import { courseTarget, cycleContaining, sessionsPerMonth, unusedValue } from './course-math.js';
import { applyToUnpaidInvoice } from './credits.js';
import { countedDates } from './rounds.js';

type Enrollment = typeof enrollments.$inferSelect;
type Batch = typeof batches.$inferSelect;

const anchorOf = (e: Pick<Enrollment, 'billingAnchorDate' | 'effectiveFrom'>) =>
  e.billingAnchorDate ?? e.effectiveFrom;

/** Sessions a member is offered between two days (not cancelled), split at `today`. */
async function offered(e: Membership, from: IsoDate, to: IsoDate, today: IsoDate, tx: DbOrTx = db) {
  const sessions = await memberSessions([e], from, to, tx);
  if (!sessions.length) return { held: 0, remaining: 0 };
  const off = await tx
    .select({ date: sessionCancellations.date })
    .from(sessionCancellations)
    .where(
      and(
        eq(sessionCancellations.batchId, e.batchId),
        sql`${sessionCancellations.date} between ${from} and ${to}`,
      ),
    );
  const cancelled = new Set(off.map((c) => c.date));
  const running = sessions.filter((s) => !cancelled.has(s.date));
  return {
    held: running.filter((s) => s.date <= today).length,
    remaining: running.filter((s) => s.date > today).length,
  };
}

interface Change {
  batchId: string;
  studentName: string;
  held: number;
  remaining: number;
  target: number;
  periodEnd: IsoDate;
}

/**
 * Checks the current and the previous billing month of every membership in a batch with a
 * course; records months at risk / short, and warns the coach and admins (grouped per batch).
 */
export async function evaluateDelivery(today: IsoDate = todayInAppTz()) {
  const rows = await db
    .select({ e: enrollments, b: batches, name: students.fullName })
    .from(enrollments)
    .innerJoin(batches, eq(batches.id, enrollments.batchId))
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(
      and(
        isNotNull(batches.courseMonths),
        lte(enrollments.effectiveFrom, today),
        or(
          isNull(enrollments.effectiveTo),
          sql`${enrollments.effectiveTo} >= ${addDays(today, -62)}`,
        ),
      ),
    );
  const stats = { checked: 0, atRisk: 0, short: 0, recovered: 0, failed: 0 };
  const risks: Change[] = [];
  const shorts: Change[] = [];

  for (const { e, b, name } of rows) {
    const anchor = anchorOf(e);
    const current = cycleContaining(anchor, today);
    for (const k of [current - 1, current]) {
      if (k < 1) continue;
      const cycle = cycleFor(anchor, k);
      // Whole months of this membership only, from when the course was set up.
      if (cycle.periodStart < e.effectiveFrom) continue;
      if (e.effectiveTo && e.effectiveTo < cycle.periodEnd) continue;
      if (b.courseSetOn && cycle.periodEnd < b.courseSetOn) continue;
      if (cycle.periodStart > today) continue;
      try {
        stats.checked++;
        const r = await checkMonth(e, b, name, { k, ...cycle }, today);
        if (r === 'at_risk') stats.atRisk++;
        if (r === 'short') stats.short++;
        if (r === 'recovered') stats.recovered++;
        if (r && r !== 'recovered') {
          const held = await offered(e, cycle.periodStart, cycle.periodEnd, today);
          (r === 'short' ? shorts : risks).push({
            batchId: b.id,
            studentName: name,
            ...held,
            target: sessionsPerMonth(b.weekdays),
            periodEnd: cycle.periodEnd,
          });
        }
      } catch (err) {
        stats.failed++;
        logger.error({ err, enrollmentId: e.id, cycle: k }, 'Delivery check failed');
      }
    }
  }
  await noticeGrouped(risks, 'risk', today);
  await noticeGrouped(shorts, 'short', today);
  return stats;
}

/** Records one month; returns what newly happened (for notices), or null. */
async function checkMonth(
  e: Enrollment,
  b: Batch,
  _name: string,
  cycle: { k: number; periodStart: IsoDate; periodEnd: IsoDate },
  today: IsoDate,
): Promise<'at_risk' | 'short' | 'recovered' | null> {
  const target = sessionsPerMonth(b.weekdays);
  const cycleNumber = e.cycleOffset + cycle.k;
  const { held, remaining } = await offered(e, cycle.periodStart, cycle.periodEnd, today);
  const ended = cycle.periodEnd < today;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(sessionShortfalls)
      .where(
        and(
          eq(sessionShortfalls.enrollmentId, e.id),
          eq(sessionShortfalls.cycleNumber, cycleNumber),
        ),
      )
      .for('update');
    const numbers = { held, remaining, target };
    if (held + remaining >= target) {
      if (row?.status === 'at_risk') {
        await tx
          .update(sessionShortfalls)
          .set({ ...numbers, status: 'recovered' })
          .where(eq(sessionShortfalls.id, row.id));
        return 'recovered';
      }
      // Short or already decided: keep the numbers current, the status stands.
      if (row)
        await tx.update(sessionShortfalls).set(numbers).where(eq(sessionShortfalls.id, row.id));
      return null;
    }
    const status = ended ? ('short' as const) : ('at_risk' as const);
    if (!row) {
      await tx.insert(sessionShortfalls).values({
        enrollmentId: e.id,
        studentId: e.studentId,
        batchId: b.id,
        cycleNumber,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        ...numbers,
        status,
      });
      return status;
    }
    if (row.status === 'at_risk' || row.status === 'recovered') {
      await tx
        .update(sessionShortfalls)
        .set({ ...numbers, status })
        .where(eq(sessionShortfalls.id, row.id));
      return row.status === status ? null : status;
    }
    // Short or resolved: keep the numbers current, the decision stands.
    await tx.update(sessionShortfalls).set(numbers).where(eq(sessionShortfalls.id, row.id));
    return null;
  });
}

async function noticeGrouped(list: Change[], kind: 'risk' | 'short', today: IsoDate) {
  const byBatch = new Map<string, Change[]>();
  for (const c of list) byBatch.set(c.batchId, [...(byBatch.get(c.batchId) ?? []), c]);
  const admins = byBatch.size ? await activeAdminIds() : [];
  for (const [batchId, items] of byBatch) {
    const [b] = await db
      .select({ name: batches.name, coachId: batches.coachId })
      .from(batches)
      .where(eq(batches.id, batchId));
    if (!b) continue;
    const n = items.length;
    const who = items
      .slice(0, 6)
      .map((c) => `${c.studentName} (${c.held + c.remaining} of ${c.target})`)
      .join(', ');
    await notifyOnce(`delivery-${kind}:${batchId}:${today}`, [b.coachId, ...admins], {
      category: 'sessions',
      icon: kind === 'risk' ? '⚠️' : '📉',
      actions: [{ label: 'Review', link: `/delivery?batch=${batchId}` }],
      title:
        kind === 'risk'
          ? `${n} student${n === 1 ? '' : 's'} may get fewer sessions this month · ${b.name}`
          : `${n} student${n === 1 ? '' : 's'} got fewer sessions than paid for · ${b.name}`,
      body:
        kind === 'risk'
          ? `${who}${n > 6 ? ` and ${n - 6} more` : ''}. Add an extra session to make it up.`
          : `${who}${n > 6 ? ` and ${n - 6} more` : ''}. An admin decides: discount, extra session or dismiss.`,
      link: `/delivery?batch=${batchId}`,
      tag: `delivery-${kind}-${batchId}`,
    });
  }
}

// ─── Course pace ─────────────────────────────────────────────────────────────

export interface PaceRow {
  roundId: string;
  student: { id: string; fullName: string; code: string };
  batch: { id: string; name: string; coachId: string };
  attended: number;
  target: number;
  /** Sessions still scheduled for them until the course's last month ends. */
  remaining: number;
  /** Sessions they would still be short by then. */
  short: number;
  courseEndsOn: IsoDate;
  inExtension: boolean;
}

/**
 * Students who can't reach the target within the course's months on the current schedule (or
 * are already in an extension month).
 */
export async function behindPace(today: IsoDate, filter?: SQL): Promise<PaceRow[]> {
  const rows = await db
    .select({
      round: courseRounds,
      e: enrollments,
      b: batches,
      s: { id: students.id, fullName: students.fullName, code: students.code },
    })
    .from(courseRounds)
    .innerJoin(enrollments, eq(enrollments.id, courseRounds.enrollmentId))
    .innerJoin(batches, eq(batches.id, courseRounds.batchId))
    .innerJoin(students, eq(students.id, courseRounds.studentId))
    .where(and(eq(courseRounds.status, 'active'), isNotNull(batches.courseMonths), filter))
    .orderBy(asc(batches.name), asc(students.fullName));
  const out: PaceRow[] = [];
  for (const { round, e, b, s } of rows) {
    if (round.startedOn > today) continue;
    const anchor = anchorOf(e);
    const target = courseTarget(b.weekdays, b.courseMonths!);
    const lastMonth = cycleContaining(anchor, round.startedOn) + b.courseMonths! - 1;
    const courseEndsOn = cycleFor(anchor, lastMonth).periodEnd;
    const attended = (await countedDates(db, e, round.startedOn, today)).length;
    const inExtension = today > courseEndsOn;
    const { remaining } = inExtension
      ? { remaining: 0 }
      : await offered(e, addDays(today, 1), courseEndsOn, today);
    const short = target - attended - remaining;
    if (short > 0 || inExtension)
      out.push({
        roundId: round.id,
        student: s,
        batch: { id: b.id, name: b.name, coachId: b.coachId },
        attended,
        target,
        remaining,
        short: Math.max(0, short),
        courseEndsOn,
        inExtension,
      });
  }
  return out;
}

/** Monday: each coach gets their batches' students behind pace; admins get all of them. */
export async function sendPaceDigest(today: IsoDate = todayInAppTz()) {
  const rows = await behindPace(today);
  if (!rows.length) return { students: 0, coaches: 0 };
  const line = (r: PaceRow) =>
    `${r.student.fullName} ${r.attended}/${r.target}${r.inExtension ? ' (extension month)' : `, ${r.short} short`}`;
  const summary = (list: PaceRow[]) => {
    const byBatch = new Map<string, PaceRow[]>();
    for (const r of list) byBatch.set(r.batch.name, [...(byBatch.get(r.batch.name) ?? []), r]);
    return [...byBatch]
      .map(
        ([name, rs]) =>
          `${name}: ${rs.slice(0, 5).map(line).join(', ')}${rs.length > 5 ? ` +${rs.length - 5}` : ''}`,
      )
      .join(' · ');
  };
  const coaches = new Map<string, PaceRow[]>();
  for (const r of rows) coaches.set(r.batch.coachId, [...(coaches.get(r.batch.coachId) ?? []), r]);
  for (const [coachId, list] of coaches)
    await notifyOnce(`pace-digest:${coachId}:${today}`, [coachId], {
      category: 'sessions',
      icon: '🐢',
      title: `${list.length} student${list.length === 1 ? ' is' : 's are'} behind course pace`,
      body: `${summary(list)}. Makeups help them finish on time.`,
      link: '/delivery?tab=pace',
      tag: 'pace-digest',
    });
  await notifyOnce(`pace-digest:admins:${today}`, await activeAdminIds(), {
    category: 'sessions',
    icon: '🐢',
    title: `${rows.length} student${rows.length === 1 ? ' is' : 's are'} behind course pace`,
    body: summary(rows),
    link: '/delivery?tab=pace',
    tag: 'pace-digest',
  });
  return { students: rows.length, coaches: coaches.size };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** Mounted at /delivery. */
export const deliveryRouter = Router();

const scopeFor = (user: AuthUser, batchId?: string): SQL | undefined =>
  and(
    isAdmin(user) ? undefined : eq(batches.coachId, user.id),
    batchId ? eq(batches.id, batchId) : undefined,
  );

const ListQuery = z.object({
  status: z
    .enum(['at_risk', 'short', 'recovered', 'discounted', 'extra_added', 'dismissed', 'open'])
    .default('open'),
  batchId: zId.optional(),
});

/** Shortfalls (open = at risk or short), with what a discount would be worth. */
deliveryRouter.get('/shortfalls', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const user = currentUser(req);
  const rows = await db
    .select({
      sf: sessionShortfalls,
      student: { id: students.id, code: students.code, fullName: students.fullName },
      batch: { id: batches.id, name: batches.name },
      invoice: {
        id: invoices.id,
        totalAmount: invoices.totalAmount,
        creditAmount: invoices.creditAmount,
      },
    })
    .from(sessionShortfalls)
    .innerJoin(students, eq(students.id, sessionShortfalls.studentId))
    .innerJoin(batches, eq(batches.id, sessionShortfalls.batchId))
    .leftJoin(
      invoices,
      and(
        eq(invoices.enrollmentId, sessionShortfalls.enrollmentId),
        eq(invoices.cycleNumber, sessionShortfalls.cycleNumber),
      ),
    )
    .where(
      and(
        scopeFor(user, q.batchId),
        q.status === 'open'
          ? inArray(sessionShortfalls.status, ['at_risk', 'short'])
          : eq(sessionShortfalls.status, q.status),
      ),
    )
    .orderBy(asc(sessionShortfalls.periodEnd), asc(students.fullName));
  ok(
    res,
    rows.map(({ sf, student, batch, invoice }) => ({
      ...sf,
      student,
      batch,
      missing: Math.max(0, sf.target - sf.held - sf.remaining),
      // Money is for admins.
      discountValue: isAdmin(user) ? discountFor(sf, invoice?.id ? invoice : null) : undefined,
    })),
  );
});

/** fee ÷ sessions per month × missing, from what the month cost (0 for free months). */
function discountFor(
  sf: { target: number; held: number; remaining: number },
  invoice: { totalAmount: number; creditAmount: number } | null,
) {
  if (!invoice) return 0;
  const missing = Math.max(0, sf.target - sf.held - sf.remaining);
  return unusedValue(invoice.totalAmount + invoice.creditAmount, sf.target, sf.target - missing);
}

/** Students behind course pace (coach: own batches). */
deliveryRouter.get('/pace', async (req, res) => {
  const q = parse(z.object({ batchId: zId.optional() }), req.query);
  const user = currentUser(req);
  if (q.batchId) await assertBatchAccess(user, q.batchId, { mainOnly: true });
  ok(res, await behindPace(todayInAppTz(), scopeFor(user, q.batchId)));
});

deliveryRouter.post('/evaluate', requireAdmin, async (_req, res) => {
  ok(res, await evaluateDelivery(todayInAppTz()));
});

async function openShortfall(tx: DbOrTx, id: string) {
  const [sf] = await tx
    .select()
    .from(sessionShortfalls)
    .where(eq(sessionShortfalls.id, id))
    .for('update');
  if (!sf) throw AppError.notFound('Shortfall');
  if (sf.status !== 'short' && sf.status !== 'at_risk')
    throw AppError.conflict(`This was already ${sf.status.replace('_', ' ')}`);
  return sf;
}

/**
 * Pro-rata discount for a month that ended short: credited to the membership and taken off its
 * next unpaid invoice now (or the next one issued). If the membership has ended, it waits for
 * the course decision, or is owed back.
 */
deliveryRouter.post('/shortfalls/:id/discount', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { note } = parse(z.object({ note: zOptionalText(500) }), req.body ?? {});
  const user = currentUser(req);
  const out = await db.transaction(async (tx) => {
    const sf = await openShortfall(tx, id);
    if (sf.status !== 'short')
      throw AppError.unprocessable(
        'The month is still running: add an extra session, or wait until it ends.',
      );
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.enrollmentId, sf.enrollmentId), eq(invoices.cycleNumber, sf.cycleNumber)),
      );
    const amount = discountFor(sf, inv && inv.status !== 'cancelled' ? inv : null);
    if (amount <= 0)
      throw AppError.unprocessable(
        'Nothing was charged for that month, so there is nothing to discount.',
      );
    const [e] = await tx.select().from(enrollments).where(eq(enrollments.id, sf.enrollmentId));
    const [waiting] = await tx
      .select({ id: courseRounds.id })
      .from(courseRounds)
      .where(
        and(eq(courseRounds.enrollmentId, sf.enrollmentId), eq(courseRounds.status, 'awaiting')),
      );
    const missing = sf.target - sf.held - sf.remaining;
    const reason = `${missing} of ${sf.target} sessions not held, ${formatDisplayDate(sf.periodStart)} – ${formatDisplayDate(sf.periodEnd)}: ${formatInr(amount)} off`;
    const status = e!.effectiveTo === null ? 'assigned' : waiting ? 'held' : 'refund_due';
    const [credit] = await tx
      .insert(studentCredits)
      .values({
        studentId: sf.studentId,
        kind: 'shortfall',
        amount,
        status,
        enrollmentId: sf.enrollmentId,
        roundId: waiting?.id ?? null,
        sourceInvoiceId: inv?.id ?? null,
        reason,
        note: note ?? null,
      })
      .returning({ id: studentCredits.id });
    const invoiceId = status === 'assigned' ? await applyToUnpaidInvoice(tx, credit!.id) : null;
    await tx
      .update(sessionShortfalls)
      .set({
        status: 'discounted',
        amount,
        creditId: credit!.id,
        invoiceId,
        resolvedById: user.id,
        resolvedAt: new Date(),
        note: note ?? null,
      })
      .where(eq(sessionShortfalls.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'shortfall.discounted',
        entityType: 'student',
        entityId: sf.studentId,
        metadata: { shortfallId: id, amount, missing, creditStatus: status, invoiceId },
      },
      tx,
    );
    return { amount, invoiceId, creditStatus: status };
  });
  ok(res, out);
});

const ExtraBody = z.object({ sessionChangeId: zId, note: zOptionalText(500) });

/** Links an extra session (asked for or approved) that makes up for the month. */
deliveryRouter.post('/shortfalls/:id/extra', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(ExtraBody, req.body);
  const user = currentUser(req);
  await db.transaction(async (tx) => {
    const sf = await openShortfall(tx, id);
    const [b] = await tx.select().from(batches).where(eq(batches.id, sf.batchId));
    if (!isAdmin(user) && b?.coachId !== user.id) throw AppError.notFound('Shortfall');
    const [c] = await tx
      .select()
      .from(sessionChanges)
      .where(eq(sessionChanges.id, body.sessionChangeId));
    if (
      !c ||
      c.batchId !== sf.batchId ||
      c.kind !== 'extra' ||
      !['pending', 'approved'].includes(c.status)
    )
      throw AppError.unprocessable('Choose an extra session of this batch');
    if (c.date < sf.periodStart)
      throw AppError.unprocessable('That extra session was before this month started');
    await tx
      .update(sessionShortfalls)
      .set({
        status: 'extra_added',
        sessionChangeId: c.id,
        resolvedById: user.id,
        resolvedAt: new Date(),
        note: body.note ?? null,
      })
      .where(eq(sessionShortfalls.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'shortfall.extra_session',
        entityType: 'student',
        entityId: sf.studentId,
        metadata: { shortfallId: id, sessionChangeId: c.id, date: c.date },
      },
      tx,
    );
  });
  ok(res, (await db.select().from(sessionShortfalls).where(eq(sessionShortfalls.id, id)))[0]);
});

const DismissBody = z.object({ reason: z.string().trim().min(3, 'Please give a reason').max(500) });

deliveryRouter.post('/shortfalls/:id/dismiss', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { reason } = parse(DismissBody, req.body);
  const user = currentUser(req);
  await db.transaction(async (tx) => {
    const sf = await openShortfall(tx, id);
    await tx
      .update(sessionShortfalls)
      .set({ status: 'dismissed', resolvedById: user.id, resolvedAt: new Date(), note: reason })
      .where(eq(sessionShortfalls.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'shortfall.dismissed',
        entityType: 'student',
        entityId: sf.studentId,
        metadata: { shortfallId: id, reason },
      },
      tx,
    );
  });
  ok(res, (await db.select().from(sessionShortfalls).where(eq(sessionShortfalls.id, id)))[0]);
});
