/**
 * Pure fee-split maths. Amounts are integer paise; percentages are basis points (10000 = 100%).
 *
 * Rules, applied to the money on each level (the fee at level 1, a section's amount at level 2):
 *  1. Flat amounts are taken first, in order, until the money runs out (a heavily discounted fee
 *     may not cover them all).
 *  2. Percentages divide what is left. They add up to 100%, so nothing is ever unassigned.
 *  3. Paise lost to rounding go to the largest percentage (the first one on a tie).
 */

export type SplitKind = 'percent' | 'flat';
export type SplitRecipient = 'academy' | 'batch_coach' | 'staff' | 'payee';

export interface SplitNode {
  name: string;
  kind: SplitKind;
  value: number;
  recipient: SplitRecipient | null;
  userId: string | null;
  payeeId: string | null;
  children: SplitNode[];
}

export const FULL = 10_000;
export const MAX_SECTIONS = 12;

/** Divides `amount` among sibling sections. Returns one amount per section, summing to `amount`. */
export function allocate(nodes: Pick<SplitNode, 'kind' | 'value'>[], amount: number): number[] {
  const out = nodes.map(() => 0);
  let left = amount;
  nodes.forEach((n, i) => {
    if (n.kind !== 'flat') return;
    out[i] = Math.min(n.value, left);
    left -= out[i];
  });
  const pct = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.kind === 'percent');
  if (pct.length === 0) return out;
  let given = 0;
  for (const { n, i } of pct) {
    out[i] = Math.floor((left * n.value) / FULL);
    given += out[i];
  }
  const top = pct.reduce((a, b) => (b.n.value > a.n.value ? b : a));
  out[top.i]! += left - given;
  return out;
}

export interface ShareLine {
  label: string;
  account: 'academy_fund' | 'staff_due' | 'payee_due';
  userId: string | null;
  payeeId: string | null;
  amount: number;
}

/** The academy keeps everything when a plan has no split. */
export const DEFAULT_SPLIT: SplitNode[] = [
  {
    name: 'Academy',
    kind: 'percent',
    value: FULL,
    recipient: 'academy',
    userId: null,
    payeeId: null,
    children: [],
  },
];

/**
 * Turns a fee into share lines. `batchCoachId` is the coach on the invoice; a "batch coach"
 * share with no coach goes to the academy. Zero-amount lines are dropped.
 */
export function computeShares(
  tree: SplitNode[],
  amount: number,
  batchCoachId: string | null,
): ShareLine[] {
  const lines: ShareLine[] = [];
  const walk = (nodes: SplitNode[], money: number, prefix: string) => {
    const parts = allocate(nodes, money);
    nodes.forEach((n, i) => {
      const part = parts[i]!;
      // Lines are named after who finally receives the money (no parent section names).
      const label = n.name || prefix || 'Share';
      if (n.children.length) return walk(n.children, part, '');
      if (part === 0) return;
      if (n.recipient === 'staff' && n.userId)
        lines.push({ label, account: 'staff_due', userId: n.userId, payeeId: null, amount: part });
      else if (n.recipient === 'batch_coach' && batchCoachId)
        lines.push({
          label,
          account: 'staff_due',
          userId: batchCoachId,
          payeeId: null,
          amount: part,
        });
      else if (n.recipient === 'payee' && n.payeeId)
        lines.push({ label, account: 'payee_due', userId: null, payeeId: n.payeeId, amount: part });
      else
        lines.push({ label, account: 'academy_fund', userId: null, payeeId: null, amount: part });
    });
  };
  walk(tree.length ? tree : DEFAULT_SPLIT, amount, '');
  // Safety net for a malformed tree (no percentage on a level): never lose money.
  const rest = amount - lines.reduce((s, l) => s + l.amount, 0);
  if (rest > 0)
    lines.push({
      label: 'Unassigned',
      account: 'academy_fund',
      userId: null,
      payeeId: null,
      amount: rest,
    });
  return lines;
}

/** Problems with a split tree, as `{ path, message }` (empty when valid). */
export function validateTree(tree: SplitNode[]): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const level = (nodes: SplitNode[], path: string, depth: number) => {
    if (nodes.length === 0) {
      errors.push({ path, message: 'Add at least one section' });
      return;
    }
    if (nodes.length > MAX_SECTIONS)
      errors.push({ path, message: `At most ${MAX_SECTIONS} sections` });
    const pct = nodes.filter((n) => n.kind === 'percent');
    const total = pct.reduce((s, n) => s + n.value, 0);
    if (pct.length === 0)
      errors.push({ path, message: 'Add a percentage section to receive what is left' });
    else if (total !== FULL)
      errors.push({ path, message: `Percentages add up to ${total / 100}%, not 100%` });
    nodes.forEach((n, i) => {
      const at = `${path}${path ? '.' : ''}${i}`;
      if (n.kind === 'percent' && n.value > FULL)
        errors.push({ path: at, message: 'A percentage cannot exceed 100%' });
      if (n.children.length) {
        if (depth >= 2) errors.push({ path: at, message: 'Only two levels are allowed' });
        else if (n.recipient)
          errors.push({ path: at, message: 'A divided section cannot also have a recipient' });
        else level(n.children, `${at}.children`, depth + 1);
      } else if (!n.recipient) {
        errors.push({ path: at, message: 'Choose who receives this section' });
      } else if (n.recipient === 'staff' && !n.userId) {
        errors.push({ path: at, message: 'Choose a staff member' });
      } else if (n.recipient === 'payee' && !n.payeeId) {
        errors.push({ path: at, message: 'Choose a payee' });
      }
    });
  };
  level(tree, '', 1);
  return errors;
}
