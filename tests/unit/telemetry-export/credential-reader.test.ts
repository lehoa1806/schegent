// FR-R6-F14 — reading the destination credential: which port failures are `unavailable`, which
// values a request header may carry, and a reader that never rejects (FR-002, FR-016).
import { describe, expect, it } from 'vitest';

import type { SecretStoreAvailability, TelemetrySecretPort } from '../../../src/contracts/telemetry-export';
import { CREDENTIAL_CHARS_MAX, isHeaderValue, readCredential } from '../../../src/services/telemetry-export/credential-reader';

const REFERENCE = 'export-credential-reference';
const VALUE = 'synthetic-credential-value';

interface FakePort extends TelemetrySecretPort {
  readonly asked: string[];
}

function port(stored: unknown, availability: SecretStoreAvailability = 'available'): FakePort {
  const asked: string[] = [];
  return {
    asked,
    availability: () => availability,
    read: (reference) => {
      asked.push(reference);
      // The port is typed to give text or null; a faulty one can give anything.
      return Promise.resolve(stored as string | null);
    }
  };
}

describe('credential reader', () => {
  it('gives the value the port holds for the reference', async () => {
    const secrets = port(VALUE);
    expect(await readCredential(secrets, REFERENCE)).toEqual({ kind: 'value', value: VALUE });
    expect(secrets.asked).toEqual([REFERENCE]);
  });

  it('is unavailable without a port', async () => {
    expect(await readCredential(null, REFERENCE)).toEqual({ kind: 'failed', reason: 'credential-unavailable' });
  });

  it('does not read from a store that is unavailable', async () => {
    const secrets = port(VALUE, 'unavailable');
    expect(await readCredential(secrets, REFERENCE)).toEqual({ kind: 'failed', reason: 'credential-unavailable' });
    expect(secrets.asked).toEqual([]);
  });

  it.each([
    ['no value', null],
    ['a number', 42],
    ['an object', { value: VALUE }],
    ['nothing at all', undefined]
  ])('is unavailable when the port gives %s', async (_label, stored) => {
    expect(await readCredential(port(stored), REFERENCE)).toEqual({ kind: 'failed', reason: 'credential-unavailable' });
  });

  it('is unavailable when the availability check throws, when the read throws and when it rejects', async () => {
    const failure = new Error(`store failure naming ${REFERENCE}`);
    const throwingCheck: TelemetrySecretPort = {
      availability: () => {
        throw failure;
      },
      read: () => Promise.resolve(VALUE)
    };
    const throwingRead: TelemetrySecretPort = {
      availability: () => 'available',
      read: () => {
        throw failure;
      }
    };
    const rejectingRead: TelemetrySecretPort = { availability: () => 'available', read: () => Promise.reject(failure) };
    for (const secrets of [throwingCheck, throwingRead, rejectingRead]) {
      const state = await readCredential(secrets, REFERENCE);
      expect(state).toEqual({ kind: 'failed', reason: 'credential-unavailable' });
      expect(JSON.stringify(state)).not.toContain(REFERENCE);
    }
  });

  it.each([
    ['is empty', ''],
    ['has a line break', `${VALUE}\r\nx-injected: 1`],
    ['has a tab', `${VALUE}\tmore`],
    ['has a delete character', `${VALUE}${String.fromCharCode(0x7f)}`],
    ['has a character outside ASCII', `${VALUE}${String.fromCharCode(0xe9)}`],
    ['is one character too long', 'v'.repeat(CREDENTIAL_CHARS_MAX + 1)]
  ])('is invalid when the value %s, and does not return it', async (_label, stored) => {
    const state = await readCredential(port(stored), REFERENCE);
    expect(state).toEqual({ kind: 'failed', reason: 'credential-invalid' });
  });

  it('accepts every printable ASCII character and a value of the longest length', () => {
    const printable = Array.from({ length: 0x7e - 0x20 + 1 }, (_unused, index) => String.fromCharCode(0x20 + index)).join('');
    expect(printable).toHaveLength(95);
    expect(isHeaderValue(printable)).toBe(true);
    expect(isHeaderValue('v'.repeat(CREDENTIAL_CHARS_MAX))).toBe(true);
    expect(isHeaderValue('v'.repeat(CREDENTIAL_CHARS_MAX + 1))).toBe(false);
    expect(isHeaderValue(String.fromCharCode(0x1f))).toBe(false);
  });
});
