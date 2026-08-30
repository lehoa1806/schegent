// FR-R3-143 (T049 run 4) — the allowlist entry guard, driven through the tab.
//
// WHY THIS EXISTS. `sanitizeProcessEnvAllowlist` (`src/runner/spawn-env.ts`)
// drops a malformed name SILENTLY at spawn time. An operator who types `MY-VAR`
// would see the row accepted, the save succeed, and the variable simply never
// reach the backend, with nothing anywhere saying why. `StringListField` refuses
// the entry at the moment it is added instead — and until this file, nothing
// asserted that it does. The `MY-VAR` case was written only in a source comment,
// which is a claim, not a check.
//
// WHY THE TAB AND NOT THE COMPONENT. `StringListField`'s `value` is
// `$bindable`, so mounting it alone means building a wrapper whose only job is
// to hold the binding — and the binding is half of what is under test, because
// "rejected, not silently dropped" is a statement about the list the parent
// keeps. Mounting `GeneralSettingsTab` takes the operator's path: the real
// `itemPattern` arrives from `SETTINGS_SCHEMA` through the real `FieldSpec`,
// which is the wiring a component-level test would stub out.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import type { ComponentType } from 'svelte';

import GeneralSettingsTab from '../../GeneralSettingsTab.svelte';
import { IDLE_GENERAL_SETTINGS, type WorkflowSnapshot } from '../../../../lib/snapshot-types';

const KEY = 'cliEnvironmentAllowlist';

/**
 * The tab falls back to `IDLE_GENERAL_SETTINGS` when the projection is absent,
 * and that fallback ships `cliEnvironmentAllowlist: []` — the state this test
 * wants. Casting is honest about what is being exercised: the tab reads one
 * field of the snapshot on this path, and a full fixture would assert nothing
 * extra while hiding which field that is.
 */
function mountTab(): ReturnType<typeof render> {
  return render(GeneralSettingsTab as unknown as ComponentType, {
    props: { snapshot: {} as unknown as WorkflowSnapshot }
  });
}

/**
 * Mount over a projected allowlist. Used for the states `add()` cannot reach —
 * a duplicate arrives from a hand-edited `settings.json`, never from this UI.
 */
function mountTabWithAllowlist(allowlist: readonly string[]): ReturnType<typeof render> {
  return render(GeneralSettingsTab as unknown as ComponentType, {
    props: {
      snapshot: {
        generalSettings: { ...IDLE_GENERAL_SETTINGS, cliEnvironmentAllowlist: allowlist }
      } as unknown as WorkflowSnapshot
    }
  });
}

function rows(container: HTMLElement): string[] {
  return [...container.querySelectorAll(`[data-testid="string-list-${KEY}"] li code`)].map(
    (el) => el.textContent
  );
}

async function typeAndAdd(container: HTMLElement, name: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(
    `[data-testid="general-settings-input-${KEY}"]`
  );
  expect(input, 'the allowlist entry field must be mounted').not.toBeNull();
  await fireEvent.input(input as HTMLInputElement, { target: { value: name } });
  const add = container.querySelector<HTMLButtonElement>(
    `[data-testid="general-settings-add-${KEY}"]`
  );
  expect(add, 'the Add button must be mounted').not.toBeNull();
  await fireEvent.click(add as HTMLButtonElement);
}

function errorText(container: HTMLElement): string {
  return container.querySelector(`[data-testid="string-list-error-${KEY}"]`)?.textContent ?? '';
}

describe('FR-R3-143 — the process-environment allowlist refuses a name the spawn path would drop', () => {
  afterEach(cleanup);

  it('refuses `MY-VAR` visibly, and does not add it', async () => {
    const { container } = mountTab();
    await typeAndAdd(container, 'MY-VAR');

    expect(
      rows(container),
      'the entry must not land in the list. A row that saves and then vanishes at spawn ' +
        'time is exactly the failure this control exists to prevent'
    ).toEqual([]);
    expect(
      errorText(container),
      'and the refusal must be visible — silence here is the same outcome as the silent drop'
    ).not.toEqual('');
    const input = container.querySelector<HTMLInputElement>(
      `[data-testid="general-settings-input-${KEY}"]`
    );
    expect(input?.getAttribute('aria-invalid'), 'the field reports its own invalidity').toBe(
      'true'
    );
    expect(
      input?.value,
      'the rejected text stays in the field so it can be corrected rather than retyped'
    ).toBe('MY-VAR');
  });

  // The control. Without it, a component that refused everything would pass the
  // test above and look correct.
  it('accepts a well-formed name', async () => {
    const { container } = mountTab();
    await typeAndAdd(container, 'HTTPS_PROXY');

    expect(rows(container)).toEqual(['HTTPS_PROXY']);
    expect(errorText(container)).toEqual('');
    expect(
      container.querySelector(`[data-testid="general-settings-remove-${KEY}-0"]`),
      'an accepted row brings its own Remove'
    ).not.toBeNull();
  });

  it('refuses a duplicate, and says which name', async () => {
    const { container } = mountTab();
    await typeAndAdd(container, 'HTTPS_PROXY');
    await typeAndAdd(container, 'HTTPS_PROXY');

    expect(rows(container), 'the list keeps one').toEqual(['HTTPS_PROXY']);
    expect(errorText(container)).toContain('HTTPS_PROXY');
  });

  // FR-R3-143 (review) — the rows are keyed by INDEX because a projected list
  // may hold the same name twice; `remove` must be positional for the same
  // reason. Removing by VALUE deletes every matching row, so one click on a
  // two-row list empties it — and the operator's next Save writes a list they
  // did not author. `add()` cannot build this state, which is why the projection
  // is supplied directly.
  it('removes one row of a projected duplicate pair, not both', async () => {
    const { container } = mountTabWithAllowlist(['HTTPS_PROXY', 'HTTPS_PROXY']);
    expect(rows(container), 'the projection is rendered verbatim').toEqual([
      'HTTPS_PROXY',
      'HTTPS_PROXY'
    ]);

    const remove = container.querySelector<HTMLButtonElement>(
      `[data-testid="general-settings-remove-${KEY}-0"]`
    );
    expect(remove, 'the first row must carry its own Remove').not.toBeNull();
    await fireEvent.click(remove as HTMLButtonElement);

    expect(
      rows(container),
      'one click removes one row. A click that empties the list deletes an entry ' +
        'the operator never selected'
    ).toEqual(['HTTPS_PROXY']);
  });

  it('refuses an empty entry rather than adding a blank row', async () => {
    const { container } = mountTab();
    await typeAndAdd(container, '   ');

    expect(rows(container)).toEqual([]);
    expect(errorText(container)).toContain('Enter a name');
  });
});
