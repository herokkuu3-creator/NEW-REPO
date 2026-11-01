import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ generate: vi.fn(), create: vi.fn() }));
vi.mock('../src/solutionPosts/service', () => ({ createPostRouter: mock.create }));
import { answerChat, isSensitiveChatText } from '../src/notifications/aiChat';

afterEach(() => vi.resetAllMocks());
describe('Telegram AI chat', () => {
  it('sends the actual question through the configured server router', async () => {
    mock.generate.mockResolvedValue({ value: 'Why did the bug cross the road? To get to the other byte.', model: 'test' });
    mock.create.mockResolvedValue({ generate: mock.generate });
    expect(await answerChat('Tell me a joke')).toContain('byte');
    expect(mock.create).toHaveBeenCalledWith({}, 'bazaarlink');
    expect(mock.generate).toHaveBeenCalledWith(expect.arrayContaining([{ role: 'user', content: 'Tell me a joke' }]),
      expect.any(Function), 900, false, 'telegram-chat');
  });
  it('does not forward recognizable credentials or oversized input', async () => {
    expect(isSensitiveChatText(`fc-${'x'.repeat(32)}`)).toBe(true);
    expect(isSensitiveChatText('LEETCODE_SESSION=private')).toBe(true);
    expect(await answerChat(`fc-${'x'.repeat(32)}`)).toContain('remove credentials');
    expect(await answerChat('x'.repeat(4001))).toContain('4,000');
    expect(mock.create).not.toHaveBeenCalled();
  });
  it('returns a useful failure without exposing provider error text', async () => {
    mock.create.mockRejectedValue(new Error('private provider detail'));
    const response = await answerChat('hello');
    expect(response).toContain('AI_CHAT_FAILED');
    expect(response).not.toContain('private provider detail');
  });
});
