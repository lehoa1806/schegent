// Feature 087 T059 — the run-launcher family has one webview call site.
//
// The hard rule is "never add inline postCommand(...) calls for IPC families
// that have a shared helper", and this is that rule for `CMD_LAUNCH_PIPELINE`.
// It matters more here than for a settings write: the composer assembles a
// `RunRequest` out of four sections, and a second call site would be a second
// place that decides what a composition IS — one that could omit a field the
// helper carries, or send a shape the host's validator was never handed.
//
// Mirrors the established per-family scans (`no-inline-save-phases`,
// `no-inline-read-metrics-ipc`, `no-inline-process-yaml-ipc`).

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { matchingRelativePaths } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');
const HELPER = 'webview-ui/src/lib/run-launcher-ipc.ts';

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The shared helper — the only file that may name the command at all.
  HELPER
  // `webview-ui/src/lib/messages.ts` is deliberately absent: it is a bare
  // `export *` shim, so it never contains the literal and can never match.
]);



const matchRel = (pattern: string): readonly string[] =>
  matchingRelativePaths(REPO_ROOT, SCAN_ROOT, pattern, { fixed: true });

describe('Feature 087 T059 — no inline CMD_LAUNCH_PIPELINE references', () => {
  it('only the shared helper references CMD_LAUNCH_PIPELINE', () => {
    const matched = matchRel('CMD_LAUNCH_PIPELINE');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending files referencing CMD_LAUNCH_PIPELINE:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the shared helper is found by the scan', () => {
    // The positive control: an empty result must mean "nothing else references
    // it", never "the scan did not run".
    expect(matchRel('CMD_LAUNCH_PIPELINE')).toContain(HELPER);
  });

  it('no component invokes postCommand(CMD_LAUNCH_PIPELINE, ...) inline', () => {
    const matched = matchRel('postCommand(CMD_LAUNCH_PIPELINE');
    const componentOffenders = matched.filter((rel) =>
      rel.startsWith('webview-ui/src/components/')
    );
    expect(componentOffenders).toEqual([]);
  });

  it('the composer reaches the host only through the helper', () => {
    // The composer is four components deep; this pins that none of them grew its
    // own transport, whatever it might name the command.
    const posted = matchRel('postCommand(').filter((rel) =>
      rel.startsWith('webview-ui/src/components/RunLauncher/')
    );
    expect(posted).toEqual([]);
  });
});
