// Feature 099 (T496f, FR-042) — the envelope loses `scope` with the layer tier.
// It named the layer a write landed in; there is one catalog per kind now, so the
// field has no referent. The required-key case for it is not dropped but inverted:
// an envelope still carrying `scope` comes from a caller that believes in layers,
// and the ingress gate refuses it as an undeclared key rather than ignoring it.
//
// `expectedRevision` was `phaseLayerRevision(rows)` — a hash of the layer the
// webview held. A revision is the store's now, opaque to both ends, so this gate
// checks only that one is present and is a string; what a real one looks like is
// pinned in `tests/unit/catalog/`.

import { describe, expect, it } from 'vitest';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import { CMD_SAVE_PHASES } from '../../src/contracts/sidebar-ipc';

const valid = {
  type: CMD_SAVE_PHASES,
  correlationId: 'scoped-save',
  payload: {
    expectedRevision: 'rev-phase-0',
    mutation: { kind: 'create', phaseId: 'custom-phase' },
    phases: [{ id: 'custom-phase', name: 'Custom', version: 1, skill: 'skill-a' }]
  }
};

describe('revisioned Phase save IPC contract', () => {
  it('accepts an exact revisioned mutation envelope', () => {
    expect(validateInboundMessage(valid)).toMatchObject({ ok: true, command: valid });
  });

  it.each(['expectedRevision', 'mutation', 'phases'])(
    'rejects an envelope missing %s',
    (key) => {
      const payload = { ...valid.payload } as Record<string, unknown>;
      delete payload[key];
      expect(validateInboundMessage({ ...valid, payload })).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    }
  );

  it('rejects a non-string revision', () => {
    expect(validateInboundMessage({
      ...valid,
      payload: { ...valid.payload, expectedRevision: 3 }
    })).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it('rejects an envelope that still carries a scope (FR-042)', () => {
    // The successor of `rejects an envelope missing scope`. A caller pinned to
    // the layer tier must fail loudly at the boundary, not have its extra field
    // quietly dropped on the way to a handler that would ignore it.
    expect(validateInboundMessage({
      ...valid,
      payload: { ...valid.payload, scope: 'user' }
    })).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it('rejects undeclared payload keys', () => {
    expect(validateInboundMessage({
      ...valid,
      payload: { ...valid.payload, instruction: 'must not be echoed at envelope level' }
    })).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  // Feature 085 (FR-036) shipped an `import-package` arm in the handler and a
  // webview that emits it, but not in this gate — so the envelope was dropped at
  // the transport boundary and the package import never reached the code that
  // implements it. Every other test in the suite dispatches through the router
  // directly, which is exactly why the gap was invisible. These two cases pin the
  // arm from the outside: the set-naming kind is the only mutation carrying no
  // `phaseId`, and a malformed set is refused here rather than left to an algebra
  // that would report it as a mutation mismatch.
  describe('import-package (085 FR-036)', () => {
    const packageEnvelope = (mutation: unknown) => ({
      ...valid,
      payload: { ...valid.payload, mutation }
    });

    it('accepts a package envelope naming its declared phase ids', () => {
      expect(
        validateInboundMessage(packageEnvelope({ kind: 'import-package', phaseIds: ['custom-phase'] }))
      ).toMatchObject({ ok: true });
    });

    it.each([
      { kind: 'import-package' },
      { kind: 'import-package', phaseIds: [] },
      { kind: 'import-package', phaseIds: 'custom-phase' },
      { kind: 'import-package', phaseIds: [''] },
      { kind: 'import-package', phaseIds: ['x'.repeat(65)] },
      { kind: 'import-package', phaseIds: [123] },
      { kind: 'import-package', phaseIds: ['custom-phase'], phaseId: 'custom-phase' }
    ])('rejects a malformed package mutation %o', (mutation) => {
      expect(validateInboundMessage(packageEnvelope(mutation))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    });
  });
});
