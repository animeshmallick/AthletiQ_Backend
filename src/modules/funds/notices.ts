/**
 * Push notifications for money events. Everything here is fire-and-forget: a notification
 * problem never fails or delays the request that caused it.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { fundEntries, fundTxns, users } from '../../db/schema/index.js';
import { startOfIsoWeek, todayInAppTz } from '../../lib/dates.js';
import { formatInr } from '../../lib/money.js';
import type { AuthUser } from '../auth/auth.types.js';
import {
  activeAdminIds,
  notifyInBackground,
  notifyOnce,
  notifyUsers,
  pushEnabled,
} from '../push/push.service.js';

const LINK = '/money';

/** Staff shares of one fee split, by person. */
async function staffShares(paymentId: string, live: boolean) {
  return db
    .select({ userId: fundEntries.userId, amount: sql<number>`sum(${fundEntries.amount})::int` })
    .from(fundEntries)
    .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
    .where(
      and(
        eq(fundTxns.paymentId, paymentId),
        live ? isNull(fundTxns.reversedAt) : sql`${fundTxns.reversedAt} is not null`,
        eq(fundEntries.account, 'staff_due'),
        eq(fundEntries.share, true),
      ),
    )
    .groupBy(fundEntries.userId);
}

/** Tells each staff member (other than the collector) about their share of a received fee. */
export function noticeFeeShares(
  paymentId: string,
  collector: AuthUser,
  student: string,
  heldByAcademy: boolean,
) {
  notifyInBackground(async () => {
    for (const s of await staffShares(paymentId, true)) {
      if (!s.userId || s.userId === collector.id) continue;
      await notifyUsers([s.userId], {
        title: `Your share · ${formatInr(s.amount)}`,
        body: `${student}'s fee was received by ${collector.name}. ${
          heldByAcademy || collector.role === 'admin'
            ? 'The academy holds it for you.'
            : `${collector.name} holds it for you.`
        }`,
        link: LINK,
        tag: `share-${paymentId}-${s.userId}`,
      });
    }
  });
}

/** Tells staff whose share was undone because the payment was reverted or refunded. */
export function noticeSharesReversed(paymentId: string, actor: AuthUser, why: string) {
  notifyInBackground(async () => {
    const rows = await db
      .select({ txnId: fundTxns.id })
      .from(fundTxns)
      .where(and(eq(fundTxns.paymentId, paymentId), sql`${fundTxns.reversedAt} is not null`));
    if (!rows.length) return;
    for (const s of await staffShares(paymentId, false)) {
      if (!s.userId || s.userId === actor.id) continue;
      await notifyUsers([s.userId], {
        title: `Share removed · ${formatInr(s.amount)}`,
        body: `The payment was ${why} by ${actor.name}.`,
        link: LINK,
        tag: `share-undo-${paymentId}-${s.userId}`,
      });
    }
  });
}

/** One person, unless they did it themselves. */
export function noticeStaff(
  userId: string | null | undefined,
  actor: AuthUser,
  title: string,
  body: string,
) {
  if (!userId || userId === actor.id) return;
  notifyInBackground(() =>
    notifyUsers([userId], { title, body, link: LINK, tag: `funds-${userId}-${Date.now()}` }),
  );
}

/** Every active admin except the actor. */
export function noticeAdmins(actor: AuthUser, title: string, body: string) {
  notifyInBackground(async () => {
    const admins = (await activeAdminIds()).filter((a) => a !== actor.id);
    await notifyUsers(admins, { title, body, link: LINK, tag: `funds-${Date.now()}` });
  });
}

/**
 * Monday morning: staff holding the academy's cash are reminded to hand it over, and admins get
 * the money position (cash in hand, with staff, owed). Once per week per person.
 */
export async function sendMoneyReminders(now: Date = new Date()) {
  if (!pushEnabled()) return { holders: 0, admins: false };
  const week = startOfIsoWeek(todayInAppTz(now));
  const balances = await db
    .select({
      account: fundEntries.account,
      userId: fundEntries.userId,
      amount: sql<number>`sum(${fundEntries.amount})::int`,
    })
    .from(fundEntries)
    .innerJoin(fundTxns, eq(fundTxns.id, fundEntries.txnId))
    .where(isNull(fundTxns.reversedAt))
    .groupBy(fundEntries.account, fundEntries.userId);
  const sum = (account: string, staff: boolean) =>
    balances
      .filter((b) => b.account === account && Boolean(b.userId) === staff && b.amount > 0)
      .reduce((s, b) => s + b.amount, 0);

  const holders = balances.filter((b) => b.account === 'cash' && b.userId && b.amount > 0);
  const active = holders.length
    ? await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.status, 'active'),
            inArray(
              users.id,
              holders.map((h) => h.userId!),
            ),
          ),
        )
    : [];
  let reminded = 0;
  for (const h of holders) {
    if (!active.some((u) => u.id === h.userId)) continue;
    const owed =
      balances.find((b) => b.account === 'staff_due' && b.userId === h.userId)?.amount ?? 0;
    const sent = await notifyOnce(`cash-week:${week}:${h.userId}`, [h.userId!], {
      title: `You hold ${formatInr(h.amount)} for the academy`,
      body:
        owed > 0
          ? `The academy also owes you ${formatInr(owed)}. Please hand over the cash or settle with an admin.`
          : 'Please hand it over to the academy and record it in Money.',
      link: LINK,
    });
    if (sent) reminded++;
  }

  const academyCash = balances.find((b) => b.account === 'cash' && !b.userId)?.amount ?? 0;
  const withStaff = sum('cash', true);
  const owed = sum('staff_due', true) + sum('payee_due', false);
  const admins = await notifyOnce(`money-week:${week}`, await activeAdminIds(), {
    title: `Money position · ${formatInr(academyCash + withStaff)} in hand`,
    body: [
      `Academy ${formatInr(academyCash)}`,
      `with staff ${formatInr(withStaff)}`,
      owed > 0 ? `owed to others ${formatInr(owed)}` : 'nothing owed',
    ].join(' · '),
    link: LINK,
  });
  return { holders: reminded, admins };
}
