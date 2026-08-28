import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  MUTATING_COMMAND_ID_LIST,
  READ_ONLY_COMMAND_ID_LIST,
  type ReadOnlyCommandId
} from '../../src/contracts/entry-point-dispositions';

/**
 * FR-R3-136 (T1527) — what the two trust launches share.
 *
 * `runTest.ts` opens one tracked fixture twice with a single variable changed:
 * whether VS Code's Workspace Trust feature is live. `trust-untrusted-workspace`
 * gets the feature ON against a folder the profile has never trusted, which is the
 * only configuration in which `workspace.isTrusted` is `false`;
 * `trust-granted-workspace` gets a fresh copy with the feature disabled. Every
 * claim in the untrusted leg is an ABSENCE — no lock file, no spawn, no
 * workspace-supplied capability — and an absence is the one kind of assertion a
 * broken harness satisfies for free. The granted leg is the control: same fixture,
 * same sentinel, same settings, and every one of those absences becomes a
 * presence.
 *
 * The helpers here are shared so that the two legs cannot drift into asking
 * different questions of the same fixture.
 */

const EXTENSION_ID = 'schegent.schegent';
const ACTIVATION_BUDGET_MS = 20_000;
const EVIDENCE_BUDGET_MS = 20_000;
const POLL_INTERVAL_MS = 100;

/**
 * The two read-only ids this leg does not invoke, and why.
 *
 * Both open a modal destination picker — `vscode.window.showSaveDialog` for the
 * audit export, an injected `promptForDestination()` for the evidence export. A
 * modal in a headless launch has nobody to dismiss it, so invoking either would
 * hang the leg rather than fail it. That they are modal is the same fact that
 * makes them read-only under C7: no workspace content can confirm a dialog.
 */
const MODAL_READ_ONLY: readonly ReadOnlyCommandId[] = Object.freeze([
  'schegent.exportAuditLog',
  'schegent.exportRunEvidence'
]);

/** The refusal `registerGuardedCommand` writes at info on every declined call. */
const REFUSAL_MESSAGE = 'command refused: workspace not trusted';

/** Where the runtime log lands when `schegent.logging.runtimeLogFilePath` is unset. */
const SYSLOG_SEGMENTS = ['.schegent', 'syslog'] as const;

/** The election's evidence: one generation file per acquired resource. */
const OWNERSHIP_SEGMENTS = ['.schegent', 'ownership'] as const;

/** The three keys the fixture's `.vscode/settings.json` is allowed to set. */
const FIXTURE_KEYS = Object.freeze([
  'schegent.trust.allowCustomPhases',
  'schegent.loop.maxIterations',
  'schegent.cli.path'
]);

export interface TrustLegContext {
  /** The folder VS Code opened — a private copy of the tracked fixture. */
  readonly workspaceRoot: string;
  /** Values the fixture's `.vscode/settings.json` asks for, read from that file. */
  readonly fixtureSettings: Readonly<Record<string, unknown>>;
  /** The manifest VS Code actually resolved. */
  readonly manifest: ResolvedManifest;
  /** The sentinel installed at user scope, derived from the effective setting. */
  readonly sentinelPath: string;
  /** Where the sentinel appends when something spawns it. */
  readonly sentinelMarker: string;
}

interface ResolvedManifest {
  // `| undefined` is declared because the read below is a lookup of a key this
  // file names and the manifest may not: the whole point of the guard there is a
  // property that has been renamed or removed. Without the declaration,
  // `noUncheckedIndexedAccess` being off types the read as present and the guard
  // reads as dead code.
  readonly properties: Readonly<Record<string, { readonly default?: unknown } | undefined>>;
  readonly restricted: readonly string[];
}

/** Poll a predicate to a deadline. Returns whether it ever held. */
export async function waitUntil(
  predicate: () => boolean,
  budgetMs: number = EVIDENCE_BUDGET_MS
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Wait for the extension to activate on its own and collect what both legs need.
 *
 * No `ext.activate()` call: the fixture carries `.specify/`, so
 * `workspaceContains:.specify/` is what must fire. `capabilities
 * .untrustedWorkspaces.supported` is `limited`, which is precisely the promise
 * that activation still happens in an untrusted window — an extension declaring
 * `false` there would never be loaded and the untrusted leg would be asserting
 * absences about an extension that never ran.
 */
export async function enterTrustLeg(expected: {
  readonly trusted: boolean;
}): Promise<TrustLegContext> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'trust leg has no workspace folder open');
  const workspaceRoot = folder.uri.fsPath;

  // FIRST, and with the loudest message in the file. Every other assertion in
  // both legs is conditioned on this, and the two failure modes are ones a
  // reader would otherwise spend an afternoon on: the harness passing
  // `--disable-workspace-trust` to a launch that wanted the feature live, or a
  // shared `user-data-dir` carrying a trust grant from an earlier launch.
  assert.equal(
    vscode.workspace.isTrusted,
    expected.trusted,
    `this leg requires workspace.isTrusted === ${expected.trusted} and the host reported ` +
      `${vscode.workspace.isTrusted}. Nothing below can be interpreted: an untrusted leg in a ` +
      `trusted window asserts absences that a refusal never caused, and a trusted leg in an ` +
      `untrusted window asserts presences the gate correctly withheld. Check runTest.ts — the ` +
      `pass's workspaceTrust setting, and that its user-data-dir is private to the launch.`
  );

  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  const activated = await waitUntil(() => ext.isActive, ACTIVATION_BUDGET_MS);
  assert.ok(
    activated,
    `extension did not activate within ${ACTIVATION_BUDGET_MS}ms in a workspace containing ` +
      `.specify/. In an untrusted window that is a manifest problem, not a timing one: ` +
      `capabilities.untrustedWorkspaces.supported must stay 'limited' for activation to happen ` +
      `at all.`
  );

  const manifest = readResolvedManifest(ext.packageJSON);
  const fixtureSettings = readFixtureSettings(workspaceRoot);
  const sentinelPath = effectiveString('cli.path');
  assert.ok(
    sentinelPath.endsWith('no-spawn-sentinel.sh'),
    `schegent.cli.path resolves to ${JSON.stringify(sentinelPath)}, which is not the sentinel. ` +
      `The launch installs it at USER scope; without it, "nothing was spawned" is unfalsifiable ` +
      `because there was nothing to spawn.`
  );

  return {
    workspaceRoot,
    fixtureSettings,
    manifest,
    sentinelPath,
    sentinelMarker: path.join(path.dirname(sentinelPath), 'spawned.marker')
  };
}

function readResolvedManifest(packageJSON: unknown): ResolvedManifest {
  const pkg = packageJSON as {
    contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } };
    capabilities?: { untrustedWorkspaces?: { restrictedConfigurations?: readonly string[] } };
  };
  const properties = pkg.contributes?.configuration?.properties;
  const restricted = pkg.capabilities?.untrustedWorkspaces?.restrictedConfigurations;
  assert.ok(properties, 'resolved manifest declares no configuration properties');
  assert.ok(
    restricted && restricted.length > 0,
    'resolved manifest declares no restrictedConfigurations. The Phase D assertions below would ' +
      'then be comparing a workspace value against nothing, and would pass whatever VS Code did.'
  );
  return { properties, restricted };
}

/**
 * The fixture's own settings file, read from the copy VS Code opened.
 *
 * Read rather than restated: the values the workspace asks for are the fixture's
 * to define, and a test carrying its own copy of them would keep passing after the
 * fixture changed. The key set is pinned so that a setting added to the fixture
 * fails here until this file grows the assertion that setting deserves.
 */
function readFixtureSettings(workspaceRoot: string): Readonly<Record<string, unknown>> {
  const file = path.join(workspaceRoot, '.vscode', 'settings.json');
  assert.ok(fs.existsSync(file), `fixture copy has no ${file}`);
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(settings).sort(),
    [...FIXTURE_KEYS].sort(),
    'the fixture sets a different set of properties than this leg reasons about. Every setting in ' +
      'that file is an assertion in both legs — add the assertion, then add the key here.'
  );
  return settings;
}

function effectiveString(section: string): string {
  const value = vscode.workspace.getConfiguration('schegent').get(section);
  assert.equal(typeof value, 'string', `schegent.${section} is not a string: ${String(value)}`);
  return value as string;
}

/**
 * FR-013/FR-014/FR-015 end to end — what a workspace's settings are allowed to
 * say in this window.
 *
 * This is the only place `restrictedConfigurations` can be observed doing
 * anything. `tests/lint/restricted-configurations-parity.test.ts` proves the
 * manifest list agrees with the sensitivity classes; neither it nor the manifest
 * shows VS Code HONOURING the list. Three properties, chosen so the answer is
 * decidable:
 *
 *   - a restricted one, which must read the manifest default while untrusted and
 *     the workspace's value while trusted;
 *   - an unrestricted one, which must read the workspace's value in BOTH windows —
 *     the control, without which "the restricted value did not apply" is
 *     indistinguishable from "the settings file was never read";
 *   - an `application`-scoped one, which must read the workspace's value in
 *     NEITHER window, because scope is a stronger guarantee than restriction and
 *     holds in a trusted window too (C5).
 */
export function assertConfigurationPolicy(
  context: TrustLegContext,
  expected: { readonly trusted: boolean }
): void {
  const config = vscode.workspace.getConfiguration('schegent');

  const restrictedKey = 'schegent.trust.allowCustomPhases';
  const unrestrictedKey = 'schegent.loop.maxIterations';
  const scopedKey = 'schegent.cli.path';

  // The classification this leg depends on, read off the manifest rather than
  // assumed. A reclassification must break this test, not silently retarget it.
  assert.ok(
    context.manifest.restricted.includes(restrictedKey),
    `${restrictedKey} is no longer in restrictedConfigurations, so it cannot demonstrate that a ` +
      `restricted property is suppressed. Pick another 'capability' or 'evidence' class property.`
  );
  assert.ok(
    !context.manifest.restricted.includes(unrestrictedKey),
    `${unrestrictedKey} is now in restrictedConfigurations, so it can no longer serve as the ` +
      `control that proves the workspace settings file was read at all. Pick another 'run-shape' ` +
      `property.`
  );

  const declared = context.manifest.properties[restrictedKey];
  assert.ok(
    declared && 'default' in declared,
    `${restrictedKey} declares no default in the resolved manifest, so there is no value to expect ` +
      `while untrusted. A restricted property without a default has nothing to fall back TO.`
  );
  const suppressed = declared.default;
  const asked = context.fixtureSettings[restrictedKey];
  assert.notDeepEqual(
    suppressed,
    asked,
    `the fixture asks for ${JSON.stringify(asked)} and the manifest default is the same value, so ` +
      `${restrictedKey} cannot tell a suppressed workspace value from an applied one.`
  );

  const restrictedActual = config.get(restrictedKey.slice('schegent.'.length));
  assert.deepEqual(
    restrictedActual,
    expected.trusted ? asked : suppressed,
    `${restrictedKey} read ${JSON.stringify(restrictedActual)} in a ` +
      `${expected.trusted ? 'trusted' : 'untrusted'} window. The workspace asks for ` +
      `${JSON.stringify(asked)}; while untrusted VS Code must suppress that and yield the ` +
      `manifest default ${JSON.stringify(suppressed)}, because the property is named in ` +
      `capabilities.untrustedWorkspaces.restrictedConfigurations.`
  );

  const unrestrictedActual = config.get(unrestrictedKey.slice('schegent.'.length));
  assert.deepEqual(
    unrestrictedActual,
    context.fixtureSettings[unrestrictedKey],
    `${unrestrictedKey} read ${JSON.stringify(unrestrictedActual)} rather than the workspace's ` +
      `${JSON.stringify(context.fixtureSettings[unrestrictedKey])}. It is deliberately NOT ` +
      `restricted — a run-shape property in a window where no run starts — and it is this leg's ` +
      `evidence that the fixture's settings file was read. If it did not apply, the assertion ` +
      `above proves nothing.`
  );

  const scopedActual = effectiveString(scopedKey.slice('schegent.'.length));
  assert.notEqual(
    scopedActual,
    context.fixtureSettings[scopedKey],
    `${scopedKey} resolved to the value the WORKSPACE asked for. That property is ` +
      `application-scoped (FR-015) precisely so a repository cannot name the binary this ` +
      `extension executes — in a trusted window either. Check its scope in package.json.`
  );
  assert.equal(
    scopedActual,
    context.sentinelPath,
    `${scopedKey} resolved to neither the workspace's value nor the user-scope sentinel.`
  );
}

/** Generation files under `.schegent/ownership/`, or `[]` when the directory is absent. */
export function ownershipRecords(workspaceRoot: string): readonly string[] {
  const dir = path.join(workspaceRoot, ...OWNERSHIP_SEGMENTS);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

/** The runtime log's contents, or `''` when it has not been written yet. */
export function readSyslog(workspaceRoot: string): string {
  const file = path.join(workspaceRoot, ...SYSLOG_SEGMENTS);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Lines in the runtime log recording a refusal for `commandId`. */
export function refusalLines(syslog: string, commandId: string): readonly string[] {
  return syslog
    .split(/\r?\n/)
    .filter((line) => line.includes(REFUSAL_MESSAGE) && line.includes(`"commandId":"${commandId}"`));
}

export interface DrivenCommands {
  readonly mutating: readonly string[];
  readonly readOnly: readonly string[];
}

/**
 * Invoke every command the extension registers, except the two modal ones.
 *
 * Through `vscode.commands.executeCommand`, which is the point: VS Code's own
 * guidance is that a registered command can be invoked by another extension or a
 * task, so palette visibility and `enablement` clauses are not authorization.
 * This is the invocation path that bypasses all of that, and the one FR-003 is
 * about.
 *
 * A refused command returns `undefined` rather than throwing — a declined action
 * is not a fault — so the return value is not the observable. The runtime log is.
 * An id that is not registered at all DOES throw here, which is the failure a
 * disposition map gone out of step with `ui-wiring.ts` produces.
 */
export async function driveEveryCommand(): Promise<DrivenCommands> {
  for (const id of MODAL_READ_ONLY) {
    assert.ok(
      (READ_ONLY_COMMAND_ID_LIST as readonly string[]).includes(id),
      `${id} is skipped as modal but is no longer a registered read-only id. A skip list that ` +
        `names nothing is a command silently going unexercised.`
    );
  }
  const readOnly = READ_ONLY_COMMAND_ID_LIST.filter(
    (id) => !(MODAL_READ_ONLY as readonly string[]).includes(id)
  );
  assert.ok(readOnly.length > 0, 'no non-modal read-only command left to exercise');

  const mutating = [...MUTATING_COMMAND_ID_LIST];
  for (const id of [...mutating, ...readOnly]) {
    await vscode.commands.executeCommand(id);
  }
  return { mutating, readOnly };
}

/**
 * Prove the sentinel is observable, without touching the marker under assertion.
 *
 * The untrusted leg's spawn claim is "this file does not exist". A sentinel that
 * could never write — a lost exec bit after the copy, a `dirname` that resolved
 * somewhere unwritable — produces exactly that. So the script is copied
 * elsewhere and run directly here, and its marker must appear at the copy. The
 * mechanism is demonstrated in the same run that depends on it, rather than by a
 * revert somebody performed once and wrote down.
 */
export function assertSentinelObservable(context: TrustLegContext): void {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-sentinel-'));
  const copy = path.join(scratch, path.basename(context.sentinelPath));
  fs.copyFileSync(context.sentinelPath, copy);
  fs.chmodSync(copy, 0o755);
  const marker = path.join(scratch, 'spawned.marker');
  try {
    const result = cp.spawnSync(copy, ['--help'], { encoding: 'utf8' });
    assert.equal(
      result.status,
      97,
      `the sentinel exited ${String(result.status)} rather than 97: ${result.stderr}`
    );
    assert.ok(
      fs.existsSync(marker),
      `the sentinel ran and wrote no marker at ${marker}. Every "nothing was spawned" assertion ` +
        `in this leg is then unfalsifiable.`
    );
    assert.match(fs.readFileSync(marker, 'utf8'), /spawned --help/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
