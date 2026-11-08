import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';

/** Low-level Telegram Bot API sender. Never throws — notifications are best-effort. */
export interface TelegramMessageOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
  disableWebPagePreview?: boolean;
  /** Telegram reply_markup (e.g. an inline keyboard with URL buttons). */
  replyMarkup?: unknown;
}

export async function sendTelegramMessage(text: string, options: TelegramMessageOptions = {}): Promise<boolean> {
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
        disable_web_page_preview: options.disableWebPagePreview ?? true,
        ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
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

export async function sendTelegramMessageWithId(text: string, options: TelegramMessageOptions = {}): Promise<number | null> {
  const { botToken, chatId, enabled } = config.telegram;
  if (!enabled) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: options.disableWebPagePreview ?? true,
        ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { message_id?: number } };
    return data?.result?.message_id ?? null;
  } catch {
    return null;
  }
}

export async function editTelegramMessage(messageId: number, text: string, options: TelegramMessageOptions = {}): Promise<boolean> {
  const { botToken, chatId, enabled } = config.telegram;
  if (!enabled) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: options.disableWebPagePreview ?? true,
        ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
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

/** Sends a text file as a Telegram document. Best-effort, never throws. */
export async function sendTelegramDocument(fileName: string, content: string, caption: string): Promise<boolean> {
  const { botToken, chatId, enabled } = config.telegram;
  if (!enabled) return false;
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption.slice(0, 1000));
    form.append('document', new Blob([content], { type: 'text/plain' }), fileName);
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'telegram document send failed');
      return false;
    }
    logger.info({ fileName }, 'telegram document sent');
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'telegram document send error');
    return false;
  }
}
