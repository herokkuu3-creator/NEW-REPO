import { createPostRouter } from '../solutionPosts/service';
import { RoutingError } from '../solutionPosts/router';
import { logger } from '../logger';

/** Do not forward recognizable credentials or session data to an AI provider. */
export function isSensitiveChatText(text: string): boolean {
  return /(?:\b(?:fc-|sk-|cc_|xpl_|gsk_)[A-Za-z0-9_-]{12,}|\b(?:LEETCODE_SESSION|csrftoken|password|authorization|api[_ -]?key)\s*[:=]\s*\S+)/i.test(text);
}

export async function answerChat(text: string): Promise<string> {
  if (!text.trim()) return 'Send /ask followed by your question.';
  if (text.length > 4000) return 'Please keep your question under 4,000 characters.';
  if (isSensitiveChatText(text)) return 'Please remove credentials or session data before asking the AI.';
  try {
    // General Telegram chat is independent of the requested solution provider.
    const router = await createPostRouter({}, 'bazaarlink');
    const result = await router.generate([
      { role: 'system', content: 'You are a helpful assistant responding in a Telegram chat. Answer the user directly and clearly. Do not claim to have taken actions or browsed unless you have.' },
      { role: 'user', content: text },
    ], output => output.trim(), 900, false, 'telegram-chat');
    logger.info({ model: result.model }, 'telegram AI chat completed');
    return result.value;
  } catch (error) {
    const code = error instanceof RoutingError ? error.lastFailure ?? 'AI_MODELS_EXHAUSTED' :
      typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'AI_CHAT_FAILED';
    logger.warn({ code }, 'telegram AI chat failed');
    return `AI reply failed (${code}). Check /testsolkey and try again.`;
  }
}
