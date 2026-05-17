import * as fs from 'fs/promises';
import * as path from 'path';
import { buildCspMeta, generateNonce } from './csp';

// Mirrors the public shape of `vscode.Uri` for the subset the renderer cares
// about. The `scheme` field is what distinguishes a real Uri from a duck-typed
// `{ fsPath }` literal — the real `vscode.Webview.asWebviewUri` rejects partial
// shapes (BUG-004). See plan.md "Webview Sanitization Contract" rule 7.
export interface UriLike {
  readonly fsPath: string;
  readonly scheme: string;
}

export interface WebviewLike {
  asWebviewUri(localResource: UriLike): { toString(): string };
  readonly cspSource: string;
}

export interface RenderOptions {
  webview: WebviewLike;
  extensionRoot: string;
  nonce?: string;
  webviewBundleDir?: string;
  // Adapter that builds a Uri-shaped value for an absolute filesystem path.
  // Production wiring injects `(fsPath) => vscode.Uri.file(fsPath)`. The
  // renderer cannot import `vscode` directly because it is reused under
  // node-only unit tests where the module is unavailable. BUG-004.
  toLocalUri?: (fsPath: string) => UriLike;
}

const defaultToLocalUri: (fsPath: string) => UriLike = (fsPath) => ({ fsPath, scheme: 'file' });

const DEFAULT_BUNDLE_DIR = path.join('dist', 'webview');

export async function renderWebviewHtml(opts: RenderOptions): Promise<{ html: string; nonce: string }> {
  const nonce = opts.nonce ?? generateNonce();
  const bundleDir = opts.webviewBundleDir ?? path.join(opts.extensionRoot, DEFAULT_BUNDLE_DIR);
  const indexPath = path.join(bundleDir, 'index.html');
  const toLocalUri = opts.toLocalUri ?? defaultToLocalUri;
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch {
    raw = fallbackTemplate();
  }

  const csp = buildCspMeta(opts.webview.cspSource, nonce);
  let html = raw;
  html = html.replaceAll('__CSP__', csp);
  html = html.replaceAll('__NONCE__', nonce);
  html = ensureCspMetaPresent(html, csp);
  html = rewriteAssetRefs(html, opts.webview, bundleDir, toLocalUri);
  html = injectNonceIntoTags(html, nonce);
  html = stripIncompatibleAttrs(html);
  return { html, nonce };
}

export function stripIncompatibleAttrs(html: string): string {
  return html.replace(/<(script|link)\b([^>]*)>/gi, (_match, tag: string, attrs: string) => {
    const cleaned = attrs.replace(/\s+crossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
    return `<${tag}${cleaned}>`;
  });
}

export function cspPlaceholderHtml(webview: WebviewLike, nonce: string): string {
  const csp = buildCspMeta(webview.cspSource, nonce);
  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8"/>',
    `<meta http-equiv="Content-Security-Policy" content="${csp}"/>`,
    '<title>Schegent</title>',
    '</head><body><div id="app"></div></body></html>'
  ].join('');
}

export const FALLBACK_FAILURE_HTML =
  '<!doctype html><html><head>' +
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';"/>' +
  '</head><body>Failed to load Schegent sidebar.</body></html>';

function fallbackTemplate(): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8"/>',
    '<meta http-equiv="Content-Security-Policy" content="__CSP__"/>',
    '<title>Schegent</title>',
    '</head><body>',
    '<div id="app"></div>',
    '<script type="module" nonce="__NONCE__" src="./index.js"></script>',
    '</body></html>'
  ].join('');
}

function ensureCspMetaPresent(html: string, csp: string): string {
  if (/<meta[^>]+http-equiv=["']Content-Security-Policy["']/i.test(html)) {
    return html;
  }
  return html.replace(/<head[^>]*>/i, (match) => `${match}\n<meta http-equiv="Content-Security-Policy" content="${csp}"/>`);
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
    if (cleaned === 'src/main.ts') {
      const uri = webview.asWebviewUri(toLocalUri(path.join(bundleDir, 'index.js'))).toString();
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
  // BUG-001: <link rel="modulepreload"> and <link rel="preload" as="script">
  // are gated by `script-src` per the Fetch spec destination model. Without a
  // nonce the browser silently drops the preload, the entry chunk never
  // resolves, and the webview renders blank. Other rel values (stylesheet,
  // icon, manifest, …) are gated by different directives and are left alone.
  result = result.replace(/<link\b([^>]*)>/gi, (match, attrs: string) => {
    if (/\bnonce\s*=/.test(attrs)) return match;
    if (!isScriptGatedLink(attrs)) return match;
    return `<link${attrs} nonce="${nonce}">`;
  });
  return result;
}

function isScriptGatedLink(attrs: string): boolean {
  const relMatch = attrs.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!relMatch) return false;
  const rel = (relMatch[1] ?? relMatch[2] ?? relMatch[3] ?? '').toLowerCase();
  if (rel === 'modulepreload') return true;
  if (rel === 'preload') {
    const asMatch = attrs.match(/\bas\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const asValue = (asMatch?.[1] ?? asMatch?.[2] ?? asMatch?.[3] ?? '').toLowerCase();
    return asValue === 'script';
  }
  return false;
}
