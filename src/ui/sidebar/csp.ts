import { randomBytes } from 'crypto';

const NONCE_BYTES = 24;

export function generateNonce(): string {
  return randomBytes(NONCE_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function buildCspMeta(cspSource: string, nonce: string): string {
  const directives = [
    `default-src 'none'`,
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
    `connect-src 'none'`
  ];
  return directives.join('; ') + ';';
}

export const FORBIDDEN_TOKENS = ['unsafe-inline', 'unsafe-eval', 'unsafe-hashes', '*'];
