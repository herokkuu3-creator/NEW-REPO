import { z } from 'zod';

export const sectionKinds = ['intuition', 'approach', 'correctness', 'dryRun', 'takeaways'] as const;
export const visualThemes = ['aurora', 'sunset', 'ocean', 'violet'] as const;
export const visualPlanSchema = z.object({
  id: z.string().regex(/^visual-[12]$/), after: z.enum(sectionKinds),
  title: z.string().min(3).max(48), caption: z.string().min(5).max(100),
  theme: z.enum(visualThemes).default('aurora'),
  frames: z.array(z.object({
    label: z.string().min(2).max(48), items: z.array(z.string().max(8)).min(1).max(8),
    active: z.array(z.number().int().min(0).max(7)).max(8),
    state: z.string().min(1).max(64), metric: z.string().min(1).max(40), note: z.string().max(76),
  })).min(2).max(8),
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
export function renderVisualFrame(plan: VisualPlan, frameIndex: number): string {
  const frame = plan.frames[frameIndex]!;
  const colors = palettes[plan.theme];
  const width = 720; const height = 360;
  const gap = 12; const box = Math.min(76, (width - 72 - gap * (frame.items.length - 1)) / frame.items.length);
  const left = (width - (box * frame.items.length + gap * (frame.items.length - 1))) / 2;
  const blocks = frame.items.map((item, i) => {
    const x = left + i * (box + gap); const active = frame.active.includes(i);
    return `<rect x="${x}" y="122" width="${box}" height="66" rx="14" fill="${active ? colors.active : colors.idle}" stroke="${active ? colors.accent : 'none'}" stroke-width="${active ? 2 : 0}"/>` +
      text(x + box / 2, 165, item, Math.min(30, (box - 12) / Math.max(1, item.length) * 1.5), active ? colors.ink : colors.muted, 700, 'middle') +
      (active ? `<path d="M ${x + box / 2} 204 l -7 9 h 14 Z" fill="${colors.active}"/>` : '');
  }).join('');
  const progress = (frameIndex + 1) / plan.frames.length * 664;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 720 360">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors.start}"/><stop offset="1" stop-color="${colors.end}"/></linearGradient></defs>
    <rect width="720" height="360" rx="22" fill="url(#bg)"/>
    <circle cx="670" cy="42" r="78" fill="${colors.flare}" opacity=".14"/><circle cx="638" cy="18" r="34" fill="${colors.accent}" opacity=".09"/>
    <rect x="28" y="22" width="${Math.max(128, Math.min(202, plan.title.length * 6.8))}" height="24" rx="12" fill="${colors.flare}" opacity=".2"/>
    ${text(40, 39, 'TRACE · WATCH IT CHANGE', 11, colors.accent, 700)}
    ${text(30, 78, plan.title, 25, '#f7fbff', 700)}
    ${text(30, 105, frame.label, 16, colors.muted)}${blocks}
    <rect x="28" y="224" width="664" height="80" rx="13" fill="${colors.panel}" stroke="${colors.flare}" stroke-opacity=".28"/>
    ${text(44, 251, frame.state, 16, '#f3f8ff', 600)}
    ${text(674, 281, frame.metric, 21, colors.accent, 700, 'end')}
    <rect x="28" y="318" width="664" height="5" rx="2.5" fill="#ffffff" opacity=".14"/><rect x="28" y="318" width="${progress}" height="5" rx="2.5" fill="${colors.active}"/>
    ${text(30, 347, frame.note, 15, colors.muted)}
    ${text(686, 347, `${frameIndex + 1} / ${plan.frames.length}`, 11, colors.muted, 400, 'end')}
  </svg>`;
}

export async function renderVisualGif(input: VisualPlan): Promise<Buffer> {
  const plan = visualPlanSchema.parse(input);
  const [{ default: sharp }, { GIFEncoder, quantize, applyPalette }] = await Promise.all([import('sharp'), import('gifenc')]);
  const gif = GIFEncoder();
  // Process sequentially so a worker never retains a full animation of RGBA frames in memory.
  for (let i = 0; i < plan.frames.length; i++) {
    const rgba = await sharp(Buffer.from(renderVisualFrame(plan, i))).ensureAlpha().raw().toBuffer();
    const palette = quantize(rgba, 64);
    gif.writeFrame(applyPalette(rgba, palette), 720, 360, { palette, repeat: 0,
      delay: i === plan.frames.length - 1 ? 2300 : 1450 });
  }
  gif.finish();
  const result = Buffer.from(gif.bytes());
  if (result.length > 500000) throw new Error('Visual exceeds the media budget');
  return result;
}

/** A real trace table is the fallback when no persistent public image host is configured. */
export function renderVisualFallback(plan: VisualPlan): string {
  const safe = plainMarkdown;
  return `*${safe(plan.caption)}*\n\n| Step | State | Result |\n|---|---|---|\n` +
    plan.frames.map(f => `| ${safe(f.label)} | ${safe(f.state)} | ${safe(f.metric)} |`).join('\n');
}
