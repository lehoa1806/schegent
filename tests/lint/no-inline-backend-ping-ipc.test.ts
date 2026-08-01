import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');
const ALLOWED = new Set([
  'webview-ui/src/lib/messages.ts',
  'webview-ui/src/lib/backend-ping-ipc.ts'
]);

describe('CMD_PING_BACKEND single webview call site', () => {
  it('is referenced only by the shared helper and contract shim', () => {
    let output = '';
    try {
      output = execFileSync('rg', ['-l', 'CMD_PING_BACKEND', SCAN_ROOT], { encoding: 'utf8' });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 1) throw error;
    }
    const files = output.trim().split('\n').filter(Boolean).map((absolute) =>
      absolute.startsWith(`${REPO_ROOT}/`) ? absolute.slice(REPO_ROOT.length + 1) : absolute
    );
    expect(files.filter((file) => !ALLOWED.has(file))).toEqual([]);
    expect(files).toContain('webview-ui/src/lib/backend-ping-ipc.ts');
  });
});
