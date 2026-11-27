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
  // FR-R3-119 — the construction moved. `wireStage2()` in `src/extension.ts` was 1,221
  // lines; its backend-execution collaborators are now built in
  // `src/activation/backend-execution-wiring.ts`, which is `src/activation/` — the
  // directory ARCHITECTURE.md calls the composition root. This gate follows the
  // construction rather than the filename.
  const extension = read('src/activation/backend-execution-wiring.ts');

  it('constructs the recorder against the audit writer', () => {
    // Against `auditWriter.append`, and not some other sink: the append-only writer
    // is the single audit author, and a recorder wired to anything else would be a
    // second one.
    expect(extension).toContain('new ProcessTreeDegradationRecorder(');
    expect(extension).toMatch(/new ProcessTreeDegradationRecorder\(\s*\(e\)\s*=>\s*auditWriter\.append\(e\)\s*\)/);
  });

  it('routes the sidecar arm into it', () => {
    // The arm and the call, together. Either one alone is a disconnected half.
    //
    // COMMENTS STRIPPED FIRST, and that is not tidiness. This gate used to read the
    // raw file for `event.kind === 'tree-unconfirmed'`, and FR-R3-137 left exactly
    // that string in a COMMENT — one explaining why the code no longer tests it,
    // because the four branches above exhaust the union and
    // `no-unnecessary-condition` reports the re-test as always true. The gate went
    // green off the prose while the arm it pins had changed shape underneath. A
    // source-reading gate a comment can satisfy is the FR-R3-114 shape.
    const code = extension
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    // One expression, so the arm and the call cannot drift apart the way a
    // 400-character window would have allowed. The `satisfies` is what now
    // addresses this arm to the tree-unconfirmed event: it is also the compile-time
    // pin that a sixth event kind must not silently land here.
    expect(code).toMatch(
      /treeDegradationRecorder\.record\(event satisfies \{ kind: 'tree-unconfirmed' \}\)/
    );
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
