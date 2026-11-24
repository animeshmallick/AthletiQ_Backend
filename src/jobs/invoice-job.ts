import { todayInAppTz } from '../lib/dates.js';
import { generateDueInvoices } from '../modules/billing/invoice-generator.js';
import { renewCycles } from '../modules/cycles/cycles.js';
import { applyPlannedEnds } from '../modules/cycles/exits.js';
import { runExclusive, type JobTrigger } from './job-runner.js';

export function runInvoiceJob(trigger: JobTrigger) {
  return runExclusive('invoice-generation', trigger, async () => {
    const today = todayInAppTz();
    // Stopped renewals and planned leaving first, then renewals, then invoices. The generator
    // itself stops at a planned end, so billing is right even if the first steps fail.
    const ends = await applyPlannedEnds(today);
    const cycles = await renewCycles(today);
    const stats = await generateDueInvoices(today);
    return { ...stats, cycles, ends };
  });
}
