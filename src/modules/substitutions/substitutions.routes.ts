/**
 * Substitute coaches: an admin assigns (or approves a coach's request for) another coach to run a
 * batch's sessions for a date range. Substitutes get session access only on those days (see
 * access.ts); fees and income never move.
 */
import { timesOn, type DayTimes } from '../../lib/batch-times.js';
import {
  arrayContains,
  aliasedTable,
  and,
  desc,
  eq,
  gte,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db, type DbOrTx } from '../../db/client.js';
import { batchSubstitutions, batches, users } from '../../db/schema/index.js';
import { diffDays, eachDay, isoWeekday, todayInAppTz, type IsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { created, ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zIsoDate, zOptionalText } from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { getBatchOrThrow, isAdmin } from '../access/access.js';
import { cancellationsIn } from '../attendance/cancellations.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { notifyAdmins, notifyInBackground, notifyUsers } from '../push/push.service.js';

export const substitutionsRouter = Router();

/** Longest single substitution. */
const MAX_DAYS = 62;
const LOCK = 0x53554253; // "SUBS": serialises approvals so two can't claim the same day.

const sub = aliasedTable(users, 'sub');
const main = aliasedTable(users, 'main');
const requester = aliasedTable(users, 'requester');
const reviewer = aliasedTable(users, 'reviewer');

const select = {
  id: batchSubstitutions.id,
  fromDate: batchSubstitutions.fromDate,
  toDate: batchSubstitutions.toDate,
  reason: batchSubstitutions.reason,
  status: batchSubstitutions.status,
  reviewNote: batchSubstitutions.reviewNote,
  reviewedAt: batchSubstitutions.reviewedAt,
  createdAt: batchSubstitutions.createdAt,
  batch: {
    id: batches.id,
    name: batches.name,
    startTime: batches.startTime,
    endTime: batches.endTime,
    dayTimes: batches.dayTimes,
    weekdays: batches.weekdays,
  },
  substitute: { id: sub.id, name: sub.name },
  coach: { id: main.id, name: main.name },
  requestedBy: { id: requester.id, name: requester.name },
  reviewedBy: { id: reviewer.id, name: reviewer.name },
};

/** Substitutions with their batch and people: pending first, then latest first. */
async function list(where: SQL | undefined): Promise<Row[]> {
  return db
    .select(select)
    .from(batchSubstitutions)
    .innerJoin(batches, eq(batches.id, batchSubstitutions.batchId))
    .innerJoin(sub, eq(sub.id, batchSubstitutions.substituteCoachId))
    .innerJoin(main, eq(main.id, batchSubstitutions.coachId))
    .innerJoin(requester, eq(requester.id, batchSubstitutions.requestedById))
    .leftJoin(reviewer, eq(reviewer.id, batchSubstitutions.reviewedById))
    .where(where)
    .orderBy(
      sql`case ${batchSubstitutions.status} when 'pending' then 0 when 'approved' then 1 else 2 end`,
      desc(batchSubstitutions.fromDate),
    );
}

interface Person {
  id: string;
  name: string;
}
interface Row {
  id: string;
  fromDate: string;
  toDate: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  batch: {
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    dayTimes: DayTimes;
    weekdays: number[];
  };
  substitute: Person;
  coach: Person;
  requestedBy: Person;
  reviewedBy: { id: string | null; name: string | null } | null;
}

/** Scheduled (not cancelled) session days of a batch in a range. */
async function sessionDays(batch: { id: string; weekdays: number[] }, from: IsoDate, to: IsoDate) {
  const cancelled = await cancellationsIn([batch.id], from, to);
  return eachDay(from, to).filter(
    (d) => batch.weekdays.includes(isoWeekday(d)) && !cancelled.has(`${batch.id}:${d}`),
  );
}

/** Adds the number of sessions covered to each row. */
async function withSessions(rows: Row[]) {
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      reviewedBy: r.reviewedBy?.id ? r.reviewedBy : null,
      sessions: (await sessionDays(r.batch, r.fromDate, r.toDate)).length,
    })),
  );
}

/** Rows a user may see: admins everything; coaches what involves them. */
function visibleTo(user: AuthUser): SQL | undefined {
  if (isAdmin(user)) return undefined;
  return or(
    eq(batchSubstitutions.coachId, user.id),
    eq(batchSubstitutions.substituteCoachId, user.id),
    eq(batchSubstitutions.requestedById, user.id),
  );
}

const overlaps = (
  a: { startTime: string; endTime: string },
  b: { startTime: string; endTime: string },
) => a.startTime < b.endTime && b.startTime < a.endTime;

/**
 * Why this substitution can't be approved, or null: the batch already has an approved substitute
 * on one of the days, or the substitute is busy at that time (their own batch or another cover).
 */
async function conflict(
  tx: DbOrTx,
  s: {
    id?: string;
    batchId: string;
    substituteCoachId: string;
    fromDate: IsoDate;
    toDate: IsoDate;
  },
): Promise<string | null> {
  const batch = await tx.query.batches.findFirst({ where: eq(batches.id, s.batchId) });
  if (!batch) return 'Batch not found';
  const inRange = and(
    eq(batchSubstitutions.status, 'approved'),
    lte(batchSubstitutions.fromDate, s.toDate),
    gte(batchSubstitutions.toDate, s.fromDate),
    s.id ? ne(batchSubstitutions.id, s.id) : undefined,
  );

  const [same] = await tx
    .select({
      name: users.name,
      fromDate: batchSubstitutions.fromDate,
      toDate: batchSubstitutions.toDate,
    })
    .from(batchSubstitutions)
    .innerJoin(users, eq(users.id, batchSubstitutions.substituteCoachId))
    .where(and(eq(batchSubstitutions.batchId, s.batchId), inRange))
    .limit(1);
  if (same)
    return `${batch.name} already has ${same.name} as substitute from ${same.fromDate} to ${same.toDate}`;

  const [own, covers] = await Promise.all([
    tx
      .select({
        name: batches.name,
        startTime: batches.startTime,
        endTime: batches.endTime,
        dayTimes: batches.dayTimes,
        weekdays: batches.weekdays,
      })
      .from(batches)
      .where(
        and(
          eq(batches.coachId, s.substituteCoachId),
          eq(batches.isActive, true),
          ne(batches.id, batch.id),
        ),
      ),
    tx
      .select({
        name: batches.name,
        startTime: batches.startTime,
        endTime: batches.endTime,
        dayTimes: batches.dayTimes,
        weekdays: batches.weekdays,
        fromDate: batchSubstitutions.fromDate,
        toDate: batchSubstitutions.toDate,
      })
      .from(batchSubstitutions)
      .innerJoin(batches, eq(batches.id, batchSubstitutions.batchId))
      .where(and(eq(batchSubstitutions.substituteCoachId, s.substituteCoachId), inRange)),
  ]);
  for (const d of eachDay(s.fromDate, s.toDate)) {
    const wd = isoWeekday(d);
    if (!batch.weekdays.includes(wd)) continue;
    // Compare each batch's own time on that weekday.
    const here = timesOn(batch, wd);
    const clash =
      own.find((o) => o.weekdays.includes(wd) && overlaps(timesOn(o, wd), here)) ??
      covers.find(
        (c) =>
          c.fromDate <= d &&
          c.toDate >= d &&
          c.weekdays.includes(wd) &&
          overlaps(timesOn(c, wd), here),
      );
    if (clash) return `The substitute already coaches ${clash.name} at that time on ${d}`;
  }
  return null;
}

async function assertSubstituteCoach(id: string) {
  const u = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!u?.roles.includes('coach') || u.status !== 'active')
    throw AppError.badRequest('Choose an active coach as the substitute');
  return u;
}

// ─── Notices ─────────────────────────────────────────────────────────────────

const LINK = '/substitutions';
const span = (r: { fromDate: string; toDate: string }) =>
  r.fromDate === r.toDate ? r.fromDate : `${r.fromDate} to ${r.toDate}`;

function noticeDecision(r: Row, actorId: string) {
  notifyInBackground(async () => {
    const people = [r.substitute.id, r.coach.id, r.requestedBy.id].filter((x) => x !== actorId);
    const verb = {
      approved: 'approved',
      rejected: 'declined',
      cancelled: 'cancelled',
      pending: 'requested',
    }[r.status];
    await notifyUsers(people, {
      category: 'sessions',
      icon: '🔁',
      title: `Substitute ${verb} · ${r.batch.name}`,
      body: `${r.substitute.name} covering ${span(r)}${r.reviewNote ? ` — ${r.reviewNote}` : ''}`,
      link: LINK,
      tag: `sub-${r.id}`,
    });
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** Active coaches who can be picked as a substitute (names only; any signed-in user). */
substitutionsRouter.get('/coaches', async (_req, res) => {
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(arrayContains(users.roles, ['coach']), eq(users.status, 'active')))
    .orderBy(users.name);
  ok(res, rows);
});

const ListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  batchId: zId.optional(),
  /** Only substitutions that end on or after this date (default: everything). */
  from: zIsoDate.optional(),
});

substitutionsRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const q = parse(ListQuery, req.query);
  const rows = await list(
    and(
      visibleTo(user),
      q.status ? eq(batchSubstitutions.status, q.status) : undefined,
      q.batchId ? eq(batchSubstitutions.batchId, q.batchId) : undefined,
      q.from ? gte(batchSubstitutions.toDate, q.from) : undefined,
    ),
  );
  ok(res, await withSessions(rows));
});

const CreateBody = z
  .object({
    batchId: zId,
    substituteCoachId: zId,
    fromDate: zIsoDate,
    toDate: zIsoDate,
    reason: zOptionalText(300),
  })
  .refine((b) => b.toDate >= b.fromDate, {
    message: 'End date must be on or after the start date',
    path: ['toDate'],
  })
  .refine((b) => diffDays(b.fromDate, b.toDate) < MAX_DAYS, {
    message: `A substitution can cover up to ${MAX_DAYS} days`,
    path: ['toDate'],
  });

/** Admins assign directly (approved); a batch's coach requests one (pending, for an admin). */
substitutionsRouter.post('/', async (req, res) => {
  const user = currentUser(req);
  const body = parse(CreateBody, req.body);
  const admin = isAdmin(user);
  const batch = await getBatchOrThrow(body.batchId);
  if (!admin && batch.coachId !== user.id)
    throw AppError.forbidden('Only the batch’s coach can request a substitute');
  if (body.substituteCoachId === batch.coachId)
    throw AppError.badRequest('The substitute must be a different coach');
  if (body.toDate < todayInAppTz()) throw AppError.badRequest('Choose dates from today onwards');
  await assertSubstituteCoach(body.substituteCoachId);
  if (!(await sessionDays(batch, body.fromDate, body.toDate)).length)
    throw AppError.unprocessable(`${batch.name} has no sessions in those dates`);

  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    if (admin) {
      const why = await conflict(tx, body);
      if (why) throw AppError.conflict(why);
    }
    const [row] = await tx
      .insert(batchSubstitutions)
      .values({
        ...body,
        reason: body.reason ?? null,
        coachId: batch.coachId,
        requestedById: user.id,
        status: admin ? 'approved' : 'pending',
        reviewedById: admin ? user.id : null,
        reviewedAt: admin ? new Date() : null,
      })
      .returning({ id: batchSubstitutions.id });
    await audit(
      {
        ...auditCtx(req),
        action: admin ? 'substitution.assigned' : 'substitution.requested',
        entityType: 'batch',
        entityId: batch.id,
        metadata: { substitutionId: row!.id, ...body },
      },
      tx,
    );
    return row!.id;
  });

  const [row] = await withSessions(await list(eq(batchSubstitutions.id, id)));
  if (admin) noticeDecision(row!, user.id);
  else
    notifyInBackground(() =>
      notifyAdmins({
        category: 'approvals',
        icon: '🔁',
        actions: [{ label: 'Review', link: LINK }],
        title: `Substitute request · ${row!.batch.name}`,
        body: `${user.name ?? 'A coach'} asks for ${row!.substitute.name} to cover ${span(row!)}`,
        link: LINK,
        tag: `sub-${id}`,
      }),
    );
  created(res, row);
});

const ReviewBody = z.object({ note: zOptionalText(300) });

async function transition(
  req: Parameters<Parameters<typeof substitutionsRouter.post>[1]>[0],
  to: 'approved' | 'rejected' | 'cancelled',
) {
  const user = currentUser(req);
  const { id } = parse(zIdParam, req.params);
  const { note } = parse(ReviewBody, req.body ?? {});
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    const current = await tx.query.batchSubstitutions.findFirst({
      where: eq(batchSubstitutions.id, id),
    });
    if (!current) throw AppError.notFound('Substitution');
    if (to === 'cancelled') {
      const mine = current.requestedById === user.id || current.coachId === user.id;
      if (!isAdmin(user) && !mine) throw AppError.notFound('Substitution');
      if (!['pending', 'approved'].includes(current.status))
        throw AppError.conflict('This substitution is already closed');
      if (current.toDate < todayInAppTz()) throw AppError.conflict('This substitution has ended');
    } else {
      if (current.status !== 'pending') throw AppError.conflict('This request was already handled');
      if (to === 'approved') {
        const why = await conflict(tx, current);
        if (why) throw AppError.conflict(why);
      }
    }
    await tx
      .update(batchSubstitutions)
      .set({
        status: to,
        reviewedById: user.id,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
      })
      .where(eq(batchSubstitutions.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: `substitution.${to}`,
        entityType: 'batch',
        entityId: current.batchId,
        metadata: { substitutionId: id, note: note ?? null },
      },
      tx,
    );
    return id;
  });
  const [row] = await withSessions(await list(eq(batchSubstitutions.id, result)));
  noticeDecision(row!, user.id);
  return row!;
}

substitutionsRouter.post('/:id/approve', requireAdmin, async (req, res) => {
  ok(res, await transition(req, 'approved'));
});
substitutionsRouter.post('/:id/reject', requireAdmin, async (req, res) => {
  ok(res, await transition(req, 'rejected'));
});
substitutionsRouter.post('/:id/cancel', async (req, res) => {
  ok(res, await transition(req, 'cancelled'));
});

// ─── Insights ────────────────────────────────────────────────────────────────

const InsightsQuery = z
  .object({ from: zIsoDate, to: zIsoDate })
  .refine((q) => q.to >= q.from && diffDays(q.from, q.to) <= 366, {
    message: 'Choose up to a year',
  });

/**
 * Substitute sessions in a period: how many were covered, by whom and for whom, plus open
 * requests. Coaches see their own numbers; admins see the academy.
 */
substitutionsRouter.get('/insights', async (req, res) => {
  const user = currentUser(req);
  const q = parse(InsightsQuery, req.query);
  const rows = await withSessionsIn(
    await list(
      and(
        visibleTo(user),
        inArray(batchSubstitutions.status, ['approved', 'pending']),
        lte(batchSubstitutions.fromDate, q.to),
        gte(batchSubstitutions.toDate, q.from),
      ),
    ),
    q.from,
    q.to,
  );
  const approved = rows.filter((r) => r.status === 'approved');
  const today = todayInAppTz();
  const tally = (pick: (r: (typeof rows)[number]) => { id: string; name: string }) => {
    const m = new Map<
      string,
      { id: string; name: string; sessions: number; substitutions: number }
    >();
    for (const r of approved) {
      const p = pick(r);
      const t = m.get(p.id) ?? { ...p, sessions: 0, substitutions: 0 };
      t.sessions += r.sessionsInPeriod;
      t.substitutions++;
      m.set(p.id, t);
    }
    return [...m.values()].sort((a, b) => b.sessions - a.sessions);
  };
  ok(res, {
    from: q.from,
    to: q.to,
    totals: {
      substitutions: approved.length,
      sessions: approved.reduce((n, r) => n + r.sessionsInPeriod, 0),
      pending: rows.filter((r) => r.status === 'pending').length,
      upcoming: approved.filter((r) => r.fromDate > today).length,
      active: approved.filter((r) => r.fromDate <= today && r.toDate >= today).length,
      /** For coaches: sessions they covered vs sessions covered for them. */
      coveredByMe: approved
        .filter((r) => r.substitute.id === user.id)
        .reduce((n, r) => n + r.sessionsInPeriod, 0),
      coveredForMe: approved
        .filter((r) => r.coach.id === user.id)
        .reduce((n, r) => n + r.sessionsInPeriod, 0),
    },
    bySubstitute: tally((r) => r.substitute),
    byCoach: tally((r) => r.coach),
    byBatch: tally((r) => ({ id: r.batch.id, name: r.batch.name })),
  });
});

/** Sessions of each substitution that fall inside [from, to]. */
async function withSessionsIn(rows: Row[], from: IsoDate, to: IsoDate) {
  return Promise.all(
    rows.map(async (r) => {
      const a = r.fromDate > from ? r.fromDate : from;
      const b = r.toDate < to ? r.toDate : to;
      return { ...r, sessionsInPeriod: a <= b ? (await sessionDays(r.batch, a, b)).length : 0 };
    }),
  );
}
