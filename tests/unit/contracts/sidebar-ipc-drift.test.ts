import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Authoritative from '../../../src/contracts/sidebar-ipc';
import * as HostShim from '../../../src/ui/sidebar/messages';

// Drift guard for FR-024 / US4.
//
// The host shim is statically imported above so module identity can be
// asserted via `===`. The webview shim lives in a package configured with
// `"type": "module"` + bundler resolution, which cannot be statically
// imported from the host's Node16/CJS TS context (TS1479). Module identity
// for the webview shim is guaranteed at the source-text level: it is a
// single `export *` re-export of the authoritative module. We assert that
// invariant by reading the shim's source. If a future contributor adds a
// local declaration, fork in a divergent type, or repoints the path, this
// test fails.

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('sidebar-ipc drift guard (FR-024)', () => {
  it('host shim re-exports CMD_CANCEL identical to authoritative module', () => {
    expect(HostShim.CMD_CANCEL).toBe(Authoritative.CMD_CANCEL);
    expect(HostShim.CMD_CANCEL).toBe('CMD_CANCEL');
  });

  it('host shim shares SCHEMA_VERSION with authoritative module', () => {
    expect(HostShim.SCHEMA_VERSION).toBe(Authoritative.SCHEMA_VERSION);
  });

  it('host shim exports the same COMMAND_GUARDS object as authoritative module', () => {
    expect(HostShim.COMMAND_GUARDS).toBe(Authoritative.COMMAND_GUARDS);
  });

  it('every COMMAND_TYPES literal has a guard in COMMAND_GUARDS', () => {
    for (const literal of Authoritative.COMMAND_TYPES) {
      expect(Authoritative.COMMAND_GUARDS).toHaveProperty(literal);
      const guard = Authoritative.COMMAND_GUARDS[literal];
      expect(typeof guard).toBe('function');
    }
  });

  it('COMMAND_GUARDS keyset equals COMMAND_TYPES (no extra/missing keys)', () => {
    const guardKeys = Object.keys(Authoritative.COMMAND_GUARDS).sort();
    const literals = [...Authoritative.COMMAND_TYPES].sort();
    expect(guardKeys).toEqual(literals);
  });

  it('discriminated union is exhaustive — each literal has a runtime guard that accepts a minimal command of that type', () => {
    // Most guards accept the bare `{ type, correlationId }` envelope. A
    // small number require a non-empty payload because they carry
    // operator input — register their minimal valid fixtures here. The
    // drift contract is still: "every literal has a runtime guard that
    // accepts SOME minimal command of that type", not "the bare envelope
    // is always sufficient".
    const PAYLOAD_REQUIRED_FIXTURES: Partial<
      Record<(typeof Authoritative.COMMAND_TYPES)[number], Record<string, unknown>>
    > = {
      [Authoritative.CMD_SET_CONFIRM_SUPPRESSION]: {
        actionKey: 'queue.clean-all',
        suppressed: true
      },
      // ReadMetricsCommand.payload is required at the type level (see its
      // field comment) even though every ReadMetricsRequest field is
      // itself optional, so `{}` is the minimal valid payload — a bare
      // envelope with no `payload` key at all is correctly rejected.
      [Authoritative.CMD_READ_METRICS]: {},
      [Authoritative.CMD_PING_BACKEND]: { runner: 'claude' },
      // Feature 084 — both export fields are required: `resourceKind` names
      // the one kind this exchange format admits, and `resourceId` names what
      // to resolve from the effective catalog.
      [Authoritative.CMD_EXPORT_PROCESS_YAML]: {
        resourceKind: 'phase',
        resourceId: 'specify'
      },
      // Feature 084 — preflight carries the resource kind and nothing else: no
      // location, no bytes, no scope (FR-020a).
      [Authoritative.CMD_PREFLIGHT_PROCESS_YAML]: { resourceKind: 'phase' }
    };
    for (const literal of Authoritative.COMMAND_TYPES) {
      const guard = Authoritative.COMMAND_GUARDS[literal];
      const payload = PAYLOAD_REQUIRED_FIXTURES[literal];
      const minimal = payload === undefined
        ? { type: literal, correlationId: 'c-test' }
        : { type: literal, correlationId: 'c-test', payload };
      expect(guard(minimal), `guard for ${literal} must accept a minimal fixture`).toBe(true);
      expect(guard({ type: 'NEVER_VALID_LITERAL' }), `guard for ${literal} must reject foreign literal`).toBe(false);
    }
  });

  it('rejects null, undefined, primitives, and objects without a type discriminator', () => {
    for (const literal of Authoritative.COMMAND_TYPES) {
      const guard = Authoritative.COMMAND_GUARDS[literal];
      expect(guard(null)).toBe(false);
      expect(guard(undefined)).toBe(false);
      expect(guard('string')).toBe(false);
      expect(guard(42)).toBe(false);
      expect(guard({})).toBe(false);
      expect(guard({ type: undefined })).toBe(false);
    }
  });

  // Feature 082 (US1, T019) — the two catalog saves are one contract shape.
  // If CMD_SAVE_PIPELINES ever drifts back to the unscoped `{ pipelines }`
  // payload, the Builder and the Phase editor stop agreeing on what a
  // revisioned complete-layer save is, and the shared save-layer-intent
  // algebra loses its second consumer.
  it('SavePipelinesCommand declares the same scoped save envelope as SavePhasesCommand', () => {
    // The two save shapes are declared together in the focused catalog-save
    // module; the barrel re-exports them so `sidebar-ipc.ts` remains the single
    // import site for the wire contract.
    const barrel = fs.readFileSync(path.join(REPO_ROOT, 'src/contracts/sidebar-ipc.ts'), 'utf8');
    expect(barrel, 'sidebar-ipc.ts must re-export SavePipelinesCommand').toMatch(
      /export type \{[^}]*SavePipelinesCommand[^}]*\} from '\.\/sidebar-ipc\/catalog-save'/
    );
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/contracts/sidebar-ipc/catalog-save.ts'),
      'utf8'
    );
    const declaration = source.match(
      /export interface SavePipelinesCommand[\s\S]*?\n\}/
    )?.[0];
    expect(declaration, 'SavePipelinesCommand must declare a payload').toBeDefined();
    for (const field of ['scope', 'expectedRevision', 'mutation', 'pipelines']) {
      expect(declaration, `SavePipelinesCommand payload must carry '${field}'`).toContain(field);
    }
  });

  it('host shim re-exports the identical CMD_SAVE_PIPELINES guard', () => {
    expect(HostShim.isCmdSavePipelines).toBe(Authoritative.isCmdSavePipelines);
    expect(Authoritative.COMMAND_GUARDS[Authoritative.CMD_SAVE_PIPELINES]).toBe(
      Authoritative.isCmdSavePipelines
    );
  });

  it('SCHEMA_VERSION is a numeric integer constant', () => {
    expect(typeof Authoritative.SCHEMA_VERSION).toBe('number');
    expect(Number.isInteger(Authoritative.SCHEMA_VERSION)).toBe(true);
  });

  it('webview shim source re-exports the authoritative IPC module via a single export-* statement', () => {
    const shimPath = path.join(REPO_ROOT, 'webview-ui/src/lib/messages.ts');
    const text = fs.readFileSync(shimPath, 'utf8');

    // Strip line and block comments before matching.
    const codeOnly = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Must contain exactly one export-* targeting the authoritative module.
    // The `.js` extension is required by the webview's "type": "module"
    // declaration; bundler resolution maps it to the .ts source.
    const exportStarMatches = codeOnly.match(
      /export\s+\*\s+from\s+['"][^'"]*src\/contracts\/sidebar-ipc(?:\.js)?['"]/g
    ) ?? [];
    expect(
      exportStarMatches,
      'webview shim must contain exactly one export-* re-export of src/contracts/sidebar-ipc'
    ).toHaveLength(1);

    // No other top-level `export ...` statements that could shadow or
    // diverge from the canonical surface.
    const otherExports = codeOnly.match(/^\s*export\s+(?!\*\s+from\s)\S/gm) ?? [];
    expect(
      otherExports,
      'webview shim must not declare any local exports beyond the export-*'
    ).toEqual([]);
  });

  it('host shim source re-exports the authoritative IPC module via a single export-* statement', () => {
    const shimPath = path.join(REPO_ROOT, 'src/ui/sidebar/messages.ts');
    const text = fs.readFileSync(shimPath, 'utf8');
    const codeOnly = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const exportStarMatches = codeOnly.match(
      /export\s+\*\s+from\s+['"][^'"]*contracts\/sidebar-ipc(?:\.js)?['"]/g
    ) ?? [];
    expect(exportStarMatches).toHaveLength(1);
    const otherExports = codeOnly.match(/^\s*export\s+(?!\*\s+from\s)\S/gm) ?? [];
    expect(otherExports).toEqual([]);
  });
});
