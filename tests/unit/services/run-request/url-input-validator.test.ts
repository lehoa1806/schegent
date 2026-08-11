// Feature 087 (T025, US5, FR-019) — the URL gate.
//
// A URL input stays a reference. Validation checks its shape and its scheme and
// stops there; it never dereferences it. Fetching an operator-supplied URL
// during validation is the SSRF primitive itself — it would make the extension
// host issue arbitrary requests, from inside whatever network the operator's
// machine sits on, as a side effect of typing in a form.
//
// The implementation lives in `run-request-validator.ts` per plan.md's file
// layout and task T026; this file is named for the gate, as T025 specifies.
//
// The no-network assertion is made against a `globalThis.fetch` spy rather than
// an injected port. A port that exists only to be ignored is dead weight in the
// signature, and the spy proves the same property against the real seam.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateUrlReference } from '../../../../src/services/run-request/run-request-validator';

const fetchSpy = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  fetchSpy.mockReset();
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch === undefined) {
    delete (globalThis as { fetch?: typeof globalThis.fetch }).fetch;
    return;
  }
  globalThis.fetch = originalFetch;
});

describe('validateUrlReference', () => {
  it.each([
    'https://example.com',
    'https://example.com/path?query=1#fragment',
    'http://example.com',
    'https://user:pass@example.com/path',
    'https://192.168.0.1/internal',
    'https://localhost:3000/health'
  ])('accepts %s', (url) => {
    expect(validateUrlReference(url)).toEqual({ ok: true });
  });

  // Reachability is not shape. A host that does not resolve, a service that is
  // down, a 404 — all of them are reported where access is attempted, not by
  // substituting or fabricating content here (FR-019).
  it('accepts a well-formed URL that could not possibly resolve', () => {
    expect(validateUrlReference('https://this-host-does-not-exist.invalid/a')).toEqual({
      ok: true
    });
  });

  it.each([
    ['file:///etc/passwd', 'the traversal bypass a scheme allowlist exists to close'],
    ['javascript:alert(1)', 'script execution'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'inline payload'],
    ['ftp://example.com/f', 'unsupported transport'],
    ['vscode://extension/x', 'host-local command surface']
  ])('refuses %s', (url) => {
    expect(validateUrlReference(url)).toMatchObject({
      ok: false,
      code: 'url-scheme-not-allowed'
    });
  });

  it.each(['', '   ', 'not a url', 'example.com', '//example.com', 'https://'])(
    'refuses %s as malformed',
    (url) => {
      expect(validateUrlReference(url)).toMatchObject({ ok: false, code: 'url-malformed' });
    }
  );

  // Not a defect: `https:` is a WHATWG "special" scheme, so the parser collapses
  // the empty authority and reads `path` as the host. Pinned because it looks
  // like a malformed URL and a later "tighten this up" would break it.
  it('accepts https:///path, which normalizes to the host `path`', () => {
    expect(validateUrlReference('https:///path')).toEqual({ ok: true });
  });

  it('never performs network access, for any input', () => {
    for (const url of [
      'https://example.com',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
      'not a url'
    ]) {
      validateUrlReference(url);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
