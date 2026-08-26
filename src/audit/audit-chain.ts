// FR-R3-112 (FR-124, FR-126, FR-126a) — make tampering with the audit log EVIDENT.
//
// THE THREAT, already disclosed as `T3` and until now only disclosed. The CLI runs with the OS
// user's authority and `.schegent/audit.log` is an ordinary 0600 file inside the workspace. So
// every capability-applied record, mutation-ledger entry and phase outcome this round added is
// **operational telemetry, not evidence**, against the one actor the log exists to describe: the
// agent can rewrite its own history and nothing would know.
//
// WHAT A CHAIN BUYS, and it is worth being precise because the word "tamper-proof" would be wrong.
// Each entry carries the digest of the previous entry's canonical bytes. Editing entry N changes its
// digest, so entry N+1's `prevDigest` no longer matches and a verifier names N as the first break.
// That makes tampering **evident**, not impossible: the chain head sits on the same disk as the log,
// so an attacker who can edit the log can also recompute every subsequent digest. What they cannot
// do is edit one entry and leave the rest alone, which is what casual tampering looks like.
//
// ROTATION AND PRUNING, which is where a naive chain breaks. The retention machinery rotates
// `audit.log` to `audit.log.N` and prunes old files, and pruning is the legitimate operation that
// most resembles tampering: entries disappear. A verifier that cried wolf on every routine prune
// would be turned off within a week. So:
//
//   * a rotated file's first entry carries the previous file's LAST digest, so the chain crosses
//     the seam rather than restarting;
//   * a prune writes an explicit CUT RECORD naming the removed range's boundary digests. A
//     discontinuity WITH a well-formed cut record verifies as a prune; one WITHOUT is a break.
//
// The signed-cut-point alternative was declined: it needs a key, and a key on the log's own disk
// adds no assurance the chain head does not already provide. `node:crypto` is the whole dependency
// (FR-129).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The digest algorithm, recorded per entry so a future change is readable rather than inferred. */
export const AUDIT_DIGEST_ALG = 'sha256';

/**
 * The digest of the FIRST entry in a chain that has no predecessor.
 *
 * A distinctive constant rather than an empty string: an empty `prevDigest` is indistinguishable
 * from a field that was dropped, and "the chain starts here" must not read the same as "someone
 * removed the link".
 */
export const AUDIT_CHAIN_GENESIS = 'genesis';

/**
 * The digest of one entry's canonical bytes.
 *
 * Over the SERIALIZED LINE, not over a re-serialization of the parsed object. A verifier reads
 * lines from disk, and hashing anything other than exactly what is on disk would make the chain
 * depend on both sides serializing identically — key order, number formatting, unicode escapes.
 * That is a coupling nobody would remember, and its failure mode is a verifier that reports
 * tampering on an untouched file.
 */
export function digestOf(line: string): string {
  return createHash(AUDIT_DIGEST_ALG).update(line, 'utf8').digest('hex');
}

/** A cut record, written by the retention prune so a removal is distinguishable from an edit. */
export interface AuditCutRecord {
  readonly kind: 'audit-cut';
  readonly cutAtMs: number;
  /** The digest the removed range began at, so a reader can see WHAT was removed. */
  readonly removedFrom: string;
  /** The digest the removed range ended at. The next surviving entry links to THIS. */
  readonly removedTo: string;
  readonly removedCount: number;
}

/**
 * The cut record a prune should write for a removed range, or `null` when none is owed.
 *
 * `null` HAS TWO MEANINGS AND BOTH ARE CORRECT. An empty removal owes nothing. A removal of
 * only PRE-CHAIN entries also owes nothing: those entries never advanced the chain, so their
 * absence shortens the unchained prefix and leaves every link intact. Writing a cut record for
 * them would move `expected` off genesis and make the first genuinely chained entry look
 * broken — a false alarm manufactured by the very mechanism meant to prevent one.
 *
 * The boundaries come from the removed lines themselves: `removedFrom` is what the chain was at
 * before the first removed chained entry (that entry's own `prevDigest`), and `removedTo` is the
 * digest of the last removed chained entry's bytes, which is exactly what the first surviving
 * entry links to. Derived, never assumed — a cut record whose boundaries were computed from
 * anything other than the bytes being deleted would verify a gap it had not actually measured.
 *
 * @param removedLines every line being removed, oldest first, across all files in one prune.
 */
export function cutRecordFor(
  removedLines: readonly string[],
  cutAtMs: number
): AuditCutRecord | null {
  let removedFrom: string | null = null;
  let removedTo: string | null = null;
  let removedCount = 0;
  for (const line of removedLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // An unparseable line in a file being deleted is not a boundary and not a chained
      // entry. It is counted, because the count describes what left.
      removedCount += 1;
      continue;
    }
    removedCount += 1;
    const prev = (parsed as { prevDigest?: unknown }).prevDigest;
    if (typeof prev !== 'string') continue;
    if (removedFrom === null) removedFrom = prev;
    removedTo = digestOf(trimmed);
  }
  if (removedFrom === null || removedTo === null) return null;
  return { kind: 'audit-cut', cutAtMs, removedFrom, removedTo, removedCount };
}

export function isAuditCutRecord(value: unknown): value is AuditCutRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<AuditCutRecord>;
  return (
    record.kind === 'audit-cut'
    && typeof record.cutAtMs === 'number'
    && typeof record.removedFrom === 'string'
    && typeof record.removedTo === 'string'
    && typeof record.removedCount === 'number'
  );
}

/** What a chain walk concluded. */
export type ChainVerdict =
  | {
      readonly ok: true;
      readonly entries: number;
      readonly cuts: number;
      /**
       * Leading entries written before the chain existed.
       *
       * Reported, never hidden: a log that is mostly unchained verifies trivially, and an operator
       * reading "ok" deserves to know how much of their history the chain actually covers.
       */
      readonly unchainedPrefix: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'broken-link' | 'malformed';
      /** 1-based index of the FIRST entry that does not verify. */
      readonly atEntry: number;
      readonly detail: string;
    };

interface ChainLine {
  readonly raw: string;
  readonly parsed: { prevDigest?: unknown; kind?: unknown } & Record<string, unknown>;
}

/**
 * Walk a chain and name the FIRST break.
 *
 * First, not all: a broken link makes every subsequent link unverifiable, so reporting them all
 * would bury the one that matters under noise that follows from it.
 *
 * `lines` is every line of the chain in order, oldest first — across files, since the chain crosses
 * rotation boundaries. The caller is responsible for that ordering because it knows the rotation
 * naming scheme and this does not.
 */
export function verifyChain(lines: readonly string[]): ChainVerdict {
  let expected = AUDIT_CHAIN_GENESIS;
  let entries = 0;
  let cuts = 0;
  /**
   * Entries written before FR-R3-112, which carry no `prevDigest`.
   *
   * WHY THIS ARM EXISTS. Every workspace that ran a phase before this feature has a log full of
   * unchained entries. Reporting them as tampering would mean the verifier's first run on every
   * existing installation says the audit log has been altered — false, alarming, and the fastest
   * possible route to nobody invoking it again.
   *
   * WHY IT IS A PREFIX AND NOT AN EXEMPTION. Only a LEADING run of unchained entries is excused.
   * Once a chained entry appears, an unchained one after it IS a break: that is exactly what
   * removing a link would look like, and treating it as "legacy" would be the fail-open this whole
   * mechanism exists to remove. The count is reported either way, so an operator can see how much
   * of the log the chain covers.
   */
  let unchainedPrefix = 0;
  let sawChainedEntry = false;

  for (const [index, raw] of lines.entries()) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    let parsed: ChainLine['parsed'];
    try {
      parsed = JSON.parse(trimmed) as ChainLine['parsed'];
    } catch {
      // A truncated final line is the expected shape of a power-loss casualty, and the disclosure
      // in the durability decision says so. It is reported as malformed rather than as tampering:
      // those have different remedies.
      return {
        ok: false,
        reason: 'malformed',
        atEntry: index + 1,
        detail: 'line is not valid JSON (a truncated final line is the usual cause)'
      };
    }

    if (isAuditCutRecord(parsed)) {
      // A prune. The chain resumes from where the removed range ended.
      if (parsed.removedFrom !== expected) {
        return {
          ok: false,
          reason: 'broken-link',
          atEntry: index + 1,
          detail:
            `a cut record claims to remove a range starting at ${parsed.removedFrom}, but the ` +
            `chain was at ${expected} — entries were removed without a cut record covering them`
        };
      }
      expected = parsed.removedTo;
      cuts += 1;
      continue;
    }

    const prev = parsed.prevDigest;
    if (typeof prev !== 'string') {
      if (!sawChainedEntry) {
        // Pre-FR-R3-112. Excused as a prefix, counted, and the chain still begins at genesis when
        // the first chained entry arrives.
        unchainedPrefix += 1;
        continue;
      }
      return {
        ok: false,
        reason: 'malformed',
        atEntry: index + 1,
        detail:
          'entry carries no prevDigest, and it follows entries that do. A missing link after a '
          + 'chained entry is a removal, not legacy data — legacy entries are only excused as a '
          + 'leading prefix.'
      };
    }
    if (prev !== expected) {
      return {
        ok: false,
        reason: 'broken-link',
        atEntry: index + 1,
        detail:
          `entry links to ${prev} but the previous entry hashes to ${expected}. Either this ` +
          'entry or an earlier one was modified, or entries were removed without a cut record.'
      };
    }
    expected = digestOf(trimmed);
    entries += 1;
    sawChainedEntry = true;
  }

  return { ok: true, entries, cuts, unchainedPrefix };
}

// ---------------------------------------------------------------------------
// Reading the chain off disk.
//
// WHY IT LIVES IN THIS FILE. Two callers need "which files are the chain, and in what order":
// `npm run audit:verify` and the evidence-health surface's verify command. The ordering is the
// part that is easy to get wrong and impossible to notice — an earlier draft of the script
// parsed the archive suffix as an integer, a shape this product has never written, so
// `Number.isFinite` silently dropped every archive and the verifier reported "ok" after
// reading one file. A verifier that reads less than it claims is worse than none.
//
// It is in THIS module rather than its own because the script runs under
// `node --experimental-strip-types`, which resolves relative imports literally: a separate
// module would have to import this one with a `.ts` extension, which `tsc` rejects. One file
// with no relative imports is what lets the script and the host share one authority instead of
// keeping two opinions about whether a log is intact.
// ---------------------------------------------------------------------------
export const AUDIT_LOG_BASENAME = 'audit.log';
export const AUDIT_CUTS_BASENAME = 'audit.log.cuts';

/**
 * The archive stamp shape `AuditLogWriter.maybeRotate` writes, current and legacy.
 *
 * Kept beside the reader rather than imported from the writer: the writer's copy governs
 * what it *creates* and this one governs what a verifier *accepts*, and a verifier that
 * accepted only what today's writer produces would stop reading yesterday's archives after
 * a naming change. They are deliberately the same today and independently changeable.
 */
const ARCHIVE_STAMP_RE = /^\d{8}-\d{6}(?:-\d{3}-[0-9a-f]{8})?$/;

export interface ChainFiles {
  /** Files to read, oldest first: the cut record, then archives, then the live log. */
  readonly ordered: readonly string[];
  /** Files beside the log whose names this reader does not recognize. Reported, never read. */
  readonly unrecognized: readonly string[];
}

/**
 * Which files make up the chain, in walk order.
 *
 * The cut file comes FIRST because a prune removes the oldest end of history: the surviving
 * entries link past the removed range, so the record explaining the gap has to be read
 * before the entries that follow it. Archives sort by their stamp, which is lexicographically
 * chronological. The live log is always last.
 */
export function collectChainFiles(auditDir: string): ChainFiles | null {
  if (!existsSync(auditDir)) return null;
  const names = readdirSync(auditDir).filter((name) => name.startsWith(AUDIT_LOG_BASENAME));
  if (names.length === 0) return null;

  const stamped: { name: string; stamp: string }[] = [];
  const unrecognized: string[] = [];
  for (const name of names) {
    if (name === AUDIT_LOG_BASENAME || name === AUDIT_CUTS_BASENAME) continue;
    const stamp = name.slice(AUDIT_LOG_BASENAME.length + 1);
    if (ARCHIVE_STAMP_RE.test(stamp)) stamped.push({ name, stamp });
    else unrecognized.push(name);
  }
  stamped.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));

  return {
    ordered: [
      ...(names.includes(AUDIT_CUTS_BASENAME) ? [AUDIT_CUTS_BASENAME] : []),
      ...stamped.map((entry) => entry.name),
      ...(names.includes(AUDIT_LOG_BASENAME) ? [AUDIT_LOG_BASENAME] : [])
    ],
    unrecognized
  };
}

export interface ChainCheck {
  readonly files: ChainFiles;
  readonly verdict: ChainVerdict;
}

/**
 * Verify the chain under one audit directory, or `null` when there is no log.
 *
 * No log is not a broken log — a fresh workspace has nothing to verify, and reporting that
 * as a failure would train an operator to ignore the one report that matters. Read errors
 * are NOT caught here: an unanswerable check must reach the caller as a refusal rather than
 * being flattened into a verdict, because "could not read" and "verified" are the two
 * answers that must never look alike.
 */
export function verifyAuditChainAt(auditDir: string): ChainCheck | null {
  const files = collectChainFiles(auditDir);
  if (files === null) return null;
  const lines: string[] = [];
  for (const name of files.ordered) {
    for (const line of readFileSync(join(auditDir, name), 'utf8').split('\n')) lines.push(line);
  }
  return { files, verdict: verifyChain(lines) };
}
