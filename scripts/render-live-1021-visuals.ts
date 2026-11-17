import os from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { renderVisualGif, VisualPlan } from '../src/solutionPosts/visuals';

const items = ['(', '(', ')', '(', ')', ')'];
const plans: VisualPlan[] = [
  {
    id: 'visual-1', after: 'intuition', title: 'Depth in Motion',
    caption: 'Outer shell skipped; inner structure kept.', theme: 'ocean',
    frames: [
      { label: 'Index 0 · outer open', items, active: [0], state: 'depth=1; skip', metric: 'depth=1', note: 'Outer opening is not appended.' },
      { label: 'Index 1 · inner open', items, active: [1], state: 'depth=2; keep', metric: 'depth=2', note: 'Inner opening is appended.' },
    ],
  },
  {
    id: 'visual-2', after: 'dryRun', title: 'The Boundary Clicks',
    caption: 'The inner close stays; the primitive shell does not.', theme: 'sunset',
    frames: [
      { label: 'Index 2 · inner close', items, active: [2], state: 'depth=1; keep', metric: 'output=()', note: 'Inner close is appended.' },
      { label: 'Index 5 · outer close', items, active: [5], state: 'depth=0; skip', metric: 'output=()()', note: 'Primitive boundary reached.' },
    ],
  },
];

async function main() {
  const outDir = os.tmpdir();
  await writeFile(path.join(outDir, 'leetcode-1021-visual-1.gif'), await renderVisualGif(plans[0]!));
  await writeFile(path.join(outDir, 'leetcode-1021-visual-2.gif'), await renderVisualGif(plans[1]!));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
