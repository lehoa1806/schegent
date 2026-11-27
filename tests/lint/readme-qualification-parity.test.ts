/**
 * Post-merge review Priority 4 — keeps entry-point qualification claims in
 * `repo/README.md` and snapshot incompatibility ownership in `repo/ARCHITECTURE.md`
 * consistent with the dated evidence records and implementation.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

describe('Post-merge Priority 4 — README qualification and ARCHITECTURE snapshot ownership parity', () => {
  it('README macOS support row cites the dated live provider qualification log and distinguishes connectivity from OS containment', () => {
    const readme = read('README.md');
    const log = read('docs/release/backend-qualification-log.md');

    // Control: the qualification log records passed live turns for all three providers.
    expect(log).toMatch(/Claude.*Passed/i);
    expect(log).toMatch(/Codex.*Passed/i);
    expect(log).toMatch(/Agy.*Passed/i);

    // README must not still claim live macOS provider canaries are unqualified.
    expect(readme).not.toMatch(/live paid provider canary remains unqualified/i);
    expect(readme).toContain('docs/release/backend-qualification-log.md');
    expect(readme).toContain('docs/architecture/backend-containment-qualification.md');
    expect(readme).toMatch(/connectivity.*distinct from.*containment|distinct from OS containment/i);
    // Permission posture must qualify Codex containment per tuple rather than claiming a blanket qualification.
    expect(readme).toMatch(/containment-qualified tuple|unqualified Codex/i);
  });

  it('ARCHITECTURE Schema Versions table assigns incompatible-snapshot refusal to the webview receiver rather than host SnapshotTransport', () => {
    const arch = read('ARCHITECTURE.md');
    const hostTransport = read('src/ui/sidebar/snapshot-transport.ts');
    const webviewMerge = read('webview-ui/src/lib/snapshot-merge.ts');

    // Code ground truth: host forwards non-matching shapes as mode 'full'; receiver returns 'unknown-schema'.
    expect(hostTransport).toContain("if (!isWorkflowSnapshot(snapshot))");
    expect(hostTransport).toContain("mode: 'full'");
    expect(webviewMerge).toContain("unknown-schema");

    const row = arch
      .split('\n')
      .find((line) => line.includes('src/ui/sidebar/snapshot.ts') && line.includes('`SCHEMA_VERSION`'));
    expect(row, 'expected SCHEMA_VERSION row in ARCHITECTURE.md').toBeDefined();
    expect(row).not.toMatch(/Host `SnapshotTransport` refuses/i);
    expect(row).toMatch(/skip delta encoding|full snapshots/i);
    expect(row).toContain('reconcileSnapshotMessage');
    expect(row).toContain('unknown-schema');
  });
});

