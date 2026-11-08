import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { isTest } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  batches,
  locations,
  registrationRequests,
  users,
  type CoachRegistrationDetails,
  type StudentRegistrationDetails,
} from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { created, ok, pageMeta } from '../../lib/http.js';
import {
  parse,
  zEmail,
  zId,
  zIdParam,
  zIsoDate,
  zName,
  zOptionalText,
  zPagination,
  zPaise,
  zPassword,
  zPhone,
  zTrainingDays,
  zWeekdays,
} from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { audit, auditCtx } from '../audit/audit.service.js';
import { toPublicUser } from '../auth/auth.service.js';
import { hashPassword } from '../auth/password.js';
import { getAcademySettings } from '../settings/settings.js';
import { createStudent, getStudentDetail } from '../students/students.service.js';

// ═══ Public (unauthenticated) ═══════════════════════════════════════════════

export const publicRegistrationRouter = Router();

const registrationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many registrations from this network. Please try again later.',
      },
    });
  },
});

/** Honeypot: real users never see or fill the `website` field; bots usually do. */
const Honeypot = { website: z.string().max(0, 'Invalid submission').optional() };

/** Data for the public registration page: academy name and the batches students can pick from. */
publicRegistrationRouter.get('/options', async (_req, res) => {
  const [academy, batchRows] = await Promise.all([
    getAcademySettings(),
    db
      .select({
        id: batches.id,
        name: batches.name,
        weekdays: batches.weekdays,
        startTime: batches.startTime,
        endTime: batches.endTime,
        location: { id: locations.id, name: locations.name, address: locations.address },
      })
      .from(batches)
      .innerJoin(locations, eq(locations.id, batches.locationId))
      .where(and(eq(batches.isActive, true), eq(locations.isActive, true)))
      .orderBy(asc(locations.name), asc(batches.startTime)),
  ]);
  ok(res, {
    academy: { name: academy.name, phone: academy.phone, email: academy.email },
    batches: batchRows,
  });
});

const StudentSignup = z.object({
  ...Honeypot,
  fullName: zName,
  dateOfBirth: zIsoDate.nullable().optional(),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  guardianName: zOptionalText(120),
  phone: zPhone,
  alternatePhone: zPhone.nullable().optional(),
  email: zEmail.nullable().optional(),
  address: zOptionalText(500),
  medicalNotes: zOptionalText(1000),
  preferredBatchId: zId.nullable().optional(),
  preferredDays: zWeekdays.nullable().optional(),
  message: zOptionalText(1000),
  consent: z.literal(true, { message: 'Please accept the terms to continue' }),
});

publicRegistrationRouter.post('/student', registrationLimiter, async (req, res) => {
  const body = parse(StudentSignup, req.body);

  let preferredLocationId: string | null = null;
  if (body.preferredBatchId) {
    const b = await db.query.batches.findFirst({ where: eq(batches.id, body.preferredBatchId) });
    if (!b?.isActive) throw AppError.unprocessable('Selected batch is not available');
    preferredLocationId = b.locationId;
  }

  const details: StudentRegistrationDetails = {
    dateOfBirth: body.dateOfBirth ?? null,
    gender: body.gender ?? null,
    guardianName: body.guardianName,
    alternatePhone: body.alternatePhone ?? null,
    address: body.address,
    medicalNotes: body.medicalNotes,
  };
  const [row] = await db
    .insert(registrationRequests)
    .values({
      type: 'student',
      fullName: body.fullName,
      email: body.email ?? null,
      phone: body.phone,
      message: body.message,
      details,
      preferredBatchId: body.preferredBatchId ?? null,
      preferredLocationId,
      preferredDays: body.preferredDays ?? null,
      ipAddress: req.ip ?? null,
    })
    .returning({ id: registrationRequests.id });

  created(res, {
    id: row!.id,
    message:
      'Thank you! Your registration has been received. The academy will contact you shortly to confirm your batch.',
  });
});

const CoachSignup = z.object({
  ...Honeypot,
  fullName: zName,
  email: zEmail,
  phone: zPhone,
  password: zPassword,
  experience: zOptionalText(1000),
  specialization: zOptionalText(200),
  message: zOptionalText(1000),
});

publicRegistrationRouter.post('/coach', registrationLimiter, async (req, res) => {
  const body = parse(CoachSignup, req.body);

  const [existingUser, [pending]] = await Promise.all([
    db.query.users.findFirst({ where: sql`lower(${users.email}) = ${body.email}` }),
    db
      .select({ n: count() })
      .from(registrationRequests)
      .where(
        and(
          eq(registrationRequests.type, 'coach'),
          eq(registrationRequests.status, 'pending'),
          sql`lower(${registrationRequests.email}) = ${body.email}`,
        ),
      ),
  ]);
  if (existingUser)
    throw AppError.conflict('An account with this email already exists. Try signing in instead.');
  if ((pending?.n ?? 0) > 0)
    throw AppError.conflict('A registration with this email is already awaiting approval.');

  const details: CoachRegistrationDetails = {
    experience: body.experience,
    specialization: body.specialization,
  };
  const [row] = await db
    .insert(registrationRequests)
    .values({
      type: 'coach',
      fullName: body.fullName,
      email: body.email,
      phone: body.phone,
      message: body.message,
      details,
      passwordHash: await hashPassword(body.password),
      ipAddress: req.ip ?? null,
    })
    .returning({ id: registrationRequests.id });

  created(res, {
    id: row!.id,
    message:
      'Thanks for registering! You will be able to sign in once an administrator approves your account.',
  });
});

// ═══ Admin review (mounted behind requireAdmin) ═════════════════════════════

export const registrationsRouter = Router();

const ListQuery = zPagination.extend({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  type: z.enum(['student', 'coach']).optional(),
});

const publicColumns = {
  id: registrationRequests.id,
  type: registrationRequests.type,
  status: registrationRequests.status,
  fullName: registrationRequests.fullName,
  email: registrationRequests.email,
  phone: registrationRequests.phone,
  message: registrationRequests.message,
  details: registrationRequests.details,
  preferredDays: registrationRequests.preferredDays,
  preferredBatch: { id: batches.id, name: batches.name },
  preferredLocation: { id: locations.id, name: locations.name },
  reviewedAt: registrationRequests.reviewedAt,
  reviewNote: registrationRequests.reviewNote,
  studentId: registrationRequests.studentId,
  userId: registrationRequests.userId,
  createdAt: registrationRequests.createdAt,
};

registrationsRouter.get('/', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [eq(registrationRequests.status, q.status)];
  if (q.type) filters.push(eq(registrationRequests.type, q.type));
  const where = and(...filters);

  const [rows, total, [counts]] = await Promise.all([
    db
      .select(publicColumns)
      .from(registrationRequests)
      .leftJoin(batches, eq(batches.id, registrationRequests.preferredBatchId))
      .leftJoin(locations, eq(locations.id, registrationRequests.preferredLocationId))
      .where(where)
      .orderBy(
        q.status === 'pending'
          ? asc(registrationRequests.createdAt)
          : desc(registrationRequests.reviewedAt),
      )
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.$count(registrationRequests, where),
    db
      .select({
        pendingStudents: sql<number>`(count(*) filter (where ${registrationRequests.type} = 'student'))::int`,
        pendingCoaches: sql<number>`(count(*) filter (where ${registrationRequests.type} = 'coach'))::int`,
      })
      .from(registrationRequests)
      .where(eq(registrationRequests.status, 'pending')),
  ]);
  ok(res, rows, { ...pageMeta(q.page, q.pageSize, total), pending: counts });
});

registrationsRouter.get('/:id', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const [row] = await db
    .select(publicColumns)
    .from(registrationRequests)
    .leftJoin(batches, eq(batches.id, registrationRequests.preferredBatchId))
    .leftJoin(locations, eq(locations.id, registrationRequests.preferredLocationId))
    .where(eq(registrationRequests.id, id));
  if (!row) throw AppError.notFound('Registration');
  ok(res, row);
});

async function lockPending(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id: string) {
  const [reg] = await tx
    .select()
    .from(registrationRequests)
    .where(eq(registrationRequests.id, id))
    .for('update');
  if (!reg) throw AppError.notFound('Registration');
  if (reg.status !== 'pending')
    throw AppError.conflict(`This registration was already ${reg.status}`);
  return reg;
}

const ApproveStudentBody = z.object({
  joiningDate: zIsoDate,
  batchId: zId,
  trainingDays: zTrainingDays,
  feePlanId: zId,
  customMonthlyFee: zPaise.nullable().optional(),
  monthlyDiscount: zPaise.default(0),
  /** Admin may correct details captured on the form. */
  fullName: zName.optional(),
  phone: zPhone.optional(),
  notes: zOptionalText(2000),
  note: zOptionalText(500),
});

registrationsRouter.post('/:id/approve', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const actor = currentUser(req);

  const result = await db.transaction(async (tx) => {
    const reg = await lockPending(tx, id);

    if (reg.type === 'student') {
      const body = parse(ApproveStudentBody, req.body);
      const d = reg.details as StudentRegistrationDetails;
      const student = await createStudent(
        tx,
        {
          fullName: body.fullName ?? reg.fullName,
          phone: body.phone ?? reg.phone,
          email: reg.email,
          dateOfBirth: d.dateOfBirth,
          gender: d.gender,
          guardianName: d.guardianName,
          alternatePhone: d.alternatePhone,
          address: d.address,
          medicalNotes: d.medicalNotes,
          notes: body.notes,
          joiningDate: body.joiningDate,
          batchId: body.batchId,
          trainingDays: body.trainingDays,
          feePlanId: body.feePlanId,
          customMonthlyFee: body.customMonthlyFee ?? null,
          monthlyDiscount: body.monthlyDiscount,
        },
        actor.id,
      );
      await tx
        .update(registrationRequests)
        .set({
          status: 'approved',
          reviewedById: actor.id,
          reviewedAt: new Date(),
          reviewNote: body.note,
          studentId: student.id,
        })
        .where(eq(registrationRequests.id, id));
      await audit(
        {
          ...auditCtx(req),
          action: 'registration.student_approved',
          entityType: 'student',
          entityId: student.id,
          metadata: { registrationId: id },
        },
        tx,
      );
      return { type: 'student' as const, studentId: student.id };
    }

    const { note } = parse(z.object({ note: zOptionalText(500) }), req.body ?? {});
    const existing = await tx.query.users.findFirst({
      where: sql`lower(${users.email}) = ${reg.email!.toLowerCase()}`,
    });
    if (existing) throw AppError.conflict('A user with this email already exists');
    const [user] = await tx
      .insert(users)
      .values({
        name: reg.fullName,
        email: reg.email!,
        phone: reg.phone,
        role: 'coach',
        status: 'active',
        passwordHash: reg.passwordHash,
      })
      .returning();
    await tx
      .update(registrationRequests)
      .set({
        status: 'approved',
        reviewedById: actor.id,
        reviewedAt: new Date(),
        reviewNote: note,
        userId: user!.id,
        passwordHash: null,
      })
      .where(eq(registrationRequests.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'registration.coach_approved',
        entityType: 'user',
        entityId: user!.id,
        metadata: { registrationId: id },
      },
      tx,
    );
    return { type: 'coach' as const, user: toPublicUser(user!) };
  });

  ok(
    res,
    result.type === 'student'
      ? { type: 'student', student: await getStudentDetail(result.studentId) }
      : result,
  );
});

registrationsRouter.post('/:id/reject', async (req, res) => {
  const { id } = parse(zIdParam, req.params);
  const { reason } = parse(z.object({ reason: zOptionalText(500) }), req.body ?? {});
  const actor = currentUser(req);
  await db.transaction(async (tx) => {
    await lockPending(tx, id);
    await tx
      .update(registrationRequests)
      .set({
        status: 'rejected',
        reviewedById: actor.id,
        reviewedAt: new Date(),
        reviewNote: reason,
        passwordHash: null,
      })
      .where(eq(registrationRequests.id, id));
    await audit(
      {
        ...auditCtx(req),
        action: 'registration.rejected',
        entityType: 'registration',
        entityId: id,
        metadata: { reason },
      },
      tx,
    );
  });
  ok(res, { id, status: 'rejected' });
});
