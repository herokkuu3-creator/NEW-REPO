import { createInterface } from 'node:readline/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prisma } from '../src/database/prisma';
import { contextSchema, generateArticle } from '../src/solutionPosts/article';
import { createPostRouter, generateForRun, retryPost } from '../src/solutionPosts/service';
import { RoutingError } from '../src/solutionPosts/router';
import { approvePost } from '../src/solutionPosts/store';
import { publishPost, reconcilePost } from '../src/solutionPosts/publisher';
import { runCombined, setSelectedAccounts } from '../src/solutionPosts/scheduler';

/** Explicit CLI actions; invoking the menu never enables scheduling as a side effect. */
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'sample') {
    if (!args[0] || !args[1]) throw new Error('Usage: solution:post sample <context.json> <output.md>');
    const context = contextSchema.parse(JSON.parse(await readFile(resolve(args[0]), 'utf8')));
    const result = await generateArticle(await createPostRouter(), context, []).catch(async error => {
      if (error instanceof RoutingError) await writeFile(resolve(args[1]!) + '.metadata.json', JSON.stringify({
        status: 'FAILED', attempts: error.attempts }, null, 2), 'utf8');
      throw error;
    });
    await writeFile(resolve(args[1]), `# ${result.title}\n\n${result.markdown}`, 'utf8');
    await writeFile(resolve(args[1]) + '.metadata.json', JSON.stringify({ model: result.model,
      reviewModel: result.reviewModel, style: result.style, attempts: result.attempts }, null, 2), 'utf8');
    console.log(`Sample written to ${resolve(args[1])}; no publication or database change`);
    return;
  }
  if (command === 'generate') {
    if (!args[0] || !args[1]) throw new Error('Usage: solution:post generate <accountId> <runId>');
    console.log(await generateForRun(args[0], args[1])); return;
  }
  if (command === 'history') {
    console.table(await prisma.solutionPost.findMany({ select: { id: true, accountId: true, problemSlug: true,
      status: true, model: true, lastError: true, publishedUrl: true }, orderBy: { createdAt: 'desc' }, take: 50 })); return;
  }
  if (command === 'preview') {
    if (!args[0] || !args[1]) throw new Error('Usage: solution:post preview <postId> <output.md>');
    const post = await prisma.solutionPost.findUniqueOrThrow({ where: { id: args[0] } });
    if (!post.markdown) throw new Error('No completed draft');
    await writeFile(resolve(args[1]), `# ${post.title}\n\n${post.markdown}`, 'utf8');
    console.log(`Review hash: ${post.contentHash}`); return;
  }
  if (command === 'retry') { if (!args[0]) throw new Error('postId required'); console.log(await retryPost(args[0])); return; }
  if (command === 'approve') {
    if (!args[0] || !args[1]) throw new Error('Usage: solution:post approve <postId> <reviewedContentHash>');
    console.log(await approvePost(args[0], args[1])); return;
  }
  if (command === 'publish') { if (!args[0]) throw new Error('postId required'); console.log(await publishPost(args[0])); return; }
  if (command === 'reconcile') {
    if (!args[0] || !args[1]) throw new Error('Usage: solution:post reconcile <postId> <publishedURL>');
    console.log(await reconcilePost(args[0], args[1])); return;
  }
  if (command && !['daily', 'schedule'].includes(command)) throw new Error('Commands: generate, daily, schedule, history, preview, retry, approve, publish, reconcile, sample');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const action = command ?? (await rl.question('Operation (daily / schedule / history): ')).trim();
    if (action === 'history') { console.table(await prisma.solutionPost.findMany({ select: { id: true, problemSlug: true, status: true }, take: 50 })); return; }
    if (!['daily', 'schedule'].includes(action)) throw new Error('Unknown operation');
    const accounts = await prisma.account.findMany({ where: { status: { not: 'DISABLED' } }, orderBy: { label: 'asc' } });
    accounts.forEach((a, i) => console.log(`${i + 1}. ${a.label} (${a.username ?? 'identity not verified'})`));
    const answer = (await rl.question('Select account numbers separated by commas, all, or clear: ')).trim();
    let ids: string[];
    if (answer === 'all') ids = accounts.map(a => a.id);
    else if (answer === 'clear') ids = [];
    else {
      const indexes = answer.split(',').map(v => Number(v.trim()) - 1);
      if (indexes.some(i => !Number.isInteger(i) || !accounts[i])) throw new Error('Invalid account selection');
      ids = [...new Set(indexes.map(i => accounts[i]!.id))];
    }
    console.log(`${action}: ${ids.length} accounts; schedule 06:00 Asia/Kolkata; generate, validate, and publish when SOLUTION_POST_AUTO_PUBLISH=true.`);
    if ((await rl.question('Apply this selection? Type yes: ')).trim() !== 'yes') return;
    console.log(action === 'schedule' ? await setSelectedAccounts(ids) : await runCombined(ids));
  } finally { rl.close(); }
}

main().catch(error => { console.error('Solution operation failed. Check configuration, account identity, and solution history.');
  if (error instanceof RoutingError) console.error(JSON.stringify(error.attempts)); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
