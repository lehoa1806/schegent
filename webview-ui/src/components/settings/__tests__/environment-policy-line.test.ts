// FR-R3-143 (T035) — the "Effective policy" line in the backends group.
//
// WHY THIS EXISTS. Three settings fold into one outcome, and the fold is not
// commutative with what the controls look like: `cli.inheritEnvironment: false`
// silently overrides both `cli.environmentMode` and `cli.environmentAllowlist`,
// and produces a policy with no allowlist field at all. An operator reading the
// four controls sees `allowlist`, a populated list, and a legacy boolean they have
// no reason to connect to either — and their spawns forward nothing.
//
// So the line has two obligations, and they are tested separately below:
//   1. it must agree with the spawn (asserted against the SAME function the spawn
//      calls, so the two cannot drift), and
//   2. when the legacy boolean is what decided the outcome, it must SAY SO. An
//      "Effective policy: minimal" that does not name its cause, sitting above a
//      mode reading `allowlist`, reads as a stale surface. The operator disbelieves
//      it, re-edits the list, and files a bug against the allowlist.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import GeneralSettingsTab from '../GeneralSettingsTab.svelte';
import type { WorkflowSnapshot, GeneralSettings } from '../../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import { foldLegacyRun } from '../../../lib/__tests__/queue-runtime-fixture';
import { resolveProcessEnvironmentPolicy } from '../../../../../src/contracts/process-environment-policy';

vi.mock('../../../lib/vscode-api', () => ({
  postCommand: () => ({ correlationId: 'corr-test' })
}));
vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: { markPending: vi.fn(), onceAck: vi.fn(() => () => undefined) }
}));

afterEach(() => cleanup());

interface EnvironmentInputs {
  readonly inheritEnvironment: boolean;
  readonly mode: string;
  readonly allowlist: readonly string[];
}

function buildSnapshot(inputs: EnvironmentInputs): WorkflowSnapshot {
  const generalSettings = Object.freeze({
    ...IDLE_GENERAL_SETTINGS,
    cliInheritEnvironment: inputs.inheritEnvironment,
    cliEnvironmentMode: inputs.mode,
    cliEnvironmentAllowlist: Object.freeze([...inputs.allowlist])
  }) as unknown as GeneralSettings;
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues: foldLegacyRun({
      status: 'idle',
      activeFeature: null,
      phases: Object.freeze([]),
      liveActivity: Object.freeze({
        summary: null,
        category: null,
        lastEventAt: null,
        freshness: 'idle',
        staleSeconds: null
      }),
      workflowElapsedMs: null
    }),
    queue: Object.freeze({
      orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-08-30T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings
  }) as unknown as WorkflowSnapshot;
}

function policyLine(inputs: EnvironmentInputs): string {
  const { container } = render(GeneralSettingsTab, {
    props: { snapshot: buildSnapshot(inputs) }
  });
  const node = container.querySelector('[data-testid="effective-environment-policy"]');
  expect(node, 'the backends group must render an effective-policy line').not.toBeNull();
  // Collapsed: the label and the sentence are separate text nodes, so `textContent`
  // carries the template's indentation between them.
  return collapse((node as HTMLElement).textContent);
}

function collapse(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** The label the legacy boolean carries in the UI, which the line must quote. */
const LEGACY_BOOLEAN_LABEL = 'Inherit Host Environment (legacy)';

describe('FR-R3-143 — the effective environment policy line', () => {
  it('names the legacy boolean as the cause when it overrides mode and allowlist', () => {
    // The headline case, stated exactly as the acceptance criterion does:
    // boolean off, mode `allowlist`, a populated list.
    const text = policyLine({
      inheritEnvironment: false,
      mode: 'allowlist',
      allowlist: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']
    });

    expect(text, 'the outcome the spawn will actually apply').toContain('minimal');
    expect(text, 'the input that decided it, quoted as the UI labels it').toContain(
      LEGACY_BOOLEAN_LABEL
    );
    expect(
      text,
      'and that the two controls below it are inert, which is the part an operator ' +
        'cannot infer from the outcome alone'
    ).toMatch(/overrides/i);
  });

  it('does not blame the boolean when the mode chose minimal on its own', () => {
    // `minimal` from either input produces the same outcome. Naming the boolean
    // here would be a false cause: turning it on would change nothing.
    const text = policyLine({ inheritEnvironment: true, mode: 'minimal', allowlist: [] });
    expect(text).toContain('minimal');
    expect(text).not.toContain(LEGACY_BOOLEAN_LABEL);
  });

  it('counts the names that will actually be forwarded, not the rows on screen', () => {
    // `sanitizeProcessEnvAllowlist` drops an illegal name silently, at spawn time,
    // in another process. A settings surface that counts rows would report three.
    const text = policyLine({
      inheritEnvironment: true,
      mode: 'allowlist',
      allowlist: ['HTTPS_PROXY', '1BAD', 'HTTPS_PROXY']
    });
    expect(text).toContain('allowlist');
    expect(text, 'one legal name: the digit-leading entry and the duplicate are dropped').toContain(
      '1 name'
    );
  });

  it('renders at all when the projected list carries a duplicate', () => {
    // Regression, found by the test above. `StringListField` keyed its rows by
    // NAME, so a `settings.json` containing the same variable twice — legal: the
    // manifest constrains each element and says nothing about uniqueness — threw
    // `each_key_duplicate` and took the entire Settings tab down with it. The
    // list editor's own `add()` rejects duplicates, which is why nothing reached
    // this path from the UI.
    const { container } = render(GeneralSettingsTab, {
      props: {
        snapshot: buildSnapshot({
          inheritEnvironment: true,
          mode: 'allowlist',
          allowlist: ['HTTPS_PROXY', 'HTTPS_PROXY']
        })
      }
    });
    const rows = container.querySelectorAll('[data-testid^="general-settings-remove-cliEnvironmentAllowlist-"]');
    expect(rows.length, 'both rows render; neither is dropped or merged').toBe(2);
  });

  it('says so plainly when an allowlist is empty', () => {
    const text = policyLine({ inheritEnvironment: true, mode: 'allowlist', allowlist: [] });
    expect(text).toContain('allowlist');
    expect(text).toContain('nothing else');
  });

  it('warns that inherit forwards credentials', () => {
    const text = policyLine({ inheritEnvironment: true, mode: 'inherit', allowlist: [] });
    expect(text).toContain('inherit');
    expect(text).toMatch(/credentials/i);
  });

  it('reads the DRAFT: the line moves before anything is saved', async () => {
    const { container } = render(GeneralSettingsTab, {
      props: {
        snapshot: buildSnapshot({ inheritEnvironment: true, mode: 'inherit', allowlist: [] })
      }
    });
    const line = container.querySelector(
      '[data-testid="effective-environment-policy"]'
    ) as HTMLElement;
    expect(collapse(line.textContent)).toContain('inherit');

    const select = container.querySelector(
      '[data-testid="general-settings-input-cliEnvironmentMode"]'
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'minimal' } });

    expect(
      collapse(line.textContent),
      'reading the projection would show the operator the policy they already have, ' +
        'which is not the question the edit in front of them raises'
    ).toContain('minimal');
  });
});

describe('FR-R3-143 — the line agrees with the spawn', () => {
  // The oracle calls `resolveProcessEnvironmentPolicy` — the same function
  // `buildSpawnEnv`'s caller does. This is deliberately not an independent
  // reimplementation: the claim under test is AGREEMENT, and a second copy of the
  // precedence rules here would be the exact defect the line exists to prevent,
  // relocated into its own test.
  const MATRIX: readonly EnvironmentInputs[] = [
    { inheritEnvironment: true, mode: 'inherit', allowlist: [] },
    { inheritEnvironment: true, mode: 'minimal', allowlist: ['HTTPS_PROXY'] },
    { inheritEnvironment: true, mode: 'allowlist', allowlist: ['HTTPS_PROXY'] },
    { inheritEnvironment: false, mode: 'inherit', allowlist: [] },
    { inheritEnvironment: false, mode: 'allowlist', allowlist: ['HTTPS_PROXY'] },
    { inheritEnvironment: false, mode: 'minimal', allowlist: [] }
  ];

  it('NON-VACUITY: the matrix contains cases where the outcome is not the selected mode', () => {
    // Without this, a line that simply echoed the mode dropdown would satisfy every
    // assertion below and the agreement check would prove nothing.
    const overridden = MATRIX.filter(
      (inputs) =>
        resolveProcessEnvironmentPolicy({
          inheritEnvironment: inputs.inheritEnvironment,
          mode: inputs.mode,
          allowlist: inputs.allowlist
        }).mode !== inputs.mode
    );
    expect(overridden.length).toBeGreaterThanOrEqual(2);
  });

  it('renders the resolved mode for every combination', () => {
    for (const inputs of MATRIX) {
      const expected = resolveProcessEnvironmentPolicy({
        inheritEnvironment: inputs.inheritEnvironment,
        mode: inputs.mode,
        allowlist: inputs.allowlist
      }).mode;
      const text = policyLine(inputs);
      expect(
        text,
        `inherit=${String(inputs.inheritEnvironment)} mode=${inputs.mode} should resolve to ` +
          `${expected}, but the line read: ${text}`
      ).toContain(`Effective policy: ${expected}`);
      cleanup();
    }
  });
});

describe('FR-R3-143 — the line calls the shared fold, not a copy of it', () => {
  const SOURCE = readFileSync(
    resolve(__dirname, '..', 'general', 'BackendEnvironmentGroup.svelte'),
    'utf8'
  );

  it('imports the resolver from contracts', () => {
    expect(SOURCE).toMatch(
      /import \{ resolveProcessEnvironmentPolicy \} from '[^']*src\/contracts\/process-environment-policy'/
    );
  });

  it('does not restate the fold', () => {
    // The two names that only appear inside a reimplementation: `inheritProcessEnv`
    // is the policy field the fold sets, and `sanitizeProcessEnvAllowlist` is the
    // filter it applies. The component consumes the RESULT, so neither belongs here.
    expect(SOURCE, 'the component must not construct a policy of its own').not.toContain(
      'inheritProcessEnv'
    );
    expect(SOURCE, 'nor filter the allowlist itself').not.toContain('sanitizeProcessEnvAllowlist');
  });
});
