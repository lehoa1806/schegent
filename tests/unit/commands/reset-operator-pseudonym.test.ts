// Feature 251 (FR-R4-F04, contract T18, FR-028, US5-3; P4, O8, O9) — resetting the operator pseudonym.
//
// What it pins: declining the modal writes no row and keeps the pseudonym; confirming appends exactly one
// `operator-pseudonym-reset` row with `payload: {}`, `runId: ''` and `phase: 'operator'`, and only THEN
// stores a new pseudonym, which later actions carry; and an append that throws leaves the stored value
// unchanged and says the reset did not happen (O9). The row carries neither the old nor the new value.
//
// Why: a reset that stored first and appended second would leave a new identity with no record that the
// old one was retired, and one that wrote the values into the row would put the identifier it exists to
// replace into the evidence.

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { RESET_OPERATOR_PSEUDONYM_TEXT, runResetOperatorPseudonym } from '../../../src/commands/reset-operator-pseudonym';
import { createOperatorAttribution, type OperatorAttributionStore } from '../../../src/lib/operator-attribution';
import type { Notifier } from '../../../src/ui/notifications';

function setup(options: { confirm?: boolean; appendFails?: boolean } = {}) {
  const writes: Array<unknown> = [];
  const events: string[] = [];
  const store: OperatorAttributionStore & { value: unknown } = {
    value: undefined,
    readOperatorPseudonym: () => store.value,
    writeOperatorPseudonym: async (next) => {
      events.push('store');
      writes.push(next);
      store.value = next;
    }
  };
  const attribution = createOperatorAttribution(store, randomBytes);
  const rows: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const notifier = {
    info: (message: string) => notices.push(message),
    warn: (message: string) => {
      notices.push(message);
      return Promise.resolve(undefined);
    }
  } as unknown as Notifier;
  const run = (): Promise<void> =>
    runResetOperatorPseudonym({
      confirm: async () => options.confirm ?? true,
      auditWriter: {
        append: async (entry: Record<string, unknown>) => {
          events.push('append');
          if (options.appendFails === true) throw new Error('disk full');
          rows.push(entry);
          return entry as never;
        }
      } as never,
      attribution,
      notifier
    });
  return { attribution, rows, notices, events, run, store, writes };
}

describe('runResetOperatorPseudonym (T18)', () => {
  it('records nothing and keeps the pseudonym when the confirmation is declined', async () => {
    const t = setup({ confirm: false });
    const before = await t.attribution.ensureStored();
    t.writes.length = 0;

    await t.run();

    expect(t.rows).toEqual([]);
    expect(t.writes).toEqual([]);
    expect(t.attribution.current()).toBe(before);
    expect(t.notices).toEqual([]);
  });

  it('appends one empty-payload row, THEN stores a new pseudonym that later actions carry', async () => {
    const t = setup();
    const before = await t.attribution.ensureStored();
    t.events.length = 0;

    await t.run();

    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ runId: '', phase: 'operator', iteration: 0, eventType: 'operator-pseudonym-reset', outcome: 'info', payload: {} });
    expect(t.events, 'the append comes before the store').toEqual(['append', 'store']);
    const after = t.attribution.current();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^pseudonym-[0-9a-f]{16}$/);
    expect(JSON.stringify(t.rows[0]), 'neither value is in the row').not.toContain(before);
    expect(JSON.stringify(t.rows[0])).not.toContain(after);
    expect(t.notices).toContain(RESET_OPERATOR_PSEUDONYM_TEXT.done);
  });

  it('changes nothing, and says so, when the append throws (O9)', async () => {
    const t = setup({ appendFails: true });
    const before = await t.attribution.ensureStored();
    t.events.length = 0;

    await t.run();

    expect(t.events, 'only the append was attempted').toEqual(['append']);
    expect(t.attribution.current(), 'the stored value did not change').toBe(before);
    expect(t.notices).toContain(RESET_OPERATOR_PSEUDONYM_TEXT.failed);
    expect(t.notices.join(' ')).not.toContain('disk full');
  });
});
