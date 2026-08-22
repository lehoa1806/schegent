import { describe, expect, it } from 'vitest';
import { filesReferencing } from './webview-source-scan';

const HELPER = 'webview-ui/src/lib/backend-ping-ipc.ts';
const ALLOWED = new Set(['webview-ui/src/lib/messages.ts', HELPER]);

describe('CMD_PING_BACKEND single webview call site', () => {
  it('is referenced only by the shared helper and contract shim', () => {
    const files = filesReferencing('CMD_PING_BACKEND');
    expect(files.filter((file) => !ALLOWED.has(file))).toEqual([]);
    // The vacuity control, unchanged from the ripgrep version: without it, a
    // scan that resolved nothing would satisfy the assertion above.
    expect(files).toContain(HELPER);
  });
});
