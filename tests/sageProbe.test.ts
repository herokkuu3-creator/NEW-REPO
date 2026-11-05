import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  maskSageKey,
  sanitizeSageOutput,
  probeSageApi,
  askSage,
  sageConsoleHtml,
  DEFAULT_SAGE_API_KEY,
} from '../src/ai/sageProbe';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Sage Inkstone Probe & Ask', () => {
  describe('maskSageKey', () => {
    it('masks keys preserving only start and end', () => {
      expect(maskSageKey('sk-0c521134a79c8241d29ce148c8b1f42c3bd8458dbca136601fb17dd217c4a056')).toBe(
        'sk-0c521…a056',
      );
      expect(maskSageKey('')).toBe('(none)');
      expect(maskSageKey('short')).toBe('***');
    });
  });

  describe('sanitizeSageOutput', () => {
    it('removes raw api keys from error and output strings', () => {
      const key = 'sk-0c521134a79c8241d29ce148c8b1f42c3bd8458dbca136601fb17dd217c4a056';
      const text = `Failed with key ${key} and token sk-abcdef1234567890abcdef1234567890`;
      const cleaned = sanitizeSageOutput(text, key);
      expect(cleaned).not.toContain(key);
      expect(cleaned).toContain('[REDACTED_API_KEY]');
    });
  });

  describe('probeSageApi', () => {
    it('reports successful models and chat diagnostics from server', async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const u = url.toString();
        if (u.includes('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [
                { id: 'deepseek-v4.1-flash-1017', status: 'active' },
                { id: 'qwen3.8-27b', status: 'active' },
                { id: 'deprecated-model', status: 'deprecated' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (u.includes('/chat/completions')) {
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-test',
              model: 'deepseek-v4.1-flash-1017',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'SAGE_RENDER_OK' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      });

      vi.stubGlobal('fetch', mockFetch);

      const result = await probeSageApi();
      expect(result.ok).toBe(true);
      expect(result.modelsStatus).toBe(200);
      expect(result.modelsCount).toBe(2); // active models filtered
      expect(result.models).toContain('deepseek-v4.1-flash-1017');
      expect(result.chatStatus).toBe(200);
      expect(result.chatReply).toBe('SAGE_RENDER_OK');
      expect(result.markerMatched).toBe(true);
      expect(result.keyMasked).toContain('sk-0c521…');
    });

    it('classifies HTTP 401 as INVALID_API_KEY', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          const u = url.toString();
          if (u.includes('/models')) return new Response(null, { status: 401 });
          return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      const result = await probeSageApi('sk-invalid-test-key-1234567890');
      expect(result.ok).toBe(false);
      expect(result.chatStatus).toBe(401);
      expect(result.category).toBe('INVALID_API_KEY');
      expect(result.error).toContain('Incorrect API key');
    });

    it('classifies HTTP 402 as INSUFFICIENT_BALANCE_OR_CREDITS', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          return new Response(JSON.stringify({ error: { message: 'Out of credits' } }), {
            status: 402,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      const result = await probeSageApi();
      expect(result.ok).toBe(false);
      expect(result.chatStatus).toBe(402);
      expect(result.category).toBe('INSUFFICIENT_BALANCE_OR_CREDITS');
    });
  });

  describe('askSage', () => {
    it('validates empty or oversized questions', async () => {
      const empty = await askSage('');
      expect(empty.ok).toBe(false);
      expect(empty.error).toBe('EMPTY_QUESTION');

      const oversized = await askSage('a'.repeat(4001));
      expect(oversized.ok).toBe(false);
      expect(oversized.error).toBe('QUESTION_TOO_LONG');
    });

    it('successfully queries the AI model and returns content', async () => {
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
                      content: 'Quicksort is an efficient divide-and-conquer sorting algorithm.',
                    },
                  },
                ],
                usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        ),
      );

      const res = await askSage('What is quicksort?');
      expect(res.ok).toBe(true);
      expect(res.answer).toContain('Quicksort is an efficient');
      expect(res.model).toBe('deepseek-v4.1-flash-1017');
    });

    it('falls back to reasoning_content if content is empty', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                model: 'Sage-A1.5',
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: null,
                      reasoning_content: 'Thought: The answer to 1+1 is 2.',
                    },
                  },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        ),
      );

      const res = await askSage('1+1?');
      expect(res.ok).toBe(true);
      expect(res.answer).toContain('Thought: The answer to 1+1 is 2.');
    });
  });

  describe('sageConsoleHtml', () => {
    it('renders HTML console with action buttons and inputs', () => {
      const html = sageConsoleHtml('Render Web Service');
      expect(html).toContain('Sage Inkstone (Intern-AI)');
      expect(html).toContain('Render Web Service');
      expect(html).toContain('runDiagnosticTest()');
      expect(html).toContain('askQuestion()');
      expect(html).toContain('/sage/test');
      expect(html).toContain('/sage/ask');
      expect(html).toContain(DEFAULT_SAGE_API_KEY);
    });
  });
});
