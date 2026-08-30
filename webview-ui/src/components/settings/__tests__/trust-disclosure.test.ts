// FR-R3-143 (T039) — the read-only `schegent.trust.*` disclosure on the Settings tab.
//
// WHY IT IS DRIVEN, NOT READ. The acceptance for this surface rules out the
// obvious test: render the component, read its template, assert it says what it
// says. That passes for a component whose ladder is wrong, because the assertion
// was copied from the same wrong ladder. So the inputs here are RAW CONFIG —
// `(isTrusted, workspaceValue, globalValue)`, the three things VS Code actually
// reports — and both the effective value and the deciding step are computed by
// the HOST's own functions before the component ever sees them. If the
// disclosure and the resolver disagree about any of the four states, this fails.
//
// Same shape as `environment-policy-line.test.ts` (T035), and for the same
// reason: a surface that reports a host decision has to be asserted against the
// function that makes it, or the two drift and only the operator finds out.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import TrustDisclosure from '../general/TrustDisclosure.svelte';
import type { WorkflowSnapshot } from '../../../lib/snapshot-types';
import {
  resolveCapabilityDecision,
  resolveCapabilityScope,
  type ResolvedScope
} from '../../../../../src/state/capability-trust-decision';

// `vi.hoisted` so the spy exists before the hoisted `vi.mock` factory runs.
const { postCommand } = vi.hoisted(() => ({
  postCommand: vi.fn((..._args: unknown[]) => ({ correlationId: 'corr-test' }))
}));
vi.mock('../../../lib/vscode-api', () => ({ postCommand }));

afterEach(() => {
  cleanup();
  postCommand.mockClear();
});

interface ConfigState {
  /** What an operator did, in the words the ladder is written in. */
  readonly label: string;
  readonly isTrusted: boolean;
  readonly workspaceValue: unknown;
  readonly globalValue: unknown;
}

/**
 * The four states of spec C1, expressed as INPUTS. No expected scope appears
 * here on purpose — the expectations below are computed from the resolver, so a
 * ladder change moves the test's expectations and the component's output
 * together, and a disagreement between them is the only thing that can fail.
 */
const STATES: readonly ConfigState[] = [
  {
    label: 'silent at both scopes in a trusted workspace',
    isTrusted: true,
    workspaceValue: undefined,
    globalValue: undefined
  },
  {
    label: 'the workspace said yes',
    isTrusted: true,
    workspaceValue: true,
    globalValue: undefined
  },
  {
    label: 'the user said no',
    isTrusted: true,
    workspaceValue: undefined,
    globalValue: false
  },
  {
    label: 'the workspace is not trusted',
    isTrusted: false,
    workspaceValue: true,
    globalValue: true
  },
  {
    // The FR-R3-108 inversion, which is the case the whole disclosure exists for:
    // the repository's checked-in `true` must NOT be reported as the decider when
    // the operator's own `false` is what denied it.
    label: "the user said no and the repository's settings said yes",
    isTrusted: true,
    workspaceValue: true,
    globalValue: false
  }
];

/**
 * The operator-facing words each step must use. This is a VOCABULARY table, not
 * a second copy of the ladder: it says what "user" has to be called on screen,
 * never which inputs produce it. `resolveCapabilityScope` alone decides that.
 */
const LAYER_WORDS: Record<ResolvedScope, RegExp> = {
  user: /decided by your user settings/i,
  workspace: /decided by this workspace/i,
  'workspace-trust': /workspace trust|by default/i
};

/**
 * The ATTRIBUTION a row must not make, so a right answer for a wrong reason
 * still fails.
 *
 * Matched on "decided by <layer>", not on the layer's name alone: the
 * ceiling's allow sentence names both layers on purpose — "neither your user
 * settings nor this workspace has an opinion" is how it reports that no layer
 * decided — and forbidding the bare names would fail that correct copy.
 */
const OTHER_LAYERS: Record<ResolvedScope, readonly RegExp[]> = {
  user: [/decided by this workspace/i],
  workspace: [/decided by your user settings/i],
  'workspace-trust': [/decided by/i]
};

function snapshotFor(state: ConfigState): WorkflowSnapshot {
  const inputs = {
    isTrusted: state.isTrusted,
    workspaceValue: state.workspaceValue,
    globalValue: state.globalValue
  };
  // Both capabilities are given the SAME config, so a row that renders its
  // sibling's projection is visible as a passing test that stops failing when
  // the two states differ — which the per-capability assertions below cover.
  const decision = resolveCapabilityDecision(inputs);
  const scope = resolveCapabilityScope(inputs);
  return {
    resolvedTrust: { phases: decision, retryConditions: decision },
    resolvedScope: { phases: scope, retryConditions: scope }
  } as unknown as WorkflowSnapshot;
}

function collapse(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

describe('FR-R3-143 — the trust disclosure reports what the resolver decided', () => {
  for (const state of STATES) {
    it(`agrees with the resolver when ${state.label}`, () => {
      const inputs = {
        isTrusted: state.isTrusted,
        workspaceValue: state.workspaceValue,
        globalValue: state.globalValue
      };
      const expectedAllowed = resolveCapabilityDecision(inputs);
      const expectedScope = resolveCapabilityScope(inputs);

      const { container } = render(TrustDisclosure, { props: { snapshot: snapshotFor(state) } });

      for (const capability of ['phases', 'retryConditions'] as const) {
        const effective = container.querySelector(
          `[data-testid="trust-effective-${capability}"]`
        );
        expect(effective, `${capability} must render an effective value`).not.toBeNull();
        expect(
          collapse(effective?.textContent ?? null),
          `the rendered value for ${capability} must equal the resolver's decision`
        ).toBe(expectedAllowed ? 'Allowed' : 'Denied');

        const decidedBy = collapse(
          container.querySelector(`[data-testid="trust-decided-by-${capability}"]`)?.textContent ??
            null
        );
        expect(decidedBy, `${capability} must name a deciding layer`).toMatch(
          LAYER_WORDS[expectedScope]
        );
        for (const wrong of OTHER_LAYERS[expectedScope]) {
          expect(
            decidedBy,
            `${capability} must not name a layer that did not decide`
          ).not.toMatch(wrong);
        }
      }
    });
  }

  it('states each capability separately when the two resolve differently', () => {
    // The projection carries one entry per capability, and the ladder is run per
    // key. A component that rendered one row's projection into both would pass
    // every case above, where both keys are given identical config.
    const snapshot = {
      resolvedTrust: { phases: true, retryConditions: false },
      resolvedScope: { phases: 'workspace', retryConditions: 'user' }
    } as unknown as WorkflowSnapshot;
    const { container } = render(TrustDisclosure, { props: { snapshot } });

    expect(
      collapse(container.querySelector('[data-testid="trust-effective-phases"]')?.textContent ?? null)
    ).toBe('Allowed');
    expect(
      collapse(
        container.querySelector('[data-testid="trust-effective-retryConditions"]')?.textContent ??
          null
      )
    ).toBe('Denied');
    expect(
      collapse(
        container.querySelector('[data-testid="trust-decided-by-retryConditions"]')?.textContent ??
          null
      )
    ).toMatch(/your user settings/i);
  });

  it('says the layer is unknown rather than guessing when the host omits it', () => {
    // Legacy tolerance, and the reason the field is optional: an older host
    // bundle projects `resolvedTrust` without `resolvedScope`. Naming any step
    // here would be the exact defect this surface was built to fix.
    const snapshot = {
      resolvedTrust: { phases: false, retryConditions: false }
    } as unknown as WorkflowSnapshot;
    const { container } = render(TrustDisclosure, { props: { snapshot } });

    const decidedBy = collapse(
      container.querySelector('[data-testid="trust-decided-by-phases"]')?.textContent ?? null
    );
    expect(decidedBy).toMatch(/unknown/i);
    expect(decidedBy).not.toMatch(/your user settings/i);
    expect(decidedBy).not.toMatch(/this workspace's settings/i);
    // The effective value is still known and still correct, so it is still shown.
    expect(
      collapse(container.querySelector('[data-testid="trust-effective-phases"]')?.textContent ?? null)
    ).toBe('Denied');
  });

  it('renders both setting keys, which is what the coverage gate detects', () => {
    const { container } = render(TrustDisclosure, { props: { snapshot: snapshotFor(STATES[0]!) } });
    const text = collapse(container.textContent);
    expect(text).toContain('schegent.trust.allowCustomPhases');
    expect(text).toContain('schegent.trust.allowCustomRetryConditions');
  });

  it('hands the operator to the settings editor instead of writing the key', async () => {
    // Spec C1: there is no write path, so the affordance is a handoff. Asserted
    // as "the command was posted", not "a save was sent" — a save would ack
    // `accepted` and change nothing.
    const { container } = render(TrustDisclosure, { props: { snapshot: snapshotFor(STATES[0]!) } });
    const button = container.querySelector('[data-testid="trust-open-settings-phases"]');
    expect(button).not.toBeNull();
    await fireEvent.click(button as HTMLElement);

    expect(postCommand).toHaveBeenCalledTimes(1);
    expect(postCommand.mock.calls[0]?.[0]).toBe('CMD_OPEN_TRUST_SETTINGS');
    // No payload: a webview-supplied key must not reach `executeCommand`.
    expect(postCommand.mock.calls[0]?.length).toBe(1);
  });
});
