import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeSageApi, askSage, sageConsoleHtml } from '../src/ai/sageProbe';

vi.mock('../src/ai/sageProbe', async () => {
  const actual = await vi.importActual<any>('../src/ai/sageProbe');
  return {
    ...actual,
    probeSageApi: vi.fn(async () => ({
      ok: true,
      executionHost: 'render',
      revision: null,
      testedAt: '2026-11-05T00:00:00.000Z',
      elapsedMs: 250,
      baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
      keyMasked: 'sk-0c521…a056',
      modelsStatus: 200,
      modelsCount: 4,
      models: ['deepseek-v4.1-flash-1017', 'qwen3.8-27b', 'Sage-A1.5', 'intern-s2'],
      chatStatus: 200,
      chatModel: 'deepseek-v4.1-flash-1017',
      chatReply: 'SAGE_RENDER_OK',
      markerMatched: true,
    })),
    askSage: vi.fn(async (q: string) => ({
      ok: true,
      question: q,
      answer: 'Quicksort average time complexity is O(n log n).',
      model: 'deepseek-v4.1-flash-1017',
      elapsedMs: 800,
      executionHost: 'render',
    })),
  };
});

describe('Sage HTTP endpoints', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function createTestApp() {
    const app = Fastify();
    app.get('/sage', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return reply.type('text/html; charset=utf-8').send(sageConsoleHtml('Render Web Service'));
    });
    app.post('/sage/test', async (req, reply) => {
      const body = (req.body ?? {}) as { apiKey?: string; model?: string };
      const res = await probeSageApi(body.apiKey, body.model);
      return reply.send(res);
    });
    app.post('/sage/ask', async (req, reply) => {
      const body = (req.body ?? {}) as { question?: string; apiKey?: string; model?: string };
      const res = await askSage(body.question || '');
      return reply.send(res);
    });
    return app;
  }

  it('serves the Sage web console at GET /sage', async () => {
    const app = createTestApp();
    const res = await app.inject({ method: 'GET', url: '/sage' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Sage Inkstone (Intern-AI)');
    expect(res.body).toContain('Render Web Service');
    await app.close();
  });

  it('runs diagnostic tests at POST /sage/test', async () => {
    const app = createTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/sage/test',
      payload: { model: 'deepseek-v4.1-flash-1017' },
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.ok).toBe(true);
    expect(json.executionHost).toBe('render');
    expect(json.chatModel).toBe('deepseek-v4.1-flash-1017');
    expect(json.models).toContain('qwen3.8-27b');
    await app.close();
  });

  it('answers questions at POST /sage/ask', async () => {
    const app = createTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/sage/ask',
      payload: { question: 'What is quicksort?' },
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.ok).toBe(true);
    expect(json.answer).toContain('O(n log n)');
    await app.close();
  });
});
