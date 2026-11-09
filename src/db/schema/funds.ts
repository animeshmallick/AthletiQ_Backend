import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { id, timestamps, tz } from './_shared.js';
import { feePlans } from './academy.js';
import { payments } from './billing.js';
import { users } from './users.js';

/**
 * Fee distribution and the money ledger.
 *
 * Each fee plan has a split tree of up to two levels. On every level, flat amounts are taken
 * first (in order) and the percentages divide what is left; percentages on a level add up to
 * 100%. A section either has a recipient or is divided into sub-sections.
 *
 * Every movement of money is a `fund_txn` with balanced `fund_entries`. Balances are sums of
 * entries of txns that are not reversed, and always satisfy:
 *   Σ cash (academy + each holder) = academy fund + Σ owed to staff + Σ owed to payees.
 * Amounts are integer paise.
 */

export const splitKind = pgEnum('split_kind', ['percent', 'flat']);
export const splitRecipient = pgEnum('split_recipient', [
  'academy',
  'batch_coach',
  'staff',
  'payee',
]);
export const fundTxnType = pgEnum('fund_txn_type', [
  'fee_split',
  'handover',
  'expense',
  'payout',
  'income',
]);
/**
 * cash          money physically held: by the academy (userId null) or a staff member.
 * academy_fund  the academy's own money (its shares + other income − expenses).
 * staff_due     owed by the academy to a staff member (their shares, reimbursements).
 * payee_due     owed to an outside party (e.g. society, ground owner).
 */
export const fundAccount = pgEnum('fund_account', [
  'cash',
  'academy_fund',
  'staff_due',
  'payee_due',
]);

/** Outside parties that receive a share of fees (society, ground owner, federation…). */
export const payees = pgTable(
  'payees',
  {
    id: id(),
    name: text().notNull(),
    note: text(),
    isActive: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('payees_name_lower_uq').on(sql`lower(${t.name})`)],
);

export const feePlanSplits = pgTable(
  'fee_plan_splits',
  {
    id: id(),
    feePlanId: uuid()
      .notNull()
      .references(() => feePlans.id, { onDelete: 'cascade' }),
    parentId: uuid().references((): AnyPgColumn => feePlanSplits.id, { onDelete: 'cascade' }),
    position: smallint().notNull(),
    name: text().notNull(),
    kind: splitKind().notNull(),
    /** Basis points (10000 = 100%) for percent, paise for flat. */
    value: integer().notNull(),
    /** Null for a section divided into sub-sections. */
    recipient: splitRecipient(),
    userId: uuid().references(() => users.id, { onDelete: 'restrict' }),
    payeeId: uuid().references(() => payees.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('fee_plan_splits_plan_idx').on(t.feePlanId),
    check('fee_plan_splits_value_chk', sql`${t.value} > 0`),
  ],
);

export const fundTxns = pgTable(
  'fund_txns',
  {
    id: id(),
    type: fundTxnType().notNull(),
    occurredOn: date({ mode: 'string' }).notNull(),
    amount: integer().notNull(),
    title: text().notNull(),
    category: text(),
    note: text(),
    reference: text(),
    /** fee_split only. */
    paymentId: uuid().references(() => payments.id, { onDelete: 'restrict' }),
    /** The staff member it is about: collector, who handed over / spent, or who was paid. */
    userId: uuid().references(() => users.id, { onDelete: 'restrict' }),
    /** payout to an outside party. */
    payeeId: uuid().references(() => payees.id, { onDelete: 'restrict' }),
    createdById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reversedAt: tz(),
    reversedById: uuid().references(() => users.id, { onDelete: 'restrict' }),
    reversalReason: text(),
    ...timestamps,
  },
  (t) => [
    index('fund_txns_occurred_idx').on(t.occurredOn),
    index('fund_txns_user_idx').on(t.userId),
    uniqueIndex('fund_txns_one_split_per_payment_uq')
      .on(t.paymentId)
      .where(sql`${t.reversedAt} is null`),
    check('fund_txns_amount_chk', sql`${t.amount} > 0`),
  ],
);

export const fundEntries = pgTable(
  'fund_entries',
  {
    id: id(),
    txnId: uuid()
      .notNull()
      .references(() => fundTxns.id, { onDelete: 'cascade' }),
    account: fundAccount().notNull(),
    userId: uuid().references(() => users.id, { onDelete: 'restrict' }),
    payeeId: uuid().references(() => payees.id, { onDelete: 'restrict' }),
    /** Signed: + increases the balance. */
    amount: integer().notNull(),
    /** Fee shares only: the section path, e.g. "Academy › Society". */
    label: text(),
    /** True for a fee share (distribution), false for the money moving around. */
    share: boolean().notNull().default(false),
  },
  (t) => [
    index('fund_entries_txn_idx').on(t.txnId),
    index('fund_entries_account_idx').on(t.account, t.userId),
  ],
);
