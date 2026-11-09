import { z } from 'zod';
import { MAX_TRAINING_DAYS_PER_WEEK, MIN_TRAINING_DAYS_PER_WEEK } from '../config/constants.js';
import { AppError } from './errors.js';
import { isIsoDate } from './dates.js';

/** Parses input against a schema, converting failures into a 400 with field-level details. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function validationError(error: z.ZodError): AppError {
  const fields = error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
  return new AppError('VALIDATION_ERROR', 'Some fields are invalid', { fields });
}

// ─── Reusable field schemas ──────────────────────────────────────────────────

export const zId = z.uuid({ message: 'Must be a valid id' });

export const zIdParam = z.object({ id: zId });

export const zIsoDate = z
  .string()
  .refine(isIsoDate, { message: 'Must be a valid date (YYYY-MM-DD)' });

export const zTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Must be a valid time (HH:MM)')
  .transform((v) => (v.length === 5 ? `${v}:00` : v));

export const zWeekday = z.number().int().min(1).max(7);

export const zWeekdays = z
  .array(zWeekday)
  .min(1, 'Select at least one day')
  .max(7)
  .transform((days) => [...new Set(days)].sort((a, b) => a - b));

export const zTrainingDays = zWeekdays.refine(
  (d) => d.length >= MIN_TRAINING_DAYS_PER_WEEK && d.length <= MAX_TRAINING_DAYS_PER_WEEK,
  {
    message: `Students train between ${MIN_TRAINING_DAYS_PER_WEEK} and ${MAX_TRAINING_DAYS_PER_WEEK} days a week`,
  },
);

export const zName = z.string().trim().min(1, 'Required').max(120);
export const zOptionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

/** Indian mobile numbers, normalised to E.164 (+91XXXXXXXXXX). Also accepts other +CC numbers. */
export const zPhone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-()]/g, ''))
  .refine((v) => /^(\+?91)?[6-9]\d{9}$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v), {
    message: 'Must be a valid phone number',
  })
  .transform((v) => {
    if (v.startsWith('+')) return v;
    const digits = v.replace(/^91(?=\d{10}$)/, '');
    return `+91${digits}`;
  });

export const zEmail = z.email({ message: 'Must be a valid email' }).trim().toLowerCase().max(254);

/** Amount in paise (integer, non-negative). Clients send paise to avoid float issues. */
export const zPaise = z.number().int().min(0).max(100_000_000);

export const zPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
    message: 'Password must contain letters and numbers',
  });

export const zPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const zBoolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

/**
 * The body schema for an edit: every field optional, and no defaults. (zod 4 applies defaults
 * even inside `.partial()`, so an edit that omits `isActive` would otherwise reactivate.)
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([k, v]) => [
      k,
      v instanceof z.ZodDefault ? (v.removeDefault() as z.ZodType) : v,
    ]),
  );
  return z.object(shape).partial() as unknown as ReturnType<z.ZodObject<S>['partial']>;
}
