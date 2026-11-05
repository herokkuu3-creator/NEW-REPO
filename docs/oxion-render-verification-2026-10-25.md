# Oxion API verification from Render — 25 October 2026

## Result

All 33 provider-advertised models were tested from the live Render container. Discovery succeeded; every inference request returned HTTP 503 with `error.code: service_upgrading` and `error.type: maintenance`. No model produced text. Successful article generation, structured output, available inference allowance, and actual upstream model identity are therefore unverified.

The provider's response said its service was being upgraded and to retry shortly. This is the provider's statement, not a verified recovery ETA. These requests received JSON maintenance responses, not the earlier CodeCraft HTML/Cloudflare access challenge. No inference token usage or cost was returned. A final retry of Terra, Luna, and Gemini Flash around 3.5 minutes later returned the same 503 responses: 36 actual-key completion requests, zero successes.

## Server evidence and method

- Bot: `https://leetcode-daily-agent-avh0.onrender.com`.
- All results reported `executionHost: render` and revision `1b3d63c1ae5f415522842d1a6f0d5e84495d3dd0`.
- Discovery: 08:46:17 IST / 03:16:17 UTC; HTTP 200; 33 IDs; 98 ms upstream elapsed time.
- Inference: 08:46:26–08:46:41 IST / 03:16:26–03:16:41 UTC, using the server's response timestamps.
- Every completion request used the same fixed prompt, `Reply with exactly OXION_RENDER_OK.`, and `max_tokens: 128`. At most four requests were in flight.
- Requests were made by the authenticated `POST /admin/solutions/oxion/test` endpoint. It uses only the fixed `https://oxionai.com/v1` origin, disallows redirects, bounds output and timeout, and returns sanitized results.
- The API key was supplied per request, not committed, logged, appended to the stored pool, or selected for scheduled production generation.
- A separate local discovery call also returned 33 IDs; the inference evidence below is exclusively from Render.

## Every tested model

These are Oxion's advertised IDs. The error occurred before any generated answer, so the names are not independent verification of the upstream models.

| Advertised model ID | HTTP | Error code | Upstream elapsed ms |
|---|---:|---|---:|
| `claude-fable-5` | 503 | `service_upgrading` | 198 |
| `claude-fable-5.1` | 503 | `service_upgrading` | 24 |
| `claude-mythos-preview` | 503 | `service_upgrading` | 31 |
| `claude-opus-4.6` | 503 | `service_upgrading` | 285 |
| `claude-opus-4.7` | 503 | `service_upgrading` | 279 |
| `claude-opus-4.8` | 503 | `service_upgrading` | 35 |
| `claude-opus-5` | 503 | `service_upgrading` | 23 |
| `claude-opus-5.5` | 503 | `service_upgrading` | 23 |
| `claude-sonnet-5` | 503 | `service_upgrading` | 30 |
| `deepseek-v4-flash-0731` | 503 | `service_upgrading` | 175 |
| `deepseek-v4-pro-0813` | 503 | `service_upgrading` | 55 |
| `deepseek-v4-pro-max` | 503 | `service_upgrading` | 22 |
| `gemini-3.1-pro` | 503 | `service_upgrading` | 21 |
| `gemini-3.6-flash` | 503 | `service_upgrading` | 205 |
| `gemini-3.7-flash` | 503 | `service_upgrading` | 98 |
| `gemma-2-2b` | 503 | `service_upgrading` | 285 |
| `glm-5.2` | 503 | `service_upgrading` | 23 |
| `glm-5.3` | 503 | `service_upgrading` | 186 |
| `gpt-5.5` | 503 | `service_upgrading` | 35 |
| `gpt-5.5-pro` | 503 | `service_upgrading` | 203 |
| `gpt-5.6-luna` | 503 | `service_upgrading` | 176 |
| `gpt-5.6-sol` | 503 | `service_upgrading` | 21 |
| `gpt-5.6-terra` | 503 | `service_upgrading` | 159 |
| `grok-4.5` | 503 | `service_upgrading` | 32 |
| `grok-4.6` | 503 | `service_upgrading` | 154 |
| `kimi-k2.6` | 503 | `service_upgrading` | 152 |
| `kimi-k3` | 503 | `service_upgrading` | 40 |
| `muse-spark-1.1` | 503 | `service_upgrading` | 23 |
| `qwen3.7-max` | 503 | `service_upgrading` | 22 |
| `qwen3.8-27b` | 503 | `service_upgrading` | 146 |
| `qwen3.8-max` | 503 | `service_upgrading` | 26 |
| `seed-2.1-pro` | 503 | `service_upgrading` | 23 |
| `seed-2.1-turbo` | 503 | `service_upgrading` | 26 |

## Integration assessment

### Follow-up and negative controls

At 08:50:00 IST / 03:20:00 UTC, a deliberately invalid synthetic credential was rejected by both discovery and completion with HTTP 401, `invalid_api_key`. The supplied credential instead received HTTP 200 for discovery and HTTP 503 maintenance for completion. This supports that Oxion recognizes the supplied credential; it does not establish remaining inference allowance.

At 08:50:07 IST / 03:20:07 UTC, the final actual-key completion retries still failed:

| Model | HTTP | Error code | Upstream elapsed ms |
|---|---:|---|---:|
| `gpt-5.6-terra` | 503 | `service_upgrading` | 199 |
| `gpt-5.6-luna` | 503 | `service_upgrading` | 161 |
| `gemini-3.7-flash` | 503 | `service_upgrading` | 188 |

The deployed diagnostic itself rejected an unauthenticated caller with HTTP 401 and a caller-supplied alternate origin with HTTP 400. Every provider result above was produced by the same positively identified Render revision.

### Activation requirements

Oxion documents an OpenAI-compatible chat interface, which matches this bot's client protocol. Render can reach the provider and list models. That establishes basic connectivity and discovery only; the provider's current inference outage prevents a working-integration claim.

Before activating it, obtain a successful completion and structured-output sample, then exercise the actual article/GIF generation path. Keep production on the user's approved economical families, such as `gpt-5.6-luna`, `gpt-5.6-terra`, and `gemini-3.7-flash`.

An eventual switch would use `SOLUTION_POST_BASE_URL=https://oxionai.com/v1` and the Oxion credential. The existing persistent key pool is not scoped to a provider: changing the base URL alone could send saved CodeCraft keys to Oxion. Bind/isolate the pool to the provider, or explicitly replace it with only the intended Oxion credentials, before activating the switch. Do not append an Oxion key while CodeCraft remains the configured base URL.

Oxion's published Free plan advertises 0.5M combined input/output tokens per month without a card. Exhausted included allowance falls back to a prepaid balance, or HTTP 402 when that is empty. This is the provider's published policy; this test did not establish the supplied account's remaining usable allowance.

Primary provider pages: [models](https://www.oxionai.com/models), [pricing](https://www.oxionai.com/pricing).

## Diagnostic implementation validation

The endpoint change was committed as `1b3d63c`, pushed to both configured main remotes, and positively verified live on Render before testing. Nine focused tests passed (probe behavior, secret redaction, fixed origin/no redirects, structured output validation, route authentication and request limits). The TypeScript build and whitespace check passed. Existing unrelated workspace edits were excluded from the commit.
