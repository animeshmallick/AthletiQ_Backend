import { todayInAppTz } from '../lib/dates.js';
import { generateDueInvoices } from '../modules/billing/invoice-generator.js';
import { runExclusive, type JobTrigger } from './job-runner.js';

export function runInvoiceJob(trigger: JobTrigger) {
  return runExclusive('invoice-generation', trigger, async () => {
    const stats = await generateDueInvoices(todayInAppTz());
    return { ...stats };
  });
}
