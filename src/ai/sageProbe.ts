// This module is also loaded by the standalone submitter, which has no DATABASE_URL
// and must not trigger the main app's config validation (process.exit) at import time.
const logger = {
  warn: (obj: unknown, msg: string): void => {
    const err = (obj as { err?: unknown })?.err ?? obj;
    try { process.stderr.write(`${JSON.stringify({ level: 40, msg, err: err instanceof Error ? err.message : String(err) })}\n`); } catch { /* ignore */ }
  },
};

export const DEFAULT_SAGE_BASE_URL = 'https://discovery-api.intern-ai.org.cn/v1';
export const DEFAULT_SAGE_API_KEY = 'sk-0c521134a79c8241d29ce148c8b1f42c3bd8458dbca136601fb17dd217c4a056';
export const DEFAULT_SAGE_MODEL = 'deepseek-v4.1-flash-1017';
export const SAGE_MODELS = [
  'deepseek-v4.1-flash-1017',
  'qwen3.8-27b',
  'Sage-A1.5',
  'intern-s2',
  'kimi-k2.6',
  'minimax-m3',
  'glm-5.3',
  'Agents-A1',
  'Atria-Dawn',
] as const;

export interface SageProbeDiagnostic {
  ok: boolean;
  executionHost: 'render' | 'local';
  revision: string | null;
  testedAt: string;
  elapsedMs: number;
  baseUrl: string;
  keyMasked: string;
  modelsStatus: number;
  modelsCount: number;
  models: string[];
  chatStatus: number;
  chatModel: string;
  chatReply?: string;
  markerMatched?: boolean;
  finishReason?: string | null;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
  category?: string;
  error?: string;
  errorCode?: string;
}

export interface SageChatResult {
  ok: boolean;
  question: string;
  answer: string;
  model: string;
  elapsedMs: number;
  executionHost: 'render' | 'local';
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  error?: string;
  category?: string;
}

export function maskSageKey(key: string): string {
  const clean = key.trim();
  if (!clean) return '(none)';
  if (clean.length <= 10) return '***';
  return `${clean.slice(0, 8)}…${clean.slice(-4)}`;
}

export function sanitizeSageOutput(text: string, key?: string): string {
  let res = String(text ?? '');
  if (key && key.trim()) {
    res = res.split(key.trim()).join('[REDACTED_API_KEY]');
  }
  return res.replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
}

/**
 * Diagnostic probe testing Sage Inkstone (Intern-AI) connectivity from the server.
 * Verifies both GET /v1/models and POST /v1/chat/completions.
 */
export async function probeSageApi(
  apiKeyOverride?: string,
  modelOverride?: string,
): Promise<SageProbeDiagnostic> {
  const started = Date.now();
  const apiKey = (apiKeyOverride || process.env.SAGE_API_KEY || DEFAULT_SAGE_API_KEY).trim();
  const baseUrl = (process.env.SAGE_BASE_URL || DEFAULT_SAGE_BASE_URL).trim().replace(/\/+$/, '');
  const model = (modelOverride || process.env.SAGE_MODEL || DEFAULT_SAGE_MODEL).trim();

  const metadata = {
    executionHost: (process.env.RENDER_INSTANCE_ID ? 'render' : 'local') as 'render' | 'local',
    revision: process.env.RENDER_GIT_COMMIT ?? null,
    testedAt: new Date().toISOString(),
    baseUrl,
    keyMasked: maskSageKey(apiKey),
    chatModel: model,
  };

  // Step 1: Query models list (GET /models)
  let modelsStatus = 0;
  let models: string[] = [];
  try {
    const modelsRes = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(20000),
    });
    modelsStatus = modelsRes.status;
    if (modelsRes.ok) {
      const data = await modelsRes.json().catch(() => ({}));
      if (Array.isArray(data.data)) {
        models = data.data
          .filter((m: any) => m?.status === 'active' || !m?.status)
          .map((m: any) => m.id || m.name)
          .filter(Boolean);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Sage /models probe error');
  }

  // Step 2: Chat completion inference test (POST /chat/completions)
  let chatStatus = 0;
  try {
    const chatRes = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a test assistant. Reply with exactly the requested marker.' },
          { role: 'user', content: 'Reply with exactly SAGE_RENDER_OK in one word.' },
        ],
        max_tokens: 128,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30000),
    });

    chatStatus = chatRes.status;
    const raw = await chatRes.text();
    let data: any = {};
    try {
      data = JSON.parse(raw);
    } catch {}

    if (!chatRes.ok) {
      const category =
        chatStatus === 401
          ? 'INVALID_API_KEY'
          : chatStatus === 402
            ? 'INSUFFICIENT_BALANCE_OR_CREDITS'
            : chatStatus === 403
              ? 'PERMISSION_DENIED'
              : chatStatus === 429
                ? 'RATE_LIMIT_EXCEEDED'
                : 'API_ERROR';
      const errMsg = sanitizeSageOutput(data.error?.message ?? data.message ?? `HTTP_${chatStatus}`, apiKey);
      return {
        ...metadata,
        ok: false,
        elapsedMs: Date.now() - started,
        modelsStatus,
        modelsCount: models.length,
        models,
        chatStatus,
        category,
        error: errMsg,
        errorCode: data.error?.code ?? data.code,
      };
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim() || choice?.message?.reasoning_content?.trim() || '';
    const markerMatched = /SAGE_RENDER_OK/i.test(content);
    const finishReason = choice?.finish_reason ?? null;

    return {
      ...metadata,
      ok: chatRes.ok && content.length > 0,
      elapsedMs: Date.now() - started,
      modelsStatus,
      modelsCount: models.length,
      models,
      chatStatus,
      chatReply: sanitizeSageOutput(content, apiKey),
      markerMatched,
      finishReason,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : null,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && /Timeout|Abort/.test(error.name);
    return {
      ...metadata,
      ok: false,
      elapsedMs: Date.now() - started,
      modelsStatus,
      modelsCount: models.length,
      models,
      chatStatus,
      category: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      error: isTimeout ? 'Sage API request timed out after 30s' : 'Network error reaching Sage API endpoint',
    };
  }
}

/**
 * Ask a question to Sage Inkstone (Intern-AI) from the server.
 * Supports reasoning models by extracting final answer or reasoning content.
 */
export async function askSage(
  question: string,
  options?: { apiKey?: string; model?: string; maxTokens?: number },
): Promise<SageChatResult> {
  const started = Date.now();
  const q = question.trim();
  const executionHost = (process.env.RENDER_INSTANCE_ID ? 'render' : 'local') as 'render' | 'local';

  if (!q) {
    return {
      ok: false,
      question: '',
      answer: 'Please provide a non-empty question.',
      model: '',
      elapsedMs: 0,
      executionHost,
      error: 'EMPTY_QUESTION',
    };
  }
  if (q.length > 4000) {
    return {
      ok: false,
      question: q.slice(0, 50) + '…',
      answer: 'Please keep your question under 4,000 characters.',
      model: '',
      elapsedMs: 0,
      executionHost,
      error: 'QUESTION_TOO_LONG',
    };
  }

  const apiKey = (options?.apiKey || process.env.SAGE_API_KEY || DEFAULT_SAGE_API_KEY).trim();
  const baseUrl = (process.env.SAGE_BASE_URL || DEFAULT_SAGE_BASE_URL).trim().replace(/\/+$/, '');
  const model = (options?.model || process.env.SAGE_MODEL || DEFAULT_SAGE_MODEL).trim();
  const maxTokens = options?.maxTokens ?? 1500;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful, precise, and knowledgeable AI assistant. Answer the user clearly, thoroughly, and directly.',
          },
          { role: 'user', content: q },
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(60000),
    });

    const raw = await response.text();
    let data: any = {};
    try {
      data = JSON.parse(raw);
    } catch {}

    if (!response.ok) {
      const errMsg = sanitizeSageOutput(data.error?.message ?? data.message ?? `HTTP ${response.status}`, apiKey);
      return {
        ok: false,
        question: q,
        answer: `AI error: ${errMsg}`,
        model,
        elapsedMs: Date.now() - started,
        executionHost,
        error: errMsg,
        category:
          response.status === 401
            ? 'INVALID_API_KEY'
            : response.status === 402
              ? 'INSUFFICIENT_BALANCE'
              : response.status === 429
                ? 'RATE_LIMIT'
                : 'API_ERROR',
      };
    }

    const choice = data.choices?.[0];
    const rawContent = choice?.message?.content?.trim();
    const rawReasoning = choice?.message?.reasoning_content?.trim();
    const answer = rawContent || rawReasoning || 'No response generated by the model.';

    return {
      ok: true,
      question: q,
      answer: sanitizeSageOutput(answer, apiKey),
      model: data.model || model,
      elapsedMs: Date.now() - started,
      executionHost,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && /Timeout|Abort/.test(error.name);
    return {
      ok: false,
      question: q,
      answer: isTimeout ? 'Sage API request timed out after 60 seconds.' : 'Network error communicating with Sage API.',
      model,
      elapsedMs: Date.now() - started,
      executionHost,
      error: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
    };
  }
}

/** HTML Console for testing and interacting with Sage Inkstone (Intern-AI) directly on Render. */
export function sageConsoleHtml(hostLabel: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sage Inkstone (Intern-AI) Console</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-border: #1f2937;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --success: #34d399;
      --warning: #fbbf24;
      --error: #f87171;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 900px; margin: 0 auto; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 16px;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 12px;
    }
    h1 { font-size: 1.5rem; display: flex; align-items: center; gap: 10px; }
    .badge {
      background: rgba(56, 189, 248, 0.15);
      color: var(--primary);
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 0.8rem;
      font-weight: 600;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }
    h2 { font-size: 1.2rem; margin-bottom: 14px; color: var(--primary); display: flex; align-items: center; gap: 8px; }
    label { display: block; font-size: 0.85rem; font-weight: 600; color: var(--muted); margin-bottom: 6px; }
    .row { display: flex; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
    .col { flex: 1; min-width: 240px; }
    input, select, textarea {
      width: 100%;
      background: #1f2937;
      border: 1px solid #374151;
      color: #fff;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 0.95rem;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
    }
    textarea { min-height: 100px; resize: vertical; }
    button {
      background: var(--primary);
      color: #0b0f19;
      font-weight: 600;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.95rem;
      transition: background 0.15s;
    }
    button:hover { background: var(--primary-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .output-box {
      margin-top: 16px;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 14px;
      font-size: 0.9rem;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      max-height: 350px;
      overflow-y: auto;
    }
    .status-ok { color: var(--success); }
    .status-err { color: var(--error); }
    .hint { font-size: 0.8rem; color: var(--muted); margin-top: 4px; }
    .model-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .tag { background: #1e293b; color: var(--primary); padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🪶 Sage Inkstone (Intern-AI)</h1>
      <span class="badge">Host: ${hostLabel}</span>
    </header>

    <!-- SECTION 1: TEST API -->
    <div class="card">
      <h2>🧪 Test API Connectivity from Render</h2>
      <p class="hint" style="margin-bottom: 14px;">Verify server-side connectivity to <code>discovery-api.intern-ai.org.cn</code>, check model availability, and test inference.</p>
      <div class="row">
        <div class="col">
          <label>API Key</label>
          <input type="password" id="testApiKey" value="${DEFAULT_SAGE_API_KEY}" placeholder="sk-...">
          <span class="hint">Defaults to configured key</span>
        </div>
        <div class="col">
          <label>Model</label>
          <select id="testModel">
            <option value="deepseek-v4.1-flash-1017" selected>deepseek-v4.1-flash-1017 (Fast / Reasoning)</option>
            <option value="qwen3.8-27b">qwen3.8-27b (High Performance)</option>
            <option value="Sage-A1.5">Sage-A1.5 (Flagship Sage)</option>
            <option value="intern-s2">intern-s2 (书生-S2)</option>
            <option value="kimi-k2.6">kimi-k2.6</option>
            <option value="minimax-m3">minimax-m3</option>
            <option value="glm-5.3">glm-5.3</option>
          </select>
        </div>
      </div>
      <button id="btnTest" onclick="runDiagnosticTest()">🚀 Run API Diagnostics</button>
      <div id="testOutput" class="output-box" style="display:none;"></div>
    </div>

    <!-- SECTION 2: ASK QUESTION -->
    <div class="card">
      <h2>💬 Ask Question to Sage AI</h2>
      <p class="hint" style="margin-bottom: 14px;">Query Sage Inkstone models directly from this server.</p>
      <div class="row">
        <div class="col">
          <label>Model</label>
          <select id="askModel">
            <option value="deepseek-v4.1-flash-1017" selected>deepseek-v4.1-flash-1017</option>
            <option value="qwen3.8-27b">qwen3.8-27b</option>
            <option value="Sage-A1.5">Sage-A1.5</option>
            <option value="intern-s2">intern-s2</option>
            <option value="kimi-k2.6">kimi-k2.6</option>
            <option value="minimax-m3">minimax-m3</option>
            <option value="glm-5.3">glm-5.3</option>
          </select>
        </div>
      </div>
      <div style="margin-bottom: 14px;">
        <label>Your Question</label>
        <textarea id="askQuestion" placeholder="e.g. Write a quicksort implementation in C++ and explain its time complexity..."></textarea>
      </div>
      <button id="btnAsk" onclick="askQuestion()">💡 Ask Sage AI</button>
      <div id="askOutput" class="output-box" style="display:none;"></div>
    </div>

    <div style="text-align: center; color: var(--muted); font-size: 0.8rem; margin-top: 20px;">
      Telegram shortcuts: <code>/testsage</code> · <code>/asksage &lt;question&gt;</code> · <code>/sage &lt;question&gt;</code>
    </div>
  </div>

  <script>
    async function runDiagnosticTest() {
      const btn = document.getElementById('btnTest');
      const out = document.getElementById('testOutput');
      const apiKey = document.getElementById('testApiKey').value.trim();
      const model = document.getElementById('testModel').value;

      btn.disabled = true;
      btn.textContent = '⏳ Testing from server...';
      out.style.display = 'block';
      out.innerHTML = 'Connecting to Sage Inkstone from Render server...';

      try {
        const res = await fetch('/sage/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, model })
        });
        const data = await res.json();
        const ok = data.ok;
        let html = (ok ? '🟢 <span class="status-ok">ALL CHECKS PASSED</span>' : '🔴 <span class="status-err">DIAGNOSTIC FAILED</span>') + '\\n\\n';
        html += '• Host: ' + data.executionHost + '\\n';
        html += '• Duration: ' + data.elapsedMs + ' ms\\n';
        html += '• Masked Key: ' + data.keyMasked + '\\n';
        html += '• GET /v1/models: HTTP ' + data.modelsStatus + ' (' + data.modelsCount + ' models available)\\n';
        if (data.models && data.models.length) {
          html += '  Active: ' + data.models.slice(0, 8).join(', ') + (data.models.length > 8 ? '...' : '') + '\\n';
        }
        html += '• POST /v1/chat/completions: HTTP ' + data.chatStatus + ' (model: ' + data.chatModel + ')\\n';
        if (data.chatReply) {
          html += '  Reply: ' + data.chatReply.slice(0, 120) + '\\n';
        }
        if (data.error) {
          html += '  Error: ' + data.error + '\\n';
        }
        out.innerHTML = html;
      } catch (e) {
        out.innerHTML = '🔴 <span class="status-err">Request Failed:</span> ' + e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '🚀 Run API Diagnostics';
      }
    }

    async function askQuestion() {
      const btn = document.getElementById('btnAsk');
      const out = document.getElementById('askOutput');
      const question = document.getElementById('askQuestion').value.trim();
      const model = document.getElementById('askModel').value;
      const apiKey = document.getElementById('testApiKey').value.trim();

      if (!question) {
        alert('Please enter a question.');
        return;
      }

      btn.disabled = true;
      btn.textContent = '🤔 Thinking...';
      out.style.display = 'block';
      out.innerHTML = 'Querying Sage AI (' + model + ') from server...';

      try {
        const res = await fetch('/sage/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, model, apiKey })
        });
        const data = await res.json();
        if (data.ok) {
          let header = '🤖 <b>Answer</b> (' + data.model + ' · ' + data.elapsedMs + 'ms)\\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\n';
          out.innerHTML = header + escapeHtml(data.answer);
        } else {
          out.innerHTML = '❌ <span class="status-err">Error:</span> ' + escapeHtml(data.error || data.answer || 'Failed to get answer');
        }
      } catch (e) {
        out.innerHTML = '❌ <span class="status-err">Network error:</span> ' + e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '💡 Ask Sage AI';
      }
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.innerText = str || '';
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
}
