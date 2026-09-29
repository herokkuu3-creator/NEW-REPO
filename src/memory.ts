import fs from 'node:fs';
import { logger } from './logger';

/**
 * Container memory telemetry and pressure guard.
 *
 * Render's free web service has 512MB, and exceeding it is not a soft limit:
 * the kernel kills the process and Render reports "Ran out of memory (used over
 * 512MB)", which restarts the WHOLE service — LeetCode scheduler and Telegram
 * bot included. A browser is the only thing in this app that can grow that
 * large, so the browser steps read the container's own accounting and bail out
 * before the kernel does.
 *
 * cgroup v2 and v1 expose the numbers under different paths; both are probed
 * once and the working one is remembered.
 */

export interface MemoryReading {
  /** Bytes currently charged to the container. */
  usedMb: number | null;
  /** High-water mark for this container's lifetime. */
  peakMb: number | null;
  /** The container's ceiling (null when unlimited / unknown). */
  limitMb: number | null;
  nodeRssMb: number;
  nodeHeapMb: number;
  source: 'cgroup-v2' | 'cgroup-v1' | 'unknown';
}

interface CgroupPaths {
  source: MemoryReading['source'];
  current: string;
  peak: string;
  max: string;
}

const CANDIDATES: CgroupPaths[] = [
  {
    source: 'cgroup-v2',
    current: '/sys/fs/cgroup/memory.current',
    peak: '/sys/fs/cgroup/memory.peak',
    max: '/sys/fs/cgroup/memory.max',
  },
  {
    source: 'cgroup-v1',
    current: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
    peak: '/sys/fs/cgroup/memory/memory.max_usage_in_bytes',
    max: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  },
];

let resolvedPaths: CgroupPaths | null | undefined;

function paths(): CgroupPaths | null {
  if (resolvedPaths !== undefined) return resolvedPaths;
  resolvedPaths = CANDIDATES.find((candidate) => fs.existsSync(candidate.current)) ?? null;
  return resolvedPaths;
}

function readBytes(path: string | undefined): number | null {
  if (!path) return null;
  try {
    const raw = fs.readFileSync(path, 'utf8').trim();
    if (!raw || raw === 'max') return null;
    const value = Number(raw);
    // cgroup v1 reports "unlimited" as a huge sentinel; treat it as no limit.
    if (!Number.isFinite(value) || value > 1e15) return null;
    return value;
  } catch {
    return null;
  }
}

function toMb(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / 1_048_576);
}

export function memoryReading(): MemoryReading {
  const found = paths();
  const usage = process.memoryUsage();
  return {
    usedMb: toMb(readBytes(found?.current)),
    peakMb: toMb(readBytes(found?.peak)),
    limitMb: toMb(readBytes(found?.max)),
    nodeRssMb: Math.round(usage.rss / 1_048_576),
    nodeHeapMb: Math.round(usage.heapUsed / 1_048_576),
    source: found?.source ?? 'unknown',
  };
}

/** The container's ceiling in MB, falling back to Render free's 512MB. */
export function memoryLimitMb(): number {
  const configured = Number(process.env.MEMORY_LIMIT_MB);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return memoryReading().limitMb ?? 512;
}

/** Logs the container's memory, and returns the reading for callers that gate on it. */
export function logMemory(phase: string, extra: Record<string, unknown> = {}): MemoryReading {
  const reading = memoryReading();
  logger.info({ phase, ...reading, ...extra }, 'memory');
  return reading;
}

/**
 * Polls the container's memory while a browser runs. `onPressure` fires once,
 * when the reading gets within `reserveMb` of the ceiling — the caller closes
 * the browser and reports a real reason instead of letting the kernel SIGKILL
 * the process and take the LeetCode scheduler down with it.
 */
export class MemoryWatch {
  private timer: NodeJS.Timeout | undefined;
  private peakMb = 0;
  private fired = false;

  constructor(
    private readonly onPressure: (reading: MemoryReading, worstMb: number) => void,
    private readonly reserveMb = 64,
    private readonly intervalMs = 1_500,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  private sample(): void {
    const reading = memoryReading();
    if (reading.usedMb !== null) this.peakMb = Math.max(this.peakMb, reading.usedMb);
    if (this.fired || reading.usedMb === null) return;
    if (reading.usedMb >= memoryLimitMb() - this.reserveMb) {
      this.fired = true;
      this.onPressure(reading, this.peakMb);
    }
  }

  stop(): { peakMb: number; tripped: boolean } {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return { peakMb: this.peakMb, tripped: this.fired };
  }
}

/** Best-effort heap release before a memory-heavy step (needs --expose-gc). */
export function releaseHeap(): void {
  (globalThis as { gc?: () => void }).gc?.();
}
