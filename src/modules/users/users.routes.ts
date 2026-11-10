import { balanceOf } from '../funds/ledger.js';
import {
  and,
  arrayContains,
  asc,
  count,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { batches, coachSessions, enrollments, users } from '../../db/schema/index.js';
import { addDays, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { created, ok, pageMeta } from '../../lib/http.js';
import { parse, zEmail, zIdParam, zName, zPagination, zPhone } from '../../lib/validation.js';
import { currentUser, requireAdmin } from '../../middleware/auth.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { createOneTimeToken, revokeAllSessions, toPublicUser } from '../auth/auth.service.js';

export const usersRouter = Router();

// ─── Self-service profile ────────────────────────────────────────────────────

const ProfileBody = z.object({
  name: zName.optional(),
  phone: zPhone.nullable().optional(),
});

usersRouter.patch('/me', async (req, res) => {
  const me = currentUser(req);
  const body = parse(ProfileBody, req.body);
  const [u] = await db.update(users).set(body).where(eq(users.id, me.id)).returning();
  ok(res, toPublicUser(u!, me.role));
});

/** Coach, admin, or both — each at most once. */
const zRoles = z
  .array(z.enum(['admin', 'coach']))
  .min(1, 'Pick at least one role')
  .max(2)
  .refine((r) => new Set(r).size === r.length, 'A role can only be given once')
  // Stored in a fixed order so "admin + coach" is always the same value.
  .transform((r) => (['admin', 'coach'] as const).filter((x) => r.includes(x)));

// ─── Admin: manage coaches and admins ────────────────────────────────────────

const ListQuery = zPagination.extend({
  role: z.enum(['admin', 'coach']).optional(),
  status: z.enum(['invited', 'active', 'disabled']).optional(),
  search: z.string().trim().max(100).optional(),
});

usersRouter.get('/', requireAdmin, async (req, res) => {
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [];
  if (q.role) filters.push(arrayContains(users.roles, [q.role]));
  if (q.status) filters.push(eq(users.status, q.status));
  if (q.search) {
    const term = `%${q.search}%`;
    filters.push(or(ilike(users.name, term), ilike(users.email, term), ilike(users.phone, term))!);
  }
  const where = filters.length ? and(...filters) : undefined;

  const batchCount = db
    .select({ coachId: batches.coachId, n: count().as('n') })
    .from(batches)
    .where(eq(batches.isActive, true))
    .groupBy(batches.coachId)
    .as('bc');

  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({ user: users, activeBatches: sql<number>`coalesce(${batchCount.n}, 0)::int` })
      .from(users)
      .leftJoin(batchCount, eq(batchCount.coachId, users.id))
      .where(where)
      .orderBy(asc(users.name))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ total: count() }).from(users).where(where),
  ]);

  ok(res, await withTeamStats(rows), pageMeta(q.page, q.pageSize, total));
});

/**
 * For the team cards: students in their active batches, check-ins and on-time rate over the last
 * 30 days, cash they hold and what the academy owes them.
 */
async function withTeamStats(rows: { user: typeof users.$inferSelect; activeBatches: number }[]) {
  const ids = rows.map((r) => r.user.id);
  if (!ids.length) return [];
  const from = addDays(todayInAppTz(), -29);
  const [students, sessions] = await Promise.all([
    db
      .select({ coachId: batches.coachId, n: sql<number>`count(*)::int` })
      .from(enrollments)
      .innerJoin(batches, eq(batches.id, enrollments.batchId))
      .where(
        and(
          inArray(batches.coachId, ids),
          eq(batches.isActive, true),
          isNull(enrollments.effectiveTo),
        ),
      )
      .groupBy(batches.coachId),
    db
      .select({
        coachId: coachSessions.coachId,
        n: sql<number>`count(*)::int`,
        onTime: sql<number>`count(*) filter (where (${coachSessions.checkInAt} at time zone 'Asia/Kolkata')::time <= ${coachSessions.scheduledStart} + interval '10 minutes')::int`,
      })
      .from(coachSessions)
      .where(and(inArray(coachSessions.coachId, ids), gte(coachSessions.date, from)))
      .groupBy(coachSessions.coachId),
  ]);
  return Promise.all(
    rows.map(async (r) => {
      const s = sessions.find((x) => x.coachId === r.user.id);
      const [cash, owed] = await Promise.all([
        balanceOf(db, 'cash', { userId: r.user.id }),
        balanceOf(db, 'staff_due', { userId: r.user.id }),
      ]);
      return {
        ...toPublicUser(r.user),
        activeBatches: r.activeBatches,
        students: students.find((x) => x.coachId === r.user.id)?.n ?? 0,
        checkIns30: s?.n ?? 0,
        onTimeRate: s?.n ? Math.round((s.onTime * 100) / s.n) : null,
        cashHeld: cash,
        owed,
      };
    }),
  );
}

const CreateBody = z.object({
  name: zName,
  email: zEmail,
  phone: zPhone.nullable().optional(),
  role: z.enum(['admin', 'coach']).default('coach'),
  /** Every role they hold; defaults to just `role`. */
  roles: zRoles.optional(),
});

/** Creates the account and returns a one-time invite link the admin can share (e.g. WhatsApp). */
usersRouter.post('/', requireAdmin, async (req, res) => {
  const body = parse(CreateBody, req.body);
  const result = await db.transaction(async (tx) => {
    const roles = body.roles ?? [body.role];
    const [u] = await tx
      .insert(users)
      .values({
        name: body.name,
        email: body.email,
        roles,
        lastRole: roles.includes(body.role) ? body.role : roles[0]!,
        phone: body.phone ?? null,
        status: 'invited',
      })
      .returning();
    const invite = await createOneTimeToken(u!.id, 'invite', req.user!.id, tx);
    await audit(
      {
        ...auditCtx(req),
        action: 'user.invited',
        entityType: 'user',
        entityId: u!.id,
        metadata: { roles: body.roles ?? [body.role] },
      },
      tx,
    );
    return { user: toPublicUser(u!), inviteUrl: invite.url, inviteExpiresAt: invite.expiresAt };
  });
  created(res, result);
});

usersRouter.get('/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const u = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!u) throw AppError.notFound('User');
  ok(res, toPublicUser(u));
});

const UpdateBody = z.object({
  name: zName.optional(),
  email: zEmail.optional(),
  phone: zPhone.nullable().optional(),
  roles: zRoles.optional(),
});

usersRouter.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(UpdateBody, req.body);
  const current = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!current) throw AppError.notFound('User');
  if (body.roles && !body.roles.includes('admin') && id === currentUser(req).id)
    throw AppError.unprocessable('You can’t remove your own admin role');
  const changes = body.roles
    ? {
        ...body,
        // Their default role must stay one they hold.
        lastRole: body.roles.includes(current.lastRole) ? current.lastRole : body.roles[0]!,
      }
    : body;
  const [u] = await db.update(users).set(changes).where(eq(users.id, id)).returning();
  if (!u) throw AppError.notFound('User');
  await audit({
    ...auditCtx(req),
    action: 'user.updated',
    entityType: 'user',
    entityId: id,
    metadata: body,
  });
  // Giving or taking away a role is an access change: its own entry, flagged for a second look.
  if (body.roles && body.roles.join() !== [...current.roles].sort().join())
    await audit({
      ...auditCtx(req),
      action: 'user.roles_changed',
      entityType: 'user',
      entityId: id,
      metadata: { from: current.roles, to: body.roles },
    });
  ok(res, toPublicUser(u));
});

/** Regenerates an invite link (invited users) or issues a password-reset link (active users). */
usersRouter.post('/:id/access-link', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const u = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!u) throw AppError.notFound('User');
  if (u.status === 'disabled')
    throw AppError.unprocessable('Enable the user before sending a link');
  const type = u.status === 'invited' ? 'invite' : 'password_reset';
  const link = await createOneTimeToken(u.id, type, req.user!.id);
  await audit({
    ...auditCtx(req),
    action: `user.${type}_link_created`,
    entityType: 'user',
    entityId: id,
  });
  ok(res, { type, url: link.url, expiresAt: link.expiresAt });
});

const StatusBody = z.object({ status: z.enum(['active', 'disabled']) });

usersRouter.post('/:id/status', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { status } = parse(StatusBody, req.body);
  if (id === req.user!.id) throw AppError.unprocessable('You cannot change your own status');

  const updated = await db.transaction(async (tx) => {
    const u = await tx.query.users.findFirst({ where: eq(users.id, id) });
    if (!u) throw AppError.notFound('User');

    if (status === 'disabled') {
      const [active] = await tx
        .select({ n: count() })
        .from(batches)
        .where(and(eq(batches.coachId, id), eq(batches.isActive, true)));
      if ((active?.n ?? 0) > 0) {
        throw AppError.unprocessable(
          'This coach still has active batches. Reassign or deactivate them before disabling the account.',
        );
      }
      await revokeAllSessions(id, tx);
    }
    // Re-enabling an account that never set a password returns it to "invited".
    const nextStatus = status === 'active' && !u.passwordHash ? 'invited' : status;
    const [row] = await tx
      .update(users)
      .set({ status: nextStatus })
      .where(eq(users.id, id))
      .returning();
    await audit(
      {
        ...auditCtx(req),
        action: `user.${status === 'active' ? 'enabled' : 'disabled'}`,
        entityType: 'user',
        entityId: id,
      },
      tx,
    );
    return row!;
  });
  ok(res, toPublicUser(updated));
});
