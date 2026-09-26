import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';

/** Low-level Telegram Bot API sender. Never throws — notifications are best-effort. */
export async function sendTelegramMessage(text: string): Promise<boolean> {
  const { botToken, chatId, enabled } = config.telegram;
  if (!enabled) {
    logger.debug('telegram not configured — skipping notification');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'telegram send failed');
      return false;
    }
    logger.info('telegram notification sent');
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'telegram send error');
    return false;
  }
}

/**
 * Sends a photo (e.g. a Cloudflare diagnostics screenshot). Important on
 * Render's free tier, where the filesystem is ephemeral and the on-disk
 * diagnostics bundle disappears at the next spin-down. Best-effort.
 */
export async function sendTelegramPhoto(photoPath: string, caption: string): Promise<boolean> {
  const { botToken, chatId, enabled } = config.telegram;
  if (!enabled) return false;
  try {
    if (!fs.existsSync(photoPath)) return false;
    const bytes = fs.readFileSync(photoPath);
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption.slice(0, 1000));
    form.append(
      'photo',
      new Blob([bytes], { type: 'image/png' }),
      path.basename(photoPath),
    );
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'telegram photo send failed');
      return false;
    }
    logger.info('telegram photo sent');
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'telegram photo send error');
    return false;
  }
}
