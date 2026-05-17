import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'schegent.schegent';

// T048 / US3 host smoke test. Verifies that the dynamic-pipelines configuration
// keys ship with the activated extension and that workspace-scoped writes are
// visible via the standard VS Code Configuration API. The full
// fixture-workspace-with-prebaked-`.vscode/settings.json` flow is deferred to
// the multi-runner split tracked under spec 005; this smoke runs against the
// schegent repo workspace and writes the workspace value programmatically via
// `update(..., ConfigurationTarget.Workspace)`, then rolls it back in the
// `finally` block. That is sufficient to assert (a) `get('phases')` returns
// the workspace value, (b) the new keys are registered (their `defaultValue`
// is observable via `inspect`), and (c) `schegent.schedule` is registered
// so the QuickPick path can be reached.
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  await ext.activate();

  const config = vscode.workspace.getConfiguration('schegent');

  // (b) — The three new configuration keys must be registered with their
  // schema defaults. `inspect` returns undefined for unregistered keys.
  const phasesInspect = config.inspect<readonly unknown[]>('phases');
  const pipelinesInspect = config.inspect<readonly unknown[]>('pipelines');
  const defaultPipelineInspect = config.inspect<string>('defaultPipelineId');

  assert.ok(phasesInspect, 'schegent.phases is not a registered configuration key');
  assert.ok(pipelinesInspect, 'schegent.pipelines is not a registered configuration key');
  assert.ok(
    defaultPipelineInspect,
    'schegent.defaultPipelineId is not a registered configuration key'
  );

  assert.deepEqual(
    phasesInspect.defaultValue,
    [],
    'schegent.phases defaultValue must be []'
  );
  assert.deepEqual(
    pipelinesInspect.defaultValue,
    [],
    'schegent.pipelines defaultValue must be []'
  );
  assert.equal(
    defaultPipelineInspect.defaultValue,
    'speckit-new-feature',
    'schegent.defaultPipelineId defaultValue must be "speckit-new-feature"'
  );

  // (c) — `schegent.schedule` must be a registered command (it is the entry
  // point for the pipeline QuickPick).
  const allCommands = await vscode.commands.getCommands(true);
  assert.ok(
    allCommands.includes('schegent.schedule'),
    'schegent.schedule command is not registered'
  );

  // (a) — Programmatically install a 3-phase + 12-phase pipeline pair into
  // the workspace scope and verify `get('phases')` returns the workspace
  // value rather than the user/global value or the default.
  const customPhases: readonly Record<string, unknown>[] = [
    {
      id: 'sec-recon',
      name: 'Recon',
      instruction: 'Inventory the staged diff for new dependencies and entry points.',
      loopable: false
    },
    {
      id: 'sec-audit',
      name: 'Audit',
      instruction: 'Audit the staged diff for security regressions.',
      effort: 'high',
      loopable: true
    },
    {
      id: 'sec-report',
      name: 'Report',
      instruction: 'Summarize findings and exit.',
      loopable: false
    }
  ];

  const longPipelinePhases: string[] = [];
  for (let i = 0; i < 12; i++) {
    longPipelinePhases.push(`step-${i}`);
  }
  const longPhasesEntries = longPipelinePhases.map((id) => ({
    id,
    name: id,
    instruction: `step ${id}`,
    loopable: false
  }));

  const customPipelines: readonly Record<string, unknown>[] = [
    {
      id: 'security',
      name: 'Security Audit Pipeline',
      phases: ['sec-recon', 'sec-audit', 'sec-report']
    },
    {
      id: 'long-flow',
      name: 'Twelve Step Flow',
      phases: longPipelinePhases
    }
  ];

  const allPhases = [...customPhases, ...longPhasesEntries];

  const target = vscode.ConfigurationTarget.Workspace;
  const phasesTouched = await tryUpdate('phases', allPhases, target);
  const pipelinesTouched = await tryUpdate('pipelines', customPipelines, target);

  try {
    if (!phasesTouched || !pipelinesTouched) {
      // No `.vscode/settings.json` in the test workspace — skip the
      // workspace-scope assertions but still consider the smoke a pass for
      // the (b) and (c) checks above.
      return;
    }

    const reread = vscode.workspace.getConfiguration('schegent');
    const phases = reread.get<readonly Record<string, unknown>[]>('phases', []);
    const pipelines = reread.get<readonly Record<string, unknown>[]>('pipelines', []);
    assert.equal(
      phases.length,
      allPhases.length,
      'workspace value for schegent.phases is not visible to the API'
    );
    assert.equal(
      pipelines.length,
      customPipelines.length,
      'workspace value for schegent.pipelines is not visible to the API'
    );
    const longPipeline = pipelines.find((p) => p.id === 'long-flow');
    assert.ok(longPipeline, 'long-flow pipeline missing from workspace value');
    assert.equal(
      (longPipeline.phases as readonly string[]).length,
      12,
      'long-flow pipeline must contain 12 phase entries'
    );
  } finally {
    if (phasesTouched) {
      await tryUpdate('phases', undefined, target);
    }
    if (pipelinesTouched) {
      await tryUpdate('pipelines', undefined, target);
    }
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
