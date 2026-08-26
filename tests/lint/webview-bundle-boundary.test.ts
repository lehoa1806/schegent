import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-110 (FR-101) — asserted on the BUILT ARTIFACT, not on the source.
 *
 * WHY THE SOURCE CHECK IS NOT ENOUGH. `webview-host-import-direction.test.ts` reads import
 * statements, which is the right place to catch the mistake as it is written. It cannot see what
 * a bundler actually pulls in: a value import three modules deep, a re-export barrel, a
 * `sideEffects` misconfiguration. The question this item is really about — *is host code in the
 * untrusted surface?* — is a question about the bundle.
 *
 * WHAT LEAKED. `webview-ui/src/lib/history-rerun.ts` imported `DEFAULT_QUEUE_ID` from
 * `src/queue/queue-registry` and `history-rows.ts` imported `HISTORY_UNATTRIBUTED_QUEUE_ID` from
 * `src/state/history-entry`, both as runtime values. Everything those two modules transitively
 * import shipped, to deliver two string literals. Both now come from
 * `src/contracts/queue-identity.ts`, a leaf that imports nothing.
 *
 * HOW A LEAK IS DETECTED. By the markers a bundled module leaves behind — identifiers and
 * literals that appear in the host module and nowhere else. Minification renames locals but not
 * string literals or exported property names, so a distinctive literal is the reliable probe.
 *
 * SKIPPED, NOT FAILED, WITHOUT A BUILD. `test:host` is hermetic (`FR-R3-033`) and must not run a
 * bundler. When `dist/webview/` is absent this reports the skip rather than passing quietly — a
 * gate that silently passes because its subject is missing is the vacuity this repository
 * measures.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const BUNDLE_DIR = resolve(REPO_ROOT, 'dist/webview');

/**
 * Markers that would betray a bundled host module, and the module each belongs to.
 *
 * Every marker is a string literal or an identifier that survives minification, and each is
 * checked below to be genuinely present in its host module — a marker that has drifted out of
 * the host source would make this gate pass over nothing.
 */
const FORBIDDEN: ReadonlyArray<{
  readonly module: string;
  readonly marker: string;
  readonly why: string;
}> = [
  {
    module: 'src/queue/queue-registry.ts',
    // A refusal code produced by this module and nowhere else. Chosen after a first attempt
    // used `queueLifecycle`, which FAILED as a false positive: that identifier is shared
    // vocabulary the webview legitimately uses as a component prop, so the marker proved the
    // webview mentions queues rather than that host code shipped. A gate with a false positive
    // gets disabled, so the marker has to be something only the host module can produce.
    marker: 'cannot-delete-default-queue',
    why: 'the queue registry manages state and refusals the webview has no business holding'
  },
  {
    module: 'src/state/history-entry.ts',
    // An exported function name, not a field name: fields are shared shape, functions are code.
    marker: 'parseAuditLogPointer',
    why: 'history-entry parses evidence pointers, which is host work over host paths'
  }
];

function bundleFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      bundleFiles(full, out);
      continue;
    }
    if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('FR-R3-110 — host modules are absent from the webview bundle', () => {
  it('every forbidden marker is genuinely present in its host module', () => {
    // The gate's own premise. A marker that no longer appears in the host source would make the
    // bundle assertion below vacuous — it would be searching for a string nothing produces.
    for (const entry of FORBIDDEN) {
      const source = readFileSync(resolve(REPO_ROOT, entry.module), 'utf8');
      expect(
        source.includes(entry.marker),
        `${entry.marker} no longer appears in ${entry.module}, so searching the bundle for it ` +
          'proves nothing. Pick a marker that module actually produces.'
      ).toBe(true);
    }
  });

  it('the bundle contains no host-module marker', () => {
    const files = bundleFiles(BUNDLE_DIR);
    if (files.length === 0) {
      // Reported, not silent. `npm run build:webview` populates it; `ci` does so before the
      // visual and a11y suites.
      console.warn(
        'webview-bundle-boundary: dist/webview/ is absent, so the bundle was NOT inspected. ' +
          'Run `npm run build:webview` first. This is a skip, not a pass.'
      );
      expect(files.length).toBe(0);
      return;
    }

    const offenders: string[] = [];
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      for (const entry of FORBIDDEN) {
        if (body.includes(entry.marker)) {
          offenders.push(`${file.replace(`${REPO_ROOT}/`, '')}: ${entry.marker} (${entry.module})`);
        }
      }
    }
    expect(
      offenders,
      'Host code reached the untrusted webview bundle. A value import from outside ' +
        'src/contracts/ pulls that module and everything it imports into the surface an ' +
        'attacker controls. Move the value into src/contracts/ — if both sides need it, it is ' +
        'contract-shaped.'
    ).toEqual([]);
  });

  it('the bundle is non-trivial when present, so a truncated build cannot read as clean', () => {
    const files = bundleFiles(BUNDLE_DIR);
    if (files.length === 0) return;
    const total = files.reduce((sum, file) => sum + statSync(file).size, 0);
    expect(total, 'a near-empty bundle would pass every assertion above').toBeGreaterThan(100_000);
  });
});
