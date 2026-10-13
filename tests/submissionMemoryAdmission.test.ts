import { expect, it } from 'vitest';
import { availableMemoryMb } from '../src/codeforces/submitterService';

it('does not reject a browser because reclaimable cgroup file cache is charged as used memory', () => {
  // The production failure reported 185MB raw free on a 512MB service. With
  // 120MB of inactive file cache, the usable amount is 305MB and clears the
  // configured 300MB browser floor.
  expect(availableMemoryMb(512, 327, 120)).toBe(305);
});

it('keeps real working-memory pressure below the browser floor', () => {
  expect(availableMemoryMb(512, 420, 20)).toBe(112);
});

it('bounds invalid or excessive reclaimable accounting', () => {
  expect(availableMemoryMb(512, 327, -10)).toBe(185);
  expect(availableMemoryMb(512, 327, 1000)).toBe(512);
});
