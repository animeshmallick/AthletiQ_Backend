/**
 * A student's skill history, loaded in bulk for any number of students: every assessment with
 * its ratings, per sport, plus each sport's framework. Used by the app and the parent report.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { batches, skillAssessments, skillRatings, users } from '../../db/schema/index.js';
import { loadFrameworks, type Framework } from './framework.js';

export interface AssessmentView {
  id: string;
  month: string;
  average: number;
  levelName: string | null;
  levelCode: string | null;
  levelPosition: number | null;
  comment: string | null;
  goals: string | null;
  batchId: string;
  batchName: string;
  coachName: string;
  updatedAt: Date;
  ratings: Record<string, number>;
}

export interface SportProgress {
  framework: Framework;
  batchId: string;
  batchName: string;
  /** Oldest first. */
  assessments: AssessmentView[];
}

export async function loadProgress(studentIds: string[]): Promise<Map<string, SportProgress[]>> {
  const out = new Map<string, SportProgress[]>();
  if (!studentIds.length) return out;
  const rows = await db
    .select({
      a: skillAssessments,
      batchName: batches.name,
      coachName: users.name,
    })
    .from(skillAssessments)
    .innerJoin(batches, eq(batches.id, skillAssessments.batchId))
    .innerJoin(users, eq(users.id, skillAssessments.coachId))
    .where(inArray(skillAssessments.studentId, studentIds))
    .orderBy(asc(skillAssessments.month));
  if (!rows.length) return out;
  const ratings = await db
    .select()
    .from(skillRatings)
    .where(
      inArray(
        skillRatings.assessmentId,
        rows.map((r) => r.a.id),
      ),
    );
  const frameworks = await loadFrameworks([...new Set(rows.map((r) => r.a.sportId))]);

  for (const r of rows) {
    const list = out.get(r.a.studentId) ?? [];
    let sp = list.find((p) => p.batchId === r.a.batchId);
    if (!sp) {
      sp = {
        framework: frameworks.find((f) => f.sport.id === r.a.sportId)!,
        batchId: r.a.batchId,
        batchName: r.batchName,
        assessments: [],
      };
      list.push(sp);
    }
    sp.assessments.push({
      id: r.a.id,
      month: r.a.month,
      average: r.a.average,
      levelName: r.a.levelName,
      levelCode: r.a.levelCode,
      levelPosition: r.a.levelPosition,
      comment: r.a.comment,
      goals: r.a.goals,
      batchId: r.a.batchId,
      batchName: r.batchName,
      coachName: r.coachName,
      updatedAt: r.a.updatedAt,
      ratings: Object.fromEntries(
        ratings.filter((x) => x.assessmentId === r.a.id).map((x) => [x.skillId, x.rating]),
      ),
    });
    out.set(r.a.studentId, list);
  }
  return out;
}

/** Average of an area's ratings in one assessment (× 100), or null if none were rated. */
export function areaAverage(
  area: Framework['areas'][number],
  ratings: Record<string, number>,
): number | null {
  const vals = area.skills.map((k) => ratings[k.id]).filter((v): v is number => v !== undefined);
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) : null;
}
