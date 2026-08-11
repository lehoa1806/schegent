import { describe, expect, it } from 'vitest';
import { phaseLayerRevision } from '../../src/config/process-catalog';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import { CMD_SAVE_PHASES } from '../../src/contracts/sidebar-ipc';

const valid = {
  type: CMD_SAVE_PHASES,
  correlationId: 'scoped-save',
  payload: {
    scope: 'user',
    expectedRevision: phaseLayerRevision([]),
    mutation: { kind: 'create', phaseId: 'custom-phase' },
    phases: [{ id: 'custom-phase', name: 'Custom', version: 1, skill: 'skill-a' }]
  }
};

describe('scoped Phase save IPC contract', () => {
  it('accepts an exact revisioned mutation envelope', () => {
    expect(validateInboundMessage(valid)).toMatchObject({ ok: true, command: valid });
  });

  it.each(['scope', 'expectedRevision', 'mutation', 'phases'])(
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
