import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  writeGeneralSettings,
  CONFIGURATION_TARGET_GLOBAL
} from '../../src/config/general-settings';

// FR-R3-051 / M-05 — the claim that can only be made in a real VS Code.
//
// `writeGeneralSettings` wrote every accepted key to
// `ConfigurationTarget.Workspace`, `cli.path` included. `cli.path` is declared
// `scope: "application"` in `package.json`, and an application-scoped setting
// has NO workspace layer: real VS Code rejects or misapplies the write.
//
// The unit suite cannot see this. `GeneralSettingsConfig` is a two-method port
// and every double in the suite accepts whatever target it is handed, so the
// suite was green against a product that could not persist the setting. The
// unit test added alongside this one asserts the ARGUMENT is now `Global`; only
// this file asserts that the write LANDS, which is the part that was broken.
//
// Read back through `inspect()` rather than `get()`: `get()` returns the
// effective value and would be satisfied by the manifest default, so it would
// pass even if nothing had been written anywhere.
export async function run(): Promise<void> {
  const KEY = 'cli.path';
  const PREFIXED = `schegent.${KEY}`;
  const VALUE = '/tmp/schegent-scope-probe/claude';

  // The host mirrors `ConfigurationTarget` numerically so the module stays
  // unit-testable without importing `vscode`. If VS Code ever renumbered the
  // enum, every unit assertion about the target would still pass while the
  // product wrote to the wrong layer. This is the only place the mirror can be
  // checked against the real enum.
  assert.equal(
    CONFIGURATION_TARGET_GLOBAL,
    vscode.ConfigurationTarget.Global,
    'the mirrored Global target no longer matches vscode.ConfigurationTarget.Global'
  );

  const previous = vscode.workspace.getConfiguration().inspect<string>(PREFIXED)?.globalValue;
  try {
    const config = vscode.workspace.getConfiguration('schegent');
    const result = await writeGeneralSettings(
      config as unknown as Parameters<typeof writeGeneralSettings>[0],
      { [KEY]: VALUE }
    );
    assert.equal(result.ok, true, `write rejected: ${JSON.stringify(result)}`);

    const inspected = vscode.workspace.getConfiguration().inspect<string>(PREFIXED);
    assert.ok(inspected, 'inspect() returned nothing for a contributed setting');
    assert.equal(
      inspected.globalValue,
      VALUE,
      'application-scoped write did not land at the global layer'
    );
    assert.equal(
      inspected.workspaceValue,
      undefined,
      'application-scoped write left a value at the workspace layer'
    );
  } finally {
    await vscode.workspace
      .getConfiguration()
      .update(PREFIXED, previous, vscode.ConfigurationTarget.Global);
  }
}
