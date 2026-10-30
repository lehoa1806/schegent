// Feature 251 (FR-R4-F04, contract T17, SC-009, FR-026, FR-027; P1 to P3, P6) — who an audit row names.
//
// Rewritten (TA8). Feature 017's cases asserted that `getOperatorActor()` returned the OS user name; that
// is exactly what FR-026 removes. The OS account name is an identity the product has no business writing
// into an evidence file that is exported and shared. It is replaced by a per-workspace random pseudonym,
// `pseudonym-<16 hex>`, kept in the workspace memento.
//
// What it pins, with `os.userInfo` mocked to return a synthetic username: `getOperatorActor()` never
// returns it, before or after an attribution is installed; the pseudonym has the stated format; it is
// stable across a second installation over the same memento; a missing, wrong-version or wrong-format
// stored value gives a new one that is stored; a failed store gives `unknown-operator`; and a generated
// pseudonym passes `SanitizedLogger.sanitize` unchanged, so an append can never be refused as
// `secret-detected` because of it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  PSEUDONYM_PREFIX,
  UNKNOWN_OPERATOR,
  createOperatorAttribution,
  getOperatorActor,
  installOperatorAttribution,
  isOperatorPseudonym,
  type OperatorAttributionStore
} from '../../../src/lib/operator-attribution';
import { SanitizedLogger } from '../../../src/lib/logger';

const SYNTHETIC_OS_USER = 'synthetic-os-user-7f3a';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, userInfo: () => ({ username: 'synthetic-os-user-7f3a' }) };
  return { ...mocked, default: mocked };
});

/** A memento stand-in the attribution reads and writes through the two store methods. */
function memory(initial: unknown = undefined): OperatorAttributionStore & { value: unknown; fail: boolean } {
  const store = {
    value: initial,
    fail: false,
    readOperatorPseudonym: (): unknown => store.value,
    writeOperatorPseudonym: async (next: { version: 1; pseudonym: string }): Promise<void> => {
      if (store.fail) throw new Error('memento unavailable');
      store.value = next;
    }
  };
  return store;
}

afterEach(() => {
  installOperatorAttribution(null);
});

describe('getOperatorActor never returns the OS username (SC-009, FR-026)', () => {
  it('answers unknown-operator before anything is installed', () => {
    expect(getOperatorActor()).toBe(UNKNOWN_OPERATOR);
    expect(getOperatorActor()).not.toBe(SYNTHETIC_OS_USER);
  });

  it('answers a pseudonym once an attribution with a stored value is installed, and never the username', async () => {
    const store = memory();
    const attribution = createOperatorAttribution(store, randomBytes);
    installOperatorAttribution(attribution);
    expect(getOperatorActor(), 'installed but not yet created: still unknown').toBe(UNKNOWN_OPERATOR);

    const created = await attribution.ensureStored();
    expect(created).toMatch(/^pseudonym-[0-9a-f]{16}$/);
    expect(getOperatorActor()).toBe(created);
    expect(getOperatorActor()).not.toContain(SYNTHETIC_OS_USER);
    expect(JSON.stringify(store.value)).not.toContain(SYNTHETIC_OS_USER);
  });
});

describe('the pseudonym (P1, FR-027)', () => {
  it('has the stated format and prefix', () => {
    expect(PSEUDONYM_PREFIX).toBe('pseudonym-');
    expect(isOperatorPseudonym('pseudonym-0123456789abcdef')).toBe(true);
    for (const bad of ['pseudonym-0123456789abcde', 'pseudonym-0123456789abcdefg', 'Pseudonym-0123456789abcdef', 'unknown-operator', '', 7, null]) {
      expect(isOperatorPseudonym(bad), String(bad)).toBe(false);
    }
  });

  it('is stable across a second installation from the same memento', async () => {
    const store = memory();
    const first = await createOperatorAttribution(store, randomBytes).ensureStored();

    const second = createOperatorAttribution(store, randomBytes);
    installOperatorAttribution(second);
    expect(getOperatorActor()).toBe(first);
    expect(await second.ensureStored(), 'an existing valid value is kept, not replaced').toBe(first);
  });

  it.each([
    ['missing', undefined],
    ['a wrong version', { version: 2, pseudonym: 'pseudonym-0123456789abcdef' }],
    ['a wrong format', { version: 1, pseudonym: 'not-a-pseudonym' }],
    ['not an object', 'pseudonym-0123456789abcdef']
  ])('gives a new one, and stores it, when the stored value is %s', async (_label, stored) => {
    const store = memory(stored);
    const created = await createOperatorAttribution(store, randomBytes).ensureStored();

    expect(created).toMatch(/^pseudonym-[0-9a-f]{16}$/);
    expect(store.value).toEqual({ version: 1, pseudonym: created });
  });

  it('gives unknown-operator when the store fails, until a write succeeds', async () => {
    const store = memory();
    store.fail = true;
    const attribution = createOperatorAttribution(store, randomBytes);
    installOperatorAttribution(attribution);

    expect(await attribution.ensureStored()).toBe(UNKNOWN_OPERATOR);
    expect(getOperatorActor()).toBe(UNKNOWN_OPERATOR);

    store.fail = false;
    const retried = await attribution.ensureStored();
    expect(retried).toMatch(/^pseudonym-[0-9a-f]{16}$/);
    expect(getOperatorActor()).toBe(retried);
  });

  it('is drawn from the injected random source, eight bytes in lowercase hex', async () => {
    const store = memory();
    const fixed = (size: number): Buffer => Buffer.alloc(size, 0xab);
    expect(await createOperatorAttribution(store, fixed).ensureStored()).toBe('pseudonym-abababababababab');
  });

  it('is replaced by reset, which stores a different one', async () => {
    const store = memory();
    const attribution = createOperatorAttribution(store, randomBytes);
    installOperatorAttribution(attribution);
    const before = await attribution.ensureStored();

    const after = await attribution.reset();

    expect(after).not.toBe(before);
    expect(getOperatorActor()).toBe(after);
  });

  it('passes the redactor unchanged, so an append is never refused as secret-detected (P6)', async () => {
    const logger = new SanitizedLogger([]);
    for (let index = 0; index < 200; index += 1) {
      const created = await createOperatorAttribution(memory(), randomBytes).ensureStored();
      expect(logger.sanitize(created), created).toBe(created);
    }
  });
});
