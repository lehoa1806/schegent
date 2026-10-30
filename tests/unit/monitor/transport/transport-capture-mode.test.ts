// Feature 251 (FR-R4-F04, contract T1, FR-001) — the effective transport capture mode.
//
// What it pins: `resolveTransportCaptureMode(setting, rawTranscriptMode)` implements data-model §1's
// table verbatim, so a workspace that never touched the new setting keeps the retention it had by
// following its raw transcript mode (`inherit`), and a value that is not one of the four is read as
// `inherit` rather than as a mode nobody chose.
//
// Why: the setting is read per record and the default is `inherit`; if the resolution drifted from
// the table, an `errors-only` workspace would start keeping everything (or nothing) with no setting
// changed.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRANSPORT_CAPTURE_SETTING,
  TRANSPORT_CAPTURE_SETTINGS,
  resolveTransportCaptureMode
} from '../../../../src/contracts/transport-capture-mode';
import type { RawTranscriptMode } from '../../../../src/state/workflow-run';

const RAW_MODES: readonly RawTranscriptMode[] = ['off', 'errors-only', 'always'];

describe('the effective transport capture mode (T1, FR-001)', () => {
  it('lists the four settings, with inherit as the default', () => {
    expect([...TRANSPORT_CAPTURE_SETTINGS]).toEqual(['inherit', 'off', 'errors-only', 'on']);
    expect(DEFAULT_TRANSPORT_CAPTURE_SETTING).toBe('inherit');
  });

  it.each([
    ['off', 'off'],
    ['errors-only', 'errors-only'],
    ['always', 'on']
  ] as const)('inherit follows rawTranscriptMode %s to %s', (raw, expected) => {
    expect(resolveTransportCaptureMode('inherit', raw)).toBe(expected);
  });

  it.each(['off', 'errors-only', 'on'] as const)('%s gives itself for any raw mode', (setting) => {
    for (const raw of RAW_MODES) {
      expect(resolveTransportCaptureMode(setting, raw)).toBe(setting);
    }
  });

  it.each([undefined, null, '', 'ON', 'always', 'verbose', 3, {}, ['on']] as const)(
    'a missing or unknown value %j is treated as inherit',
    (value) => {
      for (const raw of RAW_MODES) {
        expect(resolveTransportCaptureMode(value, raw)).toBe(resolveTransportCaptureMode('inherit', raw));
      }
    }
  );
});
