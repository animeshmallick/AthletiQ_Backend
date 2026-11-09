import { z } from 'zod';
import { zId, zPaise } from '../../lib/validation.js';
import { FULL, MAX_SECTIONS, type SplitNode } from './split.js';

const base = {
  /** Shown on the share line: the recipient's name. Divided sections have none. */
  name: z.string().trim().max(60).default(''),
  kind: z.enum(['percent', 'flat']),
  /** Basis points (10000 = 100%) for percent, paise for flat. */
  value: z.number().int().min(1),
  recipient: z.enum(['academy', 'batch_coach', 'staff', 'payee']).nullable().default(null),
  userId: zId.nullable().default(null),
  payeeId: zId.nullable().default(null),
};

const refineValue = <T extends { kind: string; value: number }>(n: T, ctx: z.RefinementCtx) => {
  if (n.kind === 'percent' && n.value > FULL)
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage cannot exceed 100%' });
  if (n.kind === 'flat' && !zPaise.safeParse(n.value).success)
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'Amount is too large' });
};

const Leaf = z.object(base).superRefine(refineValue);
const Section = z
  .object({ ...base, children: z.array(Leaf).max(MAX_SECTIONS).default([]) })
  .superRefine(refineValue);

export const SplitBody = z.object({ sections: z.array(Section).max(MAX_SECTIONS) });

/** Normalises parsed input into tree nodes (recipient fields cleared where they do not apply). */
export function toTree(sections: z.output<typeof SplitBody>['sections']): SplitNode[] {
  const node = (n: z.output<typeof Leaf>, children: SplitNode[]): SplitNode => ({
    name: children.length ? '' : n.name,
    kind: n.kind,
    value: n.value,
    recipient: children.length ? null : n.recipient,
    userId: !children.length && n.recipient === 'staff' ? n.userId : null,
    payeeId: !children.length && n.recipient === 'payee' ? n.payeeId : null,
    children,
  });
  return sections.map((s) =>
    node(
      s,
      s.children.map((c) => node(c, [])),
    ),
  );
}
