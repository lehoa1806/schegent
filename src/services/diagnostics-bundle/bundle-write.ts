// FR-R4-F04 (FR-034, B5, B7; data-model §8) — serialize a diagnostics bundle within its limit, and write it.
//
// THE LIMIT IS ON THE SERIALIZED FILE. Each item was already cut to its share of CONTENT bytes
// (`bundle-collect.ts`), but JSON escapes newlines and quotes, so the serialized form is larger than the sum of
// its contents. `serializeBundle` measures the real text and, while it is over `DIAGNOSTICS_BUNDLE_MAX_BYTES`,
// halves the largest truncatable item (from the front, keeping the newest content) and marks it truncated. It
// ends at or under the limit, or with every item emptied, whichever comes first; the manifest records each
// item's final bytes and whether it was cut, so the file says what it lost.
//
// THE WRITE IS THE EXPORT WRITE (E3, E5). The destination was accepted by `resolveExportDestination` before
// anything was created; the file is opened through the checked walk beneath its resolved parent, `0600`, so a
// link in any component refuses and an existing file is narrowed and truncated. The text is written once.

import * as path from 'node:path';

import { resolveWritableAnchor } from '../../lib/path-containment';
import { openWithinRoot } from '../../lib/safe-open';
import { truncateFront, type CollectedItem } from './bundle-collect';
import { DIAGNOSTICS_BUNDLE_MAX_BYTES, type BundleItemId, type OmittedItem } from './bundle-plan';

export interface DiagnosticsBundle {
  readonly version: 1;
  readonly manifest: {
    readonly runId: string;
    readonly createdAt: string;
    readonly hostVersion: string;
    readonly rawConversationIncluded: boolean;
    readonly included: readonly { readonly item: BundleItemId; readonly bytes: number; readonly truncated: boolean }[];
    readonly omitted: readonly OmittedItem[];
  };
  readonly items: readonly { readonly item: BundleItemId; readonly runId: string; readonly content: string }[];
}

export interface SerializedBundle {
  readonly bundle: DiagnosticsBundle;
  readonly text: string;
  /** UTF-8 bytes of `text`. */
  readonly bytes: number;
}

export interface BundleInput {
  readonly runId: string;
  readonly createdAt: Date;
  readonly hostVersion: string;
  readonly rawConversationIncluded: boolean;
  readonly items: readonly CollectedItem[];
  readonly omitted: readonly OmittedItem[];
}

/** The most rounds of shrinking: each halves an item, so a few dozen empties anything the limit could hold. */
const MAX_SHRINK_ROUNDS = 64;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

function assemble(input: BundleInput, items: readonly CollectedItem[]): SerializedBundle {
  const bundle: DiagnosticsBundle = {
    version: 1,
    manifest: {
      runId: input.runId,
      createdAt: input.createdAt.toISOString(),
      hostVersion: input.hostVersion,
      rawConversationIncluded: input.rawConversationIncluded,
      included: items.map((entry) => ({ item: entry.item, bytes: entry.bytes, truncated: entry.truncated })),
      omitted: input.omitted
    },
    items: items.map((entry) => ({ item: entry.item, runId: entry.runId, content: entry.content }))
  };
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  return { bundle, text, bytes: utf8Bytes(text) };
}

/** Serialize within `DIAGNOSTICS_BUNDLE_MAX_BYTES`, shrinking the largest item from the front while it is over. */
export function serializeBundle(input: BundleInput, limit: number = DIAGNOSTICS_BUNDLE_MAX_BYTES): SerializedBundle {
  let items = [...input.items];
  let result = assemble(input, items);
  for (let round = 0; round < MAX_SHRINK_ROUNDS && result.bytes > limit; round += 1) {
    const sizes = items.map((entry) => entry.bytes);
    const largest = sizes.indexOf(Math.max(...sizes, 0));
    const target = items.at(largest);
    // Nothing left that can shrink: every item is empty, and what remains is framing.
    if (target === undefined || target.bytes === 0) break;
    const cut = truncateFront(target.content, Math.floor(target.bytes / 2));
    items = items.map((entry, index) =>
      index === largest ? { ...entry, content: cut.text, bytes: utf8Bytes(cut.text), truncated: true } : entry
    );
    result = assemble(input, items);
  }
  return result;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `schegent-diagnostics-<runId>-<YYYYMMDDTHHMMSSZ>.json`, UTC. */
export function bundleFileName(runId: string, at: Date): string {
  const stamp =
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
  return `schegent-diagnostics-${runId}-${stamp}.json`;
}

/**
 * Write `text` to `destination` (a path `resolveExportDestination` accepted), `0600`, through the checked walk.
 * `true` when the whole text landed.
 */
export async function writeBundleFile(destination: string, text: string): Promise<boolean> {
  const located = await resolveWritableAnchor(path.dirname(destination));
  if (located === null || located.tail.length > 0) return false;
  const opened = await openWithinRoot(located.anchor, [path.basename(destination)], { flags: 'w', fileMode: 0o600 });
  if (opened.outcome === 'refused') return false;
  try {
    await opened.handle.write(text, null, 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}
