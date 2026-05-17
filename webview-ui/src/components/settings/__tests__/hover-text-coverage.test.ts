/**
 * Feature 018 — Settings UI Hover Text coverage (structural test).
 *
 * Purpose: enforce at build time that every focusable control in the
 * four Settings tabs has a description surface, and that every entry in
 * the per-tab `*_DESCRIPTIONS` map is consumed by at least one mounted
 * hoverTextAnchor. Removing a `use:hoverTextAnchor={...}` from a control,
 * or adding a description-map entry without wiring it, must fail this
 * test (FR-012). Post-2026-05-13 hover-text redirect: the predecessor's
 * sibling `(?)`-button trigger pattern is gone; the action lives on the
 * control itself.
 *
 * What we check per tab:
 *   (a) Every focusable element (`input, button, select, textarea, [tabindex]`
 *       except `tabindex="-1"`) has EITHER an `aria-describedby` pointing
 *       to an in-DOM `<p id="desc-…">` (inline mode) OR
 *       `data-hover-text-anchored="true"` on the element itself (popover mode).
 *   (b) Every description-map entry — except the explicitly-listed
 *       header-only keys used as static text in `<h2>`/`<h3>` — is
 *       reflected by at least one anchored control in the DOM. Coverage
 *       is inferred from `[id^="desc-"]` (inline) and
 *       `[data-hover-text-anchored="true"]` + `data-hover-text-controlid`
 *       (popover) markers, mapped back to description keys via a per-tab
 *       `controlIdToKey` translator.
 *
 * The describe block iterates the 4-tab table so adding a new
 * settings tab is one entry, not a copy-pasted block.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import type { ComponentType } from 'svelte';

import GeneralSettingsTab from '../GeneralSettingsTab.svelte';
import FatalSignaturesTab from '../FatalSignaturesTab.svelte';
// Feature 030 (US3) — QueueSettingsTab.svelte + descriptions were
// deleted alongside the multi-queue surfaces. Multi-queue settings
// (concurrency cap, default queue) are no longer configurable.
import WakeUpTab from '../WakeUpTab.svelte';

import { GENERAL_SETTINGS_DESCRIPTIONS } from '../GeneralSettingsTab.descriptions';
import { FATAL_SIGNATURES_DESCRIPTIONS } from '../FatalSignaturesTab.descriptions';
import { WAKEUP_DESCRIPTIONS } from '../WakeUpTab.descriptions';

import type {
  GeneralSettings,
  WakeUpSettings,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS, IDLE_WAKEUP_SETTINGS } from '../../../lib/snapshot-types';

// ── Snapshot fixtures ──────────────────────────────────────────────────

function buildBaseSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: Object.freeze([]),
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false,
      queues: Object.freeze([])
    }),
    auditTail: Object.freeze([]),
    liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
    }),
    workflowElapsedMs: null,
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-05-13T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    ...overrides
  }) as unknown as WorkflowSnapshot;
}

function snapshotWithGeneralSettings(): WorkflowSnapshot {
  const generalSettings: GeneralSettings = {
    ...IDLE_GENERAL_SETTINGS,
    // Force at least one operator fatal signature row so the dynamic
    // operator-input / operator-remove hover-texts mount on FatalSignaturesTab.
    fatalSignatures: Object.freeze(['SAMPLE_FATAL_TOKEN']) as readonly string[]
  };
  return buildBaseSnapshot({ generalSettings });
}

// Feature 030 (US3) — `snapshotWithQueues` removed alongside the deleted
// QueueSettingsTab.svelte. The queue-related hover-text fixtures are no
// longer needed.

function snapshotWithWakeUp(
  schedulerType: WakeUpSettings['schedulerType'] = 'chronological'
): WorkflowSnapshot {
  const wakeUpSettings: WakeUpSettings = {
    ...IDLE_WAKEUP_SETTINGS,
    enabled: true,
    schedulerType
  };
  return buildBaseSnapshot({ wakeUpSettings });
}

// ── Per-tab table (T036 parameterization) ──────────────────────────────

interface TabSpec {
  readonly name: string;
  readonly component: ComponentType;
  readonly buildProps: () => Record<string, unknown>;
  /**
   * Additional prop builders used by the orphan-coverage assertion only.
   * Tabs with mutually-exclusive surfaces (e.g. WakeUpTab's chronological
   * XOR periodic mode) declare each variant here so the union of mounts
   * covers every description-map entry.
   */
  readonly alternateProps?: ReadonlyArray<() => Record<string, unknown>>;
  /**
   * Description-map keys that are intentionally NOT wired with a
   * hover-text anchor — they are used as static text in `<h2>` /
   * `<h3>` / `<p>` headers. Excluded from the orphan check.
   */
  readonly headerOnlyKeys: readonly string[];
  /**
   * Keys (after the prefix and dynamic-suffix translation) that this tab
   * expects to see exercised by mounting. All other keys in the map must
   * also appear here.
   */
  readonly descriptionKeys: readonly string[];
  /**
   * Translate a DOM controlId (the value of `data-hover-text-controlid`
   * or the suffix on `id="desc-…"`) back to its description-map key.
   * For dynamic per-row hover-texts (e.g. `fatal-operator-input-0` →
   * `operator-input`) the strip-suffix logic lives here.
   */
  readonly controlIdToKey: (controlId: string) => string | null;
}

const TAB_SPECS: readonly TabSpec[] = [
  {
    name: 'GeneralSettingsTab',
    component: GeneralSettingsTab as unknown as ComponentType,
    buildProps: () => ({ snapshot: snapshotWithGeneralSettings() }),
    headerOnlyKeys: ['tab-header'],
    descriptionKeys: Object.keys(GENERAL_SETTINGS_DESCRIPTIONS),
    controlIdToKey: (id) => (id in GENERAL_SETTINGS_DESCRIPTIONS ? id : null)
  },
  {
    name: 'FatalSignaturesTab',
    component: FatalSignaturesTab as unknown as ComponentType,
    buildProps: () => ({ snapshot: snapshotWithGeneralSettings() }),
    headerOnlyKeys: ['tab-header', 'built-in-section-header', 'operator-section-header'],
    descriptionKeys: Object.keys(FATAL_SIGNATURES_DESCRIPTIONS),
    controlIdToKey: (id) => {
      // Static buttons map fatal-add → operator-add, etc.
      if (id === 'fatal-add') return 'operator-add';
      if (id === 'fatal-save') return 'operator-save';
      if (id === 'fatal-reset') return 'operator-reset';
      // Dynamic per-row: fatal-operator-input-<N>, fatal-operator-remove-<N>.
      if (/^fatal-operator-input-\d+$/.test(id)) return 'operator-input';
      if (/^fatal-operator-remove-\d+$/.test(id)) return 'operator-remove';
      return null;
    }
  },
  // Feature 030 (US3) — QueueSettingsTab entry removed alongside the
  // deleted component. The 4-tab parameterized table is now a 3-tab
  // table (General, FatalSignatures, WakeUp).
  {
    name: 'WakeUpTab',
    component: WakeUpTab as unknown as ComponentType,
    buildProps: () => ({ snapshot: snapshotWithWakeUp('chronological') }),
    // WakeUpTab renders chronological-time XOR periodic-interval per
    // `schedulerType`. The orphan check unions both renders so neither
    // branch's hover-text-map entry can be silently removed.
    alternateProps: [() => ({ snapshot: snapshotWithWakeUp('periodic') })],
    headerOnlyKeys: ['tab-header'],
    descriptionKeys: Object.keys(WAKEUP_DESCRIPTIONS),
    controlIdToKey: (id) => {
      // WakeUpTab prefixes every controlId with `wakeup-`.
      if (!id.startsWith('wakeup-')) return null;
      const key = id.slice('wakeup-'.length);
      return key in WAKEUP_DESCRIPTIONS ? key : null;
    }
  }
] as const;

// ── Helpers ────────────────────────────────────────────────────────────

const FOCUSABLE_SELECTOR =
  'input, button, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Resolve a focusable control's described status under the 2026-05-13
 * hover-text redirect:
 *   - `inline`  → has `aria-describedby` pointing at an in-DOM
 *                 `<p id="desc-…">` sibling (action's inline branch).
 *   - `popover` → has `data-hover-text-anchored="true"` on the element
 *                 itself (action's popover branch).
 *   - `none`    → not described.
 */
function describedStatus(el: Element, container: ParentNode): 'inline' | 'popover' | 'none' {
  const ariaDescribedBy = el.getAttribute('aria-describedby');
  if (ariaDescribedBy) {
    const target = container.querySelector(`#${CSS.escape(ariaDescribedBy)}`);
    if (target && target.tagName.toLowerCase() === 'p') return 'inline';
  }
  if (el.getAttribute('data-hover-text-anchored') === 'true') return 'popover';
  return 'none';
}

afterEach(() => cleanup());

// ── Parameterized suite (T036) ─────────────────────────────────────────

describe.each(TAB_SPECS)('Feature 018 — hover-text coverage on $name', (spec) => {
  it('every focusable control has either `aria-describedby` (inline) or `data-hover-text-anchored="true"` (popover)', () => {
    const { container } = render(spec.component, { props: spec.buildProps() });
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    expect(focusable.length, 'tab mounted no focusable controls').toBeGreaterThan(0);

    const uncovered: string[] = [];
    for (const el of focusable) {
      const status = describedStatus(el, container);
      if (status === 'none') {
        uncovered.push(
          `<${el.tagName.toLowerCase()} data-testid="${el.getAttribute('data-testid') ?? '∅'}" ` +
            `id="${el.getAttribute('id') ?? '∅'}"> has neither aria-describedby nor data-hover-text-anchored — wire use:hoverTextAnchor or add inline description`
        );
      }
    }
    expect(uncovered, `controls missing description: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('every description-map entry (excluding header-only keys) is rendered at least once', () => {
    // Union the seen-keys set across the primary fixture plus any
    // alternate fixtures the spec declares. Mutually-exclusive surfaces
    // (WakeUpTab's chronological XOR periodic mode) require this.
    const seenControlIds = new Set<string>();
    const builders = [spec.buildProps, ...(spec.alternateProps ?? [])];
    for (const buildProps of builders) {
      const { container } = render(spec.component, { props: buildProps() });
      container
        .querySelectorAll<HTMLElement>('[data-hover-text-anchored="true"]')
        .forEach((el) => {
          const v = el.getAttribute('data-hover-text-controlid');
          if (v) seenControlIds.add(v);
        });
      container.querySelectorAll<HTMLElement>('p[id^="desc-"]').forEach((p) => {
        const id = p.getAttribute('id');
        if (id) seenControlIds.add(id.slice('desc-'.length));
      });
      cleanup();
    }

    // Map each seen controlId back to its description key.
    const seenKeys = new Set<string>();
    for (const cid of seenControlIds) {
      const key = spec.controlIdToKey(cid);
      if (key) seenKeys.add(key);
    }

    const orphanKeys: string[] = [];
    for (const key of spec.descriptionKeys) {
      if (spec.headerOnlyKeys.includes(key)) continue;
      if (!seenKeys.has(key)) orphanKeys.push(key);
    }
    expect(
      orphanKeys,
      `description keys not rendered by ${spec.name}: ${orphanKeys.join(', ')} — wire use:hoverTextAnchor for each`
    ).toEqual([]);
  });

  it('every controlId seen in DOM maps to a real description-map key', () => {
    // Defense in depth: if an anchor is mounted with a controlId that
    // does NOT translate to a known description key, we have a dangling
    // surface — fail the test so the wiring is fixed.
    const { container } = render(spec.component, { props: spec.buildProps() });
    const danglingControlIds: string[] = [];
    container
      .querySelectorAll<HTMLElement>('[data-hover-text-anchored="true"]')
      .forEach((el) => {
        const v = el.getAttribute('data-hover-text-controlid');
        if (!v) return;
        if (spec.controlIdToKey(v) === null) danglingControlIds.push(v);
      });
    container.querySelectorAll<HTMLElement>('p[id^="desc-"]').forEach((p) => {
      const id = p.getAttribute('id');
      if (!id) return;
      const controlId = id.slice('desc-'.length);
      if (spec.controlIdToKey(controlId) === null) danglingControlIds.push(controlId);
    });
    expect(
      danglingControlIds,
      `controlIds without description-map keys: ${danglingControlIds.join(', ')}`
    ).toEqual([]);
  });
});

// ── Feature 019 T028: runtime-log control hover-text content checks ────

describe('Feature 019 — runtime-log hover-text content & anchor coverage', () => {
  function collectAnchoredControlIds(): Set<string> {
    const { container } = render(GeneralSettingsTab as unknown as ComponentType, {
      props: { snapshot: snapshotWithGeneralSettings() }
    });
    const ids = new Set<string>();
    container
      .querySelectorAll<HTMLElement>('[data-hover-text-anchored="true"]')
      .forEach((el) => {
        const v = el.getAttribute('data-hover-text-controlid');
        if (v) ids.add(v);
      });
    container.querySelectorAll<HTMLElement>('p[id^="desc-"]').forEach((p) => {
      const id = p.getAttribute('id');
      if (id) ids.add(id.slice('desc-'.length));
    });
    return ids;
  }

  it('mounts hover-text anchors for runtimeLogLevel input + save + reset', () => {
    const seen = collectAnchoredControlIds();
    expect(seen.has('runtimeLogLevel')).toBe(true);
    expect(seen.has('runtimeLogLevel-save')).toBe(true);
    expect(seen.has('runtimeLogLevel-reset')).toBe(true);
  });

  it('mounts hover-text anchors for runtimeLogFilePath input + save + reset', () => {
    const seen = collectAnchoredControlIds();
    expect(seen.has('runtimeLogFilePath')).toBe(true);
    expect(seen.has('runtimeLogFilePath-save')).toBe(true);
    expect(seen.has('runtimeLogFilePath-reset')).toBe(true);
  });

  it('runtimeLogLevel description covers default + per-emit read semantics', () => {
    const entry = GENERAL_SETTINGS_DESCRIPTIONS['runtimeLogLevel'];
    const body = entry.body.toLowerCase();
    // Default value (per contracts/runtime-log-settings-ipc.md §6a):
    expect(body).toContain('info');
    // Severity floor semantics:
    expect(body).toContain('debug');
    expect(body).toContain('error');
    // Per-emit read semantics — no reload required.
    expect(body).toMatch(/next (log )?emission|no reload/);
  });

  it('runtimeLogFilePath description covers default + accepted formats + redaction + suppression', () => {
    const entry = GENERAL_SETTINGS_DESCRIPTIONS['runtimeLogFilePath'];
    const body = entry.body.toLowerCase();
    // Default value:
    expect(body).toContain('.schegent/syslog');
    // Accepted formats:
    expect(body).toContain('absolute path');
    expect(body).toContain('workspace-relative');
    // Traversal-rejection:
    expect(body).toContain('..');
    // Redaction guarantee:
    expect(body).toContain('redacted');
    // Suppression-clears-on-save semantics:
    expect(body).toMatch(/suppress|until you save/);
  });
});
