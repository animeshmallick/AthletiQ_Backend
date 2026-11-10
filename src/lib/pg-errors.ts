import { AppError } from './errors.js';

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

function asPgError(err: unknown): PgError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  // drizzle wraps driver errors in `cause`.
  const candidate = 'cause' in err && typeof err.cause === 'object' ? err.cause : err;
  if (candidate && typeof candidate === 'object' && 'code' in candidate)
    return candidate as PgError;
  return undefined;
}

/** Friendly messages for known unique constraints. */
const UNIQUE_MESSAGES: Record<string, string> = {
  users_email_lower_uq: 'A user with this email already exists',
  users_phone_uq: 'Another account already uses this phone number',
  locations_name_lower_uq: 'A location with this name already exists',
  batches_name_lower_uq: 'A batch with this name already exists',
  fee_plans_name_lower_uq:
    'A fee plan with this name already exists (the built-in free plan counts too)',
  lesson_stages_coach_name_uq: 'You already have a stage with this name',
  lesson_events_coach_name_uq: 'You already have a drill with this name',
  lesson_plan_templates_coach_name_uq: 'You already have a saved plan with this name',
  makeup_student_batch_date_uq: 'This student already has a makeup in this batch on that date',
  enrollments_one_open_per_student_uq: 'Student already has an active batch enrollment',
  payments_one_completed_per_invoice_uq: 'This invoice already has a recorded payment',
  session_cancellations_batch_date_uq: 'This session is already cancelled',
};

/** Maps Postgres constraint violations to client errors; returns undefined for anything else. */
export function mapPgError(err: unknown): AppError | undefined {
  const pg = asPgError(err);
  if (!pg?.code) return undefined;
  switch (pg.code) {
    case '23505':
      return AppError.conflict(
        (pg.constraint && UNIQUE_MESSAGES[pg.constraint]) ?? 'This record already exists',
      );
    case '23503':
      return AppError.conflict('This record is referenced by other data and cannot be changed');
    case '23514':
      return AppError.badRequest('Some values are out of the allowed range');
    case '22P02':
      return AppError.badRequest('Invalid identifier');
    default:
      return undefined;
  }
}
