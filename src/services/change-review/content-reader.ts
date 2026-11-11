/**
 * FR-R6-F12 (FR-005, FR-015; research R2) — reading one side of a change.
 *
 * A side is read by object identity, so later commits, a moved target or a changed working tree
 * never alter what a live review shows. Binary and submodule sides are never read. Every failure
 * returns its fixed sentence, never Git output.
 */

import { placeholderRead, type ContentRead } from '../../contracts/change-review';
import type { ContentResource } from './content-handles';
import { readBlob, type ReviewGitContext } from './review-git';

/** The side of an added or deleted file that does not exist; it reads as empty text. */
export const ABSENT_SIDE = 'absent';

const GITLINK_MODE = '160000';

/** The text of `resource`, or the sentence that stands in for it. */
export async function readContentResource(ctx: ReviewGitContext, resource: ContentResource | null): Promise<ContentRead> {
  if (resource === null) return placeholderRead('unavailable');
  if (resource.mode === GITLINK_MODE) return placeholderRead('submodule');
  if (resource.binary) return placeholderRead('binary');
  const read = await readBlob(ctx, resource.blob);
  if (read.ok) return { kind: 'text', text: read.value };
  if (read.failure === 'oversized') return placeholderRead('oversized');
  if (read.failure === 'exit') return placeholderRead('missing');
  return placeholderRead('read-failed');
}
