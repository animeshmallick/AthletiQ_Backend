/**
 * Cycles of a membership: opened when the student joins (or the course is first set up), renewed
 * the day after they end, closed when the membership ends. Everything follows from the
 * membership's own dates, so running it late or twice gives the same result.
 * Nothing here ever writes an invoice.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { batchCycles, batches, enrollments, invoices, students } from '../../db/schema/index.js';
import { maxDate, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { logger } from '../../lib/logger.js';
import { formatInr } from '../../lib/money.js';
import { activeAdminIds, notifyInBackground, notifyOnce } from '../push/push.service.js';
import { cycleRange, monthContaining, monthStartingFrom, sessionsPerMonth } from './cycle-math.js';

type Enrollment = typeof enrollments.$inferSelect;
export type Cycle = typeof batchCycles.$inferSelect;

export const anchorOf = (e: Pick<Enrollment, 'billingAnchorDate' | 'effectiveFrom'>) =>
  e.billingAnchorDate ?? e.effectiveFrom;

/** Last day of a membership, as far as it is known (left, or planned to). */
export const lastDayOf = (e: Pick<Enrollment, 'effectiveTo' | 'plannedEndOn'>) =>
  e.effectiveTo ?? e.plannedEndOn;

/**
 * Opens round 1 for a membership of a batch with a course (no-op otherwise, or when it has one):
 * from its first billed month, or with `current`, from the month in progress (first set-up).
 */
export async function openFirstCycle(
  tx: DbOrTx,
  e: Enrollment,
  current?: IsoDate,
): Promise<Cycle | null> {
  const [b] = await tx.select().from(batches).where(eq(batches.id, e.batchId));
  if (!b?.courseMonths) return null;
  const anchor = anchorOf(e);
  // Months that started before billing began were settled outside (or by the old batch); rounds
  // follow the billed months. Never before the membership itself.
  const first = current
    ? monthContaining(anchor, maxDate(current, e.effectiveFrom))
    : monthStartingFrom(anchor, e.billingStartsOn);
  const [row] = await tx
    .insert(batchCycles)
    .values({
      enrollmentId: e.id,
      studentId: e.studentId,
      batchId: e.batchId,
      roundNo: 1,
      firstMonth: first,
      months: b.courseMonths,
      perMonth: sessionsPerMonth(b.weekdays),
      ...cycleRange(anchor, first, b.courseMonths),
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** First set-up of a batch's course: every current member starts round 1 this billing month. */
export async function openForBatch(tx: DbOrTx, batchId: string, today: IsoDate) {
  const members = await tx
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.batchId, batchId),
        or(isNull(enrollments.effectiveTo), gte(enrollments.effectiveTo, today)),
      ),
    );
  let opened = 0;
  for (const e of members) if (await openFirstCycle(tx, e, today)) opened++;
  return opened;
}

const close = (tx: DbOrTx, id: string, status: 'completed' | 'exited', endedOn: IsoDate) =>
  tx.update(batchCycles).set({ status, endedOn }).where(eq(batchCycles.id, id));

/**
 * Brings a membership's cycles in line with its dates as of `today`: closes the ones that ended
 * (completed) or were cut short (exited), and opens the next round while the student stays.
 * Returns the rounds it opened.
 */
export async function syncCycles(
  tx: DbOrTx,
  enrollmentId: string,
  today: IsoDate,
): Promise<Cycle[]> {
  const [e] = await tx
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, enrollmentId))
    .for('update');
  if (!e) return [];
  const [b] = await tx.select().from(batches).where(eq(batches.id, e.batchId));
  const load = () =>
    tx
      .select()
      .from(batchCycles)
      .where(eq(batchCycles.enrollmentId, e.id))
      .orderBy(asc(batchCycles.roundNo));
  const last = lastDayOf(e);

  // Rounds that have run out, up to the membership's last day (also when this runs late).
  const opened: Cycle[] = [];
  let current = (await load()).at(-1);
  while (current?.status === 'active' && current.endsOn < today) {
    await close(tx, current.id, 'completed', current.endsOn);
    if ((last && last <= current.endsOn) || !b?.courseMonths || !b.isActive) break;
    const firstMonth: number = current.firstMonth + current.months;
    const [next] = await tx
      .insert(batchCycles)
      .values({
        enrollmentId: e.id,
        studentId: e.studentId,
        batchId: e.batchId,
        roundNo: current.roundNo + 1,
        firstMonth,
        months: b.courseMonths,
        perMonth: sessionsPerMonth(b.weekdays),
        ...cycleRange(anchorOf(e), firstMonth, b.courseMonths),
      })
      .returning();
    opened.push(next!);
    current = next;
  }
  if (!e.effectiveTo || e.effectiveTo > today) return opened;

  // The membership has ended: rounds that started after it never happened; the one it fell in
  // was cut short (or finished, when it ended exactly on its last day).
  const end = e.effectiveTo;
  for (const c of await load()) {
    if (c.startsOn > end && c.roundNo > 1)
      await tx.delete(batchCycles).where(eq(batchCycles.id, c.id));
    else if (c.endsOn <= end) {
      if (c.status !== 'completed') await close(tx, c.id, 'completed', c.endsOn);
    } else if (c.endedOn !== end) await close(tx, c.id, 'exited', end);
  }
  return [];
}

/** The membership's dates were corrected before any money moved: start its cycles over. */
export async function restartCycles(tx: DbOrTx, e: Enrollment) {
  await tx.delete(batchCycles).where(eq(batchCycles.enrollmentId, e.id));
  return openFirstCycle(tx, e);
}

/**
 * Nightly: closes ended cycles and renews them. Each membership is its own transaction, so one
 * problem can't hold up the rest. Admins get one note about renewals with unpaid fees.
 */
export async function renewCycles(today: IsoDate = todayInAppTz()) {
  const due = await db
    .selectDistinct({ id: batchCycles.enrollmentId })
    .from(batchCycles)
    .innerJoin(enrollments, eq(enrollments.id, batchCycles.enrollmentId))
    .where(
      and(
        eq(batchCycles.status, 'active'),
        or(
          lt(batchCycles.endsOn, today),
          and(isNotNull(enrollments.effectiveTo), lt(enrollments.effectiveTo, today)),
        ),
      ),
    );
  const stats = { checked: due.length, renewed: 0, failed: 0 };
  const renewed = new Set<string>();
  for (const { id } of due) {
    try {
      const opened = await db.transaction((tx) => syncCycles(tx, id, today));
      stats.renewed += opened.length;
      for (const c of opened) renewed.add(c.studentId);
    } catch (err) {
      stats.failed++;
      logger.error({ err, enrollmentId: id }, 'Cycle renewal failed');
    }
  }
  if (renewed.size) notifyInBackground(() => noticeRenewedWithDues([...renewed], today));
  return stats;
}

async function noticeRenewedWithDues(studentIds: string[], today: IsoDate) {
  const rows = await db
    .select({
      name: students.fullName,
      amount: sql<number>`sum(${invoices.totalAmount})::float8`,
    })
    .from(invoices)
    .innerJoin(students, eq(students.id, invoices.studentId))
    .where(
      and(
        inArray(invoices.studentId, studentIds),
        eq(invoices.status, 'due'),
        lt(invoices.periodStart, today),
      ),
    )
    .groupBy(students.id)
    .orderBy(asc(students.fullName));
  if (!rows.length) return;
  const list = rows.slice(0, 6).map((r) => `${r.name} ${formatInr(r.amount)}`);
  await notifyOnce(`renewed-dues:${today}`, await activeAdminIds(), {
    category: 'money',
    icon: '🔁',
    title: `${rows.length} student${rows.length === 1 ? '' : 's'} renewed with unpaid fees`,
    body: `${list.join(', ')}${rows.length > 6 ? ` and ${rows.length - 6} more` : ''}`,
    link: '/renewals?dues=1',
    tag: 'renewed-dues',
  });
}
