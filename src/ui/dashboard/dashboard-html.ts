import * as fs from 'fs';
import * as path from 'path';
import { buildCspMeta } from '../sidebar/csp';
import { stripIncompatibleAttrs, type WebviewLike, type UriLike } from '../sidebar/html';

export interface RenderDashboardOptions {
  readonly webview: WebviewLike;
  readonly extensionRoot: string;
  readonly nonce: string;
  // Required adapter that builds a real `vscode.Uri` from a filesystem path.
  // Production wiring injects `(fsPath) => vscode.Uri.file(fsPath)`.
  // BUG-001: omitting this — and falling back to a duck-typed `{ fsPath, scheme }`
  // literal — causes `vscode.Webview.asWebviewUri` to throw at runtime.
  readonly toLocalUri: (fsPath: string) => UriLike;
  readonly webviewBundleDir?: string;
}

const DEFAULT_BUNDLE_DIR = path.join('dist', 'webview');
const DASHBOARD_HTML_FILE = 'dashboard.html';

export function renderDashboardHtml(opts: RenderDashboardOptions): string {
  if (typeof opts.toLocalUri !== 'function') {
    throw new TypeError(
      'renderDashboardHtml: `toLocalUri` is required — pass `(fsPath) => vscode.Uri.file(fsPath)` (BUG-001)'
    );
  }
  const bundleDir = opts.webviewBundleDir ?? path.join(opts.extensionRoot, DEFAULT_BUNDLE_DIR);
  const indexPath = path.join(bundleDir, DASHBOARD_HTML_FILE);

  let raw: string;
  try {
    raw = fs.readFileSync(indexPath, 'utf8');
  } catch {
    raw = fallbackTemplate();
  }

  const csp = buildCspMeta(opts.webview.cspSource, opts.nonce);
  let html = raw;
  html = html.replaceAll('__CSP__', csp);
  html = html.replaceAll('__NONCE__', opts.nonce);
  html = ensureCspMetaPresent(html, csp);
  html = ensureVitePreloadNonceMeta(html, opts.nonce);
  html = rewriteAssetRefs(html, opts.webview, bundleDir, opts.toLocalUri);
  html = injectNonceIntoTags(html, opts.nonce);
  html = stripIncompatibleAttrs(html);
  return html;
}

function fallbackTemplate(): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8"/>',
    '<meta http-equiv="Content-Security-Policy" content="__CSP__"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>',
    '<title>Schegent Dashboard</title>',
    '</head><body>',
    '<div id="dashboard-app"></div>',
    '<script type="module" nonce="__NONCE__" src="./dashboard.js"></script>',
    '</body></html>'
  ].join('');
}

function ensureCspMetaPresent(html: string, csp: string): string {
  if (/<meta[^>]+http-equiv=["']Content-Security-Policy["']/i.test(html)) {
    return html;
  }
  return html.replace(
    /<head[^>]*>/i,
    (match) => `${match}\n<meta http-equiv="Content-Security-Policy" content="${csp}"/>`
  );
}

function ensureVitePreloadNonceMeta(html: string, nonce: string): string {
  const marker = /<meta\b[^>]*\bproperty=["']csp-nonce["'][^>]*>/i;
  const meta = `<meta property="csp-nonce" nonce="${nonce}"/>`;
  if (marker.test(html)) return html.replace(marker, meta);
  return html.replace(/<head[^>]*>/i, (match) => `${match}\n${meta}`);
}

function rewriteAssetRefs(
  html: string,
  webview: WebviewLike,
  bundleDir: string,
  toLocalUri: (fsPath: string) => UriLike
): string {
  return html.replace(/(\s(?:src|href)=)["']([^"']+)["']/gi, (full, prefix: string, ref: string) => {
    if (/^(?:https?:|data:|vscode-webview:)/i.test(ref)) return full;
    if (ref.startsWith('#')) return full;
    const cleaned = ref.replace(/^\.\//, '').replace(/^\/+/, '');
    if (cleaned === 'src/main.ts' || cleaned === 'src/dashboard-main.ts') {
      const uri = webview.asWebviewUri(toLocalUri(path.join(bundleDir, 'dashboard.js'))).toString();
      return `${prefix}"${uri}"`;
    }
    const fsPath = path.join(bundleDir, cleaned);
    const uri = webview.asWebviewUri(toLocalUri(fsPath)).toString();
    return `${prefix}"${uri}"`;
  });
}

function injectNonceIntoTags(html: string, nonce: string): string {
  let result = html;
  result = result.replace(/<script\b([^>]*)>/gi, (match, attrs: string) => {
    if (/\bnonce\s*=/.test(attrs)) return match;
    return `<script${attrs} nonce="${nonce}">`;
  });
  result = result.replace(/<style\b([^>]*)>/gi, (match, attrs: string) => {
    if (/\bnonce\s*=/.test(attrs)) return match;
    return `<style${attrs} nonce="${nonce}">`;
  });
  result = result.replace(
    /<link\b([^>]*\brel\s*=\s*["']modulepreload["'][^>]*)>/gi,
    (match, attrs: string) => {
      if (/\bnonce\s*=/.test(attrs)) return match;
      return `<link${attrs} nonce="${nonce}">`;
    }
  );
  return result;
}
