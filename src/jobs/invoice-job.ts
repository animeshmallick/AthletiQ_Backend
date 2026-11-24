import { todayInAppTz } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import { generateDueInvoices } from '../modules/billing/invoice-generator.js';
import { renewCycles } from '../modules/cycles/cycles.js';
import { applyPlannedEnds } from '../modules/cycles/exits.js';
import { runExclusive, type JobTrigger } from './job-runner.js';
import { sendMissedNotices } from './missed-notices.js';

/** Invoices must go out whatever happens to the steps around them. */
export async function safely<T>(step: string, run: () => Promise<T>) {
  try {
    return await run();
  } catch (err) {
    logger.error({ err, step }, 'Nightly step failed');
    return { error: String(err) };
  }
}

export function runInvoiceJob(trigger: JobTrigger) {
  return runExclusive('invoice-generation', trigger, async () => {
    const today = todayInAppTz();
    // Stopped renewals and planned leaving first, then renewals, then invoices. The generator
    // itself stops at a planned end, so billing is right even if the first steps fail.
    const ends = await safely('planned-ends', () => applyPlannedEnds(today));
    const cycles = await safely('renewals', () => renewCycles(today));
    const stats = await generateDueInvoices(today);
    const notices = await safely('missed-notices', () => sendMissedNotices(today));
    return { ...stats, cycles, ends, notices };
  });
}
