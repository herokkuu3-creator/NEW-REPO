import { describe, expect, it } from 'vitest';
import {
  AI_SOLVE_FAILURE_THRESHOLD,
  createMemoryQuestionFailureStore,
} from '../src/scheduler/questionFailureCounter';

describe('questionFailureCounter', () => {
  it('tracks per-question failure counts and unique failed community UUIDs, and resets on accept', async () => {
    const store = createMemoryQuestionFailureStore();

    expect((await store.get(1220)).failures).toBe(0);

    const f1 = await store.recordFailure(1220, { reason: 'Wrong Answer', communityUuid: 'uuid-1' });
    expect(f1.failures).toBe(1);
    expect(f1.failedUuids).toEqual(['uuid-1']);

    const f2 = await store.recordFailure(1220, { reason: 'TLE', communityUuid: 'uuid-2' });
    expect(f2.failures).toBe(2);
    expect(f2.failedUuids).toEqual(['uuid-1', 'uuid-2']);

    const f3 = await store.recordFailure(1220, { reason: 'no solution', communityUuid: 'uuid-2' });
    expect(f3.failures).toBe(AI_SOLVE_FAILURE_THRESHOLD);
    expect(f3.failedUuids).toEqual(['uuid-1', 'uuid-2']);

    await store.reset(1220);
    const cleared = await store.get(1220);
    expect(cleared.failures).toBe(0);
    expect(cleared.failedUuids).toEqual([]);
  });
});
