// Feature 013 — Wave 5 (US5, T064): drift guard for IPC validator ownership.
//
// The sidebar shim at `src/ui/sidebar/ipc-validator.ts` MUST only re-export
// validators from the authoritative `src/contracts/runtime-validators.ts`.
// Every `case CMD_XXX:` dispatched by `validateInboundMessage` MUST
// correspond to a `CMD_XXX` literal declared in the authoritative IPC
// contract module `src/contracts/sidebar-ipc.ts`. If a future contributor
// re-introduces a sidebar-local `function validate*`, or adds a validator
// case for a literal that is not part of the canonical contract, this
// test fails.
//
// See specs/013-correctness-trust-refactor/contracts/ipc-validator-ownership.md.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SIDEBAR_SHIM = path.join(REPO_ROOT, 'src/ui/sidebar/ipc-validator.ts');
const RUNTIME_VALIDATORS = path.join(REPO_ROOT, 'src/contracts/runtime-validators.ts');
const SIDEBAR_IPC = path.join(REPO_ROOT, 'src/contracts/sidebar-ipc.ts');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('no-duplicate-ipc-validators (Wave 5, T064)', () => {
  it('sidebar shim has no inline `function validate*` definitions', () => {
    const src = stripComments(fs.readFileSync(SIDEBAR_SHIM, 'utf8'));
    const inline = src.match(/^\s*(?:export\s+)?function\s+validate\w+/gm) ?? [];
    expect(
      inline,
      'src/ui/sidebar/ipc-validator.ts must only re-export validators from src/contracts/runtime-validators.ts'
    ).toEqual([]);
  });

  it('sidebar shim re-exports from the authoritative runtime-validators module via a single export-*', () => {
    const src = stripComments(fs.readFileSync(SIDEBAR_SHIM, 'utf8'));
    const exportStarMatches = src.match(
      /export\s+\*\s+from\s+['"][^'"]*contracts\/runtime-validators(?:\.js)?['"]/g
    ) ?? [];
    expect(exportStarMatches).toHaveLength(1);
    const otherExports = src.match(/^\s*export\s+(?!\*\s+from\s)\S/gm) ?? [];
    expect(otherExports, 'sidebar shim must declare no local exports').toEqual([]);
  });

  it('every CMD_* case in runtime-validators.ts maps to a CMD_* literal in the authoritative IPC contract', () => {
    const validators = stripComments(fs.readFileSync(RUNTIME_VALIDATORS, 'utf8'));
    const ipc = stripComments(fs.readFileSync(SIDEBAR_IPC, 'utf8'));

    const handled = new Set(
      [...validators.matchAll(/case\s+(CMD_[A-Z_]+)\s*:/g)].map((m) => m[1])
    );
    const declared = new Set(
      [...ipc.matchAll(/export const (CMD_[A-Z_]+) = ['"]CMD_[A-Z_]+['"]/g)].map((m) => m[1])
    );

    expect(handled.size, 'runtime-validators.ts must dispatch on at least one CMD_*').toBeGreaterThan(0);
    const stale: string[] = [];
    for (const c of handled) {
      if (!declared.has(c)) stale.push(c);
    }
    expect(
      stale,
      'every CMD_* handled in runtime-validators.ts must be declared in src/contracts/sidebar-ipc.ts'
    ).toEqual([]);
  });

  it('every command literal exposed to the webview has an inbound runtime validator case', () => {
    const validators = stripComments(fs.readFileSync(RUNTIME_VALIDATORS, 'utf8'));
    const ipc = stripComments(fs.readFileSync(SIDEBAR_IPC, 'utf8'));

    const handled = new Set(
      [...validators.matchAll(/case\s+(CMD_[A-Z_]+)\s*:/g)].map((m) => m[1])
    );
    const commandTypesBlock = ipc.match(/export const COMMAND_TYPES = \[([\s\S]*?)\]\s+as const;/);
    expect(commandTypesBlock, 'src/contracts/sidebar-ipc.ts must declare COMMAND_TYPES').not.toBeNull();
    const commandTypes = new Set(
      [...(commandTypesBlock?.[1] ?? '').matchAll(/\b(CMD_[A-Z_]+)\b/g)].map((m) => m[1])
    );

    expect(commandTypes.size, 'COMMAND_TYPES must expose at least one webview command').toBeGreaterThan(0);
    const missing = [...commandTypes].filter((c) => !handled.has(c)).sort();
    expect(
      missing,
      'every COMMAND_TYPES literal must be accepted or rejected by validateInboundMessage before MessageRouter dispatch'
    ).toEqual([]);
  });
});
