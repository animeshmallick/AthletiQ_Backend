import { todayInAppTz } from '../lib/dates.js';
import { generateDueInvoices } from '../modules/billing/invoice-generator.js';
import { autoLeave, evaluateCourses, remindDecisions } from '../modules/courses/rounds.js';
import { runExclusive, type JobTrigger } from './job-runner.js';

/**
 * Nightly billing. Courses are settled first, so a completed course never gets a next invoice:
 *  1. completions (and corrections) from attendance up to now;
 *  2. completions left undecided for 30 days → the student leaves;
 *  3. invoices due today (credits come off them);
 *  4. a reminder of decisions still waiting.
 */
export function runInvoiceJob(trigger: JobTrigger) {
  return runExclusive('invoice-generation', trigger, async () => {
    const today = todayInAppTz();
    const courses = await evaluateCourses(today);
    const left = await autoLeave(today);
    const stats = await generateDueInvoices(today);
    const reminders = await remindDecisions(today);
    return { ...stats, courses, ...left, decisionsWaiting: reminders.waiting };
  });
}
