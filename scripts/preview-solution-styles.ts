import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { presentationVariant } from '../src/solutionPosts/presentationStyles';
import { visualPreviewPlans } from '../src/solutionPosts/visualSamples';
import { renderVisualFrame, renderVisualGif } from '../src/solutionPosts/visuals';
import { visualDimensions } from '../src/solutionPosts/visualRenderer';

async function main() {
  const output = path.resolve(process.argv[2] ?? 'scratch/solution-visual-v2');
  await fs.mkdir(output, { recursive: true });
  const tiles: sharp.OverlayOptions[] = [];
  const manifest = [];
  for (let index = 0; index < 15; index++) {
    const presentation = presentationVariant(index); const plan = visualPreviewPlans(presentation)[0]!;
    if (process.argv.includes('--stress')) plan.frames = plan.frames.map((frame, frameIndex) => ({
      ...frame, label: 'A long label for the verified trace state',
      items: Array.from({ length: 8 }, (_, i) => `array[${i}] = 123456789012`), active: [frameIndex],
      state: `step=${frameIndex}; current state has several named values to show clearly`,
      metric: 'comparisons=1234567; remaining=123456',
      note: 'A longer explanatory note must fit without clipping or hiding the trace.',
    }));
    const svg = renderVisualFrame(plan, 0, .65); const gif = await renderVisualGif(plan);
    const basename = `${String(index + 1).padStart(2, '0')}-${plan.layout}`;
    await fs.writeFile(path.join(output, basename + '.svg'), svg);
    await fs.writeFile(path.join(output, basename + '.gif'), gif);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    await fs.writeFile(path.join(output, basename + '.png'), png);
    const thumbnail = await sharp(png).resize(450, 280, { fit: 'contain', background: '#e6e9ed' }).png().toBuffer();
    const label = Buffer.from(`<svg width="450" height="36"><rect width="450" height="36" fill="#fff"/><text x="12" y="24" font-family="Arial" font-size="16" fill="#172638">${index + 1}. ${plan.layout} / ${plan.theme}</text></svg>`);
    tiles.push({ input: thumbnail, left: (index % 3) * 450, top: Math.floor(index / 3) * 316 });
    tiles.push({ input: label, left: (index % 3) * 450, top: Math.floor(index / 3) * 316 + 280 });
    manifest.push({ index, presentation, dimensions: visualDimensions(plan), bytes: gif.length, basename });
  }
  await sharp({ create: { width: 1350, height: 1580, channels: 3, background: '#e6e9ed' } }).composite(tiles).png().toFile(path.join(output, 'comparison.png'));
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ output, styles: manifest.length, comparison: path.join(output, 'comparison.png') }));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Preview failed'); process.exitCode = 1; });
