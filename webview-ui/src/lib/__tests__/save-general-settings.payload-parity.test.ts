// FR-R3-143 (T022) — `GeneralSettingsPayload` and the host's `KEY_SPECS` are
// one set, and something says so.
//
// WHY THIS EXISTS. The payload interface listed 16 keys while `KEY_SPECS`
// accepted 22, and nothing compared them for the width of six features. It went
// unnoticed because `GeneralSettingsTab.svelte` posts through a COMPUTED key
// (`updates[spec.ipcKey ?? spec.key] = ...`), which TypeScript does not check
// against the interface — so the six missing members cost nothing until a caller
// named a key literally, which is how FR-R3-127 found two of them.
//
// The type system covers one half: `PAYLOAD_KEYS_MATCH_INTERFACE` in the module
// under test fails the typecheck if the runtime list and the interface disagree.
// It cannot cover this half, because `KEY_SPECS` lives in the host and the
// interface is erased. Hence a test.

import { describe, expect, it } from 'vitest';

import { KEY_SPECS } from '../../../../src/config/general-settings';
import { GENERAL_SETTINGS_PAYLOAD_KEYS } from '../save-general-settings';

describe('FR-R3-143 — general-settings payload / KEY_SPECS parity', () => {
  it('declares exactly the keys the host accepts', () => {
    const hostKeys = [...Object.keys(KEY_SPECS)].sort();
    const payloadKeys = [...GENERAL_SETTINGS_PAYLOAD_KEYS].sort();
    expect(payloadKeys).toEqual(hostKeys);
  });

  it('names every key the host accepts, reported one at a time', () => {
    // The assertion above fails as one opaque array diff. This one names the
    // offending keys, which is the difference between "the lists differ" and
    // "you added `foo.bar` to KEY_SPECS and not to the payload".
    const payload = new Set<string>(GENERAL_SETTINGS_PAYLOAD_KEYS);
    const missingFromPayload = Object.keys(KEY_SPECS).filter((key) => !payload.has(key));
    expect(missingFromPayload).toEqual([]);
  });

  it('names no key the host would reject', () => {
    const hostKeys = new Set(Object.keys(KEY_SPECS));
    const unknownToHost = GENERAL_SETTINGS_PAYLOAD_KEYS.filter((key) => !hostKeys.has(key));
    // A key here that `KEY_SPECS` does not carry is not a harmless extra: the
    // host rejects the WHOLE batch with `unknown-key:<key>`, so one stale
    // member silently makes every save that includes it fail.
    expect(unknownToHost).toEqual([]);
  });

  it('is a real comparison — a doctored list is caught', () => {
    // Vacuity control (meta-gate tier). The three assertions above pass on a
    // tree where the two sets agree; this proves they would not pass on one
    // where they do not, rather than that they pass on any input at all.
    const doctored = [...GENERAL_SETTINGS_PAYLOAD_KEYS, 'cli.notAKey'];
    const hostKeys = new Set(Object.keys(KEY_SPECS));
    expect(doctored.filter((key) => !hostKeys.has(key))).toEqual(['cli.notAKey']);

    const dropped = GENERAL_SETTINGS_PAYLOAD_KEYS.filter((key) => key !== 'cli.path');
    const droppedSet = new Set<string>(dropped);
    expect(Object.keys(KEY_SPECS).filter((key) => !droppedSet.has(key))).toEqual(['cli.path']);
  });
});
