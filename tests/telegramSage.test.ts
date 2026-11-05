import { afterEach, describe, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn(async (_text: string, _opts?: any) => true));
vi.mock('../src/notifications/telegram', () => ({ sendTelegramMessage: send }));
import { handleTestSage, handleAskSage } from '../src/notifications/telegramBot';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Telegram Sage Inkstone Commands', () => {
  describe('/testsage', () => {
    it('runs diagnostics and sends formatted telegram message with models and latency', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          const u = url.toString();
          if (u.includes('/models')) {
            return new Response(
              JSON.stringify({
                data: [
                  { id: 'deepseek-v4.1-flash-1017', status: 'active' },
                  { id: 'qwen3.8-27b', status: 'active' },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'SAGE_RENDER_OK' } }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }),
      );

      await handleTestSage();
      expect(send).toHaveBeenCalled();
      const calls = send.mock.calls.map((c) => c[0]).join('\n');
      expect(calls).toContain('Sage Inkstone (Intern-AI) Diagnostics');
      expect(calls).toContain('GET /v1/models:');
      expect(calls).toContain('POST /v1/chat/completions:');
      expect(calls).toContain('Sage Inkstone API is fully operational');
      expect(calls).not.toContain('sk-0c521134a79c8241d29ce148c8b1f42c3bd8458dbca136601fb17dd217c4a056');
    });
  });

  describe('/asksage', () => {
    it('prompts usage if no question provided', async () => {
      await handleAskSage('');
      expect(send).toHaveBeenCalled();
      const text = send.mock.calls[0][0];
      expect(text).toContain('Usage:');
      expect(text).toContain('/asksage &lt;your question&gt;');
    });

    it('queries Sage AI and sends answer', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                model: 'deepseek-v4.1-flash-1017',
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: 'Binary search runs in O(log n) time.',
                    },
                  },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        ),
      );

      await handleAskSage('What is binary search complexity?');
      expect(send).toHaveBeenCalled();
      const calls = send.mock.calls.map((c) => c[0]).join('\n');
      expect(calls).toContain('Thinking with Sage Inkstone');
      expect(calls).toContain('Binary search runs in O(log n) time.');
      expect(calls).toContain('Sage Inkstone');
    });
  });
});
