import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { renderWebviewHtml, type UriLike } from '../../../../src/ui/sidebar/html';

class FakeWebview {
  readonly cspSource = 'https://w.example.vscode-webview.net';
  asWebviewUri(local: UriLike): { toString(): string } {
    if (typeof local?.scheme !== 'string' || local.scheme.length === 0) {
      throw new TypeError('FakeWebview.asWebviewUri requires a Uri-shaped argument with a `scheme`');
    }
    return {
      toString: () => `${this.cspSource}/${path.basename(local.fsPath)}`
    };
  }
}

const toLocalUri = (fsPath: string): UriLike => ({ fsPath, scheme: 'file' });

// Tag classes the CSP `script-src 'nonce-...'` directive gates per the Fetch
// spec destination model. If a class lands in CSP-controlled HTML without a
// nonce, the browser silently drops it — which is exactly the BUG-001 failure
// mode where Vite-emitted `<link rel="modulepreload">` blocks the entry chunk
// from preloading and `mount()` never runs.
//
// The fixture must contain at least one tag of every class. Adding a class
// here without a corresponding handler in `injectNonceIntoTags` will cause
// this test to fail loudly — that is intentional, so a future Vite release
// emitting a new CSP-relevant tag class cannot regress silently.
type CspGatedTagClass = {
  readonly label: string;
  readonly snippet: string;
  readonly openTagMatcher: RegExp;
};

const CSP_GATED_TAG_CLASSES: readonly CspGatedTagClass[] = [
  {
    label: 'script',
    snippet: '<script type="module" src="/index.js"></script>',
    openTagMatcher: /<script\b[^>]*>/gi
  },
  {
    label: 'style',
    snippet: '<style>:root { color: red; }</style>',
    openTagMatcher: /<style\b[^>]*>/gi
  },
  {
    label: 'link rel="modulepreload"',
    snippet: '<link rel="modulepreload" href="/chunk-a.js">',
    openTagMatcher: /<link\b[^>]*\brel\s*=\s*["']modulepreload["'][^>]*>/gi
  },
  {
    label: 'link rel="preload" as="script"',
    snippet: '<link rel="preload" as="script" href="/chunk-b.js">',
    openTagMatcher: /<link\b[^>]*\brel\s*=\s*["']preload["'][^>]*\bas\s*=\s*["']script["'][^>]*>/gi
  }
];

async function withFixtureBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-nonce-'));
  const head = [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8"/>',
    '<meta http-equiv="Content-Security-Policy" content="__CSP__"/>',
    ...CSP_GATED_TAG_CLASSES.map((cls) => cls.snippet),
    '</head><body>',
    '<div id="app"></div>',
    '</body></html>'
  ].join('\n');
  await fs.writeFile(path.join(dir, 'index.html'), head, 'utf8');
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

describe('renderWebviewHtml — CSP nonce coverage on every gated tag class (BUG-001)', () => {
  it('attaches the nonce to every CSP-gated tag class emitted by the bundle', async () => {
    const tmp = await withFixtureBundle();
    try {
      const { html, nonce } = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: tmp.dir,
        webviewBundleDir: tmp.dir,
        toLocalUri
      });

      const nonceAttr = `nonce="${nonce}"`;
      for (const cls of CSP_GATED_TAG_CLASSES) {
        const opens = html.match(cls.openTagMatcher) ?? [];
        expect(opens.length, `expected at least one <${cls.label}> tag in rendered HTML`).toBeGreaterThan(0);
        for (const tag of opens) {
          expect(
            tag,
            `<${cls.label}> tag is gated by script-src 'nonce-...' but is missing the nonce attribute: ${tag}`
          ).toContain(nonceAttr);
        }
      }
    } finally {
      await tmp.cleanup();
    }
  });

  it('does not double-nonce a tag that already carries a nonce', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-nonce-idem-'));
    try {
      await fs.writeFile(
        path.join(dir, 'index.html'),
        [
          '<!doctype html>',
          '<html><head>',
          '<meta charset="utf-8"/>',
          '<meta http-equiv="Content-Security-Policy" content="__CSP__"/>',
          '<link rel="modulepreload" nonce="__NONCE__" href="/chunk-a.js">',
          '</head><body><div id="app"></div></body></html>'
        ].join('\n'),
        'utf8'
      );
      const { html, nonce } = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: dir,
        webviewBundleDir: dir,
        toLocalUri
      });
      const occurrences = (html.match(/nonce=/g) ?? []).length;
      const linkOpens = html.match(/<link\b[^>]*>/gi) ?? [];
      expect(linkOpens.length).toBeGreaterThan(0);
      for (const tag of linkOpens) {
        const linkNonces = (tag.match(/nonce=/g) ?? []).length;
        expect(linkNonces, `link tag double-nonced: ${tag}`).toBeLessThanOrEqual(1);
      }
      expect(html).toContain(`nonce="${nonce}"`);
      expect(occurrences).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves <link> tags with unrelated rel values (e.g. stylesheet, icon) unchanged', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-nonce-unrelated-'));
    try {
      await fs.writeFile(
        path.join(dir, 'index.html'),
        [
          '<!doctype html>',
          '<html><head>',
          '<meta charset="utf-8"/>',
          '<meta http-equiv="Content-Security-Policy" content="__CSP__"/>',
          '<link rel="stylesheet" href="/index.css">',
          '<link rel="icon" href="/favicon.ico">',
          '</head><body><div id="app"></div></body></html>'
        ].join('\n'),
        'utf8'
      );
      const { html } = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: dir,
        webviewBundleDir: dir,
        toLocalUri
      });
      const stylesheet = html.match(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/i)?.[0];
      const icon = html.match(/<link\b[^>]*\brel\s*=\s*["']icon["'][^>]*>/i)?.[0];
      expect(stylesheet, 'stylesheet link missing from rendered HTML').toBeDefined();
      expect(icon, 'icon link missing from rendered HTML').toBeDefined();
      expect(stylesheet!).not.toContain('nonce=');
      expect(icon!).not.toContain('nonce=');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
