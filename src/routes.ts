import { Router } from 'express';
import { requireAdmin, requireAuth } from './middleware/auth.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { attendanceRouter } from './modules/attendance/attendance.routes.js';
import { coachSessionsRouter } from './modules/attendance/coach-sessions.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { batchesRouter } from './modules/batches/batches.routes.js';
import { financeRouter } from './modules/billing/finance.routes.js';
import { invoicesRouter } from './modules/billing/invoices.routes.js';
import { publicRouter } from './modules/billing/public.routes.js';
import { feePlansRouter } from './modules/fee-plans/fee-plans.routes.js';
import { feedbackRouter } from './modules/feedback/feedback.routes.js';
import { lessonsRouter } from './modules/lessons/lessons.routes.js';
import { locationsRouter } from './modules/locations/locations.routes.js';
import {
  publicRegistrationRouter,
  registrationsRouter,
} from './modules/registrations/registrations.routes.js';
import { settingsRouter } from './modules/settings/settings.js';
import { studentsRouter } from './modules/students/students.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

/** Versioned API. Mounted at /api/v1. */
export function apiRouter(): Router {
  const api = Router();

  // Public
  api.use('/auth', authRouter);
  api.use('/public', publicRouter);
  api.use('/public/register', publicRegistrationRouter);

  // Authenticated
  api.use(requireAuth);
  api.use('/users', usersRouter);
  api.use('/locations', locationsRouter);
  api.use('/batches', batchesRouter);
  api.use('/fee-plans', feePlansRouter);
  api.use('/students', studentsRouter);
  api.use('/attendance', attendanceRouter);
  api.use('/coach-sessions', coachSessionsRouter);
  api.use('/lessons', lessonsRouter);
  api.use('/feedback', feedbackRouter);
  api.use('/invoices', invoicesRouter);
  api.use('/finance', financeRouter);
  api.use('/settings', settingsRouter);

  // Admin only
  api.use('/registrations', requireAdmin, registrationsRouter);
  api.use('/admin', requireAdmin, adminRouter);

  return api;
}
