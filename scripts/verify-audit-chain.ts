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

if (read === null) {
  // No log is not a broken log. A fresh workspace, or one that has never run a phase.
  console.log('audit:verify: no audit log present, nothing to verify');
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
    'removed AND a matching cut record forged; anything about a log this machine has never seen'
);

if (verdict.ok) {
  console.log(
    `audit:verify: ok  ${verdict.entries} entr${verdict.entries === 1 ? 'y' : 'ies'} chained, ` +
      `${verdict.cuts} legitimate cut(s)`
  );
  if (verdict.unchainedPrefix > 0) {
    // Reported, never hidden: a log that is mostly unchained verifies trivially, and an operator
    // reading "ok" deserves to know how much of their history the chain actually covers.
    console.log(
      `audit:verify: ${verdict.unchainedPrefix} leading entr${verdict.unchainedPrefix === 1 ? 'y' : 'ies'} ` +
        'predate the chain (FR-R3-112) and are NOT covered by it. They are excused only as a ' +
        'leading prefix — an unchained entry after a chained one is reported as a removal.'
    );
  }
  process.exit(0);
}

console.error(`audit:verify: ${verdict.reason} at entry ${verdict.atEntry}`);
console.error(`  ${verdict.detail}`);
console.error(
  '  This names the FIRST break only: a broken link makes every later link unverifiable, so ' +
    'reporting them all would bury the one that matters.'
);
process.exit(1);
