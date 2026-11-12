import { z } from 'zod';
import { diagramLayouts, visualThemes, visualMotions, accountDiagramLayouts, animatedScenes, sceneDirections } from './visualStyles';
import { animatedSceneDimensions, renderAnimatedScene } from './animatedScenes';
import { renderAccountVisualFrame, visualDimensions } from './visualRenderer';

export const sectionKinds = ['intuition', 'approach', 'correctness', 'dryRun', 'takeaways'] as const;
export { visualThemes } from './visualStyles';
// Animation headings are display labels; their complete explanation stays in
// the caption. Shorten benign overflows without changing any traced values.
export const visualTitleSchema = z.string().trim().min(3).max(160).transform(title => {
  // Native SVG fonts do not include color emoji; keep diagram headings legible.
  title = title.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\uFE0E\u200D]/gu, '').trim();
  if (title.length <= 48) return title;
  let prefix = '';
  for (const character of title) {
    if (prefix.length + character.length > 47) break;
    prefix += character;
  }
  const boundary = prefix.lastIndexOf(' ');
  if (boundary >= 24) prefix = prefix.slice(0, boundary);
  return prefix.trimEnd() + '…';
}).pipe(z.string().min(3).max(48));
export const visualFrameSchema = z.object({
  label: z.string().min(2).max(48), items: z.array(z.string().max(24)).min(1).max(8),
  active: z.preprocess(value => typeof value === 'number' ? [value] : value,
    z.array(z.number().int().min(0).max(7)).max(8)),
  state: z.string().min(1).max(64), metric: z.string().min(1).max(40), note: z.string().max(76),
}).strict();
export const visualPlanSchema = z.object({
  id: z.string().regex(/^visual-[12]$/), after: z.enum(sectionKinds),
  title: visualTitleSchema, caption: z.string().min(5).max(160),
  theme: z.enum(visualThemes).default('aurora'),
  layout: z.enum(diagramLayouts).optional(),
  motion: z.enum(visualMotions).optional(),
  scene: z.enum(animatedScenes).optional(),
  direction: z.enum(sceneDirections).optional(),
  terrain: z.literal('steps').optional(),
  pace: z.enum(['quick', 'measured', 'hold-final']).optional(),
  frames: z.array(visualFrameSchema).min(2).max(8),
}).superRefine((plan, ctx) => {
  for (const [i, frame] of plan.frames.entries()) if (frame.active.some(n => n >= frame.items.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['frames', i, 'active'], message: 'Active index is outside the diagram' });
  }
  // A multi-frame GIF must teach a changing state, rather than looping the same
  // screenshot. State and metric are rendered on the card, so they count as a
  // visible change along with the highlighted values.
  const snapshots = new Set(plan.frames.map(frame => JSON.stringify({
    items: frame.items, active: frame.active, state: frame.state, metric: frame.metric,
  })));
  if (snapshots.size < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['frames'], message: 'Animation frames must show a state change' });
  }
});
export type VisualPlan = z.infer<typeof visualPlanSchema>;
export interface VisualAsset { id: string; url: string; alt: string }
export type VisualResolver = (plans: VisualPlan[]) => Promise<VisualAsset[]>;
export const plainMarkdown = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]()#!|]/g, '\\$&').replace(/[\r\n]/g, ' ');

const xml = (s: string) => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const text = (x: number, y: number, value: string, size: number, color: string, weight = 400, anchor = 'start') =>
  `<text x="${x}" y="${y}" font-family="DejaVu Sans,Arial,sans-serif" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${xml(value)}</text>`;

const palettes = {
  aurora: { start: '#0d1f32', end: '#172447', panel: '#182c43', idle: '#2a405c', active: '#71f2c5', ink: '#092422', accent: '#ffd479', muted: '#b9cce1', flare: '#50d9ff' },
  sunset: { start: '#35162d', end: '#572342', panel: '#4a203c', idle: '#653055', active: '#ffbd6e', ink: '#40200b', accent: '#98f0da', muted: '#f2c6d7', flare: '#ff7cae' },
  ocean: { start: '#092636', end: '#124d64', panel: '#10465c', idle: '#1f627a', active: '#8de8ff', ink: '#07313e', accent: '#ffe38a', muted: '#c4e8ee', flare: '#50d6d0' },
  violet: { start: '#21163f', end: '#3d285f', panel: '#352553', idle: '#4d396e', active: '#d3a8ff', ink: '#2a1640', accent: '#a6f7c8', muted: '#dcccf1', flare: '#a580ff' },
} as const;

/** Original code-drawn diagrams: no fetched media, AI-generated URLs, or executable SVG markup. */
export function renderVisualFrame(plan: VisualPlan, frameIndex: number, phase = 1): string {
  if (plan.scene) return renderAnimatedScene({ ...plan, scene: plan.scene }, frameIndex, phase);
  if ((accountDiagramLayouts as readonly string[]).includes(plan.layout ?? '')) return renderAccountVisualFrame(plan, frameIndex, phase);
  const frame = plan.frames[frameIndex]!;
  const colors = palettes[plan.theme as keyof typeof palettes] ?? palettes.aurora;
  const width = 720; const height = 360;
  const gap = 12; const box = Math.min(144, (width - 72 - gap * (frame.items.length - 1)) / frame.items.length);
  const left = (width - (box * frame.items.length + gap * (frame.items.length - 1))) / 2;
  const blocks = frame.items.map((item, i) => {
    const x = left + i * (box + gap); const active = frame.active.includes(i);
    // Preserve complete coordinates/labels instead of forcing every item into
    // an eight-character schema or shrinking a whole line to unreadable text.
    const chars = Array.from(item);
    const lineLength = Math.max(4, Math.floor((box - 16) / 10));
    const lines: string[] = [];
    for (let offset = 0; offset < chars.length; offset += lineLength) lines.push(chars.slice(offset, offset + lineLength).join(''));
    if (!lines.length) lines.push('');
    const font = Math.min(28, (box - 12) / (Math.max(...lines.map(line => Array.from(line).length), 1) * .62),
      50 / (lines.length * 1.15));
    const lineHeight = font * 1.15;
    const label = lines.map((line, index) => text(x + box / 2,
      155 + (index - (lines.length - 1) / 2) * lineHeight + font * .35,
      line, font, active ? colors.ink : colors.muted, 700, 'middle')).join('');
    return `<rect x="${x}" y="122" width="${box}" height="66" rx="14" fill="${active ? colors.active : colors.idle}" stroke="${active ? colors.accent : 'none'}" stroke-width="${active ? 2 : 0}"/>` +
      label +
      (active ? `<path d="M ${x + box / 2} 204 l -7 9 h 14 Z" fill="${colors.active}"/>` : '');
  }).join('');
  const progress = (frameIndex + phase) / plan.frames.length * 664;
  if (plan.layout === 'ledger' || plan.layout === 'focus') {
    return renderAlternateFrame(plan, frameIndex, phase, progress);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 720 360">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors.start}"/><stop offset="1" stop-color="${colors.end}"/></linearGradient></defs>
    <rect width="720" height="360" rx="22" fill="url(#bg)"/>
    <circle cx="670" cy="42" r="78" fill="${colors.flare}" opacity=".14"/><circle cx="638" cy="18" r="34" fill="${colors.accent}" opacity=".09"/>
    <rect x="28" y="22" width="${Math.max(128, Math.min(202, plan.title.length * 6.8))}" height="24" rx="12" fill="${colors.flare}" opacity=".2"/>
    ${text(40, 39, 'TRACE · WATCH IT CHANGE', 11, colors.accent, 700)}
    ${text(30, 78, plan.title, 25, '#f7fbff', 700)}
    ${text(30, 105, frame.label, 16, colors.muted)}${blocks}
    ${plan.layout ? `<circle cx="${40 + progress}" cy="211" r="${4 + phase * 3}" fill="${colors.accent}" opacity="${.4 + phase * .6}"/>` : ''}
    <rect x="28" y="224" width="664" height="80" rx="13" fill="${colors.panel}" stroke="${colors.flare}" stroke-opacity=".28"/>
    ${text(44, 251, frame.state, 16, '#f3f8ff', 600)}
    ${text(674, 281, frame.metric, 21, colors.accent, 700, 'end')}
    <rect x="28" y="318" width="664" height="5" rx="2.5" fill="#ffffff" opacity=".14"/><rect x="28" y="318" width="${progress}" height="5" rx="2.5" fill="${colors.active}"/>
    ${text(30, 347, frame.note, 15, colors.muted)}
    ${text(686, 347, `${frameIndex + 1} / ${plan.frames.length}`, 11, colors.muted, 400, 'end')}
  </svg>`;
}

function renderAlternateFrame(plan: VisualPlan, frameIndex: number, phase: number, progress: number): string {
  const frame = plan.frames[frameIndex]!; const c = palettes[plan.theme as keyof typeof palettes] ?? palettes.aurora;
  const lines = (value: string, width: number) => {
    const chars = Array.from(value); const out: string[] = [];
    for (let i = 0; i < chars.length; i += width) out.push(chars.slice(i, i + width).join(''));
    return out;
  };
  const wrapped = (value: string, x: number, y: number, width: number, size: number, color: string) =>
    lines(value, width).map((line, i) => text(x, y + i * (size + 4), line, size, color, 600)).join('');
  const ledger = plan.layout === 'ledger';
  const tiles = frame.items.map((item, index) => {
    const active = frame.active.includes(index);
    const w = ledger ? 162 : Math.min(142, 652 / frame.items.length - 8);
    const x = ledger ? 30 + (index % 2) * 174 : 30 + index * (w + 8);
    const y = ledger ? 117 + Math.floor(index / 2) * 43 : 122;
    const size = Math.min(ledger ? 20 : 28, Math.max(11, (w - 28) / (Math.min(Math.max(item.length, 1), 16) * .62)));
    const perLine = Math.max(4, Math.floor((w - 28) / (size * .62)));
    const lineCount = Math.max(1, lines(item, perLine).length);
    const baseline = y + ((ledger ? 37 : 68) - (lineCount - 1) * (size + 4)) / 2 + size * .35;
    return `<rect x="${x}" y="${y}" width="${w}" height="${ledger ? 37 : 68}" rx="${ledger ? 6 : 18}" fill="${active ? c.active : c.panel}" stroke="${active ? c.accent : c.idle}" stroke-width="${active ? 2 + phase * 2 : 1}"/>` +
      text(x + 7, y + 12, String(index), 9, active ? c.ink : c.muted, 700) +
      wrapped(item, x + 18, baseline, perLine, size, active ? c.ink : '#f7fbff') +
      (active ? `<rect x="${x}" y="${y + (ledger ? 34 : 65)}" width="${w * phase}" height="3" rx="1.5" fill="${c.accent}"/>` : '');
  }).join('');
  const state = ledger ?
    `<rect x="388" y="117" width="302" height="170" rx="17" fill="${c.panel}"/>` +
      text(406, 141, 'CURRENT STATE', 11, c.accent, 700) + wrapped(frame.state, 406, 164, 29, 14, '#f7fbff') +
      wrapped(frame.metric, 406, 246, 28, 15, c.active) :
    `<rect x="30" y="212" width="660" height="91" rx="18" fill="${c.panel}"/>` +
      wrapped(frame.state, 46, 238, 65, 14, '#f7fbff') + wrapped(frame.metric, 46, 281, 65, 16, c.accent);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360" viewBox="0 0 720 360">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${c.start}"/><stop offset="1" stop-color="${c.end}"/></linearGradient></defs>
    <rect width="720" height="360" rx="22" fill="url(#bg)"/>
    ${text(30, 28, ledger ? 'VALUE LEDGER · FOLLOW THE HIGHLIGHT' : 'FOCUS VIEW · ONE DECISION AT A TIME', 11, c.accent, 700)}
    ${text(30, 64, plan.title, 24, '#f7fbff', 700)}${text(30, 96, frame.label, 15, c.muted)}
    ${tiles}${state}${text(30, 328, frame.note, 13, c.muted)}
    <rect x="30" y="345" width="660" height="4" rx="2" fill="${c.idle}"/>
    <rect x="30" y="345" width="${progress}" height="4" rx="2" fill="${c.active}"/>
    <circle cx="${30 + progress}" cy="347" r="4" fill="${c.accent}"/>
  </svg>`;
}

export async function renderVisualGif(input: VisualPlan): Promise<Buffer> {
  const plan = visualPlanSchema.parse(input);
  const [{ default: sharp }, { GIFEncoder, quantize, applyPalette }] = await Promise.all([import('sharp'), import('gifenc')]);
  const gif = GIFEncoder();
  const [sourceWidth, sourceHeight] = plan.scene ? animatedSceneDimensions[plan.scene] : visualDimensions(plan);
  const dense = !!plan.scene && plan.frames.length > 5;
  const width = dense ? Math.floor(sourceWidth * .78) : sourceWidth;
  const height = dense ? Math.round(sourceHeight * width / sourceWidth) : sourceHeight;
  const [stepDelay, finalDelay] = plan.pace === 'quick' ? [1050, 1700] : plan.pace === 'measured' ? [1650, 2150] :
    plan.pace === 'hold-final' ? [1250, 2800] : [1450, 2300];
  const transition: [number, number][] = plan.frames.length > 5 ? [[.18, 90], [.5, 90], [.82, 90]] :
    [[.12, 70], [.3, 70], [.5, 70], [.7, 70], [.87, 70]];
  const transitionDelay = transition.reduce((sum, [, delay]) => sum + delay, 0);
  // Process sequentially so a worker never retains a full animation of RGBA frames in memory.
  for (let i = 0; i < plan.frames.length; i++) {
    const hold = i === plan.frames.length - 1 ? finalDelay : stepDelay;
    const samples: [number, number][] = plan.scene
      ? i === 0 ? [[1, hold]] : [...transition, [1, hold - transitionDelay]]
      : plan.layout ? [[.25, 120], [.65, 160], [1, hold - 280]] : [[1, hold]];
    for (const [phase, delay] of samples) {
      const raster = sharp(Buffer.from(renderVisualFrame(plan, i, phase)));
      if (dense) raster.resize(width, height, { fit: 'fill' });
      const rgba = await raster.ensureAlpha().raw().toBuffer();
      const palette = quantize(rgba, dense ? 48 : 64);
      gif.writeFrame(applyPalette(rgba, palette), width, height, { palette, repeat: 0, delay });
    }
  }
  gif.finish();
  let result: Buffer = Buffer.from(gif.bytes());
  // Preserve every reviewed state and dwell time. Reduce resolution only if
  // a dense animation still exceeds the hosting budget after encoding.
  if (result.length > 500000) {
    const animation = sharp(result, { animated: true });
    if (plan.scene) animation.resize({ width: Math.floor(width * .82) });
    result = await animation.gif({ effort: 7, colours: plan.scene ? 48 : 64, dither: 0,
      interFrameMaxError: 0, interPaletteMaxError: 0, keepDuplicateFrames: true }).toBuffer();
  }
  if (result.length > 500000) throw new Error('Visual exceeds the media budget');
  return result;
}

/** A real trace table is the fallback when no persistent public image host is configured. */
export function renderVisualFallback(plan: VisualPlan): string {
  const safe = plainMarkdown;
  return `*${safe(plan.caption)}*\n\n| Step | State | Result |\n|---|---|---|\n` +
    plan.frames.map(f => `| ${safe(f.label)} | ${safe(f.state)} | ${safe(f.metric)} |`).join('\n');
}
