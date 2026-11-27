// Feature 020 T017 — the banner kinds resolved from the setting and what the
// phase directory holds. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §8.
//
// Feature 203 (D5, FR-006, SC-008) — the module stopped touching the
// filesystem. It used to `stat` the phase directory itself, which was a SECOND
// observation of a directory the reader had already listed: two answers that
// could disagree, with a race window between them, and a label chosen by
// directory existence alone. The cases below are the same four cases; each
// creates no directories and passes the one observation in instead.
//
// The fourth case keeps its intent exactly (Q2): a record present with the
// setting off must NOT be reported as `diagnostics-disabled`. Only its inputs
// move — what "a record is present" means is now an iteration that exists,
// rather than a directory that exists.

import { describe, expect, it } from 'vitest';
import type { IterationDiscovery } from '../../../../src/services/phase-log/phase-log-iteration-discovery';
import { classifyEmptyKind } from '../../../../src/services/phase-log/verbose-diagnostics-detector';

const ABSENT: IterationDiscovery = { outcome: 'directory-absent' };
const EMPTY: IterationDiscovery = { outcome: 'listed', iterations: [] };
const ONE_RECORD: IterationDiscovery = { outcome: 'listed', iterations: [1] };

describe('Feature 020 T017 — classifyEmptyKind', () => {
  it('reports no iteration recorded when the directory is listed but holds none', async () => {
    const banner = classifyEmptyKind({
      discovery: EMPTY,
      settingOn: true,
      progress: 'not-running',
      entryCount: 0
    });
    expect(banner).toEqual({ kind: 'no-iteration-recorded' });
  });

  it('reports the phase not recorded when the directory is absent and the setting is on', async () => {
    const banner = classifyEmptyKind({
      discovery: ABSENT,
      settingOn: true,
      progress: 'not-running',
      entryCount: 0
    });
    expect(banner).toEqual({ kind: 'phase-not-recorded' });
  });

  it('reports diagnostics disabled with settingKey when the setting is off and nothing is recorded', async () => {
    const banner = classifyEmptyKind({
      discovery: ABSENT,
      settingOn: false,
      progress: 'not-running',
      entryCount: 0
    });
    expect(banner).toEqual({
      kind: 'diagnostics-disabled',
      settingKey: 'schegent.logging.verbose'
    });
  });

  it('does not report diagnostics disabled when the setting is off but historical records still exist', async () => {
    // Operator toggled the setting off but kept old runs on disk. Telling them
    // to switch on a setting would be wrong twice over: the records are right
    // there, and switching it on would not produce the ones they are looking at.
    const banner = classifyEmptyKind({
      discovery: ONE_RECORD,
      settingOn: false,
      progress: 'not-running',
      entryCount: 0
    });
    expect(banner).not.toEqual(
      expect.objectContaining({ kind: 'diagnostics-disabled' })
    );
    expect(banner).toEqual({ kind: 'nothing-displayable' });
  });
});

describe('Feature 203 — the precedence the four cases above do not reach', () => {
  it('reports entries present whenever any displayable entry survived the read', () => {
    const banner = classifyEmptyKind({
      discovery: ONE_RECORD,
      settingOn: false,
      progress: 'running',
      entryCount: 3
    });
    expect(banner).toEqual({ kind: 'entries-present' });
  });

  it('claims the phase is running only when it is known to be running', () => {
    // FR-017 — `unknown` means the task is in flight between phases and the
    // phase cannot be named. It is treated as not-running rather than rendered
    // as a progress claim, because "wait, output is coming" is a promise this
    // reader is in no position to make.
    const running = classifyEmptyKind({
      discovery: EMPTY,
      settingOn: true,
      progress: 'running',
      entryCount: 0
    });
    const cannotTell = classifyEmptyKind({
      discovery: EMPTY,
      settingOn: true,
      progress: 'unknown',
      entryCount: 0
    });
    expect(running).toEqual({ kind: 'phase-running-no-output' });
    expect(cannotTell).toEqual({ kind: 'no-iteration-recorded' });
    expect(running).not.toEqual(cannotTell);
  });

  it('lets the setting outrank progress, because waiting cannot falsify it', () => {
    // D2 — of the available true statements this is the one whose advice a
    // wait cannot repair: nothing will ever appear while the setting is off.
    const banner = classifyEmptyKind({
      discovery: ABSENT,
      settingOn: false,
      progress: 'running',
      entryCount: 0
    });
    expect(banner).toEqual({
      kind: 'diagnostics-disabled',
      settingKey: 'schegent.logging.verbose'
    });
  });
});
