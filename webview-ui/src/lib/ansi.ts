// Feature 068 — strip ANSI SGR escape sequences (colors, bold, reset, etc.)
// from a string so the rendered CLI command block is readable. Pure helper;
// no DOM access, no exceptions.

// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

export function stripAnsi(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  return input.replace(ANSI_SGR, '');
}
