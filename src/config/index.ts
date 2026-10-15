import { z } from 'zod';

/**
 * Central configuration. Every environment variable is parsed and validated
 * here exactly once — the rest of the codebase consumes a typed Config object
 * and never touches process.env directly.
 */

const boolFromString = z
  .string()
  .optional()
  .transform((v) => (v ?? '').toLowerCase() === 'true');

const enabledByDefault = z
  .string()
  .optional()
  .transform((v) => v === undefined ? true : v.toLowerCase() === 'true');

const intFromString = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10);
      return Number.isFinite(n) ? n : fallback;
    });

const optionalNumber = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  BROWSER_PROFILE_PATH: z.string().default('./local-auth/browser-profile'),
  STORAGE_STATE_PATH: z.string().default('./local-auth/storage-state.json'),
  HEADLESS: boolFromString,
  DIAGNOSTICS_DIR: z.string().default('./diagnostics'),
  CHROMIUM_SINGLE_PROCESS: boolFromString,

  DAILY_RUN_HOUR: intFromString(9).pipe(z.number().int().min(0).max(23)),
  DAILY_RUN_MINUTE: intFromString(0).pipe(z.number().int().min(0).max(59)),
  TIMEZONE: z.string().default('Asia/Kolkata'),
  RUN_ON_BOOT: boolFromString,

  LLM_PROVIDER: z.string().default('gemini'),
  // LLM_API_KEY is the generic name; GEMINI_API_KEY is accepted as a
  // fallback so a Google AI Studio key can be pasted under either name.
  LLM_API_KEY: z.string().default(''),
  GEMINI_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('gemini-3.5-flash'),
  LLM_BASE_URL: z.string().default(''),
  LLM_TIMEOUT_MS: intFromString(120_000),
  LLM_MAX_TOKENS: intFromString(8192),
  LLM_REASONING_EFFORT: z
    .enum(['minimal', 'low', 'medium', 'high', 'none'])
    .optional(),
  LLM_TEMPERATURE: optionalNumber,
  MAX_SOLUTION_RETRIES: intFromString(3).pipe(z.number().int().min(0).max(10)),
  LEETCODE_LANGUAGE: z
    .enum(['cpp', 'javascript', 'typescript', 'python3'])
    .default('cpp'),

  // --- Solution source -----------------------------------------------------
  // 'community' (default): fetch diversified C++ solutions from LeetCode community
  //   solutions tab with random index per account; falls back to walkccc.
  // 'walkccc': fetch from walkccc.me; falls back to community.
  // 'llm': generate with an LLM (LLM_PROVIDER etc.).
  SOLUTION_SOURCE: z.enum(['community', 'walkccc', 'llm']).default('community'),
  WALKCCC_BASE_URL: z.string().default('https://walkccc.me/LeetCode'),

  // SOLUTION_POST_API_KEYS is a comma-separated failover pool. The singular
  // name remains a backwards-compatible one-key bootstrap option.
  SOLUTION_POST_API_KEY: z.string().default(''),
  SOLUTION_POST_API_KEYS: z.string().default(''),
  SOLUTION_POST_BASE_URL: z.string().url().default('https://codecraftapi.com/v1'),
  SOLUTION_POST_MODELS: z.string().default('gpt-5.6-terra,gpt-5.6-luna,gemini-3.7-flash'),
  SOLUTION_POST_TIMEOUT_MS: intFromString(90000).pipe(z.number().min(1000).max(300000)),
  SOLUTION_POST_RETRIES: intFromString(1).pipe(z.number().min(0).max(3)),
  SOLUTION_POST_MAX_TOKENS: intFromString(8192).pipe(z.number().min(2048).max(32768)),
  // Scheduled articles are published once the generated content and the accepted
  // submission have both passed the existing source, identity, and post checks.
  // Set false only when drafts should remain queued for a manual review.
  SOLUTION_POST_AUTO_PUBLISH: enabledByDefault,
  SOLUTION_POST_MODEL_TIMEOUTS: z.string().default('{}').transform((value, ctx) => {
    try { return z.record(z.number().int().min(1000).max(300000)).parse(JSON.parse(value)); }
    catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected JSON object of model IDs and timeout milliseconds' }); return z.NEVER; }
  }),

  // --- Transport -----------------------------------------------------------
  // 'api' (default): drive LeetCode's own GraphQL/submit endpoints through the
  //   browser context's request API. Never loads an HTML page, which is what
  //   invites Cloudflare's interstitial on datacenter IPs.
  // 'browser': navigate the UI with Playwright (fills the editor; requires the
  //   HTML pages to load unchallenged).
  TRANSPORT: z.enum(['api', 'browser']).default('api'),


  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  // Command bot (long polling): /renew refreshes the session from cookies you
  // paste, /status reports state. On by default whenever Telegram is configured.
  TELEGRAM_COMMANDS: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v.toLowerCase() === 'true')),

  PORT: intFromString(3001),
  SETUP_TOKEN: z.string().min(8, 'SETUP_TOKEN must be at least 8 characters'),
  // Public base URL of the service, used to build the /renew sign-in link in
  // Telegram alerts. Render sets RENDER_EXTERNAL_URL automatically, so on
  // Render nothing needs configuring; set PUBLIC_URL only for a custom domain.
  PUBLIC_URL: z.string().default(''),
  RENDER_EXTERNAL_URL: z.string().default(''),

  // Turnstile / Cloudflare challenge solver microservice (CPSolver)
  CPSOLVER_URL: z.string().default(''),
  TURNSTILE_SOLVER_URL: z.string().default(''),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type Config = Readonly<{
  databaseUrl: string;
  browser: {
    profilePath: string;
    storageStatePath: string;
    headless: boolean;
    diagnosticsDir: string;
    chromiumSingleProcess: boolean;
  };
  schedule: {
    hour: number;
    minute: number;
    timezone: string;
    runOnBoot: boolean;
  };
  llm: {
    provider: string;
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
    maxTokens: number;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'none';
    temperature?: number;
    maxSolutionRetries: number;
    language: 'cpp' | 'javascript' | 'typescript' | 'python3';
  };
  solution: {
    source: 'community' | 'walkccc' | 'llm';
    walkcccBaseUrl: string;
  };
  transport: 'api' | 'browser';
  solutionPosts: {
    apiKey: string; apiKeys: string[]; baseUrl: string; models: string[]; timeoutMs: number; retries: number; maxTokens: number;
    autoPublish: boolean; modelTimeoutMs: Record<string, number>;
  };
  telegram: { botToken: string; chatId: string; enabled: boolean; commands: boolean };
  api: { port: number; setupToken: string; publicUrl: string };
  solver: { cpsolverUrl: string };
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
}>;

function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // No logger here yet — config loads before pino is constructed.
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  const env = parsed.data;

  const headlessDefault = process.env.HEADLESS;
  return Object.freeze({
    databaseUrl: env.DATABASE_URL,
    browser: {
      profilePath: env.BROWSER_PROFILE_PATH,
      storageStatePath: env.STORAGE_STATE_PATH,
      headless: headlessDefault === undefined ? true : env.HEADLESS,
      diagnosticsDir: env.DIAGNOSTICS_DIR,
      chromiumSingleProcess: env.CHROMIUM_SINGLE_PROCESS,
    },
    schedule: {
      hour: env.DAILY_RUN_HOUR,
      minute: env.DAILY_RUN_MINUTE,
      timezone: env.TIMEZONE,
      runOnBoot: env.RUN_ON_BOOT,
    },
    llm: {
      provider: env.LLM_PROVIDER,
      apiKey: env.LLM_API_KEY || env.GEMINI_API_KEY,
      model: env.LLM_MODEL,
      baseUrl: env.LLM_BASE_URL,
      timeoutMs: env.LLM_TIMEOUT_MS,
      maxTokens: env.LLM_MAX_TOKENS,
      reasoningEffort: env.LLM_REASONING_EFFORT,
      temperature: env.LLM_TEMPERATURE,
      maxSolutionRetries: env.MAX_SOLUTION_RETRIES,
      language: env.LEETCODE_LANGUAGE,
    },
    solution: {
      source: env.SOLUTION_SOURCE,
      walkcccBaseUrl: env.WALKCCC_BASE_URL,
    },
    transport: env.TRANSPORT,
    solutionPosts: {
      apiKey: env.SOLUTION_POST_API_KEY,
      apiKeys: [...new Set((env.SOLUTION_POST_API_KEYS || env.SOLUTION_POST_API_KEY).split(',')
        .map(s => s.trim()).filter(Boolean))],
      baseUrl: env.SOLUTION_POST_BASE_URL,
      models: validateSolutionPostModels(env.SOLUTION_POST_MODELS),
      timeoutMs: env.SOLUTION_POST_TIMEOUT_MS,
      retries: env.SOLUTION_POST_RETRIES,
      maxTokens: env.SOLUTION_POST_MAX_TOKENS,
      autoPublish: env.SOLUTION_POST_AUTO_PUBLISH,
      modelTimeoutMs: env.SOLUTION_POST_MODEL_TIMEOUTS,
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      enabled: env.TELEGRAM_BOT_TOKEN.length > 0 && env.TELEGRAM_CHAT_ID.length > 0,
      commands: env.TELEGRAM_COMMANDS,
    },
    api: {
      port: env.PORT,
      setupToken: env.SETUP_TOKEN,
      publicUrl:
        env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT}`,
    },
    solver: {
      cpsolverUrl: (env.CPSOLVER_URL || env.TURNSTILE_SOLVER_URL || '').trim().replace(/\/+$/, ''),
    },
    logLevel: env.LOG_LEVEL,
  });
}

/** Keep article generation on the user-approved economical model families. */
function validateSolutionPostModels(raw: string): string[] {
  const models = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
  const allowed = /^(?:gpt-5\.6-(?:terra|luna)|gemini-3\.(?:7|8)-flash|qwen[\w.-]*)$/i;
  if (models.some(model => !allowed.test(model))) {
    throw new Error('SOLUTION_POST_MODELS only supports gpt-5.6-terra, gpt-5.6-luna, gemini-3.7/3.8-flash, or Qwen models');
  }
  return models;
}

export const config = loadConfig();
