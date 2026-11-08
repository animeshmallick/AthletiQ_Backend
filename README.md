# AthletiQ API

Backend for AthletiQ — coaching-academy management: coaches, batches, student & coach attendance
(GPS-verified), daily lesson plans, weekly feedback, automated monthly billing and finance insights.

**Stack:** Node 26 · Express 5 · TypeScript 6 · Drizzle ORM · Neon Postgres · Zod 4 · Jest

---

## Quick start

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL / DATABASE_URL_UNPOOLED and secrets
npm run db:migrate            # apply SQL migrations (uses the unpooled URL)
npm run db:seed               # create the first admin from SEED_ADMIN_* vars
npm run dev                   # http://localhost:4000 (or $PORT)
```

> `node --env-file` does **not** override variables already set in your shell. If `PORT` is
> exported in your environment, the server uses that value.

### Scripts

| Script                                           | Purpose                                               |
| ------------------------------------------------ | ----------------------------------------------------- |
| `dev` / `build` / `start`                        | Watch mode · compile to `dist/` · run compiled server |
| `check`                                          | typecheck + lint + tests with coverage (what CI runs) |
| `test`, `test:unit`, `test:api`, `test:coverage` | Jest suites                                           |
| `db:generate`                                    | Create a migration after editing `src/db/schema/**`   |
| `db:migrate` / `db:seed` / `db:studio`           | Apply migrations · seed admin · browse data           |
| `jobs:invoices`                                  | Run invoice generation once (safe alongside the API)  |

---

## Architecture

```
src/
  app.ts, server.ts, routes.ts   Express app, graceful shutdown, /api/v1 router
  config/                        Validated env (fails fast) and business constants
  db/                            Drizzle schema, pool, migrate & seed scripts
  lib/                           Pure helpers: dates (IST calendar math), money, geo, validation, errors
  middleware/                    Auth (JWT + live user check), rate limits, error handler
  modules/<feature>/             Routes + services per domain
  jobs/                          Scheduler, advisory-locked job runner, invoice job
tests/
  unit/                          Pure logic
  api/                           Real HTTP requests against in-memory Postgres (PGlite) with real migrations
```

**Conventions**

- Responses: `{ data, meta? }`; errors: `{ error: { code, message, details?, requestId } }`.
- Money is integer **paise** everywhere. Business dates are `YYYY-MM-DD` IST calendar days.
- Every sensitive change (fees, payments, transfers, access) is written to `audit_logs`.
- Coaches only see their own batches and currently-enrolled students (404, not 403, otherwise).

---

## Domain rules

### Roles

- **Admin** manages coaches, students, batches, locations, fee plans, settings; only admins revert or
  refund payments, cancel invoices and approve registrations.
- **Coach** marks attendance, checks in/out, builds lesson plans, writes feedback, marks invoices paid
  for their students.

### Billing

- **Prepaid.** The first invoice is generated the moment a student is accepted (admin registers
  them, a registration is approved, or they rejoin) — even if training starts later. Every following
  invoice is generated at the start of its month (joined 10 Mar → invoices on 10 Mar, 10 Apr, …).
  Cycles are anchored on the joining day; 29th–31st joiners clamp to month end.
- Billing never pauses. After leaving, no further months are billed (the month in progress was already
  prepaid — cancel, adjust or refund it). Rejoining restarts billing from the rejoin date.
- The joining date can be corrected until a payment is recorded: unpaid invoices are cancelled and
  billing restarts from the corrected date.
- Daily job at **00:00 IST** (`INVOICE_CRON`), plus a catch-up 15 s after boot. Idempotent
  (unique student + cycle), gap-free numbering per financial year (`ATQ/2026-27/00001`), guarded by a
  Postgres advisory lock so multiple EC2 instances never double-run it.
- Price, plan, batch and coach are snapshotted on each invoice.
- `billingStartsOn` (defaults to the earlier of today and the joining date) is the acceptance date:
  the first invoice is issued then, and months that started earlier are never billed — set it when
  importing existing students whose current month was settled outside the system.

### Attendance

- Session roster = home-batch students whose training days include the weekday + one-off makeups.
- Coaches edit up to 1 day back; admins anytime (audited).
- Coach check-in/out is validated against the batch location's geofence; out-of-range readings are
  accepted but flagged for admin review.

### Weekly feedback

- Template lives in code: `src/modules/feedback/templates/weekly.ts`. Bump `version` when adding/removing
  fields; old reports keep rendering with their version.

### Public registration

- `GET /api/v1/public/register/options`, `POST /public/register/student`, `POST /public/register/coach`.
  Rate-limited with a honeypot field. Nothing is created until an admin approves the request.

---

## API overview (`/api/v1`)

| Area                  | Endpoints                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Auth                  | `POST auth/login · refresh · logout · accept-invite · reset-password · change-password`, `GET auth/me · invite · password-reset`       |
| Users (admin)         | `GET/POST users`, `GET/PATCH users/:id`, `POST users/:id/status · access-link`, `PATCH users/me`                                       |
| Academy               | `locations`, `fee-plans`, `batches` (+ `/:id/roster`), `settings`                                                                      |
| Students              | `GET/POST students`, `GET/PATCH students/:id`, `POST students/:id/transfer · leave · makeups`, `DELETE students/:id/makeups/:makeupId` |
| Attendance            | `GET attendance/overview · session · register · students/:id`, `PUT attendance/session`                                                |
| Coach sessions        | `GET coach-sessions/today`, `POST coach-sessions/check-in · check-out`, `GET coach-sessions`, `POST coach-sessions/:id/review`         |
| Lesson plans          | `lessons/stages`, `lessons/events` (+ `/order`), `GET lessons/plans`, `GET/PUT/DELETE lessons/plans/day`, `POST lessons/plans/copy`    |
| Feedback              | `GET feedback/template · week`, `GET/PUT feedback/students/:id/weeks/:weekStart`, `GET feedback/students/:id (+ /trends)`              |
| Billing               | `GET invoices (+ /:id, /:id/pdf)`, `POST invoices/:id/share · payments · cancel`, `POST invoices/:id/payments/:pid/revert · refund`    |
| Finance               | `GET finance/summary · projection`                                                                                                     |
| Registrations (admin) | `GET registrations (+ /:id)`, `POST registrations/:id/approve · reject`                                                                |
| Admin ops             | `POST admin/jobs/invoices/run`, `GET admin/jobs/runs · audit-logs`                                                                     |
| Public                | `GET public/invoices/:id/pdf?e&s` (signed link), `public/register/*`                                                                   |
| Health                | `GET /health` (liveness), `GET /ready` (DB check)                                                                                      |

### Clients

- **Web:** refresh token in an httpOnly cookie scoped to `/api/v1/auth`; send
  `X-Requested-With: XMLHttpRequest` on `/auth/refresh`. Access token stays in memory.
- **Android:** send `X-Client-Type: mobile`; the refresh token is returned in the body and sent back in
  the body of `/auth/refresh` and `/auth/logout`. Refresh tokens rotate; replaying an old one revokes
  the session family.

---

## Deployment

The API runs on **EC2 as a Docker container** (built from `Dockerfile`) behind nginx (HTTPS), and the web
app runs on **AWS Amplify**. The full step-by-step guide is in **[deploy.md](deploy.md)**.

- Deploys are **manual**: CI only runs checks. Each release is built on the server, tagged with its git
  commit, and swapped in (deploy.md §9). Rolling back is just running the previous tag.
- One-off tasks use the same image, for example
  `docker run --rm --env-file .env athletiq-api:<tag> node dist/db/migrate.js`.
