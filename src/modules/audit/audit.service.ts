import type { Request } from 'express';
import { db, type DbOrTx } from '../../db/client.js';
import { auditLogs } from '../../db/schema/index.js';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * Records an audit entry. Pass the transaction handle when the audited change happens inside a
 * transaction so the log commits (or rolls back) atomically with it.
 */
export async function audit(entry: AuditEntry, tx: DbOrTx = db): Promise<void> {
  await tx.insert(auditLogs).values({
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? null,
    ipAddress: entry.ipAddress ?? null,
  });
}

/** Convenience: actor + IP from the request. */
export function auditCtx(req: Request): { actorId: string | null; ipAddress: string | null } {
  return { actorId: req.user?.id ?? null, ipAddress: req.ip ?? null };
}
