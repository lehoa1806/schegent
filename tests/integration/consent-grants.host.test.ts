import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { INTEGRATION_USER_DATA_DIR_ENV } from './vscode-test-executable';
import { createUncontainedConsentRequester } from '../../src/activation/uncontained-consent';
import {
  ALLOW_UNCONTAINED_SETTING,
  judgeBackendContainment,
  resolveUncontainedGrant
} from '../../src/services/backend-containment-policy';

// FR-R3-146 (T053) — the four claims the unit suite structurally cannot make.
//
// WHY THIS FILE EXISTS. `PENDING_146` §12 listed five observables as "unproven by
// the suite", and closed the item behind a manual tier: an operator, a real
// window, a checklist. Four of the five need a real VS Code and NOT a human. This
// file is those four. What genuinely needs an operator — that the workbench PAINTS
// all 567 characters of a modal, and that the rendered list reads well — is what
// the fifth row keeps, and the record says so rather than claiming this file
// closed it.
//
// WHAT IT DELIBERATELY DOES NOT DO: show a modal. `vscode.window.showWarningMessage`
// with `{ modal: true }` returns a promise nobody in a headless launch can settle,
// and on macOS a native modal can block the window from closing at all — the leg
// would hang rather than fail. So the dialog port is a capture, exactly as
// `run-safety-wiring.ts` shapes it, and what is asserted is the STRING THE PRODUCT
// HANDS THE API. That is the whole of the defect the truncation item was about:
// the message was cut at 240 characters by our own formatter, before VS Code was
// ever involved.
//
// A NOTE ON WHAT THIS PROVES AND WHAT IT ASSUMES. It proves the untruncated string
// reaches the dialog call. It assumes VS Code renders what it is given. That
// assumption is stated rather than hidden, and it is the only residual left in the
// truncation row.

/** The refused backend this leg drives. `claude` is the default and is uncontained. */
const KIND = 'claude' as const;

/**
 * The clause the 240-character cut severed, mid-word.
 *
 * Measured, not guessed: the refusal message is 567 characters and the old bound
 * ended it at `"...or cho"`. This is the substring on the far side of that cut, so
 * an assertion that it survives is an assertion that the specific defect is gone
 * rather than that the message is merely "long".
 */
const CLAUSE_PAST_THE_OLD_CUT = 'or choose a backend that carries a sandbox';

/** The bound that used to apply. Not imported: this leg asserts it does NOT apply. */
const RETIRED_TRUNCATION_BOUND = 240;

const GIT_APPROVALS_COMMAND = 'schegent.gitApprovals';

export async function run(): Promise<void> {
  await assertRefusalReachesTheDialogWhole();
  await assertGrantLandsInTheProfileAndTakesEffectWithoutReload();
  await assertGitApprovalsIsReachable();
}

/**
 * §12 row 1, the half that is ours.
 *
 * The requester is constructed the way `run-safety-wiring.ts` constructs it, with
 * the same three ports, so what is measured is the product's own composition and
 * not a string this test built. The `confirm` captures and denies.
 */
async function assertRefusalReachesTheDialogWhole(): Promise<void> {
  const verdict = judgeBackendContainment(KIND, new Set());
  assert.equal(
    verdict.outcome,
    'refused',
    `'${KIND}' was not refused against an empty grant set, so this leg is measuring nothing. ` +
      `Either the default posture changed or the policy no longer refuses uncontained backends.`
  );
  const shown: { message: string; detail: string; approveLabel: string }[] = [];
  const request = createUncontainedConsentRequester({
    confirm: (message, detail, approveLabel) => {
      shown.push({ message, detail, approveLabel });
      // Dismissal. Nothing is written, and the assertions below are about the
      // string that reached this function.
      return Promise.resolve(undefined);
    },
    config: {
      get: <T,>(key: string): T | undefined => vscode.workspace.getConfiguration().get<T>(key),
      update: (key, value, target) =>
        vscode.workspace.getConfiguration().update(key, value, target)
    },
    logger: { info: () => undefined, warn: () => undefined }
  });

  const outcome = await request({ kind: KIND, message: verdict.message });

  assert.equal(outcome.decision, 'denied', 'a dismissed consent dialog did not deny');
  assert.equal(shown.length, 1, `expected exactly one dialog, saw ${shown.length}`);
  const dialog = shown[0];
  assert.ok(dialog, 'no dialog was recorded');

  // The detail is the policy module's message VERBATIM. Asserted as equality, not
  // as containment: a copy that drifted, a re-wrap, or a summary would all pass a
  // `includes` check while reintroducing the second authority the modal exists to
  // avoid.
  assert.equal(
    dialog.detail,
    verdict.message,
    'the dialog detail is not the policy refusal verbatim — some layer between the ' +
      'policy and the dialog is rewriting the operator-facing text'
  );
  assert.ok(
    dialog.detail.length > RETIRED_TRUNCATION_BOUND,
    `the refusal is now ${dialog.detail.length} characters, at or under the retired ` +
      `${RETIRED_TRUNCATION_BOUND}-character bound. This leg can no longer distinguish a ` +
      `truncating path from a whole one; shorten the bound or lengthen the fixture, but do ` +
      `not delete the assertion.`
  );
  assert.ok(
    dialog.detail.includes(CLAUSE_PAST_THE_OLD_CUT),
    `the clause past the old cut is missing. The operator's original report was a message ` +
      `ending mid-word at "or cho"; this is the assertion that says it does not any more. ` +
      `Got ${dialog.detail.length} characters ending ${JSON.stringify(dialog.detail.slice(-48))}.`
  );
  // The headline names the backend and the approve label names the scope, because
  // the two together are what an operator is answering.
  assert.ok(dialog.message.includes(KIND), 'the dialog headline does not name the backend');
  assert.ok(
    dialog.approveLabel.includes('Installation'),
    `the approve label does not state the scope of the grant: ${JSON.stringify(dialog.approveLabel)}`
  );

  console.log(
    `[consent-grants] refusal reached the dialog whole: ${dialog.detail.length} chars ` +
      `(retired bound ${RETIRED_TRUNCATION_BOUND}).`
  );
}

/**
 * §12 rows 2 and 3, which are one act observed twice.
 *
 * Row 2: `ConfigurationTarget.Global` lands in the profile's User settings. The
 * unit suite asserts the CALL carries that target; this reads the file VS Code
 * wrote. Row 3: the run proceeds with no window reload — the single observable
 * that distinguishes a live read from an activation-time capture (research.md R3).
 *
 * The counterfactual is made explicit rather than implied: a value captured before
 * the write is kept, and shown to still judge `refused` at the moment a fresh read
 * judges `allowed`. Without that, "it is allowed now" is equally consistent with a
 * product that had allowed it all along.
 */
async function assertGrantLandsInTheProfileAndTakesEffectWithoutReload(): Promise<void> {
  const userDataDirectory = process.env[INTEGRATION_USER_DATA_DIR_ENV];
  assert.ok(
    userDataDirectory,
    `${INTEGRATION_USER_DATA_DIR_ENV} is not set. runTest.ts passes the launch's private ` +
      `--user-data-dir through it; without the path there is no file to read and the ` +
      `'Global lands in User settings' claim cannot be made from inside the window.`
  );
  const settingsPath = path.join(userDataDirectory, 'User', 'settings.json');

  const inspected = vscode.workspace.getConfiguration().inspect<unknown>(ALLOW_UNCONTAINED_SETTING);
  const previousGlobal = inspected?.globalValue;

  // Captured BEFORE the write, the way an activation-time read would be. Held for
  // the counterfactual below.
  const capturedAtStart = resolveUncontainedGrant(
    vscode.workspace.getConfiguration('schegent.backend').get<unknown>('uncontainedBackends')
  );
  assert.equal(
    judgeBackendContainment(KIND, capturedAtStart.granted).outcome,
    'refused',
    `'${KIND}' was already granted in this profile before the leg wrote anything, so the ` +
      `before/after comparison below proves nothing.`
  );

  try {
    const verdict = judgeBackendContainment(KIND, new Set());
    assert.equal(verdict.outcome, 'refused');

    const request = createUncontainedConsentRequester({
      // The affirmative answer, given by returning the product's own label. A
      // hard-coded string here would pass even if the label the operator sees
      // stopped matching the one the requester compares against.
      confirm: (_message, _detail, approveLabel) => Promise.resolve(approveLabel),
      config: {
        get: <T,>(key: string): T | undefined => vscode.workspace.getConfiguration().get<T>(key),
        update: (key, value, target) =>
          vscode.workspace.getConfiguration().update(key, value, target)
      },
      logger: { info: () => undefined, warn: () => undefined }
    });

    const outcome = await request({ kind: KIND, message: verdict.message });
    assert.equal(
      outcome.decision,
      'granted',
      `the affirmative answer did not grant: ${JSON.stringify(outcome)}`
    );

    // ROW 2 — the file. `inspect().globalValue` says the API believes it wrote to
    // the global layer; only the file says the global layer is this profile's
    // `User/settings.json` rather than somewhere else.
    assert.deepEqual(
      vscode.workspace.getConfiguration().inspect<readonly string[]>(ALLOW_UNCONTAINED_SETTING)
        ?.globalValue,
      [KIND],
      'the grant did not land at the global layer'
    );
    assert.ok(
      fs.existsSync(settingsPath),
      `no settings.json at ${settingsPath} after a ConfigurationTarget.Global write. The ` +
        `write went somewhere other than this profile's User settings.`
    );
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(
      onDisk[ALLOW_UNCONTAINED_SETTING],
      [KIND],
      `'${ALLOW_UNCONTAINED_SETTING}' is not in ${settingsPath} with the granted id. ` +
        `Read back: ${JSON.stringify(onDisk[ALLOW_UNCONTAINED_SETTING])}`
    );

    // ROW 3 — no reload. Same process, same extension host, no window operation of
    // any kind between the write above and the read below.
    const readAfterWrite = resolveUncontainedGrant(
      vscode.workspace.getConfiguration('schegent.backend').get<unknown>('uncontainedBackends')
    );
    assert.equal(
      judgeBackendContainment(KIND, readAfterWrite.granted).outcome,
      'allowed',
      `'${KIND}' is still refused by a read taken after the grant was written in the same ` +
        `window. The grant requires a reload to take effect, which is the defect R3's live ` +
        `read exists to prevent.`
    );

    // The counterfactual, stated: the value captured before the write STILL refuses.
    // So what changed the verdict is the freshness of the read and nothing else.
    assert.equal(
      judgeBackendContainment(KIND, capturedAtStart.granted).outcome,
      'refused',
      'the grant set captured before the write now allows the backend, so this leg is not ' +
        'comparing a captured read against a live one and row 3 is unproven.'
    );
    // And exactly one id was granted — the widening this whole feature corrects.
    assert.deepEqual([...readAfterWrite.granted], [KIND]);

    console.log(
      `[consent-grants] Global write landed in ${settingsPath}; live re-read flipped ` +
        `'${KIND}' from refused to allowed with no reload.`
    );
  } finally {
    await vscode.workspace
      .getConfiguration()
      .update(ALLOW_UNCONTAINED_SETTING, previousGlobal, vscode.ConfigurationTarget.Global);
  }
}

/**
 * §12 row 5, the part a suite can reach.
 *
 * FR-012 requires the Git grant to be "observable and revocable by the operator",
 * and five documents satisfied that by naming a `.schegent/state.json` that has
 * never existed. `schegent.gitApprovals` is the surface that replaced the fiction,
 * and the claim this leg makes is the one the unit tests cannot: that it is
 * CONTRIBUTED, REGISTERED and REACHABLE in a real host.
 *
 * The command is invoked. In this workspace no grant is stored, so it takes the
 * `NO_APPROVALS_MESSAGE` branch — it shows a notification and returns, opening no
 * QuickPick and no modal. That is the one branch a headless leg can drive to
 * completion, and it is enough for what is being asked: a command that throws
 * `command 'schegent.gitApprovals' not found` is the failure this catches.
 */
async function assertGitApprovalsIsReachable(): Promise<void> {
  const contributed = vscode.extensions
    .getExtension('schegent.schegent')
    ?.packageJSON as { contributes?: { commands?: readonly { command?: string }[] } } | undefined;
  const declared = (contributed?.contributes?.commands ?? []).map((entry) => entry.command);
  assert.ok(
    declared.includes(GIT_APPROVALS_COMMAND),
    `'${GIT_APPROVALS_COMMAND}' is not in the manifest VS Code resolved. An operator cannot ` +
      `reach it from the Command Palette, which is the only route FR-012 has left. ` +
      `Declared: ${JSON.stringify(declared)}`
  );

  const registered = await vscode.commands.getCommands(true);
  assert.ok(
    registered.includes(GIT_APPROVALS_COMMAND),
    `'${GIT_APPROVALS_COMMAND}' is contributed but not registered. A contributed command with ` +
      `no registration is a palette entry that throws when pressed.`
  );

  // Reachable, and it returns. `executeCommand` rejects if the handler throws, so
  // an unhandled fault in the empty-list path fails here.
  await vscode.commands.executeCommand(GIT_APPROVALS_COMMAND);

  console.log(`[consent-grants] '${GIT_APPROVALS_COMMAND}' is contributed, registered and ran.`);
}
