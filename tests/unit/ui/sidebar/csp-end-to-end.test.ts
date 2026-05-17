import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, basename, join } from 'node:path';
import { renderWebviewHtml, FALLBACK_FAILURE_HTML, type UriLike } from '../../../../src/ui/sidebar/html';
import { FORBIDDEN_TOKENS } from '../../../../src/ui/sidebar/csp';

const CSP_META_RE = /<meta\s+http-equiv=["']Content-Security-Policy["']/i;

const REPO_ROOT = resolve(__dirname, '../../../..');
const WEBVIEW_BUNDLE_DIR = resolve(REPO_ROOT, 'dist/webview');
const BUNDLE_HTML = resolve(WEBVIEW_BUNDLE_DIR, 'index.html');

class FakeWebview {
  readonly cspSource = 'https://w.example.vscode-webview.net';
  asWebviewUri(local: UriLike): { toString(): string } {
    if (typeof local?.scheme !== 'string' || local.scheme.length === 0) {
      // BUG-004: real `vscode.Webview.asWebviewUri` rejects partial duck-typed
      // shapes — the fixture mirrors that contract so unit tests catch
      // regressions where callers pass `{ fsPath }` literals.
      throw new TypeError('FakeWebview.asWebviewUri requires a Uri-shaped argument with a `scheme`');
    }
    return {
      toString: () => `${this.cspSource}/${basename(local.fsPath)}`
    };
  }
}

const toLocalUri = (fsPath: string): UriLike => ({ fsPath, scheme: 'file' });

describe('CSP audit on the real built bundle (T059)', () => {
  it.runIf(existsSync(BUNDLE_HTML))(
    'host-rendered HTML carries no forbidden CSP tokens',
    async () => {
      const { html } = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: REPO_ROOT,
        webviewBundleDir: WEBVIEW_BUNDLE_DIR,
        toLocalUri
      });
      for (const token of FORBIDDEN_TOKENS) {
        expect(html, `forbidden token "${token}" present in rendered HTML`).not.toContain(token);
      }
    }
  );

  it.runIf(existsSync(BUNDLE_HTML))(
    'host-rendered HTML has CSP meta and a fresh nonce on every script tag',
    async () => {
      const { html, nonce } = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: REPO_ROOT,
        webviewBundleDir: WEBVIEW_BUNDLE_DIR,
        toLocalUri
      });
      expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
      expect(html).toContain(`'nonce-${nonce}'`);
      const scriptOpenTags = html.match(/<script\b[^>]*>/g) ?? [];
      expect(scriptOpenTags.length).toBeGreaterThan(0);
      for (const tag of scriptOpenTags) {
        expect(tag, `script tag missing nonce: ${tag}`).toContain(`nonce="${nonce}"`);
      }
    }
  );

  it.runIf(existsSync(BUNDLE_HTML))(
    'built index.html keeps the __CSP__ placeholder for the host renderer',
    () => {
      const raw = readFileSync(BUNDLE_HTML, 'utf8');
      expect(raw).toContain('__CSP__');
    }
  );

  it.runIf(existsSync(BUNDLE_HTML))(
    'host-rendered HTML carries no crossorigin attribute on <script> or <link> tags (BUG-002)',
    async () => {
      const { html } = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: REPO_ROOT,
        webviewBundleDir: WEBVIEW_BUNDLE_DIR,
        toLocalUri
      });
      expect(
        html,
        'crossorigin attribute on <script>/<link> would trigger CORS preflight on vscode-webview:// URIs'
      ).not.toMatch(/<(?:script|link)\b[^>]*\bcrossorigin\b/i);
    }
  );

  it('bundle-missing path: renderWebviewHtml still emits CSP meta via fallback template (BUG-003)', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'schegent-csp-fallback-'));
    try {
      const { html } = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: emptyDir,
        webviewBundleDir: emptyDir,
        toLocalUri
      });
      expect(
        html,
        'fallbackTemplate() must include a CSP meta so the webview is never in a no-CSP state'
      ).toMatch(CSP_META_RE);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('catch-fallback HTML used by SidebarViewProvider carries CSP meta (BUG-003)', () => {
    expect(
      FALLBACK_FAILURE_HTML,
      'the failure HTML written when render rejects must still satisfy the CSP invariant'
    ).toMatch(CSP_META_RE);
  });
});
