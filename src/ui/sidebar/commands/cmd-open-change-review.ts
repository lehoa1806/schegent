import {
  reviewRefused,
  type ChangeEntry,
  type ReviewOpened,
  type ReviewPage,
  type ReviewResult
} from '../../../contracts/change-review';
import { historyErrorCode } from '../../../services/history/error-code';
import type {
  ChangeReviewEditorOpenOutcome,
  OpenChangeReviewCommand,
  OpenChangeReviewResponse
} from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R6-F12 — gated concurrent immutable candidate change review operations.
// Spawns bounded git reads against candidate/target commit SHAs via `ChangeReviewApi` and
// optionally opens VS Code's native multi-file changes or single-file fallback diff editor.

const NO_EDITOR: ChangeReviewEditorOpenOutcome = { mode: 'none', opened: 0 };

function collectLoadedEntries(
  opened: ReviewOpened,
  readPage: (cursor: string) => ReviewResult<ReviewPage>
): readonly ChangeEntry[] {
  if (opened.state === 'unavailable') return [];
  const entries: ChangeEntry[] = [...opened.firstPage.entries];
  let cursor = opened.firstPage.nextCursor;
  let guard = 0;
  while (cursor !== null && guard < 16) {
    guard += 1;
    const next = readPage(cursor);
    if (!next.ok) break;
    entries.push(...next.value.entries);
    cursor = next.value.nextCursor;
  }
  return entries;
}

export const handler: CommandHandler<OpenChangeReviewCommand> = async (ctx, command) => {
  const payload = command.payload;
  const api = ctx.deps.changeReviewApi?.();
  if (!api) {
    if (payload.op === 'close') {
      await ack(ctx, 'accepted', undefined, { op: 'close', closed: false } satisfies OpenChangeReviewResponse);
      return;
    }
    if (payload.op === 'cancelOpen') {
      await ack(ctx, 'accepted', undefined, { op: 'cancelOpen', canceled: false } satisfies OpenChangeReviewResponse);
      return;
    }
    await ack(ctx, 'rejected', 'review-not-found');
    return;
  }

  try {
    switch (payload.op) {
      case 'open': {
        const result = await api.openReview({
          requestId: payload.requestId,
          ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision })
        });
        let editor = NO_EDITOR;
        if (result.ok && payload.openInEditor === true && ctx.deps.openReviewInEditor) {
          const entries = collectLoadedEntries(result.value, (cursor) => api.readPage({ cursor }));
          editor = await ctx.deps.openReviewInEditor(result.value, entries);
        }
        const response: OpenChangeReviewResponse = { op: 'open', result, editor };
        await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.reason, response);
        return;
      }
      case 'refresh': {
        const result = await api.refreshReview({ reviewId: payload.reviewId });
        let editor = NO_EDITOR;
        if (result.ok && payload.openInEditor === true && ctx.deps.openReviewInEditor) {
          const entries = collectLoadedEntries(result.value, (cursor) => api.readPage({ cursor }));
          editor = await ctx.deps.openReviewInEditor(result.value, entries);
        }
        const response: OpenChangeReviewResponse = { op: 'refresh', result, editor };
        await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.reason, response);
        return;
      }
      case 'classify': {
        const result = await api.classifyReview({ reviewId: payload.reviewId });
        const response: OpenChangeReviewResponse = { op: 'classify', result };
        await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.reason, response);
        return;
      }
      case 'page': {
        const result = api.readPage({ cursor: payload.cursor });
        const response: OpenChangeReviewResponse = { op: 'page', result };
        await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.reason, response);
        return;
      }
      case 'close': {
        const closed = api.closeReview({ reviewId: payload.reviewId });
        const response: OpenChangeReviewResponse = {
          op: 'close',
          closed: closed.ok ? closed.value.closed : false
        };
        await ack(ctx, 'accepted', undefined, response);
        return;
      }
      case 'cancelOpen': {
        const canceled = api.cancelOpen({});
        const response: OpenChangeReviewResponse = {
          op: 'cancelOpen',
          canceled: canceled.ok ? canceled.value.canceled : false
        };
        await ack(ctx, 'accepted', undefined, response);
        return;
      }
    }
  } catch (err) {
    ctx.deps.logger.warn(`sidebar router: change review command failed: ${historyErrorCode(err)}`);
    if (payload.op === 'open' || payload.op === 'refresh') {
      const response: OpenChangeReviewResponse = {
        op: payload.op,
        result: reviewRefused('review-not-found'),
        editor: NO_EDITOR
      };
      await ack(ctx, 'rejected', 'review-not-found', response);
      return;
    }
    await ack(ctx, 'rejected', 'review-not-found');
  }
};
