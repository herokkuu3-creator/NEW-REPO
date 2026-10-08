import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return {
    config: {
      ...real.config,
      telegram: {
        ...(real.config.telegram as object),
        chatId: '9999',
        enabled: true,
        commands: true,
        botToken: 'TEST_TOKEN',
      },
    },
  };
});

import {
  HELP_TEXT,
  QueuedCommandItem,
  clearCommandQueue,
  describeActiveWorker,
  enqueueCommand,
  formatQueuePromptMessage,
  formatQueueStatusText,
  getCommandQueue,
  handleClearQueue,
  handleQueueCommandInput,
  isAnyWorkerBusy,
  isPendingQueuePrompt,
  resetQueueForTest,
  runQueueWorker,
  setPendingPromptType,
  setPendingQueuePrompt,
  validateQueueCommand,
  VALID_QUEUE_COMMANDS,
} from '../src/notifications/telegramBot';

describe('Command Queue validation (validateQueueCommand)', () => {
  beforeEach(() => {
    resetQueueForTest();
  });

  it('accepts standard slash commands', () => {
    expect(validateQueueCommand('/cfrange 5')).toEqual({ valid: true, normalized: '/cfrange 5' });
    expect(validateQueueCommand('/ccrange 10')).toEqual({ valid: true, normalized: '/ccrange 10' });
    expect(validateQueueCommand('/questionrangesubmission 200-400')).toEqual({ valid: true, normalized: '/questionrangesubmission 200-400' });
    expect(validateQueueCommand('/submitnextsolution')).toEqual({ valid: true, normalized: '/submitnextsolution' });
    expect(validateQueueCommand('/codechef')).toEqual({ valid: true, normalized: '/codechef' });
    expect(validateQueueCommand('/triggersubmission')).toEqual({ valid: true, normalized: '/triggersubmission' });
    expect(validateQueueCommand('/claimcoins')).toEqual({ valid: true, normalized: '/claimcoins' });
    expect(validateQueueCommand('/status')).toEqual({ valid: true, normalized: '/status' });
    expect(validateQueueCommand('/useproxy 1')).toEqual({ valid: true, normalized: '/useproxy 1' });
  });

  it('normalizes commands sent without a leading slash', () => {
    expect(validateQueueCommand('cfrange 5')).toEqual({ valid: true, normalized: '/cfrange 5' });
    expect(validateQueueCommand('ccrange 10')).toEqual({ valid: true, normalized: '/ccrange 10' });
    expect(validateQueueCommand('questionrangesubmission 1-50')).toEqual({ valid: true, normalized: '/questionrangesubmission 1-50' });
    expect(validateQueueCommand('submitnextsolution')).toEqual({ valid: true, normalized: '/submitnextsolution' });
    expect(validateQueueCommand('codechef')).toEqual({ valid: true, normalized: '/codechef' });
  });

  it('strips telegram bot username suffix (@bot) if present', () => {
    expect(validateQueueCommand('/cfrange@my_bot 5')).toEqual({ valid: true, normalized: '/cfrange 5' });
  });

  it('rejects queue meta-commands from being queued inside the queue', () => {
    expect(validateQueueCommand('/startqueue').valid).toBe(false);
    expect(validateQueueCommand('/queuestart').valid).toBe(false);
    expect(validateQueueCommand('/queue').valid).toBe(false);
    expect(validateQueueCommand('/queuestatus').valid).toBe(false);
    expect(validateQueueCommand('/clearqueue').valid).toBe(false);
    expect(validateQueueCommand('/cancel').valid).toBe(false);
    expect(validateQueueCommand('/help').valid).toBe(false);
  });

  it('rejects empty or completely unknown commands', () => {
    expect(validateQueueCommand('').valid).toBe(false);
    expect(validateQueueCommand('   ').valid).toBe(false);
    expect(validateQueueCommand('/invalidcommand').valid).toBe(false);
    expect(validateQueueCommand('some random message').valid).toBe(false);
  });
});

describe('Command Queue FIFO operations', () => {
  beforeEach(() => {
    resetQueueForTest();
  });

  it('enqueues commands in FIFO order with proper positions', () => {
    expect(getCommandQueue()).toHaveLength(0);

    const first = enqueueCommand('/cfrange 5');
    expect(first.position).toBe(1);
    expect(first.item.rawText).toBe('/cfrange 5');
    expect(first.item.command).toBe('/cfrange');
    expect(first.item.arg).toBe('5');

    const second = enqueueCommand('/ccrange 10');
    expect(second.position).toBe(2);
    expect(second.item.rawText).toBe('/ccrange 10');

    const third = enqueueCommand('/questionrangesubmission 200-400');
    expect(third.position).toBe(3);

    const queue = getCommandQueue();
    expect(queue).toHaveLength(3);
    expect(queue[0]!.rawText).toBe('/cfrange 5');
    expect(queue[1]!.rawText).toBe('/ccrange 10');
    expect(queue[2]!.rawText).toBe('/questionrangesubmission 200-400');
  });

  it('clears command queue completely', () => {
    enqueueCommand('/cfrange 5');
    enqueueCommand('/ccrange 5');
    expect(getCommandQueue()).toHaveLength(2);

    const cleared = clearCommandQueue();
    expect(cleared).toBe(2);
    expect(getCommandQueue()).toHaveLength(0);

    expect(handleClearQueue()).toBe('📭 Command queue was already empty.');
  });
});

describe('formatQueueStatusText & prompt', () => {
  beforeEach(() => {
    resetQueueForTest();
  });

  it('formats empty queue status correctly', () => {
    const text = formatQueueStatusText();
    expect(text).toContain('COMMAND QUEUE STATUS');
    expect(text).toContain('Active Process:</b> None (idle)');
    expect(text).toContain('Queue:</b> Empty');
    expect(text).toContain('/startqueue');
  });

  it('formats active queue status with queued items and positions', () => {
    enqueueCommand('/cfrange 5');
    enqueueCommand('/questionrangesubmission 100-200');

    const text = formatQueueStatusText();
    expect(text).toContain('Queued Commands (2):');
    expect(text).toContain('1. <code>/cfrange 5</code>');
    expect(text).toContain('2. <code>/questionrangesubmission 100-200</code>');
    expect(text).toContain('/clearqueue');
  });

  it('formats queue prompt message with examples', () => {
    const prompt = formatQueuePromptMessage();
    expect(prompt).toContain('Command Queue');
    expect(prompt).toContain('/cfrange 5');
    expect(prompt).toContain('/ccrange 5');
    expect(prompt).toContain('/questionrangesubmission 200-400');
    expect(prompt).toContain('/cancel');
  });
});

describe('handleQueueCommandInput', () => {
  beforeEach(() => {
    resetQueueForTest();
  });

  it('enqueues a valid command and sends formatted notification', async () => {
    const notifications: string[] = [];
    let workerTriggered = false;

    const ok = await handleQueueCommandInput('/cfrange 5', {
      notify: async (text) => { notifications.push(text); },
      startWorker: () => { workerTriggered = true; },
    });

    expect(ok).toBe(true);
    expect(workerTriggered).toBe(true);
    expect(getCommandQueue()).toHaveLength(1);
    expect(notifications[0]).toContain('Command Queued (#1 in queue)');
    expect(notifications[0]).toContain('<code>/cfrange 5</code>');
  });

  it('rejects an invalid command and sends error prompt without adding to queue', async () => {
    const notifications: string[] = [];
    let workerTriggered = false;

    const ok = await handleQueueCommandInput('/unknown_action', {
      notify: async (text) => { notifications.push(text); },
      startWorker: () => { workerTriggered = true; },
    });

    expect(ok).toBe(false);
    expect(workerTriggered).toBe(false);
    expect(getCommandQueue()).toHaveLength(0);
    expect(notifications[0]).toContain('Invalid Command');
  });
});

describe('runQueueWorker sequential FIFO execution', () => {
  beforeEach(() => {
    resetQueueForTest();
  });

  it('executes queued commands sequentially in FIFO order', async () => {
    enqueueCommand('/cfrange 5');
    enqueueCommand('/ccrange 5');
    enqueueCommand('/submitnextsolution');

    const executed: string[] = [];
    const notifications: string[] = [];

    let isBusy = false;

    await runQueueWorker({
      isBusy: () => isBusy,
      execute: async (item) => {
        isBusy = true;
        executed.push(item.rawText);
        // Simulate task doing work then completing
        isBusy = false;
      },
      sleep: async () => {}, // Instant sleep for tests
      notify: async (text) => {
        notifications.push(text);
      },
    });

    expect(executed).toEqual([
      '/cfrange 5',
      '/ccrange 5',
      '/submitnextsolution',
    ]);
    expect(getCommandQueue()).toHaveLength(0);
    expect(notifications.some((n) => n.includes('/cfrange 5'))).toBe(true);
    expect(notifications.some((n) => n.includes('/ccrange 5'))).toBe(true);
    expect(notifications.some((n) => n.includes('Command Queue Completed!'))).toBe(true);
  });

  it('resiliently continues to next queue item if one command fails', async () => {
    enqueueCommand('/cfrange 5');
    enqueueCommand('/invalid_runtime_failure');
    enqueueCommand('/ccrange 5');

    const executed: string[] = [];
    const notifications: string[] = [];

    await runQueueWorker({
      isBusy: () => false,
      execute: async (item) => {
        if (item.rawText.includes('invalid_runtime_failure')) {
          throw new Error('Simulation network crash');
        }
        executed.push(item.rawText);
      },
      sleep: async () => {},
      notify: async (text) => {
        notifications.push(text);
      },
    });

    expect(executed).toEqual([
      '/cfrange 5',
      '/ccrange 5',
    ]);
    expect(getCommandQueue()).toHaveLength(0);
    expect(notifications.some((n) => n.includes('Simulation network crash'))).toBe(true);
    expect(notifications.some((n) => n.includes('Command Queue Completed!'))).toBe(true);
  });
});

describe('Queue state in pendingPromptType and HELP_TEXT', () => {
  it('manages queue prompt state', () => {
    setPendingPromptType('queue');
    expect(isPendingQueuePrompt()).toBe(true);

    setPendingQueuePrompt(false);
    expect(isPendingQueuePrompt()).toBe(false);

    setPendingQueuePrompt(true);
    expect(isPendingQueuePrompt()).toBe(true);
  });

  it('HELP_TEXT contains clickable Queue Management commands', () => {
    expect(HELP_TEXT).toContain('𝗤𝗨𝗘𝗨𝗘 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧');
    expect(HELP_TEXT).toContain('├ /startqueue — Queue next command');
    expect(HELP_TEXT).toContain('├ /queuestatus — View active process &amp; queued commands');
    expect(HELP_TEXT).toContain('└ /clearqueue — Cancel &amp; purge pending queue');

    // Must be bare slash commands (not code wrapped)
    expect(HELP_TEXT).not.toContain('<code>/startqueue</code>');
    expect(HELP_TEXT).not.toContain('<code>/queuestatus</code>');
    expect(HELP_TEXT).not.toContain('<code>/clearqueue</code>');
  });
});
