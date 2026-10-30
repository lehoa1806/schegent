/**
 * FR-R3-112 (FR-125) — walk the audit log's hash chain and name the FIRST break.
 *
 * WHY THIS EXISTS. `T3` in the threat model says the audit log is writable by the agent it audits:
 * the CLI runs with the OS user's authority and `.schegent/audit.log` is an ordinary 0600 file in
 * the workspace. Until FR-R3-112 that was disclosed and nothing more, which made every record this
 * round added operational telemetry rather than evidence — against the one actor the log describes.
 *
 * WHAT IT ESTABLISHES, stated precisely because "tamper-proof" would be wrong. Each entry carries
 * the digest of the previous entry's bytes, so editing one entry breaks its successor's link and
 * this names the first break. Tampering becomes **evident**, not impossible: the chain head is on
 * the same disk, so an attacker who can edit the log can also recompute every later digest. What
 * they cannot do is edit one entry and leave the rest alone.
 *
 * ROTATION AND PRUNING. The chain crosses rotation boundaries, and a retention prune writes a cut
 * record naming the removed range's boundary digests. A discontinuity with a well-formed cut record
 * verifies as a prune; one without it is a break. Without that, every routine prune would report
 * tampering and the verifier would be turned off within a week.
 *
 * Outcomes:
 *   0  the chain verifies (or there is no log yet, which is not a failure)
 *   1  a break, named
 *   2  the chain could not be read at all — an unanswerable check is a refusal, never a pass
 */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAuditChainAt } from '../src/audit/audit-chain.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_DIR = join(ROOT, '.schegent');

let read;
try {
  // The file set, its order and the walk all come from `src/audit/audit-chain.ts`, which
  // the evidence-health surface's verify command also reads. Two copies of "which files are
  // the chain, and in what order" is how a verifier and a host come to disagree about whether
  // a log is intact.
  read = verifyAuditChainAt(AUDIT_DIR);
} catch (error) {
  console.error(`audit:verify: could-not-answer  ${error.code ?? 'read failed'}`);
  process.exit(2);
}

// FR-R4-F03 (R18) — this script reads no checkpoint: the head checkpoint is kept in the extension's per-user
// storage, which a script run from a shell has no way to find. So it never reports a loss verdict, and it
// says so on EVERY run, so that a clean exit is never mistaken for one.
const LOSS_CHECK_LINE =
  "audit:verify: loss check: not performed (the checkpoint is kept in the extension's per-user storage, " +
  'which this script does not read)';

if (read === null) {
  // No audit file is not a broken log. But this script cannot tell a new workspace from history that went
  // missing: only the extension, which holds the checkpoint, can.
  console.log(
    'audit:verify: no audit file is present; this script cannot tell a new workspace from missing history'
  );
  console.log(LOSS_CHECK_LINE);
  process.exit(0);
}

const verdict = read.verdict;
console.log(
  `audit:verify: scanned ${read.files.ordered.length} file(s): ${read.files.ordered.join(', ')}`
);
if (read.files.unrecognized.length > 0) {
  // Named, not skipped. A file beside the log whose name this script does not recognize is
  // either an operator's own copy or an archive shape that has changed; reporting it as
  // unread is the only honest option, because reading it in the wrong position would produce
  // a false break and dropping it silently is what the integer-suffix bug did.
  console.log(
    `audit:verify: NOT read (unrecognized name): ${read.files.unrecognized.join(', ')}`
  );
}
console.log(
  'audit:verify: NOT checked — whether the CONTENT of any entry is true; whether entries were ' +
    'removed AND a matching cut record forged; anything about a log this machine has never seen; ' +
    'whether recent entries were removed (loss detection needs the extension)'
);

if (verdict.ok) {
  console.log(
    `audit:verify: ok  ${verdict.entries} entr${verdict.entries === 1 ? 'y' : 'ies'} chained, ` +
      `${verdict.cuts} legitimate cut(s)`
  );
  // FR-R4-F03 (FR-001, FR-003, FR-009) — how the chain began, what retention removed, and each damage the
  // log itself diagnoses. A diagnosed damage is reported and exits 0: it is recorded, not repaired.
  if (verdict.transition !== null) console.log(`audit:verify: transition: ${verdict.transition}`);
  if (verdict.prunedLegacy > 0) console.log(`audit:verify: pruned legacy rows: ${verdict.prunedLegacy}`);
  for (const damage of verdict.damages) {
    console.log(
      `audit:verify: diagnosed damage: ${damage.file} line ${damage.line}, ${damage.byteLength} bytes, ` +
        `sha256 ${damage.digestPrefix}`
    );
  }
  if (verdict.unchainedPrefix > 0) {
    // Reported, never hidden: a log that is mostly unchained verifies trivially, and an operator
    // reading "ok" deserves to know how much of their history the chain actually covers.
    console.log(
      `audit:verify: ${verdict.unchainedPrefix} leading entr${verdict.unchainedPrefix === 1 ? 'y' : 'ies'} ` +
        'predate the chain (FR-R3-112) and are NOT covered by it. They are excused only as a ' +
        'leading prefix — an unchained entry after a chained one is reported as a removal.'
    );
  }
  // Last, so the output of a clean run ENDS with it (quickstart section 4).
  console.log(LOSS_CHECK_LINE);
  process.exit(0);
}

console.log(LOSS_CHECK_LINE);
console.error(`audit:verify: ${verdict.reason} at entry ${verdict.atEntry}`);
console.error(`  ${verdict.detail}`);
console.error(
  '  This names the FIRST break only: a broken link makes every later link unverifiable, so ' +
    'reporting them all would bury the one that matters.'
);
process.exit(1);
