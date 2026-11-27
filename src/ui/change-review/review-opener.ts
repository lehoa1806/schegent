/**
 * FR-R6-F12 (FR-004, FR-014; contracts/change-review.md section 6) — opening a review in the editor.
 *
 * Native: one multi-file changes view holding every loaded entry in index order. Fallback, when the
 * editor has no such view: a fixed notice that names counts and no path, an inert pick list, and
 * one diff for the picked entry. An unavailable review opens nothing. The editor is reached only
 * through `EditorPort`, so this module has no editor import.
 */

import type { ChangeEntry, ChangeKind, ReviewOpened } from '../../contracts/change-review';
import { documentPath, displayName, pickLabel } from './review-uri';

export const CHANGES_COMMAND = 'vscode.changes';

const SHORT_COMMIT_CHARS = 8;

export interface ChangeTriple {
  readonly label: string;
  readonly left: string | undefined;
  readonly right: string | undefined;
}

/** The few editor calls the opener makes; paths are review document paths. */
export interface EditorPort {
  hasCommand(id: string): Promise<boolean>;
  openChanges(title: string, triples: readonly ChangeTriple[]): Promise<void>;
  showNotice(text: string): void;
  pick(labels: readonly string[]): Promise<number | undefined>;
  openDiff(left: string, right: string, title: string): Promise<void>;
}

export interface OpenedInEditor {
  readonly mode: 'native' | 'fallback' | 'none';
  readonly opened: number;
}

function shownPath(entry: ChangeEntry): string {
  return entry.newPath ?? entry.oldPath ?? '';
}

function tripleOf(entry: ChangeEntry): ChangeTriple {
  const left = entry.oldPath === null ? undefined : documentPath(entry.oldHandle, entry.oldPath);
  const right = entry.newPath === null ? undefined : documentPath(entry.newHandle, entry.newPath);
  return { label: right ?? left ?? '', left, right };
}

function fallbackNotice(loaded: number, total: number): string {
  return `The editor's multi-file review is not available. Pick a file to open its diff (${loaded} of ${total} files).`;
}

function diffTitle(entry: ChangeEntry, kind: ChangeKind): string {
  return `${displayName(shownPath(entry))} (${kind})`;
}

/** Opens `opened` in the editor and says how. */
export async function openReviewInEditor(
  port: EditorPort,
  opened: ReviewOpened,
  entries: readonly ChangeEntry[]
): Promise<OpenedInEditor> {
  if (opened.review === null) return { mode: 'none', opened: 0 };
  const review = opened.review;
  if (await port.hasCommand(CHANGES_COMMAND)) {
    const title = `Review ${review.targetCommit.slice(0, SHORT_COMMIT_CHARS)}..${review.candidateCommit.slice(0, SHORT_COMMIT_CHARS)}`;
    await port.openChanges(title, entries.map(tripleOf));
    return { mode: 'native', opened: entries.length };
  }
  port.showNotice(fallbackNotice(entries.length, review.total));
  const picked = await port.pick(entries.map((entry) => pickLabel(shownPath(entry))));
  const entry = picked === undefined ? undefined : entries.at(picked);
  if (entry === undefined) return { mode: 'fallback', opened: 0 };
  await port.openDiff(
    documentPath(entry.oldHandle, entry.oldPath ?? shownPath(entry)),
    documentPath(entry.newHandle, entry.newPath ?? shownPath(entry)),
    diffTitle(entry, entry.kind)
  );
  return { mode: 'fallback', opened: 1 };
}
