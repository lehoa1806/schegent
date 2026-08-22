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

  // FR-R3-035 — the byte-equality assertion is gone; the projection is generated
  // from the host literal and `contracts:check` fails on divergence.
  //
  // It could not have survived this change in any case: the webview file is a
  // deliberate PROJECTION, not a whole-file mirror, and a byte comparison only
  // ever worked because the shared slice happened to be the whole of it. The
  // count assertion below is kept, because it is the one that still says
  // something generation does not: that the projection carries every signature,
  // not merely a syntactically-valid subset.

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

  it('the generated projection announces itself and names its source', () => {
    const webview = fs.readFileSync(WEBVIEW_PATH, 'utf8');
    expect(webview).toContain('GENERATED FILE');
    expect(webview).toContain('src/lib/fatal-signature-registry.ts');
    expect(webview).toContain('npm run contracts:generate');
  });

  it('carries none of the host-only matching surface', () => {
    // The projection exists so the webview does not carry the classifier. A
    // generator that emitted the whole host file would be a regression wearing
    // the shape of a fix.
    const webview = fs.readFileSync(WEBVIEW_PATH, 'utf8');
    for (const hostOnly of [
      'export type FatalSource',
      'export interface EffectiveSignature',
      'export interface FatalMatch'
    ]) {
      expect(webview).not.toContain(hostOnly);
    }
  });
});
