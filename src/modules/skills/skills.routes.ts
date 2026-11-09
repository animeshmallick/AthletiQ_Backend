/**
 * Monthly skill assessments.
 *  - GET /skills/batches/:id?month=YYYY-MM   the batch's students with this month's and the
 *    previous ratings. Only the batch's main coach edits (and only in the current month);
 *    admins can view.
 *  - PUT /skills/assessments                 save one student's ratings for the current month.
 *  - GET /skills/students/:id                a student's whole skill history.
 *  - GET /skills/insights?month&batchId      coverage, batch heatmap, movers, levels and more
 *    (admins: the academy; coaches: their own batches).
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  batches,
  enrollments,
  skillAssessments,
  skillRatings,
  sports,
  studentPhotos,
  students,
  users,
} from '../../db/schema/index.js';
import { addMonthsClamped, todayInAppTz } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { parse, zId, zIdParam, zOptionalText } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import type { AuthUser } from '../auth/auth.types.js';
import { assertStudentAccess, getBatchOrThrow, isAdmin } from '../access/access.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { activeSkills, levelFor, loadFramework, loadFrameworks, monthStart } from './framework.js';
import { areaAverage, loadProgress } from './progress.js';

export const skillsRouter = Router();

const zMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
  .transform((m) => `${m}-01`);

const thisMonth = () => monthStart(todayInAppTz());

function canEdit(user: AuthUser, batch: { coachId: string }, month: string) {
  return !isAdmin(user) && batch.coachId === user.id && month === thisMonth();
}

// ─── One batch, one month ────────────────────────────────────────────────────

skillsRouter.get('/batches/:id', async (req, res) => {
  const user = currentUser(req);
  const { id } = parse(zIdParam, req.params);
  const { month = thisMonth() } = parse(z.object({ month: zMonth.optional() }), req.query);
  const batch = await getBatchOrThrow(id);
  // Only the main coach (and admins) — substitutes don't assess.
  if (!isAdmin(user) && batch.coachId !== user.id) throw AppError.notFound('Batch');
  if (month > thisMonth()) throw AppError.badRequest('That month has not started yet');

  const framework = await loadFramework(batch.sportId);
  // Current members, plus anyone assessed in this batch that month (they may have moved since).
  const [members, assessedThen] = await Promise.all([
    db
      .select({ id: students.id, fullName: students.fullName, code: students.code })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .where(and(eq(enrollments.batchId, id), isNull(enrollments.effectiveTo))),
    db
      .select({ id: students.id, fullName: students.fullName, code: students.code })
      .from(skillAssessments)
      .innerJoin(students, eq(students.id, skillAssessments.studentId))
      .where(and(eq(skillAssessments.batchId, id), eq(skillAssessments.month, month))),
  ]);
  const roster = [...new Map([...members, ...assessedThen].map((s) => [s.id, s])).values()].sort(
    (a, b) => a.fullName.localeCompare(b.fullName),
  );
  const ids = roster.map((s) => s.id);

  const [assessments, photos] = await Promise.all([
    ids.length
      ? db
          .select()
          .from(skillAssessments)
          .where(
            and(
              inArray(skillAssessments.studentId, ids),
              eq(skillAssessments.batchId, batch.id),
              lt(skillAssessments.month, monthStart(addMonthsClamped(month, 1))),
            ),
          )
          .orderBy(desc(skillAssessments.month))
      : [],
    ids.length
      ? db
          .select({ id: studentPhotos.studentId })
          .from(studentPhotos)
          .where(inArray(studentPhotos.studentId, ids))
      : [],
  ]);
  const ratings = assessments.length
    ? await db
        .select()
        .from(skillRatings)
        .where(
          inArray(
            skillRatings.assessmentId,
            assessments.map((a) => a.id),
          ),
        )
    : [];
  const view = (a: (typeof assessments)[number]) => ({
    id: a.id,
    month: a.month,
    average: a.average,
    levelName: a.levelName,
    levelCode: a.levelCode,
    comment: a.comment,
    goals: a.goals,
    updatedAt: a.updatedAt,
    ratings: Object.fromEntries(
      ratings.filter((r) => r.assessmentId === a.id).map((r) => [r.skillId, r.rating]),
    ),
  });

  ok(res, {
    batch: { id: batch.id, name: batch.name, coachId: batch.coachId },
    month,
    editable: canEdit(user, batch, month),
    framework,
    students: roster.map((s) => {
      const mine = assessments.filter((a) => a.studentId === s.id);
      const current = mine.find((a) => a.month === month);
      const previous = mine.find((a) => a.month < month);
      return {
        ...s,
        hasPhoto: photos.some((p) => p.id === s.id),
        current: current ? view(current) : null,
        previous: previous ? view(previous) : null,
      };
    }),
  });
});

const AssessmentBody = z.object({
  batchId: zId,
  studentId: zId,
  ratings: z
    .array(z.object({ skillId: zId, rating: z.number().int().min(1).max(5) }))
    .min(1)
    .max(300),
  comment: zOptionalText(1000),
  goals: zOptionalText(1000),
});

/** The main coach saves this month's assessment (create or update until the month ends). */
skillsRouter.put('/assessments', async (req, res) => {
  const user = currentUser(req);
  const body = parse(AssessmentBody, req.body);
  const batch = await getBatchOrThrow(body.batchId);
  if (isAdmin(user) || batch.coachId !== user.id)
    throw AppError.forbidden('Only the batch’s coach can assess its students');
  const month = thisMonth();

  const [member] = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.batchId, batch.id),
        eq(enrollments.studentId, body.studentId),
        isNull(enrollments.effectiveTo),
      ),
    )
    .limit(1);
  if (!member) throw AppError.unprocessable('This student is not in the batch');

  const framework = await loadFramework(batch.sportId);
  const wanted = activeSkills(framework);
  if (!wanted.length) throw AppError.unprocessable('This sport has no skills set up yet');
  const given = new Map(body.ratings.map((r) => [r.skillId, r.rating]));
  if (body.ratings.some((r) => !wanted.some((k) => k.id === r.skillId)))
    throw AppError.unprocessable('Some ratings are for skills this batch is not assessed on');
  const missing = wanted.filter((k) => !given.has(k.id));
  if (missing.length)
    throw new AppError('VALIDATION_ERROR', `Rate every skill (${missing.length} left)`, {
      fields: missing.map((k) => ({ path: k.id, message: 'Required' })),
    });

  const values = [...given.values()];
  const average = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100);
  const level = levelFor(framework.levels, average);
  const saved = await db.transaction(async (tx) => {
    const [a] = await tx
      .insert(skillAssessments)
      .values({
        studentId: body.studentId,
        sportId: batch.sportId,
        batchId: batch.id,
        coachId: user.id,
        month,
        average,
        levelName: level?.name ?? null,
        levelCode: level?.code ?? null,
        levelPosition: level?.position ?? null,
        comment: body.comment ?? null,
        goals: body.goals ?? null,
      })
      .onConflictDoUpdate({
        target: [skillAssessments.studentId, skillAssessments.batchId, skillAssessments.month],
        set: {
          sportId: batch.sportId,
          coachId: user.id,
          average,
          levelName: level?.name ?? null,
          levelCode: level?.code ?? null,
          levelPosition: level?.position ?? null,
          comment: body.comment ?? null,
          goals: body.goals ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    await tx.delete(skillRatings).where(eq(skillRatings.assessmentId, a!.id));
    await tx
      .insert(skillRatings)
      .values([...given].map(([skillId, rating]) => ({ assessmentId: a!.id, skillId, rating })));
    return a!;
  });
  await audit({
    ...auditCtx(req),
    action: 'skills.assessed',
    entityType: 'student',
    entityId: body.studentId,
    metadata: { month, average: average / 100, level: level?.name ?? null, batchId: batch.id },
  });
  ok(res, { ...saved, ratings: Object.fromEntries(given) });
});

// ─── One student ─────────────────────────────────────────────────────────────

skillsRouter.get('/students/:id', async (req, res) => {
  const user = currentUser(req);
  const { id } = parse(zIdParam, req.params);
  await assertStudentAccess(user, id);
  const progress = (await loadProgress([id])).get(id) ?? [];
  ok(
    res,
    progress.map((p) => {
      const latest = p.assessments.at(-1)!;
      const prev = p.assessments.at(-2) ?? null;
      return {
        framework: p.framework,
        assessments: p.assessments,
        current: {
          month: latest.month,
          average: latest.average,
          levelName: latest.levelName,
          levelCode: latest.levelCode,
          levelPosition: latest.levelPosition,
          change: prev ? latest.average - prev.average : null,
        },
        areas: p.framework.areas
          .map((area) => ({
            id: area.id,
            name: area.name,
            now: areaAverage(area, latest.ratings),
            before: prev ? areaAverage(area, prev.ratings) : null,
          }))
          .filter((a) => a.now !== null),
      };
    }),
  );
});

// ─── Insights ────────────────────────────────────────────────────────────────

skillsRouter.get('/insights', async (req, res) => {
  const user = currentUser(req);
  const q = parse(z.object({ month: zMonth.optional(), batchId: zId.optional() }), req.query);
  const month = q.month ?? thisMonth();
  const admin = isAdmin(user);

  // Batches in scope: active ones (coaches: those they run as main coach).
  const scope = await db
    .select({
      id: batches.id,
      name: batches.name,
      sportId: batches.sportId,
      sportName: sports.name,
      coachId: batches.coachId,
      coachName: users.name,
    })
    .from(batches)
    .innerJoin(sports, eq(sports.id, batches.sportId))
    .innerJoin(users, eq(users.id, batches.coachId))
    .where(
      and(
        eq(batches.isActive, true),
        admin ? undefined : eq(batches.coachId, user.id),
        q.batchId ? eq(batches.id, q.batchId) : undefined,
      ),
    )
    .orderBy(asc(batches.name));
  const batchIds = scope.map((b) => b.id);
  const members = batchIds.length
    ? await db
        .select({
          batchId: enrollments.batchId,
          studentId: students.id,
          fullName: students.fullName,
        })
        .from(enrollments)
        .innerJoin(students, eq(students.id, enrollments.studentId))
        .where(and(inArray(enrollments.batchId, batchIds), isNull(enrollments.effectiveTo)))
    : [];
  const studentIds = [...new Set(members.map((m) => m.studentId))];
  const sportIds = [...new Set(scope.map((b) => b.sportId))];
  const [frameworks, assessments] = await Promise.all([
    loadFrameworks(sportIds),
    studentIds.length
      ? db
          .select()
          .from(skillAssessments)
          .where(
            and(
              inArray(skillAssessments.studentId, studentIds),
              inArray(skillAssessments.batchId, batchIds),
              lt(skillAssessments.month, monthStart(addMonthsClamped(month, 1))),
              // Six months of history is plenty for trends.
              gte(skillAssessments.month, monthStart(addMonthsClamped(month, -6))),
            ),
          )
          .orderBy(desc(skillAssessments.month))
      : [],
  ]);
  const ratings = assessments.length
    ? await db
        .select()
        .from(skillRatings)
        .where(
          inArray(
            skillRatings.assessmentId,
            assessments.map((a) => a.id),
          ),
        )
    : [];
  const ratingsOf = (assessmentId: string) =>
    Object.fromEntries(
      ratings.filter((r) => r.assessmentId === assessmentId).map((r) => [r.skillId, r.rating]),
    );
  const bySport = (b: (typeof scope)[number]) => frameworks.find((f) => f.sport.id === b.sportId)!;
  /** A student's assessments in a batch, newest first, up to `month`. */
  const historyOf = (studentId: string, batchId: string) =>
    assessments.filter((a) => a.studentId === studentId && a.batchId === batchId);

  // Coverage: who still needs this month's assessment.
  const coverage = scope.map((b) => {
    const kids = members.filter((m) => m.batchId === b.id);
    const done = kids.filter((k) => historyOf(k.studentId, b.id).some((a) => a.month === month));
    return {
      batchId: b.id,
      batchName: b.name,
      sportName: b.sportName,
      coachId: b.coachId,
      coachName: b.coachName,
      students: kids.length,
      assessed: done.length,
      pending: kids
        .filter((k) => !done.includes(k))
        .map((k) => ({ id: k.studentId, fullName: k.fullName })),
    };
  });

  // Heatmap: each batch's average per area, from each student's latest assessment.
  const heatmap = scope.map((b) => {
    const f = bySport(b);
    const latest = members
      .filter((m) => m.batchId === b.id)
      .map((m) => historyOf(m.studentId, b.id)[0])
      .filter((a): a is (typeof assessments)[number] => !!a);
    return {
      batchId: b.id,
      batchName: b.name,
      sportName: b.sportName,
      assessed: latest.length,
      areas: f.areas
        .filter((a) => a.isActive)
        .map((area) => {
          const vals = latest
            .map((a) => areaAverage(area, ratingsOf(a.id)))
            .filter((v): v is number => v !== null);
          return {
            areaId: area.id,
            name: area.name,
            average: vals.length ? Math.round(vals.reduce((x, y) => x + y, 0) / vals.length) : null,
          };
        }),
    };
  });

  // Movers: change between each student's two latest assessments (latest must be this month).
  type Mover = {
    studentId: string;
    fullName: string;
    batchName: string;
    average: number;
    change: number;
    levelName: string | null;
    levelCode: string | null;
    levelChange: number;
  };
  const movers: Mover[] = [];
  const stale: {
    studentId: string;
    fullName: string;
    batchName: string;
    lastMonth: string | null;
  }[] = [];
  for (const m of members) {
    const b = scope.find((x) => x.id === m.batchId)!;
    const [now, before] = historyOf(m.studentId, b.id);
    if (!now || now.month < monthStart(addMonthsClamped(month, -1)))
      stale.push({
        studentId: m.studentId,
        fullName: m.fullName,
        batchName: b.name,
        lastMonth: now?.month ?? null,
      });
    if (now?.month === month && before)
      movers.push({
        studentId: m.studentId,
        fullName: m.fullName,
        batchName: b.name,
        average: now.average,
        change: now.average - before.average,
        levelName: now.levelName,
        levelCode: now.levelCode,
        levelChange: (now.levelPosition ?? 0) - (before.levelPosition ?? 0),
      });
  }
  const improved = movers
    .filter((x) => x.change > 0)
    .sort((a, b) => b.change - a.change)
    .slice(0, 8);
  const atRisk = movers
    .filter((x) => x.change < 0)
    .sort((a, b) => a.change - b.change)
    .slice(0, 8);

  // Levels: distribution from each student's latest assessment, per sport.
  const levels = frameworks.map((f) => {
    const latest = members
      .filter((m) => scope.find((b) => b.id === m.batchId)!.sportId === f.sport.id)
      .map((m) => historyOf(m.studentId, m.batchId)[0])
      .filter((a): a is (typeof assessments)[number] => !!a);
    const unique = [...new Map(latest.map((a) => [a.studentId, a])).values()];
    return {
      sportId: f.sport.id,
      sportName: f.sport.name,
      levels: f.levels.map((l) => ({
        code: l.code,
        name: l.name,
        n: unique.filter((a) => a.levelName === l.name).length,
      })),
      unranked: unique.filter((a) => !a.levelName).length,
      promoted: movers.filter((x) => x.levelChange > 0).length,
      demoted: movers.filter((x) => x.levelChange < 0).length,
    };
  });

  // Skills: strongest and weakest across everyone's latest assessment.
  const skillTotals = new Map<string, { name: string; area: string; sum: number; n: number }>();
  const seen = new Set<string>();
  for (const m of members) {
    const b = scope.find((x) => x.id === m.batchId)!;
    const now = historyOf(m.studentId, b.id)[0];
    if (!now || seen.has(now.id)) continue;
    seen.add(now.id);
    const f = bySport(b);
    for (const [skillId, rating] of Object.entries(ratingsOf(now.id))) {
      const area = f.areas.find((a) => a.skills.some((k) => k.id === skillId));
      const skill = area?.skills.find((k) => k.id === skillId);
      if (!area || !skill) continue;
      const t = skillTotals.get(skillId) ?? { name: skill.name, area: area.name, sum: 0, n: 0 };
      t.sum += rating;
      t.n += 1;
      skillTotals.set(skillId, t);
    }
  }
  const skillAverages = [...skillTotals.entries()]
    .map(([id, t]) => ({
      skillId: id,
      name: t.name,
      area: t.area,
      average: Math.round((t.sum / t.n) * 100),
      n: t.n,
    }))
    .sort((a, b) => b.average - a.average);

  // Academy average by month (last six), from everything in scope.
  const months = Array.from({ length: 6 }, (_, i) => monthStart(addMonthsClamped(month, i - 5)));
  const trend = months.map((m) => {
    const list = assessments.filter((a) => a.month === m);
    return {
      month: m,
      assessed: list.length,
      average: list.length
        ? Math.round(list.reduce((x, a) => x + a.average, 0) / list.length)
        : null,
    };
  });

  // Coaches (admins): how many they assessed this month and how generously they rate.
  const coaches = admin
    ? [...new Map(scope.map((b) => [b.coachId, b.coachName])).entries()].map(([id, name]) => {
        const mine = assessments.filter((a) => a.coachId === id && a.month === month);
        const cov = coverage.filter((c) => c.coachId === id);
        return {
          coachId: id,
          name,
          students: cov.reduce((n, c) => n + c.students, 0),
          assessed: cov.reduce((n, c) => n + c.assessed, 0),
          averageGiven: mine.length
            ? Math.round(mine.reduce((x, a) => x + a.average, 0) / mine.length)
            : null,
        };
      })
    : [];

  const totalStudents = coverage.reduce((n, c) => n + c.students, 0);
  const totalAssessed = coverage.reduce((n, c) => n + c.assessed, 0);
  const thisMonthList = assessments.filter((a) => a.month === month);
  ok(res, {
    month,
    totals: {
      students: totalStudents,
      assessed: totalAssessed,
      coverage: totalStudents ? Math.round((totalAssessed / totalStudents) * 100) : null,
      average: thisMonthList.length
        ? Math.round(thisMonthList.reduce((x, a) => x + a.average, 0) / thisMonthList.length)
        : null,
      improved: movers.filter((x) => x.change > 0).length,
      declined: movers.filter((x) => x.change < 0).length,
      promoted: movers.filter((x) => x.levelChange > 0).length,
      demoted: movers.filter((x) => x.levelChange < 0).length,
    },
    coverage,
    heatmap,
    improved,
    atRisk,
    stale: stale.slice(0, 20),
    staleCount: stale.length,
    levels,
    strongest: skillAverages.slice(0, 5),
    weakest: [...skillAverages].reverse().slice(0, 5),
    trend,
    coaches,
  });
});
