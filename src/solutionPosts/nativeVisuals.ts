import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { PostError } from './service';
import { readStoredVisualGif } from './visualStore';

const NATIVE_GIF = /^https:\/\/assets\.leetcode\.com\/users\/images\/[a-zA-Z0-9._-]+\.gif$/;
const DRAFT_GIF_PATH = /^\/solution-assets\/([a-f0-9]{64})\.gif$/;
const UPLOAD_TIMEOUT_MS = 20_000;

export interface StoredGif {
  digest: string;
  bytes: Buffer;
}

function draftVisualReferences(lines: string[]) {
  const references: Array<{ line: number; url: string; digest: string }> = [];
  let fence = '';
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const delimiter = marker[1]!;
      if (!fence) fence = delimiter;
      else if (delimiter.startsWith(fence) && !marker[2]!.trim()) fence = '';
      continue;
    }
    if (fence || !/\/solution-assets(?:\/|%2f)/i.test(line)) continue;
    // The renderer puts each generated image on its own Markdown line.
    const image = /^!\[(?:\\.|[^\]\\])*\]\((https:\/\/[^\s()<>]+)\)[ \t\r]*$/.exec(line);
    const url = image && URL.parse(image[1]!);
    const digest = url && !url.username && !url.password && !url.search && !url.hash && DRAFT_GIF_PATH.exec(url.pathname)?.[1];
    if (!digest) throw new PostError('ARTICLE_GIF_REFERENCE_INVALID');
    references.push({ line: index, url: image[1]!, digest });
  }
  if (references.length && (references.length !== 2 || references[0]?.digest === references[1]?.digest)) {
    throw new PostError('TWO_ARTICLE_GIFS_REQUIRED');
  }
  return references;
}

/** Replaces only generated image destinations. The approved prose and code remain byte-for-byte identical. */
export async function attachArticleVisuals(markdown: string, upload: (gif: StoredGif, index: number) => Promise<string>) {
  const lines = markdown.split('\n');
  const references = draftVisualReferences(lines);
  const files = await Promise.all(references.map(async ({ digest }) => {
    const bytes = await readStoredVisualGif(digest);
    if (!bytes) throw new PostError('ARTICLE_GIF_MISSING_OR_INVALID');
    return { digest, bytes };
  }));
  const used = new Set<string>();
  for (const [index, file] of files.entries()) {
    const reference = references[index]!;
    const url = await upload(file, index);
    if (used.has(url) || !await verifyUploadedGif(url, file)) throw new PostError('ARTICLE_GIF_UPLOAD_UNVERIFIED');
    used.add(url);
    const line = lines[reference.line]!;
    const start = line.lastIndexOf(`](${reference.url})`) + 2;
    lines[reference.line] = line.slice(0, start) + url + line.slice(start + reference.url.length);
  }
  return lines.join('\n');
}

export async function verifyUploadedGif(url: string, gif: StoredGif, fetcher = globalThis.fetch): Promise<boolean> {
  if (!NATIVE_GIF.test(url)) return false;
  try {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(12_000) });
    const length = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    if (response.status !== 200 || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'image/gif' ||
      (length !== null && (!encoding || encoding === 'identity') && Number(length) !== gif.bytes.length) || !response.body) {
      await response.body?.cancel();
      return false;
    }
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let size = 0;
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        size += chunk.value.byteLength;
        if (size > gif.bytes.length) { await reader.cancel(); return false; }
        hash.update(chunk.value);
      }
    } finally { reader.releaseLock(); }
    return size === gif.bytes.length && hash.digest('hex') === gif.digest;
  } catch { return false; }
}

type MonacoWindow = { monaco?: { editor: { getModels(): Array<{ getValue(): string }> } } };
type GifFile = { name: string; mimeType: string; buffer: Buffer };

export function readEditorMarkdown(page: Page) {
  return page.evaluate(() => {
    const models = (window as unknown as MonacoWindow).monaco?.editor.getModels() ?? [];
    return models.length === 1 ? models[0]!.getValue() : null;
  });
}

async function dropImageFile(page: Page, file: GifFile) {
  const transfer = await page.evaluateHandle(({ name, type, encoded }) => {
    const bytes = Uint8Array.from(atob(encoded), byte => byte.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], name, { type }));
    return data;
  }, { name: file.name, type: file.mimeType, encoded: file.buffer.toString('base64') });
  try {
    await page.getByRole('textbox', { name: 'Editor content', exact: true }).dispatchEvent('drop', { dataTransfer: transfer }, { timeout: 5000 });
  } finally { await transfer.dispose(); }
}

async function chooseImageFile(page: Page, file: GifFile) {
  const inputs = page.locator('input[type="file"][accept*="image" i], input[type="file"][accept*=".gif" i]');
  if (await inputs.count() === 1) return inputs.setInputFiles(file, { timeout: 5000 });
  const label = /^(?:(?:insert|add|upload) )?(?:an? )?images?$/i;
  const toolbar = page.getByRole('button', { name: label }).or(page.getByTitle(label)).filter({ visible: true });
  if (await toolbar.count() !== 1) return dropImageFile(page, file);

  const chooser = page.waitForEvent('filechooser', { timeout: 2500 }).catch(() => null);
  await toolbar.click({ timeout: 5000 });
  const direct = await chooser;
  if (direct) return direct.setFiles(file, { timeout: 5000 });
  if (await inputs.count() === 1) return inputs.setInputFiles(file, { timeout: 5000 });

  const upload = page.getByRole('button', { name: /^(?:upload(?: an?)?(?: image| file)?|choose file|browse)$/i }).filter({ visible: true });
  if (await upload.count() !== 1) throw new PostError('LEETCODE_IMAGE_UPLOAD_UNAVAILABLE');
  const [selected] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), upload.click({ timeout: 5000 })]);
  return selected.setFiles(file, { timeout: 5000 });
}

/** Uses LeetCode's own image toolbar or the image file input it exposes. */
export async function uploadArticleGif(page: Page, gif: StoredGif, index: number): Promise<string> {
  const file = { name: `visual-${index + 1}.gif`, mimeType: 'image/gif', buffer: gif.bytes };
  const previous = await readEditorMarkdown(page);
  if (previous === null) throw new PostError('EDITOR_SOURCE_UNAVAILABLE');
  try {
    await chooseImageFile(page, file);

    // The toolbar writes the upload result back to Monaco. Ignore any URLs that
    // were already there when this particular file was selected.
    const result = await page.waitForFunction(before => {
      const models = (window as unknown as MonacoWindow).monaco?.editor.getModels() ?? [];
      if (models.length !== 1) return false;
      const urls = models[0]!.getValue().match(/https:\/\/assets\.leetcode\.com\/users\/images\/[a-zA-Z0-9._-]+\.gif/g) ?? [];
      return urls.find(url => !before.includes(url)) ?? false;
    }, previous, { timeout: UPLOAD_TIMEOUT_MS });
    try { return await result.jsonValue() as string; }
    finally { await result.dispose(); }
  } catch (error) {
    if (error instanceof PostError) throw error;
    throw new PostError('LEETCODE_IMAGE_UPLOAD_FAILED');
  }
}
