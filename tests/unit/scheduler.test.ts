import { afterEach, describe, expect, it, jest } from '@jest/globals';

type Scheduler = typeof import('../../src/jobs/scheduler');

function loadScheduler(env: Record<string, string>) {
  const schedule = jest.fn((_expr: string, fn: () => void, _opts: unknown) => {
    scheduled.push(fn);
    return { stop: jest.fn() };
  });
  const validate = jest.fn((expr: string) => expr !== 'bad cron');
  const runInvoiceJob = jest.fn(async (_trigger: string) => ({ ran: true }));
  const scheduled: (() => void)[] = [];
  let mod!: Scheduler;

  const previous = { ...process.env };
  Object.assign(process.env, env);
  jest.isolateModules(() => {
    jest.doMock('node-cron', () => ({ __esModule: true, default: { schedule, validate } }));
    jest.doMock('../../src/jobs/invoice-job', () => ({ runInvoiceJob }));

    mod = require('../../src/jobs/scheduler') as Scheduler;
  });
  process.env = previous;
  return { mod, schedule, runInvoiceJob, scheduled };
}

describe('scheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does nothing when disabled', () => {
    const { mod, schedule } = loadScheduler({ SCHEDULER_ENABLED: 'false' });
    mod.startScheduler();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('schedules the invoice job at midnight IST and catches up after boot', async () => {
    jest.useFakeTimers();
    const { mod, schedule, runInvoiceJob, scheduled } = loadScheduler({
      SCHEDULER_ENABLED: 'true',
      INVOICE_CRON: '0 0 * * *',
    });
    mod.startScheduler();
    expect(schedule).toHaveBeenCalledWith(
      '0 0 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: 'Asia/Kolkata', noOverlap: true }),
    );

    scheduled[0]!();
    expect(runInvoiceJob).toHaveBeenCalledWith('schedule');
    jest.advanceTimersByTime(15_000);
    expect(runInvoiceJob).toHaveBeenCalledWith('startup');

    mod.stopScheduler();
  });

  it('logs (and survives) job failures', async () => {
    jest.useFakeTimers();
    const { mod, runInvoiceJob, scheduled } = loadScheduler({ SCHEDULER_ENABLED: 'true' });
    runInvoiceJob.mockRejectedValue(new Error('boom'));
    mod.startScheduler();
    scheduled[0]!();
    jest.advanceTimersByTime(15_000);
    await Promise.resolve();
    expect(runInvoiceJob).toHaveBeenCalledTimes(2);
    mod.stopScheduler();
  });

  it('refuses an invalid cron expression', () => {
    const { mod } = loadScheduler({ SCHEDULER_ENABLED: 'true', INVOICE_CRON: 'bad cron' });
    expect(() => mod.startScheduler()).toThrow('Invalid INVOICE_CRON expression: bad cron');
  });
});
