import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const HOST_PATH = path.join(REPO_ROOT, 'src', 'ui', 'sidebar', 'duration.ts');
const WEBVIEW_PATH = path.join(REPO_ROOT, 'webview-ui', 'src', 'lib', 'format-duration.ts');

describe('formatDuration host/webview parity', () => {
  it('host duration.ts and webview format-duration.ts have byte-identical bodies', () => {
    const host = fs.readFileSync(HOST_PATH, 'utf8');
    const webview = fs.readFileSync(WEBVIEW_PATH, 'utf8');
    expect(host).toBe(webview);
  });
});

describe('messages SIDEBAR_IPC_SCHEMA_VERSION (Wave 5 — authoritative module)', () => {
  // Feature 013 — Wave 5: SCHEMA_VERSION lives in the authoritative IPC
  // contract module. Host and webview shims are single `export *`
  // re-exports, so a parity check across the two shim files is no longer
  // meaningful — the drift guard in
  // `tests/unit/contracts/sidebar-ipc-drift.test.ts` enforces module
  // identity. This test now guards the authoritative declaration.
  it('the authoritative IPC module declares SIDEBAR_IPC_SCHEMA_VERSION', () => {
    const AUTHORITATIVE = path.join(REPO_ROOT, 'src', 'contracts', 'sidebar-ipc.ts');
    // FR-R3-110 (FR-103) — renamed from the bare `SCHEMA_VERSION`, which collided with
    // `src/ui/sidebar/snapshot.ts`'s constant of the same name and a different value.
    const RX = /export const SIDEBAR_IPC_SCHEMA_VERSION = (\d+) as const/;
    const match = RX.exec(fs.readFileSync(AUTHORITATIVE, 'utf8'));
    expect(match, 'authoritative module must declare SCHEMA_VERSION').not.toBeNull();
    expect(Number.parseInt(match![1], 10)).toBeGreaterThan(0);
  });
});
