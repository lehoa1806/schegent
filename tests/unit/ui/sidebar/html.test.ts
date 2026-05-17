import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { renderWebviewHtml, stripIncompatibleAttrs, type UriLike } from '../../../../src/ui/sidebar/html';

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
      toString: () => `${this.cspSource}/${path.basename(local.fsPath)}`
    };
  }
}

const toLocalUri = (fsPath: string): UriLike => ({ fsPath, scheme: 'file' });

async function withTempBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-html-'));
  await fs.writeFile(
    path.join(dir, 'index.html'),
    [
      '<!doctype html>',
      '<html><head>',
      '<meta charset="utf-8"/>',
      '<meta http-equiv="Content-Security-Policy" content="__CSP__"/>',
      '</head><body>',
      '<div id="app"></div>',
      '<script type="module" nonce="__NONCE__" src="/src/main.ts"></script>',
      '</body></html>'
    ].join('\n'),
    'utf8'
  );
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

describe('renderWebviewHtml', () => {
  it('emits HTML with CSP meta and asset rewriting', async () => {
    const tmp = await withTempBundle();
    try {
      const { html, nonce } = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: tmp.dir,
        webviewBundleDir: tmp.dir,
        toLocalUri
      });
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy"`);
      expect(html).toContain(`nonce="${nonce}"`);
      expect(html).toContain(`src="https://w.example.vscode-webview.net/index.js"`);
      expect(html).not.toContain('__CSP__');
      expect(html).not.toContain('__NONCE__');
      expect(html).not.toContain('/src/main.ts');
      expect(html).toContain(`'nonce-${nonce}'`);
    } finally {
      await tmp.cleanup();
    }
  });

  it('uses fallback template when bundle index.html is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-html-empty-'));
    try {
      const { html } = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: dir,
        webviewBundleDir: dir,
        toLocalUri
      });
      expect(html).toContain('<div id="app"></div>');
      expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('produces a fresh nonce per call', async () => {
    const tmp = await withTempBundle();
    try {
      const a = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: tmp.dir,
        webviewBundleDir: tmp.dir,
        toLocalUri
      });
      const b = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: tmp.dir,
        webviewBundleDir: tmp.dir,
        toLocalUri
      });
      expect(a.nonce).not.toBe(b.nonce);
    } finally {
      await tmp.cleanup();
    }
  });

  it('strips crossorigin from Vite-emitted bundle output (BUG-002)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-html-vite-'));
    try {
      await fs.writeFile(
        path.join(dir, 'index.html'),
        [
          '<!doctype html>',
          '<html><head>',
          '<meta charset="utf-8"/>',
          '<script type="module" crossorigin src="/index.js"></script>',
          '<link rel="stylesheet" crossorigin href="/index.css">',
          '</head><body>',
          '<div id="app"></div>',
          '</body></html>'
        ].join('\n'),
        'utf8'
      );
      const { html } = await renderWebviewHtml({
        webview: new FakeWebview(),
        extensionRoot: dir,
        webviewBundleDir: dir,
        toLocalUri
      });
      expect(html).not.toMatch(/<(?:script|link)\b[^>]*\bcrossorigin\b/i);
      expect(html).toContain('https://w.example.vscode-webview.net/index.js');
      expect(html).toContain('https://w.example.vscode-webview.net/index.css');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rewriteAssetRefs invokes asWebviewUri with a Uri-shaped argument (BUG-004)', async () => {
    const tmp = await withTempBundle();
    try {
      const webview = new FakeWebview();
      const spy = vi.spyOn(webview, 'asWebviewUri');
      await renderWebviewHtml({
        webview,
        extensionRoot: tmp.dir,
        webviewBundleDir: tmp.dir,
        toLocalUri
      });
      expect(spy).toHaveBeenCalled();
      for (const call of spy.mock.calls) {
        const arg = call[0];
        expect(typeof arg.fsPath, `arg.fsPath must be a string, got ${typeof arg.fsPath}`).toBe('string');
        expect(typeof arg.scheme, `arg.scheme must be a string, got ${typeof arg.scheme}`).toBe('string');
        expect(arg.scheme.length, 'arg.scheme must be non-empty').toBeGreaterThan(0);
      }
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('stripIncompatibleAttrs (BUG-002 — T067)', () => {
  it('removes crossorigin from <script type="module" crossorigin src="x">, preserving other attrs', () => {
    const input = '<script type="module" crossorigin src="x"></script>';
    const out = stripIncompatibleAttrs(input);
    expect(out).not.toMatch(/<script\b[^>]*\bcrossorigin\b/i);
    expect(out).toContain('type="module"');
    expect(out).toContain('src="x"');
    expect(out).toContain('</script>');
  });

  it('removes crossorigin from <link rel="stylesheet" crossorigin href="x">', () => {
    const input = '<link rel="stylesheet" crossorigin href="x">';
    const out = stripIncompatibleAttrs(input);
    expect(out).not.toMatch(/<link\b[^>]*\bcrossorigin\b/i);
    expect(out).toContain('rel="stylesheet"');
    expect(out).toContain('href="x"');
  });

  it('leaves tags without crossorigin unchanged byte-for-byte', () => {
    const input = [
      '<!doctype html>',
      '<html><head>',
      '<meta charset="utf-8"/>',
      '<script type="module" nonce="abc123" src="https://example/index.js"></script>',
      '<link rel="stylesheet" href="https://example/index.css">',
      '</head><body><div id="app"></div></body></html>'
    ].join('\n');
    expect(stripIncompatibleAttrs(input)).toBe(input);
  });

  it('leaves crossorigin substring inside text content and data-* attributes alone', () => {
    const input = [
      '<div data-crossorigin="true">',
      '  <p>The crossorigin attribute is a CORS hint.</p>',
      '  <script nonce="x" src="y">// crossorigin in comment</script>',
      '</div>'
    ].join('\n');
    const out = stripIncompatibleAttrs(input);
    expect(out).toContain('data-crossorigin="true"');
    expect(out).toContain('The crossorigin attribute is a CORS hint.');
    expect(out).toContain('// crossorigin in comment');
    expect(out).not.toMatch(/<script\b[^>]*\sscrossorigin\b/i);
  });

  it('handles attribute-order variance (crossorigin first, last, or middle)', () => {
    const variants = [
      '<script crossorigin type="module" src="x"></script>',
      '<script type="module" src="x" crossorigin></script>',
      '<script type="module" crossorigin src="x"></script>',
      '<link crossorigin rel="stylesheet" href="x">',
      '<link rel="stylesheet" href="x" crossorigin>',
      '<link rel="stylesheet" crossorigin href="x">'
    ];
    for (const v of variants) {
      const out = stripIncompatibleAttrs(v);
      expect(out, `failed to strip crossorigin from: ${v}`).not.toMatch(
        /<(?:script|link)\b[^>]*\bcrossorigin\b/i
      );
    }
  });

  it('is idempotent — running twice yields the same output', () => {
    const input = [
      '<script type="module" crossorigin src="/index.js"></script>',
      '<link rel="stylesheet" crossorigin href="/index.css">',
      '<script nonce="x" src="y"></script>'
    ].join('\n');
    const once = stripIncompatibleAttrs(input);
    const twice = stripIncompatibleAttrs(once);
    expect(twice).toBe(once);
  });

  it('handles crossorigin with quoted values (crossorigin="anonymous")', () => {
    const input = '<script type="module" crossorigin="anonymous" src="x"></script>';
    const out = stripIncompatibleAttrs(input);
    expect(out).not.toMatch(/\bcrossorigin\b/i);
    expect(out).toContain('type="module"');
    expect(out).toContain('src="x"');
  });
});
