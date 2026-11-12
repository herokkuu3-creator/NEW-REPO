import type { VisualPlan } from './visuals';
import { paletteForAccount, type AnimatedScene } from './visualStyles';

export const animatedSceneDimensions: Record<AnimatedScene, [number, number]> = {
  orbit: [720, 490], switchboard: [780, 410], grid: [680, 505], stage: [690, 450],
  film: [780, 400], terminal: [800, 510], waterfall: [650, 540], split: [760, 440],
};

const escape = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
const ease = (value: number) => value * value * (3 - 2 * value);
const mix = (from: number, to: number, progress: number) => from + (to - from) * progress;

const routeColors = {
  background: '#fbf7f1', ink: '#241c40', muted: '#625674', cloud: '#f4eafc', blush: '#fbe6d6',
  baseline: '#cbbce1', front: '#e9dcfa', top: '#f7eeff', side: '#c8b6e9',
  violet: '#6141c5', violetTop: '#9477eb', violetSide: '#462a9b', soft: '#eee5ff',
  green: '#c9f0dc', greenTop: '#e2f8ee', greenSide: '#9bceb2', forest: '#194d3b',
};

function blendColor(from: string, to: string, progress: number): string {
  const channel = (start: number) => Math.round(mix(parseInt(from.slice(start, start + 2), 16),
    parseInt(to.slice(start, start + 2), 16), progress)).toString(16).padStart(2, '0');
  return '#' + channel(1) + channel(3) + channel(5);
}

function routeItem(item: string): { index: string; value: string } | undefined {
  const match = /^(?:b\[?|best\[)(\d+)\]?\s*[:=]\s*(.+)$/i.exec(item);
  return match ? { index: match[1]!, value: match[2]!.replace(/^(?:inf(?:inity)?|∞)$/i, '∞') } : undefined;
}

function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  const chars = Array.from(value.trim());
  while (chars.length > width) {
    const space = chars.lastIndexOf(' ', width);
    lines.push(chars.splice(0, space > width / 2 ? space + 1 : width).join('').trim());
  }
  if (chars.length) lines.push(chars.join('').trimStart());
  return lines;
}

export function renderAnimatedScene(plan: VisualPlan & { scene: AnimatedScene }, index: number, phase: number): string {
  const [width, height] = animatedSceneDimensions[plan.scene];
  const colors = paletteForAccount(plan.theme);
  const current = plan.frames[index]!;
  const previous = plan.frames[Math.max(0, index - 1)]!;
  const progress = ease(phase);
  const focus = current.active[0] ?? 0;
  const oldFocus = previous.active[0] ?? 0;
  const flip = plan.direction === 'reverse' ? -1 : 1;
  const sans = 'DejaVu Sans, sans-serif';
  const mono = 'DejaVu Sans Mono, monospace';
  const serif = 'DejaVu Serif, serif';

  const rect = (x: number, y: number, w: number, h: number, fill: string, radius = 0) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}"/>`;
  const circle = (x: number, y: number, radius: number, fill: string, stroke = 'none', strokeWidth = 1) =>
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  const path = (points: string, stroke: string, sw = 2, dash = '') =>
    `<path d="${points}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
  const text = (value: string, x: number, y: number, maxWidth: number, size: number, fill = colors.ink,
    weight = 500, align: 'start' | 'middle' | 'end' = 'start', font = sans, maxLines = Infinity) => {
    const ratio = font === mono ? .64 : .61;
    let lines = wrap(value, Math.max(4, Math.floor(maxWidth / (size * ratio))));
    while (lines.length > maxLines && size > 10) {
      size--;
      lines = wrap(value, Math.max(4, Math.floor(maxWidth / (size * ratio))));
    }
    return lines.map((line, i) => `<text x="${x}" y="${y + i * size * 1.23}" fill="${fill}" font-family="${font}"
      font-size="${size}" font-weight="${weight}" text-anchor="${align}">${escape(line)}</text>`).join('');
  };
  const slide = (content: string, x: number, y: number, opacity = 1) =>
    `<g transform="translate(${x} ${y})" opacity="${opacity}">${content}</g>`;
  const change = (content: string) => slide(content, 0, (1 - progress) * 12, .25 + .75 * progress);
  const shortItems = (frame: typeof current) =>
    frame.items.map((item, i) => frame.active.includes(i) ? '[' + item + ']' : item).join('  /  ');
  const itemText = (frame: typeof current, x: number, y: number, width: number, size: number, maxLines: number,
    fill = colors.muted, align: 'start' | 'middle' = 'start') => {
    return text(shortItems(frame), x, y, width, size, fill, 600, align, mono, maxLines);
  };
  const ellipse = (x: number, y: number, rx: number, ry: number, fill: string, stroke = 'none', sw = 1) =>
    `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  const keyline = (x: number, y: number, w: number, h: number, radius: number) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="none" stroke="${colors.line}"/>`;
  const definitions = `<defs>
    <radialGradient id="wash"><stop stop-color="${colors.accent}" stop-opacity=".17"/><stop offset="1" stop-color="${colors.accent}" stop-opacity="0"/></radialGradient>
  </defs>`;
  let art = rect(0, 0, width, height, colors.background);

  switch (plan.scene) {
    case 'orbit': {
      const cx = width / 2;
      const cy = 246;
      const angle = (i: number, count: number) => -Math.PI / 2 + flip * i * Math.PI * 2 / count;
      const point = (a: number) => [cx + Math.cos(a) * 242, cy + Math.sin(a) * 110] as const;
      const before = angle(oldFocus, previous.items.length);
      const after = angle(focus, current.items.length);
      const delta = Math.atan2(Math.sin(after - before), Math.cos(after - before));
      const [cursorX, cursorY] = point(before + delta * progress);
      art += ellipse(cx, cy, 328, 181, 'url(#wash)');
      art += ellipse(cx, cy, 273, 134, 'none', colors.line, .65);
      art += ellipse(cx, cy, 211, 82, 'none', colors.line, .55);
      art += text(plan.title, 33, 42, 654, 27, colors.ink, 700, 'start', serif);
      art += `<ellipse cx="${cx}" cy="${cy}" rx="242" ry="110" stroke="${colors.line}" stroke-width="2" stroke-dasharray="4 6" fill="none"/>`;
      art += path(`M${cx} ${cy} L${cursorX} ${cursorY}`, colors.accent, 2, '3 7');
      art += current.items.map((value, item) => {
        const [x, y] = point(angle(item, current.items.length));
        const active = current.active.includes(item);
        return circle(x, y, 36, active ? colors.selected : colors.surface, active ? colors.accent : colors.line, 2) +
          text(value, x, y + (value.length < 6 ? 7 : -8), 62, value.length < 6 ? 22 : 13, active ? colors.selectedInk : colors.ink, 700, 'middle', mono, 3);
      }).join('');
      if (current.active.length) art += circle(cursorX, cursorY, 41 + (1 - progress) * 9, 'none', colors.accent, 3);
      art += rect(cx - 140, cy - 36, 280, 72, colors.surface, 36) + keyline(cx - 140, cy - 36, 280, 72, 36);
      art += path('M33 399 H687', colors.line, 1);
      art += change(text(current.metric, cx, cy + 3, 237, 24, colors.accent, 700, 'middle', mono, 2));
      art += text(current.label, 34, 74, 610, 16, colors.muted, 600);
      art += text(current.state, 31, 427, 651, 18, colors.ink, 700) + text(current.note, 31, 464, 651, 14, colors.muted);
      break;
    }
    case 'switchboard': {
      const hubX = flip > 0 ? 534 : 247;
      const portX = flip > 0 ? 270 : 511;
      const listX = flip > 0 ? 248 : 533;
      const y = (i: number, count: number) => 115 + (i + .5) * 229 / count;
      art += rect(23, 89, width - 46, 272, colors.surface, 24);
      art += keyline(23, 89, width - 46, 272, 24);
      art += ellipse(hubX, 225, 170, 141, 'url(#wash)');
      art += text(plan.title, 33, 41, 710, 24, colors.ink, 700, 'start', mono);
      art += current.items.map((value, item) => {
        const level = y(item, current.items.length);
        const active = current.active.includes(item);
        const cable = `M${portX} ${level} C${portX + flip * 90} ${level} ${hubX - flip * 103} 225 ${hubX} 225`;
        return path(cable, colors.line, 2) +
          (active ? `<path d="${cable}" fill="none" stroke="${colors.accent}" stroke-width="5" stroke-dasharray="${progress * 354} 780"/>` : '') +
          circle(portX, level, active ? 7 : 4, active ? colors.accent : colors.line) +
          text(value, listX, level + 5, 207, 15, active ? colors.accent : colors.ink, 700, flip > 0 ? 'end' : 'start', mono, 1);
      }).join('');
      art += rect(hubX - 117, 112, 234, 226, colors.background, 15) + keyline(hubX - 117, 112, 234, 226, 15);
      art += text(current.label, hubX, 146, 197, 15, colors.muted, 600, 'middle', mono);
      art += change(text(current.metric, hubX, 208, 202, 26, colors.accent, 700, 'middle', mono, 2));
      art += text(current.state, hubX, 272, 199, 15, colors.ink, 600, 'middle');
      art += text(current.note, 33, 385, 715, 15, colors.muted);
      break;
    }
    case 'grid': {
      const cell = (i: number, count: number) => {
        const columns = Math.min(4, count);
        const column = flip > 0 ? i % columns : columns - 1 - i % columns;
        return [(width - columns * 151 + 11) / 2 + column * 151, 132 + Math.floor(i / columns) * 96 + (count <= 4 ? 42 : 0)] as const;
      };
      const [x0, y0] = cell(oldFocus, previous.items.length);
      const [x1, y1] = cell(focus, current.items.length);
      art += rect(24, 101, 632, 230, colors.surface, 18);
      for (let x = 25; x < width; x += 25) art += path(`M${x} 98 V331`, colors.line, .55);
      for (let y = 106; y < 333; y += 25) art += path(`M25 ${y} H655`, colors.line, .55);
      art += text(plan.title, 30, 42, 614, 23, colors.ink, 700, 'start', mono);
      art += text(current.label, 31, 78, 604, 15, colors.muted, 500, 'start', mono);
      art += current.items.map((value, item) => {
        const [x, y] = cell(item, current.items.length);
        const active = current.active.includes(item);
        return rect(x, y, 140, 78, active ? colors.selected : colors.surface, 2) +
          text(value, x + 70, y + 33, 126, 14, active ? colors.selectedInk : colors.ink, 700, 'middle', mono);
      }).join('');
      if (current.active.length) art += slide(path('M0 14 V0 H16 M123 0 H140 V14 M140 64 V78 H123 M16 78 H0 V64', colors.accent, 4),
        mix(x0, x1, progress), mix(y0, y1, progress));
      art += text(current.state, 34, 376, 606, 18, colors.ink, 700, 'start', mono) +
        change(text(current.metric, 34, 421, 606, 22, colors.accent, 700, 'start', mono)) +
        text(current.note, 34, 471, 606, 14, colors.muted);
      break;
    }
    case 'stage': {
      const x = flip > 0 ? 405 : 34;
      const center = flip > 0 ? 205 : 481;
      art += rect(x, 27, 251, height - 54, colors.surface, 26) + keyline(x, 27, 251, height - 54, 26);
      art += ellipse(center, 234, 200, 152, 'url(#wash)');
      art += path(`M${center - 154} 282 Q${center} 222 ${center + 154} 282`, colors.line, 2);
      art += ellipse(center, 294, 150, 29, colors.line);
      art += ellipse(center, 281, 150, 29, colors.surface, colors.line, 2);
      art += ellipse(center, 281, 116, 16, 'none', colors.accent, 1);
      const spot = current.items[focus]!;
      const oldSpot = previous.items[oldFocus]!;
      const actor = (label: string, x: number, y: number, opacity: number) => slide(
        rect(-110, -49, 220, 106, colors.accent, 24) +
        rect(-110, -56, 220, 106, colors.selected, 24) +
        text(label, 0, label.length > 11 ? -10 : 9, 192, 30, colors.selectedInk, 700, 'middle', serif, 2), x, y, opacity);
      if (index > 0 && spot !== oldSpot && phase < 1) art += actor(oldSpot, center - flip * 172 * progress, 218, 1 - progress);
      art += actor(spot, center + flip * 172 * (1 - progress), 218 - Math.sin(Math.PI * progress) * 44, progress);
      art += text(plan.title, center, 49, 334, 26, colors.ink, 700, 'middle', serif, 2);
      art += text(current.label, center, 111, 337, 16, colors.muted, 700, 'middle');
      art += itemText(current, center, 341, 340, 14, 5, colors.muted, 'middle');
      art += path(`M${x + 22} 192 H${x + 229}`, colors.line, 1);
      art += change(text(current.metric, x + 22, 116, 207, 30, colors.accent, 700, 'start', serif, 2));
      art += text(current.state, x + 22, 237, 203, 17, colors.ink, 700);
      art += text(current.note, x + 22, 345, 203, 15, colors.muted, 500, 'start', sans, 4);
      break;
    }
    case 'film': {
      const panel = (frame: typeof current, x: number, opacity: number) => slide(
        rect(0, 0, 486, 207, colors.surface, 12) + keyline(0, 0, 486, 207, 12) +
        path('M24 133 H461', colors.line, 1) +
        text(frame.label, 24, 38, 438, 19, colors.ink, 700, 'start', serif) +
        itemText(frame, 24, 74, 438, 15, 4) +
        text(frame.state, 24, 151, 435, 16, colors.ink, 700) +
        text(frame.metric, 24, 186, 435, 18, colors.accent, 700), x, 113, opacity);
      art += text(plan.title, 32, 50, 716, 26, colors.ink, 700, 'start', serif);
      art += rect(0, 83, width, 257, colors.line);
      for (let x = 12; x < width; x += 34) art += rect(x, 90, 19, 7, colors.background, 2) + rect(x, 326, 19, 7, colors.background, 2);
      if (index > 0) art += panel(previous, 147 - flip * progress * 514, .95 - .6 * progress);
      art += panel(current, 147 + flip * (1 - progress) * 514, .55 + .45 * progress);
      art += text(current.note, 32, 372, 715, 15, colors.ink);
      break;
    }
    case 'terminal': {
      // The saved scene identifier also covers articles created before the illustration.
      const c = routeColors;
      const items = current.items.map(routeItem);
      const stairs = plan.terrain === 'steps' || items.every(Boolean) && /steps?|stairs?|climb|jump/i.test(
        [plan.title, plan.caption, ...plan.frames.map(frame => frame.note)].join(' '));
      const base = 345;
      const span = 644;
      const stride = span / Math.max(current.items.length, 3);
      const size = Math.min(111, stride - 15);
      const position = (i: number, count: number) => {
        const spacing = span / Math.max(count, 3);
        const column = stairs || flip > 0 ? i : count - i - 1;
        return { x: width / 2 + (column - (count - 1) / 2) * spacing,
          y: stairs ? 277 - 96 * i / Math.max(count - 1, 1) : 237 };
      };
      const points = current.items.map((_, i) => position(i, current.items.length));
      const poly = (points: string, fill: string) => `<polygon points="${points}" fill="${fill}"/>`;
      const final = index === plan.frames.length - 1;
      const highlight = final ? c.forest : c.violet;
      const label = (value: string, x: number, y: number, w: number, size: number, ink = c.ink,
        weight = 700, align: 'start' | 'middle' = 'start', maxLines = 2) =>
        text(value, x, y, w, size, ink, weight, align, 'Arial, DejaVu Sans, sans-serif', maxLines);

      art = rect(0, 0, width, height, c.background);
      art += `<path d="M0 189C124 114 227 119 344 169S614 211 800 100V332C656 356 524 371 382 334S128 283 0 341Z" fill="${c.cloud}"/>`;
      art += ellipse(681, 207, 90, 65, c.blush);
      art += label(plan.title, 38, 68, 572, 35, c.ink, 700, 'start', 1);
      art += label(current.label, 39, 110, 680, 19, c.muted, 500);
      // This is trace progress, independent of the values or algorithm indices.
      const markerX = 762 - plan.frames.length * 16;
      art += plan.frames.map((_, i) => rect(markerX + i * 16, 61, 11, 5, i <= index ? c.violet : c.baseline, 2.5)).join('');
      art += path('M54 347 H746', c.baseline, 1.5);

      const route = points.map(({ x, y }, i) => (i ? 'L' : 'M') + (x + 5) + ' ' + (y - 28)).join(' ');
      if (points.length > 1) art += path(route, c.baseline, 2, '4 7');
      art += current.items.map((value, i) => {
        const point = points[i]!;
        const active = current.active.includes(i);
        const entering = index > 0 && active && (!previous.active.includes(i) || previous.items[i] !== value);
        const light = active ? entering ? progress : 1 : 0;
        const x = point.x;
        const y = point.y + (entering ? (1 - progress) * 13 : 0);
        const top = blendColor(c.top, final ? c.greenTop : c.violetTop, light);
        const front = blendColor(c.front, final ? c.green : c.violet, light);
        const side = blendColor(c.side, final ? c.greenSide : c.violetSide, light);
        const ink = active && light > .63 ? (final ? c.forest : '#ffffff') : c.ink;
        const left = x - size / 2;
        const right = x + size / 2;
        const floor = stairs ? base : point.y + 75;
        const depth = Math.min(16, stride * .12);
        const item = items[i];
        const displayed = stairs && item ? item.value : value;
        const valueSize = displayed.length <= 5 ? 30 : 18;
        const shadow = ellipse(x + 8, floor + 2, size * .55, 9, c.baseline);
        const body = rect(left, y, size, floor - y, front) +
          poly(`${right},${y} ${right + depth},${y - 11} ${right + depth},${floor - 11} ${right},${floor}`, side) +
          poly(`${left},${y} ${left + depth},${y - 11} ${right + depth},${y - 11} ${right},${y}`, top);
        const caption = stairs && item ? label('Step ' + item.index, x, 368, size + 6, 13, c.muted, 600, 'middle', 1) : '';
        return shadow + body + label(displayed, x, y + (valueSize === 30 ? 38 : 32), size - 9, valueSize,
          ink, 700, 'middle', 3) + caption;
      }).join('');

      if (current.active.length) {
        const destination = points[focus]!;
        const origin = previous.active.length ? position(oldFocus, previous.items.length) : destination;
        const x = mix(origin.x, destination.x, progress) + 5;
        const y = mix(origin.y, destination.y, progress) - 28 - 28 * Math.sin(Math.PI * progress);
        art += circle(x, y, 14 + (1 - progress) * 5, final ? c.greenTop : c.soft) +
          circle(x, y, 7, highlight) + circle(x - 2, y - 2, 2, '#fff8f7');
      }

      art += rect(30, 388, 740, 97, '#fffdf9', 20);
      art += label(current.state, 49, 421, 478, 18, c.ink, 700);
      art += label(current.note, 49, 463, 478, 14, c.muted, 500);
      const result = rect(551, 403, 203, 67, final ? c.green : c.soft, 16) +
        label(current.metric, 652, 434 - (current.metric.length > 15 ? 7 : 0),
          178, 26, highlight, 700, 'middle');
      art += slide(result, 0, (1 - progress) * 9, .45 + progress * .55);
      break;
    }
    case 'waterfall': {
      const history = plan.frames.slice(Math.max(0, index - 2), index + 1);
      const anchor = flip > 0 ? 28 : 172;
      art += text(plan.title, 28, 49, 591, 23, colors.ink, 700, 'start', serif);
      art += history.map((frame, offset) => {
        const selected = offset === history.length - 1;
        const x = anchor + flip * offset * 68;
        const y = 98 + offset * 81 - (selected ? (1 - progress) * 37 : 0);
        return slide(rect(0, 0, 445, 69, selected ? colors.selected : colors.surface, 13) +
          keyline(0, 0, 445, 69, 13) + rect(7, 10, 3, 49, selected ? colors.selectedInk : colors.line, 1) +
          text(frame.label, 17, 24, 412, 14, selected ? colors.selectedInk : colors.ink, 700) +
          text(frame.metric, 17, 50, 412, 15, selected ? colors.selectedInk : colors.muted, 700, 'start', mono),
        x, y, selected ? progress : 1);
      }).join('');
      art += path('M28 347 H620', colors.line);
      art += text(current.state, 28, 382, 585, 19, colors.ink, 700, 'start', serif) +
        itemText(current, 28, 437, 591, 15, 4, colors.accent) +
        text(current.note, 28, 510, 591, 14, colors.muted);
      break;
    }
    case 'split': {
      const from = flip > 0 ? 20 : 399;
      const to = flip > 0 ? 399 : 20;
      const panel = (frame: typeof current, active: boolean) => {
        const ink = active ? colors.selectedInk : colors.ink;
        return rect(0, 0, 341, 260, active ? colors.selected : colors.surface, 10) +
          text(frame.label, 17, 30, 306, 16, ink, 700) +
          text(frame.metric, 17, 94, 309, 24, ink, 700, 'start', serif) +
          text(frame.state, 17, 160, 307, 15, ink, 600) +
          path('M17 188 H322', active ? colors.selectedInk : colors.line, 1) + itemText(frame, 17, 208, 307, 13, 4, ink);
      };
      art += text(plan.title, 25, 46, 711, 25, colors.ink, 700, 'start', serif);
      if (index > 0) art += slide(panel(previous, false), from, 106);
      art += slide(panel(current, true), index ? to + flip * (1 - progress) * 44 : (width - 341) / 2, 106, progress);
      if (index > 0) {
        const direction = 380 + flip * (progress - .5) * 12;
        art += path(`M${direction - flip * 12} 235 H${direction + flip * 12} m${-flip * 6} -7 l${flip * 6} 7 l${-flip * 6} 7`, colors.accent, 3);
      }
      art += text(current.note, 25, 403, 711, 14, colors.muted);
      break;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${definitions}${art}</svg>`;
}
