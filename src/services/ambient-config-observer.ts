// FR-R3-105 (FR-066) — observe the backend CLI's own configuration, without recording it.
//
// THE GAP. A narrowed argv defers to whatever the CLI's ambient configuration says. The
// host neither pinned nor read that file, so evidence could answer "which bound did the
// host apply" and not "and was that bound the operative one". The threat model discloses
// the trust anchor — the backend CLI honouring its own flags — but not that a local config
// file can widen a narrowed set with every flag honoured.
//
// OBSERVE, NOT PIN. Pinning (`--settings`) is the stronger answer and the source item
// names it as the destination "if the CLI's flag is stable". Whether it is stable cannot be
// established without a live turn, which costs operator quota, so this delivers the
// minimum the item sets — read and record — and the pinning decision is recorded as
// deferred rather than taken on an assumption.
//
// WHAT IS RECORDED, AND WHAT MUST NOT BE. A digest of the observed values, plus the names
// of the keys read. **Not the path**: AGENTS.md forbids serializing workspace paths into
// the structured audit log, and a home-directory path is worse because it carries the
// operator's username. **Not the values**: a settings file can hold an API key. A digest
// answers the question evidence actually needs — did the ambient configuration change
// between these two Runs — without the log becoming a copy of it.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AmbientConfigObservation } from '../contracts/audit-events';
import type { BackendRunnerKind } from '../contracts/backend-kinds';

/** A minimal read seam, so tests never touch a real home directory. */
export interface AmbientConfigReader {
  readonly readFile: (path: string) => Promise<string>;
}

/**
 * Where each backend keeps its ambient configuration.
 *
 * `null` for a backend with none known. Absence is reported as `null` rather than as an
 * empty observation, because "there is no such file" and "the file is empty" are different
 * facts and an operator reading evidence should be able to tell them apart.
 */
function configPathFor(kind: BackendRunnerKind): string | null {
  switch (kind) {
    case 'claude':
      return join(homedir(), '.claude', 'settings.json');
    case 'codex':
      return join(homedir(), '.codex', 'config.toml');
    case 'agy':
      return null;
    default:
      return null;
  }
}

/**
 * The keys whose values are digested, in a fixed order.
 *
 * A fixed order matters: the digest must be stable across runs for the same content, and
 * object key order is not guaranteed. Only keys that could WIDEN an applied bound are
 * read — the point is not to fingerprint the operator's settings but to notice a change
 * that could have loosened a narrowing.
 */
export const OBSERVED_KEYS = ['permissions', 'allowedTools', 'disallowedTools', 'env'] as const;

export async function observeAmbientConfig(
  kind: BackendRunnerKind,
  reader: AmbientConfigReader
): Promise<AmbientConfigObservation | null> {
  const path = configPathFor(kind);
  if (path === null) return null;

  let raw: string;
  try {
    raw = await reader.readFile(path);
  } catch {
    // Unreadable and absent are the same answer for this purpose: nothing was observed.
    // Not a failure — most operators have no such file, and a missing file must not fail a
    // phase.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A TOML or malformed file cannot be keyed into, so the whole text is digested. The
    // observation is still useful — it changes when the file changes — and the empty key
    // list says the scope was the file rather than named keys.
    return { digest: digestOf(raw), keysObserved: [] };
  }

  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const present = OBSERVED_KEYS.filter((key) => record[key] !== undefined);
  const material = present.map((key) => `${key}=${JSON.stringify(record[key])}`).join('\n');
  return { digest: digestOf(material), keysObserved: present };
}

function digestOf(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex');
}
