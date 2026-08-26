// FR-R3-085 (PRIV-01) — what is kept, where, for how long, DERIVED from the
// constants that enforce it.
//
// WHY DERIVED AND NOT WRITTEN
//
// This exact class has recurred three times in this round: operator-facing text
// asserting a property nothing checks (`R-14`), a manifest promising a record the
// contract did not declare (`D2`), and a document describing a product that had
// changed underneath it (`F-08`). Each time the fix was an edit, and each time
// the text drifted again.
//
// So every bound below is READ from the constant that enforces it. There is no
// second number to keep in step, and `tests/lint/retention-disclosure-parity.test.ts`
// fails if the rendered document and these constants disagree.
//
// WHAT THIS DOES NOT CHANGE. Errors-only remains the default capture posture.
// This describes what is retained; it does not alter what is captured.
import { AUDIT_PAYLOAD_MAX_BYTES } from '../audit/audit-payload';
import { MAX_ARTIFACT_BYTES } from './evidence-export';
import { CLI_TRANSPORT_MAX_BYTES } from '../monitor/cli-transport-sink';
import {
  CHECKPOINT_MAX_AGE_MS,
  CHECKPOINT_MAX_TOTAL_BYTES,
  CHECKPOINT_RECENT_RUN_FLOOR
} from './run-checkpoint-retention';
import { AUDIT_ROTATION_DEFAULT_AGE_MS, AUDIT_ROTATION_DEFAULT_SIZE_BYTES } from '../audit/audit-log-writer';

export interface RetentionEntry {
  /** What is held. */
  readonly artifact: string;
  /** Where it lives, relative to the workspace or named as private storage. */
  readonly location: string;
  /** Whether its CONTENT is redacted. The raw transcript deliberately is not. */
  readonly redacted: boolean;
  /** The bound, in the words a reader needs, derived from a constant. */
  readonly bound: string;
  /** The constant this bound came from, so a reader can check it. */
  readonly source: string;
}

const days = (ms: number): number => Math.round(ms / 86_400_000);
const mib = (bytes: number): number => Math.round(bytes / (1024 * 1024));
const kib = (bytes: number): number => Math.round(bytes / 1024);

/**
 * The disclosure, as data. Rendering is separate so the same facts can reach a
 * document, a command and a test without three copies of them.
 */
export function retentionDisclosure(): readonly RetentionEntry[] {
  return Object.freeze([
    {
      artifact: 'Structured audit log',
      location: '.schegent/audit.log (plus timestamped rotations)',
      redacted: true,
      bound: `rotates at ${mib(AUDIT_ROTATION_DEFAULT_SIZE_BYTES)} MiB or ${days(
        AUDIT_ROTATION_DEFAULT_AGE_MS
      )} days, whichever comes first`,
      source: 'AUDIT_ROTATION_DEFAULT_SIZE_BYTES / AUDIT_ROTATION_DEFAULT_AGE_MS in src/audit/audit-log-writer.ts'
    },
    {
      artifact: 'Audit event payload',
      location: 'inside each audit entry',
      redacted: true,
      bound: `each payload is truncated above ${kib(AUDIT_PAYLOAD_MAX_BYTES)} KiB`,
      source: 'AUDIT_PAYLOAD_MAX_BYTES in src/audit/audit-payload.ts'
    },
    {
      artifact: 'Raw session transcript',
      location: '.schegent/sessions/raw-<runId>.log',
      // Stated plainly. This is the threat model's declared position, not an
      // oversight, and it is the reason an operator needs this disclosure at all.
      redacted: false,
      bound: 'kept for `always`, or promoted for a non-clean Run under `errors-only`; governed by the session-retention settings',
      source: 'src/audit/raw-transcript-writer.ts; schegent.logging.* settings'
    },
    {
      artifact: 'CLI transport generations',
      location: '.schegent/sessions/',
      redacted: true,
      bound: `bounded at ${mib(CLI_TRANSPORT_MAX_BYTES)} MiB`,
      source: 'CLI_TRANSPORT_MAX_BYTES in src/monitor/cli-transport-sink.ts'
    },
    {
      artifact: 'Export of a run\'s evidence',
      location: 'the directory you choose when you run the export',
      redacted: true,
      bound: `each artifact is carried up to ${mib(
        MAX_ARTIFACT_BYTES
      )} MiB; anything larger is omitted and the manifest says which and why`,
      source: 'MAX_ARTIFACT_BYTES in src/services/evidence-export.ts'
    },
    {
      artifact: 'Private recovery checkpoints',
      location: "the extension's globalStorage — deliberately outside the workspace",
      redacted: false,
      bound: `${days(CHECKPOINT_MAX_AGE_MS)} days and ${mib(
        CHECKPOINT_MAX_TOTAL_BYTES
      )} MiB total, with the ${CHECKPOINT_RECENT_RUN_FLOOR} most recent Run directories protected from the size limit`,
      source: 'CHECKPOINT_MAX_AGE_MS / CHECKPOINT_MAX_TOTAL_BYTES / CHECKPOINT_RECENT_RUN_FLOOR in src/services/run-checkpoint-retention.ts'
    }
  ]);
}

/** The disclosure as a Markdown table, for the operator document. */
export function renderRetentionDisclosure(): string {
  const rows = retentionDisclosure()
    .map(
      (entry) =>
        `| ${entry.artifact} | \`${entry.location}\` | ${
          entry.redacted ? 'redacted' : '**not redacted**'
        } | ${entry.bound} | \`${entry.source}\` |`
    )
    .join('\n');
  return [
    '| Artifact | Location | Content | Bound | Derived from |',
    '|---|---|---|---|---|',
    rows
  ].join('\n');
}
