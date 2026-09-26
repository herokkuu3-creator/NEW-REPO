import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    environment: 'node',
    env: {
      // config validation runs at import time; tests never touch these services
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      SETUP_TOKEN: 'test-token-for-vitest',
      // Default provider under test — no network calls are made by any test.
      LLM_PROVIDER: 'gemini',
      LLM_API_KEY: 'test-gemini-key',
      LLM_MODEL: 'gemini-3.5-flash',
    },
  },
});
