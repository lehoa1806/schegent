/**
 * Feature 011 T062 — parity test for FATAL_SIGNATURES.
 *
 * Per SC-011 (extended), the webview's `FATAL_SIGNATURES` mirror at
 * `webview-ui/src/lib/fatal-signature-registry.ts` must remain
 * byte-equivalent to the host's source-of-truth list. The mirror file
 * may carry a top-of-file `// Mirror of ...` banner per T070, which is
 * legitimately different; everything after that banner block must be
 * byte-equal modulo top-of-file comments.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FATAL_SIGNATURES } from '../../src/lib/fatal-signature-registry';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOST_PATH = path.join(REPO_ROOT, 'src', 'lib', 'fatal-signature-registry.ts');
const WEBVIEW_PATH = path.join(
  REPO_ROOT,
  'webview-ui',
  'src',
  'lib',
  'fatal-signature-registry.ts'
);

describe('Feature 011 T062 — fatal-signature-registry host/webview parity (SC-011)', () => {
  it('webview mirror file exists', () => {
    expect(fs.existsSync(WEBVIEW_PATH)).toBe(true);
  });

  it('FATAL_SIGNATURES literal in the webview mirror is byte-equal to the host', () => {
    const hostText = fs.readFileSync(HOST_PATH, 'utf8');
    const webviewText = fs.readFileSync(WEBVIEW_PATH, 'utf8');

    // Extract the FATAL_SIGNATURES literal body (everything between
    // `Object.freeze([` and the matching `])`) from both files. This
    // is the smallest unit that absolutely MUST match — banners,
    // imports, and surrounding helpers may legitimately differ between
    // host CommonJS and webview ESM module layouts.
    const re = /Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/;
    const hostMatch = hostText.match(re);
    const webviewMatch = webviewText.match(re);

    expect(hostMatch, 'host FATAL_SIGNATURES literal not found').toBeTruthy();
    expect(webviewMatch, 'webview FATAL_SIGNATURES literal not found').toBeTruthy();
    if (hostMatch && webviewMatch) {
      expect(webviewMatch[1].trim()).toBe(hostMatch[1].trim());
    }
  });

  it('the webview mirror exports the same number of signatures as the host', () => {
    const webviewText = fs.readFileSync(WEBVIEW_PATH, 'utf8');
    // Count quoted string literals inside the Object.freeze([...]) array.
    // We use the same regex pattern as above to extract the body, then
    // count the entries by matching double-quoted strings.
    const re = /Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/;
    const m = webviewText.match(re);
    expect(m).toBeTruthy();
    if (!m) return;
    const stringLiteralRe = /"(?:[^"\\]|\\.)*"/g;
    const matches = m[1].match(stringLiteralRe) ?? [];
    expect(matches.length).toBe(FATAL_SIGNATURES.length);
  });

  it('the webview mirror carries the required parity banner', () => {
    const text = fs.readFileSync(WEBVIEW_PATH, 'utf8');
    expect(text).toMatch(/Mirror of\s+src\/lib\/fatal-signature-registry\.ts/);
  });
});
