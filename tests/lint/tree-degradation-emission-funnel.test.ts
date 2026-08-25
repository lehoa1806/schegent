import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FR-R3-083 — the runner's report actually reaches the audit writer.
 *
 * THE GAP THIS CLOSES
 *
 * Every other piece of the evidence path is tested, and none of them tested the
 * wire between them. Delete the `tree-unconfirmed` arm from `extension.ts`'s monitor
 * hook, or drop the recorder it constructs, and:
 *
 *   - `tree-escalation.test.ts` still passes — it asserts the emit through an
 *     injected hook;
 *   - `process-tree-degradation.test.ts` still passes — it constructs the recorder
 *     directly;
 *   - `runners-report-not-record.test.ts` still passes — it pins the layering, not
 *     the wiring.
 *
 * No `process-tree-unconfirmed` entry would ever be written again, with the whole
 * suite green, while `docs/operations/platform-observation-record.md` went on
 * recording that acceptance half as observed. The feature's headline claim would be
 * false and nothing would say so.
 *
 * This is the device `backend-posture-emission-funnel.test.ts` uses for the same
 * shape of one-site wiring, applied here.
 *
 * Hermetic (FR-R3-033): `readFileSync`, never a spawned binary.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, ...relPath.split('/')), 'utf8');
}

describe('the degraded-tree report reaches the audit writer (FR-R3-083)', () => {
  const extension = read('src/extension.ts');

  it('constructs the recorder against the audit writer', () => {
    // Against `auditWriter.append`, and not some other sink: the append-only writer
    // is the single audit author, and a recorder wired to anything else would be a
    // second one.
    expect(extension).toContain('new ProcessTreeDegradationRecorder(');
    expect(extension).toMatch(/new ProcessTreeDegradationRecorder\(\s*\(e\)\s*=>\s*auditWriter\.append\(e\)\s*\)/);
  });

  it('routes the sidecar arm into it', () => {
    // The arm and the call, together. Either one alone is a disconnected half.
    expect(extension).toContain("event.kind === 'tree-unconfirmed'");
    const arm = extension.slice(extension.indexOf("event.kind === 'tree-unconfirmed'"));
    expect(arm.slice(0, 400)).toContain('treeDegradationRecorder.record(event);');
  });

  it('keeps that the ONLY place the recorder is driven', () => {
    // A second driver would mean two entries per surviving group, or one written
    // from a site with no access to the hook's attribution.
    const drivers = extension.match(/treeDegradationRecorder\.record\(/g) ?? [];
    expect(drivers).toHaveLength(1);
  });

  it('has the recorder emit the declared event type', () => {
    // The last link: the type the recorder writes is the one the contract declares
    // and the classifier scopes. A rename on one side alone fails here.
    expect(read('src/controller/process-tree-degradation-recorder.ts')).toContain(
      "eventType: 'process-tree-unconfirmed'"
    );
    expect(read('src/contracts/audit-events.ts')).toContain(
      "export const PROCESS_TREE_EVENT_TYPES = ['process-tree-unconfirmed'] as const;"
    );
  });
});
