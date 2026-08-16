import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_BY_COMMAND: Record<string, ReadonlySet<string>> = {
  CMD_SAVE_PIPELINES: new Set([
    'webview-ui/src/lib/messages.ts',
    'webview-ui/src/lib/save-pipelines.ts',
    // Feature 082 (T021) — pins the envelope emitted by the sole call site.
    'webview-ui/src/lib/__tests__/save-pipelines.test.ts'
  ]),
  CMD_SAVE_MODELS: new Set([
    'webview-ui/src/lib/messages.ts',
    'webview-ui/src/lib/save-models.ts',
    'webview-ui/src/lib/__tests__/save-catalog-command.test.ts',
    // Feature 096 (T023) — pins the import-confirm envelope emitted by
    // `saveModelsImport`, the second `CMD_SAVE_MODELS` call site added
    // alongside the pre-existing manual add/remove `saveModels` path.
    'webview-ui/src/lib/__tests__/save-models.test.ts'
  ]),
  // Feature 083 (T035) — same gate as the Pipeline save: a per-component send
  // would bypass the correlation, pending, and timeout handling the helper owns.
  CMD_SAVE_WORKFLOWS: new Set([
    'webview-ui/src/lib/messages.ts',
    'webview-ui/src/lib/save-workflows.ts',
    'webview-ui/src/lib/__tests__/save-workflows.test.ts'
  ]),
  /**
   * Feature 086 (T072) — the FIRST of the three ordered writes, which had no
   * entry here at all.
   *
   * T072 asked whether the third save call site was in scope; it is, as
   * `CMD_SAVE_WORKFLOWS` above. Checking that turned up the gap in the other
   * direction: 082 added the Pipeline save to this scan and 083 the Workflow
   * save, but the Phase save — the oldest of the three, and the one an import
   * package writes first — was never added. Nothing failed, because a
   * command this file does not name cannot produce an offender.
   *
   * It matters most on this feature's path. A package import performs Phases,
   * then Pipelines, then Workflows, each with its own `expectedRevision` and its
   * own single mutation intent. A component that sent the Phase write inline
   * would send it without the revision the helper attaches, and the layer it
   * raced would be overwritten rather than reported as stale.
   */
  CMD_SAVE_PHASES: new Set([
    'webview-ui/src/lib/messages.ts',
    'webview-ui/src/lib/save-phases.ts',
    'webview-ui/src/lib/__tests__/save-phases.test.ts',
    'webview-ui/src/lib/__tests__/save-catalog-command.test.ts'
  ])
};

/**
 * The helper each command must be sent from, so an empty match set is a failure
 * rather than a pass.
 *
 * Feature 086 (T072) — the vacuity guard this file was missing. `offenders` is a
 * filter over the grep result, so a renamed constant, a moved scan root, or a
 * grep that silently stopped matching would produce zero matches and therefore
 * zero offenders. The sibling scan for the exchange family
 * (`no-inline-process-yaml-ipc.test.ts`) has always asserted its helper is among
 * the matches; this one now does the same.
 */
const HELPER_BY_COMMAND: Record<string, string> = {
  CMD_SAVE_PIPELINES: 'webview-ui/src/lib/save-pipelines.ts',
  CMD_SAVE_MODELS: 'webview-ui/src/lib/save-models.ts',
  CMD_SAVE_WORKFLOWS: 'webview-ui/src/lib/save-workflows.ts',
  CMD_SAVE_PHASES: 'webview-ui/src/lib/save-phases.ts'
};

function listMatchingFiles(pattern: string): readonly string[] {
  let out: string;
  try {
    out = execSync(`grep -rln "${pattern}" "${SCAN_ROOT}"`, { encoding: 'utf8' });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((abs) =>
      abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs
    );
}

describe('no inline catalog-save IPC calls', () => {
  for (const [command, allowlist] of Object.entries(ALLOWED_BY_COMMAND)) {
    it(`only allowlisted files reference ${command}`, () => {
      const matched = listMatchingFiles(command);
      // The scan found the sole call site, so an empty offender list means the
      // allowlist held rather than that the grep matched nothing.
      expect(matched, `${command} must be sent from its helper`).toContain(
        HELPER_BY_COMMAND[command]
      );
      const offenders = matched.filter((rel) => !allowlist.has(rel));
      expect(
        offenders,
        `Offending files referencing ${command}:\n${offenders.join('\n')}`
      ).toEqual([]);
    });

    it(`no component invokes postCommand(${command}, ...) inline`, () => {
      const matched = listMatchingFiles(`postCommand(${command}`);
      const componentOffenders = matched.filter(
        (rel) =>
          rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
      );
      expect(componentOffenders).toEqual([]);
    });
  }
});
