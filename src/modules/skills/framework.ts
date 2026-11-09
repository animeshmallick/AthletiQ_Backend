/** A sport's skills and level ladder, and how a rating average maps to a level. */
import { asc, inArray } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { skillAreas, skills, sportLevels, sports } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';

export const RATING_LABELS = ['Beginner', 'Developing', 'Competent', 'Advanced', 'Excellent'];

/** The standard ladder every sport starts with (thresholds are average ratings × 100). */
export const STANDARD_LEVELS = [
  { code: 'A1', name: 'Novice / Absolute Beginner', minScore: 100 },
  { code: 'A2', name: 'Advanced Beginner', minScore: 175 },
  { code: 'B1', name: 'Lower Intermediate', minScore: 250 },
  { code: 'B2', name: 'Upper Intermediate', minScore: 325 },
  { code: 'C1', name: 'Advanced / Regional Competitor', minScore: 400 },
  { code: 'C2', name: 'Elite / National & International', minScore: 460 },
];

export const BANDS: Record<string, string> = { A: 'Beginner', B: 'Intermediate', C: 'Advanced' };
/** "B1" → "Intermediate". */
export const bandOf = (code: string | null | undefined) =>
  code ? (BANDS[code[0]!] ?? null) : null;

export interface Level {
  id: string;
  /** "B1": the letter is the band (A Beginner, B Intermediate, C Advanced). */
  code: string | null;
  name: string;
  minScore: number;
  position: number;
}

export interface Framework {
  sport: { id: string; name: string; isActive: boolean };
  areas: {
    id: string;
    name: string;
    position: number;
    isActive: boolean;
    skills: {
      id: string;
      name: string;
      description: string | null;
      position: number;
      isActive: boolean;
    }[];
  }[];
  levels: Level[];
}

/** Frameworks for several sports at once (two queries per kind). */
export async function loadFrameworks(sportIds: string[], tx: DbOrTx = db): Promise<Framework[]> {
  if (!sportIds.length) return [];
  const [sportRows, areaRows, levelRows] = await Promise.all([
    tx.select().from(sports).where(inArray(sports.id, sportIds)),
    tx
      .select()
      .from(skillAreas)
      .where(inArray(skillAreas.sportId, sportIds))
      .orderBy(asc(skillAreas.position)),
    tx
      .select()
      .from(sportLevels)
      .where(inArray(sportLevels.sportId, sportIds))
      .orderBy(asc(sportLevels.position)),
  ]);
  const skillRows = areaRows.length
    ? await tx
        .select()
        .from(skills)
        .where(
          inArray(
            skills.areaId,
            areaRows.map((a) => a.id),
          ),
        )
        .orderBy(asc(skills.position))
    : [];
  return sportRows.map((s) => ({
    sport: { id: s.id, name: s.name, isActive: s.isActive },
    areas: areaRows
      .filter((a) => a.sportId === s.id)
      .map((a) => ({
        id: a.id,
        name: a.name,
        position: a.position,
        isActive: a.isActive,
        skills: skillRows
          .filter((k) => k.areaId === a.id)
          .map((k) => ({
            id: k.id,
            name: k.name,
            description: k.description,
            position: k.position,
            isActive: k.isActive,
          })),
      })),
    levels: levelRows
      .filter((l) => l.sportId === s.id)
      .map((l) => ({
        id: l.id,
        code: l.code,
        name: l.name,
        minScore: l.minScore,
        position: l.position,
      })),
  }));
}

export async function loadFramework(sportId: string, tx: DbOrTx = db): Promise<Framework> {
  const [f] = await loadFrameworks([sportId], tx);
  if (!f) throw AppError.notFound('Sport');
  return f;
}

/** Skills currently assessed (active skill in an active area). */
export function activeSkills(f: Framework) {
  return f.areas.filter((a) => a.isActive).flatMap((a) => a.skills.filter((k) => k.isActive));
}

/** The highest level whose minimum the average (× 100) reaches; null below the first rung. */
export function levelFor(levels: Level[], average: number): Level | null {
  let best: Level | null = null;
  for (const l of [...levels].sort((a, b) => a.minScore - b.minScore)) {
    if (average >= l.minScore) best = l;
  }
  return best;
}

/** "2026-03" or "2026-03-14" → "2026-03-01". */
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
