import type { VisualPlan } from './visuals';
import type { IllustrationKind } from './visualStyles';

type Point = { x: number; y: number };
type Frame = VisualPlan['frames'][number];

const palettes = [
  { paper: '#fcf6ef', surface: '#fffdf8', ink: '#241c40', muted: '#665a72', fog: '#eee3fc', glow: '#f9dfcc', stroke: '#c9b6e0', focus: '#6644ce', focusInk: '#fff', result: '#c9f0dc', resultInk: '#194d3b' },
  { paper: '#eef8fc', surface: '#fbfdff', ink: '#17344f', muted: '#4c6479', fog: '#dcecfb', glow: '#e9ddf8', stroke: '#a6c8e0', focus: '#1969b1', focusInk: '#fff', result: '#caf0ed', resultInk: '#114841' },
  { paper: '#f3f7ed', surface: '#fcfff9', ink: '#243d30', muted: '#4c6656', fog: '#e0efdb', glow: '#f9e6bf', stroke: '#b5cead', focus: '#327451', focusInk: '#fff', result: '#fae9bb', resultInk: '#574416' },
  { paper: '#fdf2ee', surface: '#fffdfb', ink: '#512f36', muted: '#765659', fog: '#fae0e4', glow: '#f9e9cb', stroke: '#dcadb9', focus: '#a93c5a', focusInk: '#fff', result: '#efe2ff', resultInk: '#543565' },
] as const;

export function illustratedDimensions(plan: Pick<VisualPlan, 'id'>): [number, number] {
  return plan.id === 'visual-1' ? [780, 465] : [800, 510];
}

const escape = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;

function wrap(value: string, columns: number): string[] {
  const lines: string[] = [];
  const chars = Array.from(value.trim());
  while (chars.length > columns) {
    const space = chars.lastIndexOf(' ', columns);
    lines.push(chars.splice(0, space > columns / 2 ? space + 1 : columns).join('').trim());
  }
  if (chars.length) lines.push(chars.join('').trim());
  return lines;
}

function treeRows(count: number, edges: NonNullable<Frame['edges']>): number[][] {
  const level = Array.from({ length: count }, () => 0);
  const parents = Array.from({ length: count }, () => 0);
  for (const [, child] of edges) parents[child]!++;
  const queue = level.flatMap((_, i) => parents[i] === 0 ? [i] : []);
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i]!;
    for (const [, child] of edges.filter(edge => edge[0] === parent)) {
      level[child] = Math.max(level[child]!, level[parent]! + 1);
      if (--parents[child]! === 0) queue.push(child);
    }
  }
  if (queue.length !== count) return [];
  return Array.from({ length: Math.max(...level) + 1 }, (_, row) =>
    level.flatMap((value, i) => value === row ? [i] : []));
}

export function renderQuestionIllustration(plan: VisualPlan, kind: IllustrationKind, index: number, phase: number): string {
  const [width, height] = illustratedDimensions(plan);
  const frame = plan.frames[index]!;
  const previous = plan.frames[Math.max(index - 1, 0)]!;
  const concept = plan.id === 'visual-1';
  const final = index === plan.frames.length - 1;
  const progress = phase * phase * (3 - 2 * phase);
  const theme = [...plan.theme].reduce((sum, char) => sum + char.charCodeAt(0), concept ? 1 : 0);
  const c = palettes[theme % palettes.length]!;
  const panelLeft = concept && plan.direction === 'reverse';
  const area = { left: panelLeft ? 280 : 38, top: concept ? 152 : 145, width: concept ? 462 : 724, height: concept ? 229 : 231 };
  const rect = (x: number, y: number, w: number, h: number, fill: string, radius = 0, stroke = 'none') =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
  const circle = (x: number, y: number, radius: number, fill: string, stroke = 'none') =>
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}" stroke="${stroke}"/>`;
  const path = (d: string, stroke: string, size = 2, dash = '') =>
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${size}" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
  const text = (value: string, x: number, y: number, maxWidth: number, size: number, ink: string = c.ink,
    weight = 700, align = 'start', rows = 2) => {
    let lines = wrap(value, Math.floor(maxWidth / (size * .57)));
    while (lines.length > rows && size > 10) lines = wrap(value, Math.floor(maxWidth / (--size * .57)));
    return lines.map((line, i) =>
      `<text x="${x}" y="${y + i * size * 1.18}" fill="${ink}" text-anchor="${align}" font-family="Arial, DejaVu Sans, sans-serif" font-size="${size}" font-weight="${weight}">${escape(line)}</text>`).join('');
  };
  const group = (content: string, dx: number, dy: number, opacity = 1) =>
    `<g transform="translate(${dx} ${dy})" opacity="${opacity}">${content}</g>`;
  const active = (item: number) => frame.active.includes(item);
  const entering = (item: number) => active(item) && index > 0 &&
    (!previous.active.includes(item) || frame.items[item] !== previous.items[item]);
  const focus = final ? c.result : c.focus;
  const focusInk = final ? c.resultInk : c.focusInk;
  const palette = (item: number) => active(item) ? focus : c.surface;
  const ink = (item: number) => active(item) ? focusInk : c.ink;

  const tile = (item: number, center: Point, w: number, h: number) => {
    const x = center.x - w / 2;
    const y = center.y - h / 2;
    const lift = entering(item) ? (1 - progress) * 11 : 0;
    const shadow = rect(x + 3, y + 6, w, h, c.stroke, 12);
    return shadow + group(
      rect(x, y, w, h, palette(item), 10, active(item) ? 'none' : c.stroke) +
      text(frame.items[item]!, center.x, center.y + (frame.items[item]!.length <= 7 ? 7 : -1),
        w - 10, w > 85 ? 21 : 17, ink(item), 700, 'middle', 3),
    0, lift, entering(item) ? .57 + progress * .43 : 1);
  };
  const row = (count: number, y: number, inset = 0): Point[] => {
    const spread = area.width - 2 * inset;
    return Array.from({ length: count }, (_, i) => ({ x: area.left + inset + (i + .5) * spread / count, y }));
  };
  let body = '';
  switch (kind) {
    case 'grid': {
      const all = plan.frames.flatMap(step => step.cells ?? []);
      const rows = [...new Set(all.map(cell => cell[0]))].sort((a, b) => a - b);
      const columns = [...new Set(all.map(cell => cell[1]))].sort((a, b) => a - b);
      const compact = frame.cells && rows.length && columns.length && rows.at(-1)! - rows[0]! < 6 && columns.at(-1)! - columns[0]! < 6;
      const rowCount = compact ? rows.at(-1)! - rows[0]! + 1 : Math.ceil(frame.items.length / 4);
      const columnCount = compact ? columns.at(-1)! - columns[0]! + 1 : Math.min(4, frame.items.length);
      const h = Math.min(73, (area.height - 24) / rowCount);
      const w = Math.min(110, (area.width - 22) / columnCount);
      const left = area.left + (area.width - columnCount * w) / 2;
      const top = area.top + (area.height - rowCount * h) / 2 + (compact ? 7 : 0);
      body += rect(left - 11, top - 11, columnCount * w + 22, rowCount * h + 22, c.fog, 20, c.stroke);
      if (compact && frame.cells) {
        body += columns.map(col =>
          text(String(col), left + (col - columns[0]! + .5) * w, top - 17, w, 14, c.muted, 700, 'middle', 1)).join('');
        body += rows.map(r =>
          text(String(r), left - 22, top + (r - rows[0]! + .5) * h + 4, 28, 14, c.muted, 700, 'middle', 1)).join('');
        body += frame.cells.map(([r, col], i) =>
          tile(i, { x: left + (col - columns[0]! + .5) * w, y: top + (r - rows[0]! + .5) * h }, w - 9, h - 9)).join('');
      } else {
        body += frame.items.map((_, i) =>
          tile(i, { x: left + (i % columnCount + .5) * w, y: top + (Math.floor(i / columnCount) + .5) * h }, w - 9, h - 9)).join('');
      }
      break;
    }
    case 'tree':
    case 'graph': {
      const links = frame.edges ?? [];
      const levels = kind === 'tree' && links.length ? treeRows(frame.items.length, links) : [];
      const positions: Point[] = frame.items.map((_, i) => {
        if (levels.length) {
          const depth = levels.findIndex(level => level.includes(i));
          const layer = levels[depth]!;
          return { x: area.left + (layer.indexOf(i) + .5) * area.width / layer.length,
            y: area.top + 20 + (area.height - 40) * depth / Math.max(1, levels.length - 1) };
        }
        const angle = -Math.PI / 2 + i * Math.PI * 2 / frame.items.length;
        return { x: area.left + area.width / 2 + Math.cos(angle) * area.width * .35,
          y: area.top + area.height / 2 + Math.sin(angle) * area.height * .36 };
      });
      const rowGap = levels.length > 1 ? (area.height - 40) / (levels.length - 1) : 60;
      const radius = Math.min(concept ? 25 : 30, Math.max(11, rowGap / 2 - 3));
      body += links.map(([a, b]) => {
        const from = positions[a]!;
        const to = positions[b]!;
        return `<g data-edge="${a}-${b}">${path(`M${from.x} ${from.y} L${to.x} ${to.y}`, active(a) && active(b) ? c.focus : c.stroke, 3)}</g>`;
      }).join('');
      body += positions.map(({ x, y }, i) => {
        const lift = entering(i) ? 5 * (1 - progress) : 0;
        return (active(i) ? circle(x, y, radius + 7 + (1 - progress) * 7, c.fog) : '') +
          group(circle(x + 1, y + 4, radius, c.stroke) + circle(x, y, radius, palette(i), c.stroke) +
            text(frame.items[i]!, x, y + (frame.items[i]!.length < 5 ? 6 : -2), radius * 1.7,
              radius > 20 ? 18 : 12, ink(i), 700, 'middle', 2), 0, lift, entering(i) ? .63 + progress * .37 : 1);
      }).join('');
      break;
    }
    case 'stack': {
      const count = frame.items.length;
      const h = Math.min(49, (area.height - 25) / count);
      const w = Math.min(320, area.width - 64);
      const x = area.left + area.width / 2;
      body += path(`M${x - w / 2 - 14} ${area.top + 15} V${area.top + area.height - 8} H${x + w / 2 + 14} V${area.top + 15}`,
        c.stroke, 3);
      body += frame.items.map((_, i) =>
        tile(i, { x, y: area.top + area.height - 15 - (i + .5) * h }, w, h - 5)).join('');
      break;
    }
    case 'window':
    case 'search':
    case 'queue':
    case 'sequence': {
      const positions = row(frame.items.length, area.top + area.height * .52, 12);
      const size = Math.min(116, (area.width - 24) / frame.items.length - 6);
      const first = positions[0]!;
      const last = positions.at(-1)!;
      body += path(`M${first.x - size / 2} ${first.y + 58} H${last.x + size / 2}`, c.stroke, kind === 'queue' ? 7 : 2);
      if (frame.range && (kind === 'window' || kind === 'search')) {
        const [from, to] = frame.range;
        const oldRange = previous.range ?? frame.range;
        const oldPositions = previous.range ? row(previous.items.length, first.y, 12) : positions;
        const start = lerp(oldPositions[oldRange[0]]!.x, positions[from]!.x, progress) - size / 2 - 5;
        const end = lerp(oldPositions[oldRange[1]]!.x, positions[to]!.x, progress) + size / 2 + 5;
        body += `<g data-range="${from}-${to}">${rect(start, first.y - 61, end - start, 118, c.fog, 17, c.stroke)}</g>`;
        body += path(`M${start} ${first.y - 52} V${first.y - 61} H${end} V${first.y - 52}`, c.focus, 3);
      }
      body += positions.map((point, i) => tile(i, point, size, 68)).join('');
      break;
    }
    case 'decision': {
      const count = frame.items.length;
      const columns = count > 4 ? 4 : Math.min(2, count);
      const rows = Math.ceil(count / columns);
      const w = Math.min(196, area.width / columns - 14);
      const h = Math.min(84, (area.height - 34) / rows);
      body += frame.items.map((_, i) => tile(i, {
        x: area.left + (i % columns + .5) * area.width / columns,
        y: area.top + 16 + (Math.floor(i / columns) + .5) * (area.height - 25) / rows,
      }, w, h)).join('');
      break;
    }
  }

  const art = rect(0, 0, width, height, c.paper) +
    `<path d="M0 173C141 104 238 125 366 161S621 177 800 103V348C633 383 491 343 350 323S127 303 0 353Z" fill="${c.fog}"/>` +
    `<ellipse cx="${concept ? 394 : 672}" cy="214" rx="94" ry="62" fill="${c.glow}"/>` +
    text(plan.title, 39, 66, width - 180, 34, c.ink, 700, 'start', 1) +
    text(frame.label, 40, 108, width - 80, 19, c.muted, 500) +
    plan.frames.map((_, i) => rect(width - 35 - (plan.frames.length - i) * 14, 59, 9, 5, i <= index ? c.focus : c.stroke, 2)).join('') + body;
  const panelX = panelLeft ? 32 : 523;
  const panel = concept ?
    rect(panelX, 143, 225, 256, c.surface, 20, c.stroke) +
      group(text(frame.metric, panelX + 112, 195, 189, 29, c.focus, 700, 'middle'), 0, (1 - progress) * 9, .58 + .42 * progress) +
      path('M' + (panelX + 21) + ' 239 H' + (panelX + 204), c.stroke, 1) +
      text(frame.state, panelX + 22, 269, 181, 17, c.ink, 700, 'start', 4) +
      text(frame.note, 40, 430, 700, 15, c.muted, 500) :
    rect(30, 388, 740, 97, c.surface, 20) +
      text(frame.state, 49, 421, 478, 18) + text(frame.note, 49, 463, 478, 14, c.muted, 500) +
      group(rect(551, 403, 203, 67, final ? c.result : c.fog, 16) +
        text(frame.metric, 652, frame.metric.length > 15 ? 427 : 438, 177, 25,
          final ? c.resultInk : c.focus, 700, 'middle'), 0, (1 - progress) * 9, .58 + .42 * progress);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g data-illustration="${kind}">${art}${panel}</g></svg>`;
}
