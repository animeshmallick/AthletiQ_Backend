import { timesOn } from '../../lib/batch-times.js';
import { and, asc, desc, eq, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { batches, coachSessions, locations, users } from '../../db/schema/index.js';
import { addDays, diffDays, isoWeekday, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { distanceMeters, isWithinGeofence } from '../../lib/geo.js';
import { parse, zId, zIdParam, zIsoDate, zOptionalText } from '../../lib/validation.js';
import { currentUser, requireAdmin, requireCoach } from '../../middleware/auth.js';
import { isAdmin, isSubstituteFor } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { coveredBy, substitutesOn } from '../substitutions/coverage.js';
import { assertNotCancelled, cancellationsIn } from './cancellations.js';
import { notifyAdmins, notifyInBackground, notifyUsers } from '../push/push.service.js';

export const coachSessionsRouter = Router();

const GpsBody = z.object({
  batchId: zId,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Reported GPS accuracy radius in metres. */
  accuracy: z.number().min(0).max(10_000).nullable().optional(),
  note: zOptionalText(500),
});

/** The batch (with location) if this coach runs it today: as its coach or its substitute. */
async function loadOwnBatchWithLocation(coachId: string, batchId: string) {
  const [row] = await db
    .select({ batch: batches, location: locations })
    .from(batches)
    .innerJoin(locations, eq(locations.id, batches.locationId))
    .where(eq(batches.id, batchId));
  if (!row) throw AppError.notFound('Batch');
  if (row.batch.coachId !== coachId && !(await isSubstituteFor(coachId, batchId, todayInAppTz())))
    throw AppError.notFound('Batch');
  return row;
}

function evaluate(
  location: typeof locations.$inferSelect,
  lat: number,
  lng: number,
  accuracy?: number | null,
) {
  const distance = Math.round(
    distanceMeters({ lat, lng }, { lat: location.latitude, lng: location.longitude }),
  );
  return { distance, within: isWithinGeofence(distance, location.radiusMeters, accuracy) };
}

function present(s: typeof coachSessions.$inferSelect) {
  return {
    ...s,
    flagged: !s.checkInWithinFence || s.checkOutWithinFence === false,
    durationMinutes: s.checkOutAt
      ? Math.round((s.checkOutAt.getTime() - s.checkInAt.getTime()) / 60_000)
      : null,
  };
}

// ─── Coach: today's sessions ────────────────────────────────────────────────

coachSessionsRouter.get('/today', requireCoach, async (req, res) => {
  const user = currentUser(req);
  const today = todayInAppTz();
  const weekday = isoWeekday(today);

  const [todaysBatches, sessions] = await Promise.all([
    db
      .select({ batch: batches, location: locations })
      .from(batches)
      .innerJoin(locations, eq(locations.id, batches.locationId))
      .where(
        and(
          or(eq(batches.coachId, user.id), coveredBy(user.id, today)),
          eq(batches.isActive, true),
          sql`${weekday} = any(${batches.weekdays})`,
        ),
      )
      .orderBy(asc(batches.startTime)),
    db
      .select()
      .from(coachSessions)
      .where(and(eq(coachSessions.coachId, user.id), eq(coachSessions.date, today))),
  ]);

  const ids = todaysBatches.map((b) => b.batch.id);
  const [cancelled, subs] = await Promise.all([
    cancellationsIn(ids, today, today),
    substitutesOn(ids, today),
  ]);
  const list = todaysBatches
    .map((r) => ({ ...r, time: timesOn(r.batch, today) }))
    .sort((a, b) => a.time.startTime.localeCompare(b.time.startTime));
  ok(res, {
    date: today,
    sessions: list.map(({ batch, location, time }) => {
      const s = sessions.find((x) => x.batchId === batch.id);
      return {
        // Today's own time (a batch can run at different times on different days).
        batch: { id: batch.id, name: batch.name, ...time },
        location: {
          id: location.id,
          name: location.name,
          address: location.address,
          latitude: location.latitude,
          longitude: location.longitude,
          radiusMeters: location.radiusMeters,
        },
        session: s ? present(s) : null,
        cancelled: cancelled.get(`${batch.id}:${today}`) ?? null,
        /** You're covering this batch today as a substitute. */
        asSubstitute: batch.coachId !== user.id,
        substitute: subs.get(batch.id) ?? null,
      };
    }),
  });
});

coachSessionsRouter.post('/check-in', requireCoach, async (req, res) => {
  const user = currentUser(req);
  const body = parse(GpsBody, req.body);
  const { batch, location } = await loadOwnBatchWithLocation(user.id, body.batchId);
  const today = todayInAppTz();
  if (!batch.isActive) throw AppError.unprocessable('This batch is inactive');
  if (!batch.weekdays.includes(isoWeekday(today)))
    throw AppError.unprocessable(`${batch.name} is not scheduled today`);
  await assertNotCancelled(batch.id, today);

  const { distance, within } = evaluate(location, body.latitude, body.longitude, body.accuracy);
  const [session] = await db
    .insert(coachSessions)
    .values({
      coachId: user.id,
      batchId: batch.id,
      locationId: location.id,
      date: today,
      ...(({ startTime, endTime }) => ({ scheduledStart: startTime, scheduledEnd: endTime }))(
        timesOn(batch, today),
      ),
      checkInAt: new Date(),
      checkInLat: body.latitude,
      checkInLng: body.longitude,
      checkInAccuracyM: body.accuracy ?? null,
      checkInDistanceM: distance,
      checkInWithinFence: within,
      note: body.note,
    })
    .onConflictDoNothing()
    .returning();
  if (!session) throw AppError.conflict('You have already checked in for this session');
  if (!within) {
    notifyInBackground(() =>
      notifyAdmins({
        title: 'Check-in flagged',
        body: `${user.name} checked in ${distance} m from ${location.name} (${batch.name})`,
        link: '/coach-sessions',
        tag: `flag-${session.id}`,
      }),
    );
  }

  ok(res, {
    session: present(session),
    message: within
      ? `Checked in at ${location.name}`
      : `Checked in, but you appear to be ${distance} m from ${location.name}. This check-in has been flagged for review.`,
  });
});

coachSessionsRouter.post('/check-out', requireCoach, async (req, res) => {
  const user = currentUser(req);
  const body = parse(GpsBody, req.body);
  const { location } = await loadOwnBatchWithLocation(user.id, body.batchId);
  const today = todayInAppTz();

  const existing = await db.query.coachSessions.findFirst({
    where: and(
      eq(coachSessions.coachId, user.id),
      eq(coachSessions.batchId, body.batchId),
      eq(coachSessions.date, today),
    ),
  });
  if (!existing) throw AppError.unprocessable('Check in before checking out');
  if (existing.checkOutAt) throw AppError.conflict('You have already checked out of this session');

  const { distance, within } = evaluate(location, body.latitude, body.longitude, body.accuracy);
  const [session] = await db
    .update(coachSessions)
    .set({
      checkOutAt: new Date(),
      checkOutLat: body.latitude,
      checkOutLng: body.longitude,
      checkOutAccuracyM: body.accuracy ?? null,
      checkOutDistanceM: distance,
      checkOutWithinFence: within,
      note: body.note ?? existing.note,
    })
    .where(eq(coachSessions.id, existing.id))
    .returning();

  ok(res, {
    session: present(session!),
    message: within
      ? 'Checked out. Great session!'
      : `Checked out, but you appear to be ${distance} m from ${location.name}. This check-out has been flagged for review.`,
  });
});

// ─── History / admin review ──────────────────────────────────────────────────

const ListQuery = z.object({
  coachId: zId.optional(),
  batchId: zId.optional(),
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  flagged: z.enum(['true', 'false']).optional(),
});

coachSessionsRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const q = parse(ListQuery, req.query);
  const to = q.to ?? todayInAppTz();
  const from = q.from ?? addDays(to, -29);
  if (diffDays(from, to) > 366) throw AppError.badRequest('Date range cannot exceed one year');

  const filters: SQL[] = [gte(coachSessions.date, from), lte(coachSessions.date, to)];
  if (!isAdmin(user)) filters.push(eq(coachSessions.coachId, user.id));
  else if (q.coachId) filters.push(eq(coachSessions.coachId, q.coachId));
  if (q.batchId) filters.push(eq(coachSessions.batchId, q.batchId));
  if (q.flagged === 'true') {
    filters.push(
      or(
        eq(coachSessions.checkInWithinFence, false),
        eq(coachSessions.checkOutWithinFence, false),
      )!,
    );
  }

  const rows = await db
    .select({
      session: coachSessions,
      coach: { id: users.id, name: users.name },
      batch: {
        id: batches.id,
        name: batches.name,
        // The time the session was scheduled for that day.
        startTime: coachSessions.scheduledStart,
        endTime: coachSessions.scheduledEnd,
      },
      location: { id: locations.id, name: locations.name, radiusMeters: locations.radiusMeters },
    })
    .from(coachSessions)
    .innerJoin(users, eq(users.id, coachSessions.coachId))
    .innerJoin(batches, eq(batches.id, coachSessions.batchId))
    .innerJoin(locations, eq(locations.id, coachSessions.locationId))
    .where(and(...filters))
    .orderBy(desc(coachSessions.date), asc(coachSessions.scheduledStart));

  const sessions = rows.map((r) => ({
    ...present(r.session),
    coach: r.coach,
    batch: r.batch,
    location: r.location,
  }));
  const totalMinutes = sessions.reduce((sum, s) => sum + (s.durationMinutes ?? 0), 0);
  ok(res, {
    from,
    to,
    sessions,
    summary: {
      sessions: sessions.length,
      flagged: sessions.filter((s) => s.flagged).length,
      unreviewedFlagged: sessions.filter((s) => s.flagged && !s.reviewedAt).length,
      missingCheckOut: sessions.filter((s) => !s.checkOutAt && s.date < todayInAppTz()).length,
      totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    },
  });
});

coachSessionsRouter.post('/:id/review', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { note } = parse(z.object({ note: zOptionalText(500) }), req.body);
  const [s] = await db
    .update(coachSessions)
    .set({ reviewedById: currentUser(req).id, reviewedAt: new Date(), reviewNote: note })
    .where(eq(coachSessions.id, id))
    .returning();
  if (!s) throw AppError.notFound('Coach session');
  await audit({
    ...auditCtx(req),
    action: 'coach_session.reviewed',
    entityType: 'coach_session',
    entityId: id,
    metadata: { note },
  });
  ok(res, present(s));
});

/**
 * Admin: close a session a coach forgot to check out of (no GPS reading). The time defaults to now
 * and can be set earlier (e.g. the batch end time), never before the check-in or in the future.
 */
coachSessionsRouter.post('/:id/check-out', requireAdmin, async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const body = parse(
    z.object({ at: z.iso.datetime({ offset: true }).optional(), reason: zOptionalText(300) }),
    req.body,
  );
  const admin = currentUser(req);
  const existing = await db.query.coachSessions.findFirst({ where: eq(coachSessions.id, id) });
  if (!existing) throw AppError.notFound('Coach session');
  if (existing.checkOutAt) throw AppError.conflict('This coach has already checked out');
  const at = body.at ? new Date(body.at) : new Date();
  if (at <= existing.checkInAt) throw AppError.badRequest('Check-out must be after the check-in');
  if (at.getTime() > Date.now() + 60_000)
    throw AppError.badRequest('Check-out cannot be in the future');

  const note = [
    existing.note,
    `Checked out by ${admin.name}${body.reason ? `: ${body.reason}` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const [saved] = await db
    .update(coachSessions)
    .set({ checkOutAt: at, note })
    .where(and(eq(coachSessions.id, id), isNull(coachSessions.checkOutAt)))
    .returning();
  if (!saved) throw AppError.conflict('This coach has already checked out');
  await audit({
    ...auditCtx(req),
    action: 'coach_session.checked_out_by_admin',
    entityType: 'coach_session',
    entityId: id,
    metadata: { at: at.toISOString(), reason: body.reason },
  });
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, existing.batchId) });
  notifyInBackground(() =>
    notifyUsers([existing.coachId], {
      title: 'You were checked out',
      body: `${batch?.name ?? 'Your session'} · by ${admin.name}${body.reason ? ` (${body.reason})` : ''}`,
      link: '/coach-sessions',
      tag: `checkout-${id}`,
    }),
  );
  ok(res, present(saved));
});
