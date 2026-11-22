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

const TELEGRAM_MAX_TEXT_LEN = 4096;
const TELEGRAM_HTML_TAGS = new Set(['b', 'strong', 'i', 'em', 'code', 'pre', 'a', 'span', 'blockquote', 'u', 's']);

function stripTelegramHtml(html: string): string {
  const withoutTags = html.replace(/<\/?(?:b|strong|i|em|code|pre|a|span|blockquote|u|s)(?:\s[^>]*)?>/gi, '');
  return withoutTags.replace(/&(lt|gt|quot|#39|amp);/gi, (full, entity: string) => {
    switch (entity.toLowerCase()) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case '#39': return "'";
      case 'amp': return '&';
      default: return full;
    }
  });
}

function trackOpenHtmlTags(html: string): Array<{ name: string; openTag: string }> {
  const openTags: Array<{ name: string; openTag: string }> = [];
  const tagRe = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*)?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const raw = match[0];
    const isClosing = raw.startsWith('</');
    const tagName = match[1]!.toLowerCase();
    if (!TELEGRAM_HTML_TAGS.has(tagName)) continue;
    if (isClosing) {
      for (let i = openTags.length - 1; i >= 0; i -= 1) {
        if (openTags[i]!.name === tagName) {
          openTags.splice(i, 1);
          break;
        }
      }
    } else {
      openTags.push({ name: tagName, openTag: raw });
    }
  }
  return openTags;
}

function trimIncompleteHtmlBoundary(html: string): string {
  let out = html;
  const lastLt = out.lastIndexOf('<');
  const lastGt = out.lastIndexOf('>');
  if (lastLt > lastGt) {
    out = out.slice(0, lastLt);
  }
  return out.replace(/&[a-zA-Z0-9#]*$/, '');
}

export function truncateTelegramText(
  text: string,
  maxLen = TELEGRAM_MAX_TEXT_LEN,
  parseMode?: 'HTML' | 'MarkdownV2',
): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 0) return '';
  if (parseMode === 'HTML') {
    const ellipsis = maxLen >= 20 ? '\n…' : '…';
    let sliceLen = Math.max(0, maxLen - ellipsis.length - 16);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const body = trimIncompleteHtmlBoundary(text.slice(0, sliceLen));
      const openTags = trackOpenHtmlTags(body);
      const closers = openTags.slice().reverse().map((t) => `</${t.name}>`).join('');
      const candidate = `${body}${closers}${ellipsis}`;
      if (candidate.length <= maxLen) return candidate;
      const over = candidate.length - maxLen;
      sliceLen = Math.max(0, sliceLen - over);
    }
    return text.slice(0, maxLen);
  }
  let body = text.slice(0, Math.max(0, maxLen - 1));
  if (parseMode === 'MarkdownV2') {
    const trailingSlashes = body.match(/\\+$/)?.[0].length ?? 0;
    if (trailingSlashes % 2 === 1) {
      body = body.slice(0, -1);
    }
  }
  return `${body}…`;
}

export function splitTelegramMessage(
  text: string,
  maxLen = TELEGRAM_MAX_TEXT_LEN,
  parseMode?: 'HTML' | 'MarkdownV2',
): string[] {
  if (text.length <= maxLen) return [text];
  const targetLen = parseMode === 'HTML' ? Math.max(128, maxLen - 128) : maxLen;
  const rawChunks: string[] = [];
  let current = '';

  const pushLongSegment = (segment: string): void => {
    let remaining = segment;
    while (remaining.length > targetLen) {
      let cut = targetLen;
      if (parseMode === 'HTML') {
        const trimmed = trimIncompleteHtmlBoundary(remaining.slice(0, cut));
        if (trimmed.length > 0) cut = trimmed.length;
      }
      rawChunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    current = remaining;
  };

  for (const line of text.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= targetLen) {
      current = next;
    } else {
      if (current) {
        rawChunks.push(current);
        current = '';
      }
      if (line.length <= targetLen) {
        current = line;
      } else {
        pushLongSegment(line);
      }
    }
  }
  if (current) rawChunks.push(current);

  if (parseMode !== 'HTML') {
    return rawChunks.map((chunk) => truncateTelegramText(chunk, maxLen, parseMode));
  }

  const balanced: string[] = [];
  let carried: Array<{ name: string; openTag: string }> = [];
  for (const raw of rawChunks) {
    const prefix = carried.map((t) => t.openTag).join('');
    const withPrefix = `${prefix}${raw}`;
    const openAfter = trackOpenHtmlTags(withPrefix);
    const closers = openAfter.slice().reverse().map((t) => `</${t.name}>`).join('');
    balanced.push(truncateTelegramText(`${withPrefix}${closers}`, maxLen, 'HTML'));
    carried = openAfter;
  }
  return balanced;
}

async function readTelegramErrorDescription(res: Response): Promise<string> {
  try {
    if (typeof res.json === 'function') {
      const data = (await res.json()) as { description?: unknown };
      if (data && typeof data.description === 'string') return data.description;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof res.text === 'function') {
      return await res.text();
    }
  } catch {
    // ignore
  }
  return '';
}

async function callTelegramWithEntityFallback(
  method: 'sendMessage' | 'editMessageText',
  payload: Record<string, unknown>,
  rawText: string,
  options: TelegramMessageOptions,
  timeoutMs = 15_000,
): Promise<{ ok: true; res?: Response; notModified?: boolean } | { ok: false; status: number; description: string }> {
  const { botToken } = config.telegram;
  const post = (body: Record<string, unknown>) =>
    fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const res = await post({
    ...payload,
    text: rawText,
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
  });
  if (res.ok) return { ok: true, res };

  const desc = await readTelegramErrorDescription(res);
  if (method === 'editMessageText' && /message is not modified/i.test(desc)) {
    return { ok: true, notModified: true };
  }

  if (options.parseMode && /can't parse entities/i.test(desc)) {
    const plainText = truncateTelegramText(
      options.parseMode === 'HTML' ? stripTelegramHtml(rawText) : rawText,
      TELEGRAM_MAX_TEXT_LEN,
    );
    const retryRes = await post({
      ...payload,
      text: plainText,
    });
    if (retryRes.ok) return { ok: true, res: retryRes };
    const retryDesc = await readTelegramErrorDescription(retryRes);
    if (method === 'editMessageText' && /message is not modified/i.test(retryDesc)) {
      return { ok: true, notModified: true };
    }
    return { ok: false, status: retryRes.status, description: retryDesc };
  }

  return { ok: false, status: res.status, description: desc };
}

export async function sendTelegramMessage(text: string, options: TelegramMessageOptions = {}): Promise<boolean> {
  const { chatId, enabled } = config.telegram;
  if (!enabled) {
    logger.debug('telegram not configured — skipping notification');
    return false;
  }
  try {
    const chunks = options.replyMarkup
      ? [truncateTelegramText(text, TELEGRAM_MAX_TEXT_LEN, options.parseMode)]
      : splitTelegramMessage(text, TELEGRAM_MAX_TEXT_LEN, options.parseMode);

    let allOk = true;
    for (const chunk of chunks) {
      const outcome = await callTelegramWithEntityFallback(
        'sendMessage',
        {
          chat_id: chatId,
          disable_web_page_preview: options.disableWebPagePreview ?? true,
          ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        },
        chunk,
        options,
      );
      if (!outcome.ok) {
        logger.warn({ status: outcome.status, description: outcome.description }, 'telegram send failed');
        allOk = false;
      }
    }
    if (allOk) logger.info('telegram notification sent');
    return allOk;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'telegram send error');
    return false;
  }
}

export async function sendTelegramMessageWithId(text: string, options: TelegramMessageOptions = {}): Promise<number | null> {
  const { chatId, enabled } = config.telegram;
  if (!enabled) return null;
  try {
    const bounded = truncateTelegramText(text, TELEGRAM_MAX_TEXT_LEN, options.parseMode);
    const outcome = await callTelegramWithEntityFallback(
      'sendMessage',
      {
        chat_id: chatId,
        disable_web_page_preview: options.disableWebPagePreview ?? true,
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      },
      bounded,
      options,
    );
    if (!outcome.ok || !outcome.res) return null;
    const data = (await outcome.res.json()) as { result?: { message_id?: number } };
    return data?.result?.message_id ?? null;
  } catch {
    return null;
  }
}

export async function editTelegramMessage(messageId: number, text: string, options: TelegramMessageOptions = {}): Promise<boolean> {
  const { chatId, enabled } = config.telegram;
  if (!enabled) return false;
  try {
    const bounded = truncateTelegramText(text, TELEGRAM_MAX_TEXT_LEN, options.parseMode);
    const outcome = await callTelegramWithEntityFallback(
      'editMessageText',
      {
        chat_id: chatId,
        message_id: messageId,
        disable_web_page_preview: options.disableWebPagePreview ?? true,
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      },
      bounded,
      options,
    );
    return outcome.ok;
  } catch {
    return false;
  }
}

export async function deleteTelegramMessage(messageId: number): Promise<boolean> {
  const { botToken, chatId, enabled } = config.telegram;
  if (!enabled) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return true;
    const desc = await readTelegramErrorDescription(res);
    if (/message to delete not found|message can't be deleted/i.test(desc)) {
      return true;
    }
    logger.warn({ status: res.status, description: desc, messageId }, 'telegram deleteMessage failed');
    return false;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), messageId }, 'telegram deleteMessage error');
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
