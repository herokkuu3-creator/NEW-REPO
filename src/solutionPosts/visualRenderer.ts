import type { VisualPlan } from './visuals';
import { AccountDiagramLayout, paletteForAccount, VisualMotion } from './visualStyles';

const dimensions: Record<AccountDiagramLayout, [number, number]> = {
  timeline: [900, 420], spotlight: [640, 520], 'notebook-board': [760, 500], 'split-screen': [900, 480],
  terminal: [840, 440], stack: [640, 560], orbit: [760, 520], rail: [880, 420], matrix: [720, 520],
  ribbon: [920, 400], flow: [720, 520], blueprint: [840, 520], flashcards: [800, 460], dashboard: [900, 520], storyboard: [900, 500],
};
export function visualDimensions(plan: Pick<VisualPlan, 'layout'>): [number, number] {
  return dimensions[plan.layout as AccountDiagramLayout] ?? [720, 360];
}
const escape = (value: string) => value.replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
const fontFamily = (kind: string) => kind === 'mono' ? 'DejaVu Sans Mono,Consolas,monospace' :
  kind === 'serif' ? 'DejaVu Serif,Georgia,serif' : 'DejaVu Sans,Arial,sans-serif';
const words = (value: string, length: number) => {
  const lines: string[] = []; let rest = value;
  while (rest.length > length) {
    let cut = rest.lastIndexOf(' ', length);
    if (cut < length / 2) cut = length;
    lines.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart();
  }
  lines.push(rest); return lines;
};

/** Fifteen actual compositions. All show the same reviewed state data; none invent a trace. */
export function renderAccountVisualFrame(plan: VisualPlan, frameIndex: number, phase: number): string {
  const [w, h] = visualDimensions(plan); const layout = plan.layout as AccountDiagramLayout;
  const frame = plan.frames[frameIndex]!; const c = paletteForAccount(plan.theme);
  const mono = ['terminal', 'blueprint'].includes(layout); const font = mono ? 'mono' : layout === 'notebook-board' || layout === 'stack' ? 'serif' : 'sans';
  const rect = (x: number, y: number, width: number, height: number, fill: string, radius = 0, stroke = 'none', sw = 1) =>
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  const line = (x1: number, y1: number, x2: number, y2: number, color = c.line, width = 1, dash = '') =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
  const text = (value: string, x: number, y: number, size = 16, color = c.ink, weight = 500, anchor = 'start', family = font) =>
    `<text x="${x}" y="${y}" fill="${color}" font-family="${fontFamily(family)}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escape(value)}</text>`;
  const block = (value: string, x: number, y: number, width: number, height: number, preferred = 17, color = c.ink, weight = 600, anchor = 'start') => {
    let size = preferred;
    const charRatio = font === 'mono' ? .63 : .59;
    let lines = words(value, Math.max(4, Math.floor(width / (size * charRatio))));
    while (lines.length * size * 1.28 > height && size > 12) {
      size--; lines = words(value, Math.max(4, Math.floor(width / (size * charRatio))));
    }
    const baseline = y + Math.max(size, (height - lines.length * size * 1.28) / 2 + size);
    return lines.map((value, i) => text(value, anchor === 'middle' ? x + width / 2 : x, baseline + i * size * 1.28, size, color, weight, anchor)).join('');
  };
  const motion: VisualMotion = plan.motion ?? 'scan';
  const activeDecoration = (x: number, y: number, width: number, height: number) => {
    if (motion === 'scan') return line(x + width * phase, y + 3, x + width * phase, y + height - 3, c.selectedInk, 2);
    if (motion === 'pulse') return `<rect x="${x - 3}" y="${y - 3}" width="${width + 6}" height="${height + 6}" rx="7" fill="none" stroke="${c.accent}" stroke-width="${1 + phase * 3}" opacity="${.3 + phase * .7}"/>`;
    if (motion === 'slide') return `<path d="M ${x - 12 + phase * 9} ${y + height / 2 - 6} l 6 6 l -6 6" fill="none" stroke="${c.accent}" stroke-width="3"/>`;
    if (motion === 'wipe') return rect(x, y + height - 4, width * phase, 4, c.selectedInk);
    return `<circle cx="${x + width - 9}" cy="${y + 9}" r="${3 + phase * 4}" fill="${c.selectedInk}" opacity="${phase}"/>`;
  };
  const tile = (index: number, x: number, y: number, width: number, height: number, radius = 5, fill = c.surface) => {
    const active = frame.active.includes(index); const color = active ? c.selectedInk : c.ink;
    return `<g data-item="${index}" data-active="${active}">` +
      rect(x, y, width, height, active ? c.selected : fill, radius, active ? c.accent : c.line, active ? 2 : 1) +
      text(String(index), x + 7, y + 13, 10, color, 500, 'start', 'mono') +
      block(frame.items[index]!, x + 14, y + 13, width - 26, height - 19, 17, color) +
      (active ? activeDecoration(x, y, width, height) : '') + '</g>';
  };
  const grid = (x: number, y: number, width: number, height: number, columns: number, radius = 5) => {
    const rows = Math.ceil(frame.items.length / columns); const gap = 10;
    const tw = (width - (columns - 1) * gap) / columns; const th = (height - (rows - 1) * gap) / rows;
    return frame.items.map((_, i) => tile(i, x + (i % columns) * (tw + gap), y + Math.floor(i / columns) * (th + gap), tw, th, radius)).join('');
  };
  const footer = (center = false) => {
    const top = h - 112;
    return line(30, top, w - 30, top, c.line) +
      block(frame.state, 32, top + 10, w * .65 - 40, 48, 18, c.ink, 600, center ? 'middle' : 'start') +
      block(frame.metric, w * .65, top + 10, w * .35 - 32, 48, 23, c.accent, 700, 'middle') +
      block(frame.note, 32, h - 43, w - 64, 29, 14, c.muted, 400);
  };
  let background = rect(0, 0, w, h, c.background);
  let header = text(`${String(frameIndex + 1).padStart(2, '0')} / ${String(plan.frames.length).padStart(2, '0')}`, w - 34, 28, 12, c.muted, 600, 'end', 'mono') +
    block(plan.title, 32, 30, w - 90, 49, 27, c.ink, 700) + text(frame.label, 33, 101, 15, c.muted);
  let body = ''; let bottom = footer();
  const top = 126; const available = h - 258;
  switch (layout) {
    case 'timeline': {
      const cell = (w - 64) / frame.items.length;
      body += line(32, 193, w - 32, 193, c.accent, 3);
      frame.items.forEach((_, i) => {
        const x = 32 + i * cell;
        body += `<circle cx="${x + cell / 2}" cy="193" r="7" fill="${frame.active.includes(i) ? c.accent : c.line}"/>` +
          tile(i, x + 4, i % 2 ? 208 : 120, cell - 8, 64, 0);
      });
      break;
    }
    case 'spotlight': {
      body += grid(26, top, w * .57 - 36, available, 2, 0);
      const cx = w * .79; const cy = top + available / 2;
      body += `<circle cx="${cx}" cy="${cy}" r="${Math.min(106, available / 2)}" fill="${c.selected}"/>` +
        block(frame.metric, cx - 91, cy - 45, 182, 90, 27, c.selectedInk, 700, 'middle');
      bottom = line(26, h - 112, w - 26, h - 112, c.accent, 3) + block(frame.state, 28, h - 102, w - 56, 50, 21) + block(frame.note, 28, h - 46, w - 56, 34, 14, c.muted);
      break;
    }
    case 'notebook-board': {
      for (let y = 115; y < h - 120; y += 30) background += line(0, y, w, y, c.line, .6);
      background += line(55, 0, 55, h, '#c87873', 1.5);
      const rows = Math.ceil(frame.items.length / 2); const rowHeight = available / rows;
      frame.items.forEach((value, i) => {
        const x = 73 + (i % 2) * ((w - 100) / 2); const y = top + Math.floor(i / 2) * rowHeight;
        if (frame.active.includes(i)) body += rect(x - 8, y, (w - 122) / 2, rowHeight - 7, c.selected, 0);
        body += block(`${i}. ${value}`, x, y, (w - 150) / 2, rowHeight - 6, 20, frame.active.includes(i) ? c.selectedInk : c.ink, 500);
        if (frame.active.includes(i)) body += activeDecoration(x - 8, y, (w - 122) / 2, rowHeight - 7);
      });
      break;
    }
    case 'split-screen': {
      background += rect(w * .56, 0, w * .44, h, c.accent);
      header = block(plan.title, 28, 28, w * .56 - 52, 65, 28, c.ink, 700) + text(frame.label, 29, 111, 15, c.muted);
      body = grid(28, 137, w * .56 - 54, h - 202, 2, 0) +
        text('CURRENT STATE', w * .60, 75, 12, c.selectedInk, 700) +
        block(frame.state, w * .60, 102, w * .35, 135, 25, c.selectedInk) +
        block(frame.metric, w * .60, h - 191, w * .35, 65, 31, c.selectedInk, 700);
      bottom = block(frame.note, w * .60, h - 102, w * .35, 72, 15, c.selectedInk, 400) +
        text(`${frameIndex + 1} / ${plan.frames.length}`, 30, h - 27, 13, c.muted);
      break;
    }
    case 'terminal': {
      header = rect(0, 0, w, 33, c.surface) + [0, 1, 2].map((i) => `<circle cx="${22 + i * 18}" cy="16" r="5" fill="${c.accent}" opacity="${1 - i * .2}"/>`).join('') +
        block(plan.title, 28, 41, w - 56, 40, 25) + text(`> ${frame.label}`, 28, 108, 15, c.muted);
      const row = Math.min(30, available / frame.items.length);
      frame.items.forEach((value, i) => {
        const y = 128 + i * row;
        if (frame.active.includes(i)) body += rect(24, y - 16, w - 48, row, c.selected);
        body += text(`${frame.active.includes(i) ? '>' : ' '} [${i}] ${value}`, 34, y + 2, 16, frame.active.includes(i) ? c.selectedInk : c.ink, 500);
        if (frame.active.includes(i)) body += rect(w - 52, y - 13, 9, 15, c.selectedInk, 0) .replace('/>', ` opacity="${.25 + phase * .75}"/>`);
      });
      break;
    }
    case 'stack': {
      header = block(plan.title, 35, 27, w - 70, 57, 27, c.ink, 700, 'middle') + text(frame.label, w / 2, 109, 15, c.muted, 500, 'middle');
      const columns = frame.items.length > 4 ? 2 : 1; const rows = Math.ceil(frame.items.length / columns);
      const th = (available - 10 * (rows - 1)) / rows; const tw = (w - 110) / columns - 14;
      frame.items.forEach((_, i) => {
        const x = 52 + (i % columns) * (tw + 24) + (i % 2) * 8; const y = top + Math.floor(i / columns) * (th + 10);
        body += rect(x + 4, y + 5, tw, th, c.line, 0) + tile(i, x, y, tw, th, 0);
      });
      bottom = footer(true); break;
    }
    case 'orbit': {
      const cx = w / 2; const cy = 125 + available / 2; const rx = w / 2 - 113; const ry = available / 2 - 20;
      body = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${c.line}" stroke-dasharray="3 6"/>`;
      frame.items.forEach((_, i) => {
        const angle = (i / frame.items.length) * Math.PI * 2 - Math.PI / 2;
        body += tile(i, cx + Math.cos(angle) * rx - 86, cy + Math.sin(angle) * ry - 28, 172, 56, 25);
      });
      body += `<circle cx="${cx}" cy="${cy}" r="53" fill="${c.background}" stroke="${c.accent}" stroke-width="2"/>` +
        block(frame.metric, cx - 50, cy - 41, 100, 82, 19, c.accent, 700, 'middle');
      bottom = line(30, h - 112, w - 30, h - 112) + block(frame.state, 32, h - 102, w - 64, 49, 19) + block(frame.note, 32, h - 45, w - 64, 31, 14, c.muted);
      break;
    }
    case 'rail': {
      body += rect(30, top - 4, 8, available + 10, c.accent);
      const rows = Math.ceil(frame.items.length / 2); const th = available / rows;
      frame.items.forEach((value, i) => {
        const x = 62 + (i % 2) * ((w - 100) / 2); const y = top + Math.floor(i / 2) * th;
        body += line(x, y + th - 4, x + (w - 130) / 2, y + th - 4);
        if (frame.active.includes(i)) body += rect(x, y, (w - 130) / 2, th - 6, c.selected, 0) + activeDecoration(x, y, (w - 130) / 2, th - 6);
        body += block(`${i}  ${value}`, x + 9, y, (w - 150) / 2, th - 7, 17, frame.active.includes(i) ? c.selectedInk : c.ink);
      });
      break;
    }
    case 'matrix': {
      body = grid(30, top, w - 60, available, frame.items.length > 4 ? 4 : 2, 0);
      for (let x = 20; x < w; x += 20) background += line(x, 118, x, h - 126, c.line, .3);
      break;
    }
    case 'ribbon': {
      const tw = (w - 60) / frame.items.length;
      frame.items.forEach((_, i) => {
        const y = 126 + (i % 2) * 20;
        body += tile(i, 30 + i * tw + 3, y, tw - 6, 96, 0);
        body += line(30 + i * tw + 3, y - 8, 30 + (i + 1) * tw - 3, y - 8, c.accent, 4);
      });
      bottom = rect(0, h - 112, w, 112, c.surface) + footer(); break;
    }
    case 'flow': {
      const tw = w * .46 - 43; const rows = frame.items.length; const th = available / rows;
      frame.items.forEach((value, i) => {
        const y = top + i * th;
        body += line(30, y + th / 2, 43, y + th / 2, c.accent, 3) +
          block(value, 51, y, tw - 10, th - 2, 16, frame.active.includes(i) ? c.accent : c.ink, frame.active.includes(i) ? 700 : 500);
        if (frame.active.includes(i)) body += line(49, y + th - 2, 49 + (tw - 10) * phase, y + th - 2, c.accent, 3);
      });
      body += line(w * .48, top, w * .48, top + available, c.line, 2) +
        text('STATE', w * .54, top + 16, 12, c.muted, 700) + block(frame.state, w * .54, top + 35, w * .40, available - 35, 25);
      bottom = line(30, h - 112, w - 30, h - 112) + block(frame.metric, 30, h - 102, w - 60, 49, 24, c.accent, 700, 'middle') + block(frame.note, 30, h - 43, w - 60, 29, 14, c.muted);
      break;
    }
    case 'blueprint': {
      for (let x = 0; x < w; x += 24) background += line(x, 0, x, h, c.line, .4);
      for (let y = 0; y < h; y += 24) background += line(0, y, w, y, c.line, .4);
      body = grid(44, top, w - 88, available, 2, 0) +
        line(24, top, 24, top + available, c.accent, 1.5) + line(w - 24, top, w - 24, top + available, c.accent, 1.5);
      for (let y = top; y <= top + available; y += 16) body += line(18, y, 30, y, c.accent);
      break;
    }
    case 'flashcards': {
      const selected = frame.active[0] ?? 0;
      body += rect(40, 130, w * .62, 119, c.line, 12) + tile(selected, 32, 122, w * .62, 119, 12) +
        block(frame.metric, w * .69, 126, w * .27, 110, 25, c.accent, 700, 'middle');
      const tw = (w - 64) / frame.items.length;
      body += frame.items.map((_, i) => tile(i, 32 + i * tw, 262, tw - 5, 70, 3)).join('');
      break;
    }
    case 'dashboard': {
      body += rect(28, top, w * .30, available, c.selected, 24) +
        text('MEASURE', 49, top + 28, 12, c.selectedInk, 700) + block(frame.metric, 48, top + 45, w * .30 - 38, available - 63, 30, c.selectedInk, 700, 'middle') +
        grid(w * .35, top, w * .65 - 29, available, 2, 12);
      bottom = line(30, h - 112, w - 30, h - 112) + block(frame.state, 32, h - 102, w - 64, 49, 20) + block(frame.note, 32, h - 43, w - 64, 29, 14, c.muted);
      break;
    }
    case 'storyboard': {
      const left = 30; const x2 = w * .39; const x3 = w * .77; const columnHeight = h - 190;
      body += rect(left, 121, w * .34, columnHeight, c.surface, 0, c.line) + rect(x2, 121, w * .34, columnHeight, c.surface, 0, c.line) +
        rect(x3, 121, w * .20, columnHeight, c.selected, 0);
      body += text('VALUES', left + 12, 145, 12, c.muted, 700) + text('CURRENT STATE', x2 + 12, 145, 12, c.muted, 700) + text('MEASURE', x3 + 10, 145, 11, c.selectedInk, 700);
      const rh = (columnHeight - 40) / frame.items.length;
      frame.items.forEach((value, i) => {
        const y = 156 + i * rh;
        if (frame.active.includes(i)) body += rect(left + 8, y, w * .34 - 16, rh - 3, c.selected) + activeDecoration(left + 8, y, w * .34 - 16, rh - 3);
        body += block(`${i}: ${value}`, left + 15, y, w * .34 - 30, rh - 4, 16, frame.active.includes(i) ? c.selectedInk : c.ink);
      });
      body += block(frame.state, x2 + 14, 161, w * .34 - 28, columnHeight - 54, 24) + block(frame.metric, x3 + 11, 161, w * .20 - 22, columnHeight - 54, 23, c.selectedInk, 700, 'middle');
      bottom = block(frame.note, 30, h - 55, w - 60, 39, 15, c.muted); break;
    }
  }
  // Progress describes playback only. It never interpolates algorithm values.
  const progress = (frameIndex + phase) / plan.frames.length;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<g data-layout="${layout}" data-motion="${motion}">${background}${header}${body}${bottom}` +
    rect(0, h - 4, w * progress, 4, c.accent) + '</g></svg>';
}
