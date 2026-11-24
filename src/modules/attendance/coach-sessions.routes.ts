import { and, asc, desc, eq, gte, lte, or, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  batches,
  coachSessions,
  locations,
  sessionCancellations,
  users,
} from '../../db/schema/index.js';
import { addDays, diffDays, instantAt, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { distanceMeters, isWithinGeofence } from '../../lib/geo.js';
import { parse, zId, zIdParam, zIsoDate, zOptionalText } from '../../lib/validation.js';
import { currentUser, requireAdmin, requireCoach } from '../../middleware/auth.js';
import { isAdmin, isSubstituteFor } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { coveredBy, substitutesOn } from '../substitutions/coverage.js';
import { assertNotCancelled, cancellationsIn } from './cancellations.js';
import { notifyAdmins, notifyInBackground } from '../push/push.service.js';
import { mayRunOnSql, sessionOn, sessionOrigin, sessionsOnDay } from '../schedule/schedule.js';

export const coachSessionsRouter = Router();

/** Check-ins earlier than this before the start (or after the end) are flagged. */
const EARLY_MINUTES = 30;

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

const toMin = (t: string) => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};

/** A check-in with its flag and the session's scheduled length (there is no check-out). */
function present(s: typeof coachSessions.$inferSelect) {
  return {
    ...s,
    flagged: !s.checkInWithinFence || s.outsideTime,
    durationMinutes: Math.max(toMin(s.scheduledEnd) - toMin(s.scheduledStart), 0),
  };
}

// ─── Coach: today's sessions ────────────────────────────────────────────────

coachSessionsRouter.get('/today', requireCoach, async (req, res) => {
  const user = currentUser(req);
  const today = todayInAppTz();
  const [candidates, sessions] = await Promise.all([
    db
      .select({ batch: batches, location: locations })
      .from(batches)
      .innerJoin(locations, eq(locations.id, batches.locationId))
      .where(
        and(
          or(eq(batches.coachId, user.id), coveredBy(user.id, today)),
          eq(batches.isActive, true),
          mayRunOnSql(today),
        ),
      )
      .orderBy(asc(batches.startTime)),
    db
      .select()
      .from(coachSessions)
      .where(and(eq(coachSessions.coachId, user.id), eq(coachSessions.date, today))),
  ]);

  const running = await sessionsOnDay(
    candidates.map((r) => ({ ...r.batch, row: r })),
    today,
  );
  const todaysBatches = running.map(({ batch: { row }, session }) => ({ ...row, session }));
  const ids = todaysBatches.map((b) => b.batch.id);
  const [cancelled, subs] = await Promise.all([
    cancellationsIn(ids, today, today),
    substitutesOn(ids, today),
  ]);
  const list = todaysBatches
    .map((r) => ({
      ...r,
      time: { startTime: r.session.startTime, endTime: r.session.endTime },
    }))
    .sort((a, b) => a.time.startTime.localeCompare(b.time.startTime));
  ok(res, {
    date: today,
    sessions: list.map(({ batch, location, time, session: planned }) => {
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
        origin: sessionOrigin(planned),
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
  const planned = await sessionOn(batch, today);
  if (!planned) throw AppError.unprocessable(`${batch.name} is not scheduled today`);
  await assertNotCancelled(batch.id, today);

  const { distance, within } = evaluate(location, body.latitude, body.longitude, body.accuracy);
  const now = Date.now();
  const opens = instantAt(today, planned.startTime).getTime() - EARLY_MINUTES * 60_000;
  const outsideTime = now < opens || now > instantAt(today, planned.endTime).getTime();
  const session = await db.transaction(async (tx) => {
    // Serialised with cancelling this session.
    await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, batch.id)).for('update');
    const off = await tx.$count(
      sessionCancellations,
      and(eq(sessionCancellations.batchId, batch.id), eq(sessionCancellations.date, today)),
    );
    if (off) throw AppError.unprocessable('This session was cancelled');
    const [added] = await tx
      .insert(coachSessions)
      .values({
        coachId: user.id,
        batchId: batch.id,
        locationId: location.id,
        date: today,
        scheduledStart: planned.startTime,
        scheduledEnd: planned.endTime,
        checkInAt: new Date(),
        checkInLat: body.latitude,
        checkInLng: body.longitude,
        checkInAccuracyM: body.accuracy ?? null,
        checkInDistanceM: distance,
        checkInWithinFence: within,
        outsideTime,
        note: body.note,
      })
      .onConflictDoNothing()
      .returning();
    return added;
  });
  if (!session) throw AppError.conflict('You have already checked in for this session');
  if (!within || outsideTime) {
    const why = [
      within ? null : `${distance} m from ${location.name}`,
      outsideTime
        ? `session time is ${planned.startTime.slice(0, 5)}–${planned.endTime.slice(0, 5)}`
        : null,
    ].filter(Boolean);
    notifyInBackground(() =>
      notifyAdmins({
        category: 'sessions',
        icon: '🚩',
        actions: [{ label: 'Review', link: '/coach-sessions' }],
        title: `${user.name} checked in ${within ? 'outside session time' : 'away from the venue'}`,
        body: `${why.join(' · ')} · ${batch.name}. Review the check-in.`,
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

// ─── History / admin review ──────────────────────────────────────────────────

const FLAGGED = or(
  eq(coachSessions.checkInWithinFence, false),
  eq(coachSessions.outsideTime, true),
)!;

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
  if (q.flagged === 'true') filters.push(FLAGGED);

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
  // Hours coached: each checked-in session counts its scheduled length.
  const totalMinutes = sessions.reduce((sum, s) => sum + s.durationMinutes, 0);
  ok(res, {
    from,
    to,
    sessions,
    summary: {
      sessions: sessions.length,
      flagged: sessions.filter((s) => s.flagged).length,
      unreviewedFlagged: sessions.filter((s) => s.flagged && !s.reviewedAt).length,
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
