import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileStampLocal, humanLocal, isoLocal, tzLabel } from '../src/time';
import { buildReport } from '../src/scheduler/report';

const instant = new Date('2026-09-27T07:33:10.439Z'); // = 13:03:10.439 IST

describe('IST time formatting', () => {
  it('isoLocal renders Indian time with the +05:30 offset', () => {
    expect(isoLocal(instant, 'Asia/Kolkata')).toBe('2026-09-27T13:03:10.439+05:30');
  });

  it('isoLocal is still the same instant (machine-parseable)', () => {
    expect(new Date(isoLocal(instant, 'Asia/Kolkata')).getTime()).toBe(instant.getTime());
  });

  it('handles the date rolling over past midnight IST', () => {
    expect(isoLocal(new Date('2026-09-27T19:00:00.000Z'), 'Asia/Kolkata')).toBe('2026-09-28T00:30:00.000+05:30');
  });

  it('defaults to the configured TIMEZONE (Asia/Kolkata)', () => {
    expect(isoLocal(instant)).toBe('2026-09-27T13:03:10.439+05:30');
  });

  it('humanLocal is a short IST label for Telegram', () => {
    expect(humanLocal(instant, 'Asia/Kolkata')).toBe('27 Sep 2026, 13:03 IST');
    expect(tzLabel('Asia/Kolkata')).toBe('IST');
  });

  it('fileStampLocal is filesystem-safe', () => {
    expect(fileStampLocal(instant, 'Asia/Kolkata')).toBe('2026-09-27T13-03-10-439+0530');
  });

  it('other timezones still work', () => {
    expect(isoLocal(instant, 'UTC')).toBe('2026-09-27T07:33:10.439+00:00');
  });

  it('run reports are stamped in IST', () => {
    const r = buildReport({ date: '2026-09-27', reason: 'cron', startedAt: isoLocal(), outcomes: [] });
    expect(r.finishedAt).toMatch(/\+05:30$/);
  });

  it('log lines carry IST time', () => {
    const out = execFileSync(
      process.execPath,
      ['--import', 'tsx', '-e', "require('./src/logger').logger.info('ist check')"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://t:t@localhost:5432/t',
          SETUP_TOKEN: 'test-token-for-vitest',
          TIMEZONE: 'Asia/Kolkata',
        },
        encoding: 'utf8',
      },
    );
    const line = JSON.parse(out.trim().split('\n').pop()!);
    expect(line.msg).toBe('ist check');
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+05:30$/);
  });
});
