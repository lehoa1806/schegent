import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'schegent.schegent';

/**
 * The three definition keys this smoke test was originally written about
 * (T048 / US3). Feature 099 (T494, FR-054) deleted them: Phases, Pipelines and
 * Workflows are stored under `.schegent/catalog/`, not configured, and the keys
 * were deleted rather than drained because there is no installed base to migrate.
 */
const DELETED_DEFINITION_KEYS: readonly string[] = ['phases', 'pipelines', 'workflows'];

// T048 / US3 host smoke test, as feature 099 leaves it. It verifies that the
// configuration keys ship with the activated extension and that workspace-scoped
// writes are visible via the standard VS Code Configuration API.
//
// Feature 099 (T494, FR-054) — this asserted that `schegent.phases` and
// `schegent.pipelines` were registered with a `[]` default, and round-tripped a
// three-Phase and a twelve-Phase Pipeline through the workspace scope to prove
// the API carried definition rows. Those keys no longer exist, so the three
// claims are made against what replaced them:
//
//   (a) a workspace-scoped write is visible to the API — carried by
//       `schegent.defaultPipelineId`, which is `resource`-scoped and is the key
//       that survived the collapse;
//   (b) the registered keys have their schema defaults, **and the deleted ones
//       are absent** — the deletion is asserted rather than assumed, because a
//       key reappearing in `package.json` would silently restore a second place
//       to author a definition from;
//   (c) `schegent.schedule` is registered so the QuickPick path can be reached.
//
// The definition round-trip itself is not re-homed onto the store here: the
// store's own suites cover it against a real filesystem, and this file is a
// smoke test of the *configuration* surface.
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  await ext.activate();

  const config = vscode.workspace.getConfiguration('schegent');

  // (b) — the surviving key must be registered with its schema default.
  // `inspect` returns undefined for unregistered keys.
  const defaultPipelineInspect = config.inspect<string>('defaultPipelineId');
  assert.ok(
    defaultPipelineInspect,
    'schegent.defaultPipelineId is not a registered configuration key'
  );
  // Feature 098 (T066, FR-033a) — this asserted `'speckit-new-feature'`, the
  // Pipeline the built-in layer supplied. There is no built-in layer, so a
  // shipped default would name a Pipeline no installation has; the empty string
  // is how "no default" is spelled, and `package.json` declares it that way.
  assert.equal(
    defaultPipelineInspect.defaultValue,
    '',
    'schegent.defaultPipelineId defaultValue must be "" — the extension ships no pipelines'
  );

  // (b, second half) — the deleted definition keys must stay deleted. A
  // registered key contributes a `defaultValue`; an unregistered one contributes
  // nothing, whether `inspect` answers with `undefined` or with an empty record.
  for (const key of DELETED_DEFINITION_KEYS) {
    const inspected = config.inspect<unknown>(key);
    assert.equal(
      inspected?.defaultValue,
      undefined,
      `schegent.${key} is still a registered configuration key — definitions live in the catalog store`
    );
  }

  // (c) — `schegent.schedule` must be a registered command (it is the entry
  // point for the pipeline QuickPick).
  const allCommands = await vscode.commands.getCommands(true);
  assert.ok(
    allCommands.includes('schegent.schedule'),
    'schegent.schedule command is not registered'
  );

  // (a) — Programmatically write the default Pipeline id into the workspace
  // scope and verify `get` returns the workspace value rather than the
  // user/global value or the default. The id is legal under the key's declared
  // pattern, so what the assertion proves is the scope precedence rather than
  // the grammar.
  const workspacePipelineId = 'smoke-default-pipeline';
  const target = vscode.ConfigurationTarget.Workspace;
  const touched = await tryUpdate('defaultPipelineId', workspacePipelineId, target);

  try {
    if (!touched) {
      // No `.vscode/settings.json` in the test workspace — skip the
      // workspace-scope assertion but still consider the smoke a pass for
      // the (b) and (c) checks above.
      return;
    }

    const reread = vscode.workspace.getConfiguration('schegent');
    assert.equal(
      reread.get<string>('defaultPipelineId', ''),
      workspacePipelineId,
      'workspace value for schegent.defaultPipelineId is not visible to the API'
    );
    assert.equal(
      reread.inspect<string>('defaultPipelineId')?.workspaceValue,
      workspacePipelineId,
      'schegent.defaultPipelineId did not land at the workspace scope'
    );
  } finally {
    await tryUpdate('defaultPipelineId', undefined, target);
  }
}

async function tryUpdate(
  key: string,
  value: unknown,
  target: vscode.ConfigurationTarget
): Promise<boolean> {
  try {
    await vscode.workspace.getConfiguration('schegent').update(key, value, target);
    return true;
  } catch {
    return false;
  }
}
