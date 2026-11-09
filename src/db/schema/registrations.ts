import { index, jsonb, pgEnum, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, tz } from './_shared.js';
import { batches, locations } from './academy.js';
import { students } from './students.js';
import { users } from './users.js';

export const registrationType = pgEnum('registration_type', ['student', 'coach']);
export const registrationStatus = pgEnum('registration_status', [
  'pending',
  'approved',
  'rejected',
]);

export interface StudentRegistrationDetails {
  dateOfBirth: string | null;
  gender: 'male' | 'female' | 'other' | null;
  guardianName: string | null;
  alternatePhone: string | null;
  address: string | null;
  medicalNotes: string | null;
  /** Every batch picked on the form, in order (the first is also `preferredBatchId`). */
  preferredBatchIds?: string[];
}

export interface CoachRegistrationDetails {
  experience: string | null;
  specialization: string | null;
}

/**
 * Self-service sign-ups from the public registration page. Nothing is created in the academy
 * (no student, no login, no billing) until an admin approves the request.
 */
export const registrationRequests = pgTable(
  'registration_requests',
  {
    id: id(),
    type: registrationType().notNull(),
    status: registrationStatus().notNull().default('pending'),
    fullName: text().notNull(),
    email: text(),
    phone: text().notNull(),
    message: text(),
    details: jsonb().$type<StudentRegistrationDetails | CoachRegistrationDetails>().notNull(),
    /** Coaches choose their password at sign-up; stored hashed and used on approval. */
    passwordHash: text(),
    preferredLocationId: uuid().references(() => locations.id, { onDelete: 'set null' }),
    preferredBatchId: uuid().references(() => batches.id, { onDelete: 'set null' }),
    preferredDays: smallint().array(),
    reviewedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: tz(),
    reviewNote: text(),
    studentId: uuid().references(() => students.id, { onDelete: 'set null' }),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ipAddress: text(),
    ...timestamps,
  },
  (t) => [index('registration_requests_status_idx').on(t.status, t.type, t.createdAt)],
);
