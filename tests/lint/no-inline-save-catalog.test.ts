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
    'webview-ui/src/lib/__tests__/save-catalog-command.test.ts'
  ])
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
