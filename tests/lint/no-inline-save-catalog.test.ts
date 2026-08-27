// Feature 096 (T023) — single-call-site discipline for the Model Catalog save.
//
// Feature 100 (FR-R3-016) T509d — this file used to gate four commands. Three of
// them (`CMD_SAVE_PHASES`, `CMD_SAVE_PIPELINES`, `CMD_SAVE_WORKFLOWS`) are retired
// with the whole-array save, and their property moved to
// `tests/lint/catalog-lifecycle-dispatch.test.ts`, which pins the six lifecycle
// commands to one dispatch surface.
//
// `CMD_SAVE_MODELS` stays here and stays as feature 096 left it. The Model Catalog
// is not a versioned definition catalog: it has no draft, no publish, and no
// version history, so folding it into a file named for the lifecycle would claim a
// shared model these two do not share. Its gate is the original one — the helper
// owns the correlation, pending, and timeout handling, and a component that sent
// the command inline would skip all three.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { matchingRelativePaths } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_BY_COMMAND: Record<string, ReadonlySet<string>> = {
  CMD_SAVE_MODELS: new Set([
    'webview-ui/src/lib/save-models.ts',
    'webview-ui/src/lib/__tests__/save-catalog-command.test.ts',
    // Feature 096 (T023) — pins the import-confirm envelope emitted by
    // `saveModelsImport`, the second `CMD_SAVE_MODELS` call site added
    // alongside the pre-existing manual add/remove `saveModels` path.
    'webview-ui/src/lib/__tests__/save-models.test.ts'
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
  CMD_SAVE_MODELS: 'webview-ui/src/lib/save-models.ts'
};


const matchRel = (pattern: string): readonly string[] =>
  matchingRelativePaths(REPO_ROOT, SCAN_ROOT, pattern, { fixed: true });

describe('no inline Model Catalog save IPC calls', () => {
  for (const [command, allowlist] of Object.entries(ALLOWED_BY_COMMAND)) {
    it(`only allowlisted files reference ${command}`, () => {
      const matched = matchRel(command);
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
      const matched = matchRel(`postCommand(${command}`);
      const componentOffenders = matched.filter(
        (rel) =>
          rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
      );
      expect(componentOffenders).toEqual([]);
    });
  }
});
