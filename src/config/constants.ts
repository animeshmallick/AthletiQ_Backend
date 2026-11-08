/** Academy-wide timezone. All business "calendar days" (billing, attendance, plans) are IST days. */
export const APP_TIMEZONE = 'Asia/Kolkata';

/** Students train a fixed set of weekdays per week within these bounds. */
export const MIN_TRAINING_DAYS_PER_WEEK = 1;
export const MAX_TRAINING_DAYS_PER_WEEK = 6;

/** Invoices are payable within this many days of issue; afterwards they are reported as overdue. */
export const INVOICE_DUE_DAYS = 7;

/** Invoice number prefix, e.g. ATQ/2026-27/00001. */
export const INVOICE_PREFIX = 'ATQ';

/** Default geofence radius for a location when none is provided. */
export const DEFAULT_GEOFENCE_RADIUS_M = 200;

/** Coaches may edit student attendance up to this many days after the session; admins anytime. */
export const COACH_ATTENDANCE_EDIT_WINDOW_DAYS = 1;

export const REFRESH_COOKIE_NAME = 'atq_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export const INVITE_TOKEN_TTL_HOURS = 72;
export const PASSWORD_RESET_TOKEN_TTL_HOURS = 24;

export const MAX_FAILED_LOGINS = 5;
export const LOGIN_LOCKOUT_MINUTES = 15;
