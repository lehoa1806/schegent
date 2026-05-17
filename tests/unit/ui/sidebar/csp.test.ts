import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TOKENS, buildCspMeta, generateNonce } from '../../../../src/ui/sidebar/csp';

describe('generateNonce', () => {
  it('produces base64url strings', () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(nonce.length).toBeGreaterThanOrEqual(32);
  });

  it('produces unique values across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) seen.add(generateNonce());
    expect(seen.size).toBe(32);
  });
});

describe('buildCspMeta', () => {
  const cspSource = 'https://w.example.vscode-webview.net';
  const nonce = 'a'.repeat(32);

  it('emits all six required directives', () => {
    const csp = buildCspMeta(cspSource, nonce);
    expect(csp).toContain(`default-src 'none'`);
    expect(csp).toContain(`img-src ${cspSource} data:`);
    expect(csp).toContain(`style-src ${cspSource} 'nonce-${nonce}'`);
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).toContain(`font-src ${cspSource}`);
    expect(csp).toContain(`connect-src 'none'`);
  });

  it('includes no forbidden tokens', () => {
    const csp = buildCspMeta(cspSource, nonce);
    for (const token of FORBIDDEN_TOKENS) {
      expect(csp).not.toContain(token);
    }
  });
});
