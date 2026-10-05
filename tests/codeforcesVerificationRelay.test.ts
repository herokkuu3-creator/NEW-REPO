import { describe, expect, it } from 'vitest';
import { VerificationRelay, VERIFICATION_LIFETIME_MS } from '../src/codeforces/verificationRelay';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0]).toString('base64');

describe('private phone verification relay', () => {
  it('creates one private capability, bounds gestures, and drains gestures once', () => {
    const relay = new VerificationRelay();
    const first = relay.publish('job', jpeg, 900, 600);
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(relay.frame('wrong-token')).toBeNull();
    expect(relay.queue('wrong-token', { type: 'click', x: 1, y: 1 })).toBe(false);
    expect(relay.queue(first.token, { type: 'click', x: -1, y: 1 })).toBe(false);
    expect(relay.queue(first.token, { type: 'click', x: 900, y: 1 })).toBe(false);
    expect(relay.queue(first.token, { type: 'scroll', delta: 99999 })).toBe(false);
    expect(relay.queue(first.token, { type: 'navigate', url: 'https://evil.test' })).toBe(false);
    expect(relay.queue(first.token, { type: 'click', x: 20, y: 50 })).toBe(true);
    const next = relay.publish('job', jpeg, 900, 600);
    expect(next.token).toBe(first.token);
    expect(next.actions).toEqual([{ type: 'click', x: 20, y: 50 }]);
    expect(relay.publish('job', jpeg, 900, 600).actions).toEqual([]);
  });

  it('expires links without extending their lifetime when frames refresh', () => {
    let now = 1000;
    const relay = new VerificationRelay(() => now);
    const first = relay.publish('job', jpeg, 900, 600);
    now += 1000;
    expect(relay.publish('job', jpeg, 900, 600).expiresAt).toBe(first.expiresAt);
    now = 1000 + VERIFICATION_LIFETIME_MS;
    expect(relay.frame(first.token)).toBeNull();
    expect(relay.metadata('job')).toBeUndefined();
    expect(relay.queue(first.token, { type: 'cancel' })).toBe(false);
  });

  it('revokes old account links on replacement or close and rejects large frames', () => {
    const relay = new VerificationRelay();
    const first = relay.publish('first', jpeg, 900, 600);
    const next = relay.publish('second', jpeg, 900, 600);
    expect(relay.frame(first.token)).toBeNull();
    relay.close('first');
    expect(relay.frame(next.token)).not.toBeNull();
    relay.close('second');
    expect(relay.frame(next.token)).toBeNull();
    expect(() => relay.publish('third', 'A'.repeat(600_001), 900, 600)).toThrow();
    expect(() => relay.publish('third', jpeg, 99999, 600)).toThrow();
    expect(() => relay.publish('third', 'YWJj', 900, 600)).toThrow();
  });
});
