import { and, desc, eq, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { auditLogs, jobRuns, users } from '../../db/schema/index.js';
import { ok, pageMeta } from '../../lib/http.js';
import { parse, zId, zPagination } from '../../lib/validation.js';
import { runInvoiceJob } from '../../jobs/invoice-job.js';
import { audit, auditCtx } from '../audit/audit.service.js';

/** Admin-only operational endpoints (mounted behind requireAdmin). */
export const adminRouter = Router();

/** Runs invoice generation now (idempotent — only completed, un-invoiced cycles are created). */
adminRouter.post('/jobs/invoices/run', async (req, res) => {
  const result = await runInvoiceJob('manual');
  await audit({
    ...auditCtx(req),
    action: 'job.invoices_triggered',
    entityType: 'job',
    metadata: { ran: result.ran },
  });
  ok(res, result);
});

adminRouter.get('/jobs/runs', async (req, res) => {
  const { jobName } = parse(z.object({ jobName: z.string().max(60).optional() }), req.query);
  const rows = await db
    .select()
    .from(jobRuns)
    .where(jobName ? eq(jobRuns.jobName, jobName) : undefined)
    .orderBy(desc(jobRuns.startedAt))
    .limit(50);
  ok(res, rows);
});

const AuditQuery = zPagination.extend({
  entityType: z.string().max(60).optional(),
  entityId: zId.optional(),
  actorId: zId.optional(),
});

adminRouter.get('/audit-logs', async (req, res) => {
  const q = parse(AuditQuery, req.query);
  const filters: SQL[] = [];
  if (q.entityType) filters.push(eq(auditLogs.entityType, q.entityType));
  if (q.entityId) filters.push(eq(auditLogs.entityId, q.entityId));
  if (q.actorId) filters.push(eq(auditLogs.actorId, q.actorId));
  const where = filters.length ? and(...filters) : undefined;

  const [rows, total] = await Promise.all([
    db
      .select({ log: auditLogs, actor: { id: users.id, name: users.name } })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.$count(auditLogs, where),
  ]);
  ok(
    res,
    rows.map((r) => ({ ...r.log, actor: r.actor })),
    pageMeta(q.page, q.pageSize, total),
  );
});
