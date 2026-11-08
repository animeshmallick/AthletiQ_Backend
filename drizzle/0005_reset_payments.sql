-- One-time reset requested by the academy: every paid invoice goes back to unpaid so that
-- payments are re-recorded by whoever actually receives the money ("I have received the payment").
-- Payment rows are kept (status = reverted) so the money trail and audit history stay intact.
INSERT INTO "audit_logs" ("actor_id", "action", "entity_type", "entity_id", "metadata")
SELECT NULL, 'invoice.payment_reverted', 'invoice', p."invoice_id",
       jsonb_build_object('paymentId', p."id", 'amount', p."amount", 'reason', 'Reset: all invoices marked unpaid', 'system', true)
FROM "payments" p
WHERE p."status" = 'completed';--> statement-breakpoint
UPDATE "payments"
SET "status" = 'reverted',
    "reversed_at" = now(),
    "reversal_reason" = 'Reset: all invoices marked unpaid',
    "updated_at" = now()
WHERE "status" = 'completed';--> statement-breakpoint
UPDATE "invoices"
SET "status" = 'due', "paid_at" = NULL, "updated_at" = now()
WHERE "status" = 'paid';
