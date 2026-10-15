import { Prisma, SolutionPost } from '@prisma/client';
import { prisma } from '../database/prisma';
import { contextSchema, hash, SubmissionContext } from './article';

export const transitions: Record<string, readonly string[]> = {
  PENDING: ['CHECKING_ELIGIBILITY'], CHECKING_ELIGIBILITY: ['GENERATING', 'FAILED', 'SKIPPED'],
  GENERATING: ['VALIDATING', 'FAILED'], VALIDATING: ['DRAFT_READY', 'FAILED'],
  DRAFT_READY: ['AWAITING_APPROVAL', 'PUBLISHING', 'SKIPPED'], AWAITING_APPROVAL: ['DRAFT_READY'],
  PUBLISHING: ['PUBLISHED'], PUBLISHED: [], FAILED: ['RETRY_PENDING'], SKIPPED: [],
  RETRY_PENDING: ['CHECKING_ELIGIBILITY'],
};
export function assertTransition(from: string, to: string): void {
  if (!transitions[from]?.includes(to)) throw new Error(`Invalid solution state transition: ${from} -> ${to}`);
}

export async function ensurePost(context: SubmissionContext): Promise<SolutionPost> {
  contextSchema.parse(context);
  // The empty update must never replace the accepted source on a retry.
  return prisma.solutionPost.upsert({
    where: { accountId_problemSlug_intent: { accountId: context.accountId, problemSlug: context.slug, intent: 'community-solution' } },
    create: { accountId: context.accountId, problemSlug: context.slug, submissionId: context.submissionId,
      context: JSON.stringify(context), codeHash: hash(context.code) }, update: {},
  });
}

export async function move(post: SolutionPost, to: string, data: Prisma.SolutionPostUpdateManyMutationInput = {}) {
  assertTransition(post.status, to);
  const result = await prisma.solutionPost.updateMany({ where: { id: post.id, status: post.status,
    updatedAt: post.updatedAt }, data: { ...data, status: to } });
  if (result.count !== 1) throw new Error('Solution operation is already owned by another worker');
  return prisma.solutionPost.findUniqueOrThrow({ where: { id: post.id } });
}

export async function approvePost(id: string, contentHash: string): Promise<SolutionPost> {
  let post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  if (!post.markdown || !post.title || post.contentHash !== contentHash ||
    hash(`${post.title}\n${post.markdown}`) !== contentHash) throw new Error('Review hash does not match the current draft');
  // A crash between saving DRAFT_READY and AWAITING_APPROVAL must not strand a completed draft.
  if (post.status === 'DRAFT_READY' && !post.approvedHash) post = await move(post, 'AWAITING_APPROVAL');
  if (post.status === 'DRAFT_READY' && post.approvedHash === contentHash) return post;
  return move(post, 'DRAFT_READY', { approvedHash: contentHash });
}

/** Only generation is safely recoverable by lease. PUBLISHING always requires reconciliation. */
export async function recoverGeneration(now = new Date()): Promise<void> {
  await prisma.solutionPost.updateMany({ where: { status: { in: ['CHECKING_ELIGIBILITY', 'GENERATING', 'VALIDATING'] },
    leaseUntil: { lt: now } }, data: { status: 'RETRY_PENDING', leaseUntil: null,
    lastError: 'GENERATION_INTERRUPTED' } });
}
