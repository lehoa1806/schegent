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
//
// FR-R4-F03 — WHAT THIS MODULE NOW ALSO READS.
//
//   * TWO TRANSITION FORMS. A chain that began after legacy rows links to `genesis` (form A) or to the
//     digest of the last legacy row (form B, what a writer constructed over a legacy log produces). Both
//     verify, and nothing else does as the first link. A version 2 cut record carries the last legacy
//     row it removed, so a prune of that transition still verifies.
//   * DIAGNOSED DAMAGE. A final line that is not valid JSON is excused only when the next row says so,
//     naming its length and the SHA-256 of its raw bytes and linking to the row before it. It is
//     reported, never repaired.
//   * POSITIONS. The walk counts chained rows, including those retention removed, so a checkpoint's
//     position means the same thing to the writer and to this verifier.
//
// The module still imports nothing relative: `npm run audit:verify` loads it under
// `node --experimental-strip-types`, which resolves relative imports literally.
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

/**
 * A cut record, written by the retention prune so a removal is distinguishable from an edit.
 *
 * FR-R4-F03 (FR-003; data-model §3) — VERSION 2 adds three optional fields, written by this
 * release only. Absence of `version` means version 1, the shape that existed before. The counts
 * split `removedCount` (every non-empty removed line, as before) into what the verifier needs:
 * chained rows removed (chain positions), legacy rows removed (accounted to the cut instead of
 * left as uncovered rows), and the digest of the last legacy row removed, which is the first link
 * a form-B history carries.
 */
export interface AuditCutRecord {
  readonly kind: 'audit-cut';
  readonly cutAtMs: number;
  /** The digest the removed range began at, so a reader can see WHAT was removed. */
  readonly removedFrom: string;
  /** The digest the removed range ended at. The next surviving entry links to THIS. */
  readonly removedTo: string;
  readonly removedCount: number;
  /** 2 for a record this release wrote. Absent means version 1. */
  readonly version?: 2;
  /** Version 2: chained rows removed. */
  readonly removedChained?: number;
  /** Version 2: legacy rows (no `prevDigest`) removed. */
  readonly removedLegacy?: number;
  /** Version 2: digest of the last legacy row removed, present iff `removedLegacy > 0`. */
  readonly legacyTail?: string;
}

export interface AuditCutAccumulator {
  removedFrom: string | null;
  removedTo: string | null;
  removedCount: number;
  removedChained: number;
  removedLegacy: number;
  legacyTail: string | null;
}

export function createAuditCutAccumulator(): AuditCutAccumulator {
  return {
    removedFrom: null,
    removedTo: null,
    removedCount: 0,
    removedChained: 0,
    removedLegacy: 0,
    legacyTail: null
  };
}

export function appendCutLine(acc: AuditCutAccumulator, line: string): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  // An unparseable line in a file being deleted is not a boundary and not a chained
  // entry. It is counted, because the count describes what left.
  acc.removedCount += 1;
  const prev = prevDigestOf(trimmed);
  if (prev === undefined) return;
  if (prev === null) {
    acc.removedLegacy += 1;
    acc.legacyTail = digestOf(trimmed);
    return;
  }
  acc.removedChained += 1;
  if (acc.removedFrom === null) acc.removedFrom = prev;
  acc.removedTo = digestOf(trimmed);
}

/**
 * Scan a multi-line archive body in oldest-first line order without spreading
 * or allocating a full-file line array on the call stack (FR-R5-F13, FR-002).
 */
export function appendCutText(acc: AuditCutAccumulator, text: string): void {
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    appendCutLine(acc, text.slice(start, end));
    if (nl === -1) break;
    start = nl + 1;
  }
}

export function mergeAuditCutAccumulator(
  target: AuditCutAccumulator,
  next: Readonly<AuditCutAccumulator>
): void {
  target.removedCount += next.removedCount;
  target.removedChained += next.removedChained;
  target.removedLegacy += next.removedLegacy;
  if (next.legacyTail !== null) target.legacyTail = next.legacyTail;
  if (target.removedFrom === null && next.removedFrom !== null) {
    target.removedFrom = next.removedFrom;
  }
  if (next.removedTo !== null) target.removedTo = next.removedTo;
}

export function finalizeAuditCutRecord(
  acc: Readonly<AuditCutAccumulator>,
  cutAtMs: number
): AuditCutRecord | null {
  const { removedFrom, removedTo, removedCount, removedChained, removedLegacy, legacyTail } = acc;
  if (removedFrom === null || removedTo === null) {
    if (removedLegacy === 0 || legacyTail === null) return null;
    return {
      kind: 'audit-cut',
      cutAtMs,
      removedFrom: AUDIT_CHAIN_GENESIS,
      removedTo: AUDIT_CHAIN_GENESIS,
      removedCount,
      version: 2,
      removedChained: 0,
      removedLegacy,
      legacyTail
    };
  }
  return {
    kind: 'audit-cut',
    cutAtMs,
    removedFrom,
    removedTo,
    removedCount,
    version: 2,
    removedChained,
    removedLegacy,
    ...(removedLegacy > 0 && legacyTail !== null ? { legacyTail } : {})
  };
}

/**
 * The cut record a prune should write for a removed range, or `null` when none is owed.
 *
 * `null` HAS ONE MEANING NOW: nothing was removed that the chain needs to account for. An empty
 * removal owes nothing, and neither does one of only unparseable lines (counted nowhere a link or a
 * position could use). A removal of only PRE-CHAIN entries used to owe nothing too, on the argument
 * that writing a cut for them would move `expected` off genesis and make form A look broken. The
 * verifier no longer moves `expected` for such a cut (contract V2): it writes a LEGACY-ONLY cut,
 * `genesis`/`genesis`, which an older verifier reads as a no-op and the current one reads as "these
 * legacy rows were pruned, and the last of them was `legacyTail`". Without it, a prune that removed
 * the last legacy row left a form-B history linking to a digest no retained byte produces.
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
  const acc = createAuditCutAccumulator();
  for (const line of removedLines) {
    appendCutLine(acc, line);
  }
  return finalizeAuditCutRecord(acc, cutAtMs);
}

/**
 * The `prevDigest` of one removed line: a string for a chained row, `null` for a legacy row (an
 * object with no `prevDigest`), `undefined` for a line that is not a JSON object at all.
 */
function prevDigestOf(trimmed: string): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const prev = (parsed as { prevDigest?: unknown }).prevDigest;
  return typeof prev === 'string' ? prev : null;
}

/**
 * Whether a value has the shape of a cut record of ANY version. The version and the version-2
 * fields are judged by the walk, so a record from a newer release is reported as such rather than
 * silently read as an ordinary row (contract V2).
 */
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

/** Whether a record that carries `version: 2` has the version-2 fields this release writes. */
function isWellFormedVersion2Cut(record: AuditCutRecord): boolean {
  const { removedChained, removedLegacy, legacyTail } = record;
  if (typeof removedChained !== 'number' || typeof removedLegacy !== 'number') return false;
  return removedLegacy === 0 ? legacyTail === undefined : typeof legacyTail === 'string';
}

/**
 * How the first chained link was accepted (FR-001, FR-002; contract V1): `genesis` (form A), or the
 * digest of the last legacy row (form B). `null` in a verdict with no chained row.
 */
export type ChainTransition = 'genesis' | 'legacy-tail';

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
      /**
       * Legacy rows that retention removed and a version-2 cut record accounts for (R2). Reported
       * beside `unchainedPrefix` so the two together say how much history the chain does not cover.
       */
      readonly prunedLegacy: number;
      /** How the first chained link was accepted, or `null` when no chained row was walked. */
      readonly transition: ChainTransition | null;
      /**
       * Damaged lines the log itself diagnoses (FR-008, FR-009; contract V3), in walk order. A
       * diagnosed damage is reported, kept and walked past; it is neither an intact chain nor an
       * undiagnosed `malformed` one.
       */
      readonly damages: readonly DiagnosedDamage[];
      /** Where the walk ended, in chain positions (FR-016; contract V4). */
      readonly positions: ChainPositions;
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
 * Chain positions: the 1-based count of CHAINED rows from the start of the chain, including rows
 * retention removed (data-model §1; R14). Damage and reset rows are chained rows and count; damaged
 * fragments and legacy rows do not. The writer counts the same way when it adopts a history, so a
 * checkpoint's position means the same thing to both.
 */
export interface ChainPositions {
  /** The sum of `removedChained` (version 2) or `removedCount` (version 1) over every cut applied. */
  readonly prunedThrough: number;
  /** The position of the last chained row, or `prunedThrough` when none is retained. */
  readonly tail: number;
  /** The position of the first chained row whose digest is the probe, when a probe was asked for. */
  readonly probe: { readonly digest: string; readonly foundAt: number | null } | null;
}

/** One damaged line the log diagnoses, named without any of its bytes. */
export interface DiagnosedDamage {
  /** The file's basename, as found. */
  readonly file: string;
  /** 1-based line in that file. */
  readonly line: number;
  readonly byteLength: number;
  /** The first 12 hex characters of the line's SHA-256, for operator text. */
  readonly digestPrefix: string;
}

/**
 * The three literals a damage diagnosis is made of, RESTATED here with no import (R18, TA5): this
 * module is loaded by `npm run audit:verify` under `node --experimental-strip-types`, which resolves
 * relative imports literally. `audit-integrity-condition-payload.test.ts` pins them equal to the
 * contracts module's constants, so they cannot drift apart unseen.
 */
export const CHAIN_DAMAGE_EVENT_TYPE = 'audit-integrity-condition';
export const CHAIN_DAMAGE_CONDITION = 'damaged-tail';
export const CHAIN_DAMAGE_CONDITION_VERSION = 1;

const DAMAGE_DIGEST_PREFIX_LENGTH = 12;

/** What `verifyChain` can be told beside the lines (contract V3, V5). */
export interface VerifyChainOptions {
  /**
   * Where each line came from, in the same order as `lines`: its file, its 1-based line and its
   * RAW bytes. Without it a line's bytes are taken from its decoded text, which is exact for every
   * line that decoded cleanly.
   */
  readonly sources?: readonly ChainLineSource[];
  /** A row digest to find: the head a checkpoint names. Its position is reported in `positions.probe`. */
  readonly probeDigest?: string;
}

/** The detail of a cut written before this release whose range began at a legacy digest. */
const PRE_FEATURE_CUT_DETAIL =
  'a cut written before this release removed the start of the chain, so its first link cannot be ' +
  'checked (it names a legacy row\'s digest that no retained byte produces)';

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
export function verifyChain(
  lines: readonly string[],
  options: VerifyChainOptions = {}
): ChainVerdict {
  /** The digest the next link must equal, once the chain has begun. */
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
  /** Legacy rows accounted to a version-2 cut record. */
  let prunedLegacy = 0;
  /**
   * FR-R4-F03 (FR-001, FR-002; contract V1) — the digest of the most recent legacy item in walk
   * order: a retained legacy row's digest, or a version-2 cut's `legacyTail`. While no chained link
   * has been accepted, the first link is accepted if it is `genesis` or this digest, and nothing
   * else. Form B (a writer constructed over a legacy log seeds from its last line) links to it;
   * form A (a chain that began on an empty log) links to genesis. Accepting any other digest would
   * accept an unproven first link, which FR-002 forbids.
   */
  let legacyTail: string | null = null;
  let transition: ChainTransition | null = null;
  /** True once a first link has been accepted. From then on the walk is strict. */
  let chainBegun = false;
  const damages: DiagnosedDamage[] = [];
  /** Chained rows retention removed, summed over the cuts applied (contract V4). */
  let prunedThrough = 0;
  let probeFoundAt: number | null = null;

  for (const [index, raw] of lines.entries()) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    let parsed: ChainLine['parsed'];
    try {
      parsed = JSON.parse(trimmed) as ChainLine['parsed'];
    } catch {
      // A line that does not parse is DIAGNOSED damage only when the next non-empty line says so,
      // byte for byte (contract V3); the walk then skips it and carries on from that row.
      const damage = diagnoseDamage(lines, index, options.sources, chainBegun ? expected : legacyTail);
      if (damage !== null) {
        damages.push(damage);
        continue;
      }
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
      const version: unknown = parsed.version ?? 1;
      if (version !== 1 && version !== 2) {
        // A cut a newer release wrote is never applied on a guess (data-model §3).
        return {
          ok: false,
          reason: 'malformed',
          atEntry: index + 1,
          detail: 'a cut record is of a version this release does not understand'
        };
      }
      if (version === 2 && !isWellFormedVersion2Cut(parsed)) {
        return {
          ok: false,
          reason: 'malformed',
          atEntry: index + 1,
          detail: 'a version 2 cut record does not carry the fields that version defines'
        };
      }
      cuts += 1;
      prunedThrough += version === 2 ? parsed.removedChained ?? 0 : parsed.removedCount;
      const removedLegacy = version === 2 ? parsed.removedLegacy ?? 0 : 0;
      if (removedLegacy > 0) {
        prunedLegacy += removedLegacy;
        legacyTail = parsed.legacyTail ?? legacyTail;
      }
      if (
        version === 2
        && parsed.removedChained === 0
        && parsed.removedFrom === AUDIT_CHAIN_GENESIS
        && parsed.removedTo === AUDIT_CHAIN_GENESIS
      ) {
        // A legacy-only cut moves no link: it sets the legacy tail and nothing else.
        continue;
      }
      // A prune. The chain resumes from where the removed range ended.
      const accepted = chainBegun
        ? parsed.removedFrom === expected
        : parsed.removedFrom === AUDIT_CHAIN_GENESIS || parsed.removedFrom === legacyTail;
      if (!accepted) {
        return {
          ok: false,
          reason: 'broken-link',
          atEntry: index + 1,
          detail: !chainBegun && version === 1
            ? PRE_FEATURE_CUT_DETAIL
            : `a cut record claims to remove a range starting at ${parsed.removedFrom}, but the ` +
              `chain was at ${chainBegun ? expected : AUDIT_CHAIN_GENESIS} — entries were removed ` +
              'without a cut record covering them'
        };
      }
      if (!chainBegun) {
        chainBegun = true;
        transition = parsed.removedFrom === AUDIT_CHAIN_GENESIS ? 'genesis' : 'legacy-tail';
      }
      expected = parsed.removedTo;
      continue;
    }

    const prev = parsed.prevDigest;
    if (typeof prev !== 'string') {
      if (!chainBegun) {
        // Pre-FR-R3-112. Excused as a prefix, counted, and remembered as the legacy tail, which is
        // what a form-B chain's first row links to.
        unchainedPrefix += 1;
        legacyTail = digestOf(trimmed);
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
    const linksCorrectly = chainBegun
      ? prev === expected
      : prev === AUDIT_CHAIN_GENESIS || prev === legacyTail;
    if (!linksCorrectly) {
      return {
        ok: false,
        reason: 'broken-link',
        atEntry: index + 1,
        detail: chainBegun
          ? `entry links to ${prev} but the previous entry hashes to ${expected}. Either this ` +
            'entry or an earlier one was modified, or entries were removed without a cut record.'
          : `entry links to ${prev}, but the first link of a chain must be genesis or the digest ` +
            'of the last legacy entry before it'
      };
    }
    if (!chainBegun) {
      chainBegun = true;
      transition = prev === AUDIT_CHAIN_GENESIS ? 'genesis' : 'legacy-tail';
    }
    expected = digestOf(trimmed);
    entries += 1;
    if (probeFoundAt === null && expected === options.probeDigest) probeFoundAt = prunedThrough + entries;
  }

  const probe = options.probeDigest === undefined ? null : { digest: options.probeDigest, foundAt: probeFoundAt };
  const positions: ChainPositions = { prunedThrough, tail: prunedThrough + entries, probe };
  return { ok: true, entries, cuts, unchainedPrefix, prunedLegacy, transition, damages, positions };
}

/**
 * The diagnosis of the unparseable line at `index`, or `null` when the log does not make one.
 *
 * ALL FOUR MUST HOLD (contract V3, R6): the next non-empty line parses as an `audit-integrity-condition`
 * row with condition `damaged-tail` at a version this release knows; its recorded byte length and
 * SHA-256 equal those of THIS line's raw bytes; and its `prevDigest` is the digest of the last valid
 * row before the damage (`before`, with `null` meaning genesis). A diagnosis that matched on less
 * would let a row written for one fragment excuse another, and the damaged line would stop being
 * evidence of what was found.
 */
function diagnoseDamage(
  lines: readonly string[],
  index: number,
  sources: readonly ChainLineSource[] | undefined,
  before: string | null
): DiagnosedDamage | null {
  let next = index + 1;
  while (next < lines.length && (lines[next] as string).trim().length === 0) next += 1;
  if (next >= lines.length) return null;
  let row: { eventType?: unknown; prevDigest?: unknown; payload?: Record<string, unknown> | null };
  try {
    row = JSON.parse((lines[next] as string).trim()) as typeof row;
  } catch {
    return null;
  }
  const payload = row.payload;
  if (row.eventType !== CHAIN_DAMAGE_EVENT_TYPE || typeof payload !== 'object' || payload === null) return null;
  if (payload.condition !== CHAIN_DAMAGE_CONDITION || payload.conditionVersion !== CHAIN_DAMAGE_CONDITION_VERSION) {
    return null;
  }
  const source = sources?.[index];
  const bytes = source?.bytes ?? Buffer.from(lines[index] as string, 'utf8');
  const digest = createHash(AUDIT_DIGEST_ALG).update(bytes).digest('hex');
  if (payload.byteLength !== bytes.length || payload.digest !== digest) return null;
  if (row.prevDigest !== (before ?? AUDIT_CHAIN_GENESIS)) return null;
  return {
    file: source?.file ?? AUDIT_LOG_BASENAME,
    line: source?.line ?? index + 1,
    byteLength: bytes.length,
    digestPrefix: digest.slice(0, DAMAGE_DIGEST_PREFIX_LENGTH)
  };
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
 * One line of a chain file, as bytes.
 *
 * FR-R4-F03 (FR-008; contract V5) — a torn write can cut a multi-byte UTF-8 sequence, and decoding
 * it replaces the cut bytes with U+FFFD, so a digest of the decoded text would not match what is on
 * disk. The walk therefore splits each file's `Buffer` on `0x0A` and keeps the raw bytes beside the
 * decoded line. `bytes` is everything between two newlines (or a file boundary): never trimmed, and
 * never decoded before it is digested.
 */
export interface ChainLineSource {
  /** The file's basename, as found. */
  readonly file: string;
  /** 1-based line in that file. */
  readonly line: number;
  /** Offset of the line's first byte in the file. */
  readonly byteOffset: number;
  readonly bytes: Buffer;
}

/** Split one chain file's bytes into its lines. A file ending in a newline ends with an empty line. */
export function splitChainBytes(file: string, content: Buffer): ChainLineSource[] {
  const sources: ChainLineSource[] = [];
  let start = 0;
  for (let line = 1; ; line += 1) {
    const newline = content.indexOf(0x0a, start);
    const end = newline === -1 ? content.length : newline;
    sources.push({ file, line, byteOffset: start, bytes: content.subarray(start, end) });
    if (newline === -1) return sources;
    start = newline + 1;
  }
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
export function verifyAuditChainAt(
  auditDir: string,
  options: Pick<VerifyChainOptions, 'probeDigest'> = {}
): ChainCheck | null {
  const files = collectChainFiles(auditDir);
  if (files === null) return null;
  const sources: ChainLineSource[] = [];
  for (const name of files.ordered) {
    for (const source of splitChainBytes(name, readFileSync(join(auditDir, name)))) {
      sources.push(source);
    }
  }
  return {
    files,
    verdict: verifyChain(
      sources.map((source) => source.bytes.toString('utf8')),
      { sources, ...options }
    )
  };
}

/**
 * `verifyAuditChainAt`, with each chain file read through `readFile`. The writer passes its canonical
 * walk, so a planted archive link is refused there rather than followed out of the workspace.
 */
export async function verifyAuditChainThrough(
  auditDir: string,
  readFile: (name: string) => Promise<Buffer>,
  options: Pick<VerifyChainOptions, 'probeDigest'> = {}
): Promise<ChainCheck | null> {
  const files = collectChainFiles(auditDir);
  if (files === null) return null;
  const sources: ChainLineSource[] = [];
  for (const name of files.ordered) {
    for (const source of splitChainBytes(name, await readFile(name))) {
      sources.push(source);
    }
  }
  return {
    files,
    verdict: verifyChain(
      sources.map((source) => source.bytes.toString('utf8')),
      { sources, ...options }
    )
  };
}

/**
 * The last line of the chain, read as bytes (FR-007; contract W3, R5).
 *
 * `valid` says whether it parses as a JSON object. For a valid tail, `digest` is what the next row
 * must link to. For an invalid one, `previousDigest` is the digest of the nearest valid row before it
 * in walk order, or `null` when there is none, which is what the damage row must link to.
 */
export interface ChainTail {
  /** The file's basename, as found: the live log, or the newest archive when the log is empty. */
  readonly file: string;
  /** 1-based line in that file. */
  readonly line: number;
  readonly byteOffset: number;
  /** The line's raw bytes, without any terminator. */
  readonly bytes: Buffer;
  /** Whether a newline follows the line in its file. */
  readonly endsWithNewline: boolean;
  readonly valid: boolean;
  readonly digest: string | null;
  readonly previousDigest: string | null;
}

const isBlank = (bytes: Buffer): boolean => bytes.toString('latin1').trim().length === 0;

function parsesAsObject(bytes: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8').trim());
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Read the chain's last non-empty line, or `null` when no chain file holds one.
 *
 * READ-ONLY, and the cut file is excluded: it is not part of the walk's tail. Files are read as
 * BYTES and never decoded before they are digested, because a torn write can cut a multi-byte
 * character in half and a digest of the decoded text would not match what is on disk. The newest
 * file comes first, so a live log that is absent or empty (a rotation whose next write failed)
 * falls back to the newest archive instead of starting a second chain mid-history.
 *
 * `readFile` is injected so the writer can read through its safe walk, where a planted `.schegent`
 * symlink must be refused; the default reads the path as the verifier does.
 */
export async function readChainTail(
  auditDir: string,
  readFile: (name: string) => Promise<Buffer> = (name) => Promise.resolve(readFileSync(join(auditDir, name)))
): Promise<ChainTail | null> {
  const files = collectChainFiles(auditDir);
  if (files === null) return null;
  const names = files.ordered.filter((name) => name !== AUDIT_CUTS_BASENAME);
  let tail: Omit<ChainTail, 'previousDigest'> | null = null;
  for (let at = names.length - 1; at >= 0; at -= 1) {
    const name = names[at] as string;
    const content = await readFile(name);
    const lines = splitChainBytes(name, content);
    for (let from = lines.length - 1; from >= 0; from -= 1) {
      const source = lines[from] as ChainLineSource;
      if (isBlank(source.bytes)) continue;
      if (tail === null) {
        const valid = parsesAsObject(source.bytes);
        tail = {
          file: name,
          line: source.line,
          byteOffset: source.byteOffset,
          bytes: source.bytes,
          endsWithNewline: source.byteOffset + source.bytes.length < content.length,
          valid,
          digest: valid ? digestOf(source.bytes.toString('utf8').trim()) : null
        };
        if (valid) return { ...tail, previousDigest: null };
        continue;
      }
      if (parsesAsObject(source.bytes)) {
        return { ...tail, previousDigest: digestOf(source.bytes.toString('utf8').trim()) };
      }
    }
  }
  return tail === null ? null : { ...tail, previousDigest: await readCutLink(auditDir, readFile) };
}

/**
 * Where the walk stands after the cut records alone, before it reads any retained row: the `removedTo` of
 * the last cut that moves the link, else the `legacyTail` of the last legacy-only cut, else `null`
 * (genesis). A prune can remove every retained row, so a tail check that finds no valid row (before its
 * damage, or at all) links HERE, which is where the verifier resumes the chain.
 */
export async function readCutLink(
  auditDir: string,
  readFile: (name: string) => Promise<Buffer> = (name) => Promise.resolve(readFileSync(join(auditDir, name)))
): Promise<string | null> {
  if (collectChainFiles(auditDir)?.ordered.includes(AUDIT_CUTS_BASENAME) !== true) return null;
  let expected: string | null = null;
  let legacyTail: string | null = null;
  for (const raw of (await readFile(AUDIT_CUTS_BASENAME)).toString('utf8').split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isAuditCutRecord(parsed)) continue;
    if ((parsed.removedLegacy ?? 0) > 0 && parsed.legacyTail !== undefined) legacyTail = parsed.legacyTail;
    const legacyOnly = parsed.version === 2 && parsed.removedChained === 0
      && parsed.removedFrom === AUDIT_CHAIN_GENESIS && parsed.removedTo === AUDIT_CHAIN_GENESIS;
    if (!legacyOnly) expected = parsed.removedTo;
  }
  return expected ?? legacyTail;
}
