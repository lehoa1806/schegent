/**
 * Feature 193 (T035, negative control for T038) & FR-R7-05 (T025, SC-006) —
 * asserts that `npm run contracts:check` fails, and names both the stale
 * generated file and its source descriptor, when a source contract or
 * generated file is mutated without regenerating.
 *
 * Exercises the real `scripts/generate-contract-schemas.mjs --check` binary
 * against a minimal, file-exact sandbox copy of every input and output it
 * reads — not a reimplementation of its comparison logic.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonSchemaNode } from '../helpers/json-schema-validator';

const REPO_ROOT = path.resolve(__dirname, '../..');
const GENERATOR_SCRIPT = 'scripts/generate-contract-schemas.mjs';
const STALE_ACTION_KEYS_MESSAGE = 'stale generated file: webview-ui/src/lib/generated/action-keys.ts';

// Every relative path the generator reads from or compares against in
// `--check` mode (see `scripts/generate-contract-schemas.mjs`).
const REQUIRED_FILES: readonly string[] = [
  GENERATOR_SCRIPT,
  'package.json',
  // FR-R7-05 declarative descriptor modules & emitters
  'scripts/contracts/canonical-enums.mjs',
  'scripts/contracts/descriptor-dsl.mjs',
  'scripts/contracts/emit-backend-descriptors.mjs',
  'scripts/contracts/emit-json-schema.mjs',
  'scripts/contracts/emit-types.mjs',
  'scripts/contracts/emit-validators.mjs',
  'scripts/contracts/emit-webview-mirror.mjs',
  'scripts/contracts/snapshot-descriptors.mjs',
  'scripts/contracts/ipc-descriptors/analytics-reporting.mjs',
  'scripts/contracts/ipc-descriptors/catalog.mjs',
  'scripts/contracts/ipc-descriptors/execution-workflow.mjs',
  'scripts/contracts/ipc-descriptors/history-evidence.mjs',
  'scripts/contracts/ipc-descriptors/host-messages.mjs',
  'scripts/contracts/ipc-descriptors/index.mjs',
  'scripts/contracts/ipc-descriptors/navigation-settings.mjs',
  'scripts/contracts/ipc-descriptors/phase-control.mjs',
  'scripts/contracts/ipc-descriptors/phase-log.mjs',
  'scripts/contracts/ipc-descriptors/queue-core.mjs',
  'scripts/contracts/ipc-descriptors/queue-management.mjs',
  // Canonical enum sources read by canonical-enums.mjs and emit-backend-descriptors.mjs
  'src/contracts/backend-kinds.ts',
  'src/contracts/backend-descriptors.ts',
  'src/contracts/backend-runner.ts',
  'src/config/settings-schema.ts',
  'src/contracts/catalog-store.ts',
  'src/contracts/pipeline-definitions.ts',
  'src/contracts/command-outcome.ts',
  'src/contracts/sidebar-ipc/workflow-run.ts',
  'src/contracts/snapshot-bounds.ts',
  'src/contracts/process-definitions.ts',
  'src/contracts/phase-capabilities.ts',
  'src/contracts/run-results.ts',
  'src/contracts/containment-qualification.ts',
  'src/contracts/execution-decision-observation.ts',
  'src/contracts/workflow-definitions.ts',
  'src/contracts/phase-context/context-policy.ts',
  // Existing AST extraction inputs
  'src/contracts/sidebar-ipc.ts',
  'src/contracts/audit-events.ts',
  'src/state/workflow-run.ts',
  'src/contracts/state-schema.ts',
  'src/contracts/decision-results.ts',
  'src/contracts/workflow-controls.ts',
  'src/contracts/recovery-envelope.ts',
  'src/contracts/backend-availability.ts',
  'src/contracts/queue-snapshot.ts',
  'src/queue/feature-request.ts',
  'src/runner/invocation-result.ts',
  'src/ui/sidebar/snapshot.ts',
  'src/lib/retry-condition.ts',
  'src/lib/fatal-signature-registry.ts',
  'src/contracts/action-keys.ts',
  'src/contracts/queue-failure-policy.ts',
  // Generated outputs
  'webview-ui/src/lib/generated/backend-kinds.ts',
  'webview-ui/src/lib/generated/backend-descriptors.ts',
  'webview-ui/src/lib/generated/queue-failure-policy.ts',
  'webview-ui/src/lib/generated/action-keys.ts',
  'webview-ui/src/lib/generated/snapshot-mirror.ts',
  'src/contracts/generated/boundary-contracts.ts',
  'src/contracts/generated/sidebar-ipc-types.ts',
  'src/contracts/generated/snapshot-types.ts',
  'src/contracts/generated/validators/analytics-reporting.ts',
  'src/contracts/generated/validators/catalog.ts',
  'src/contracts/generated/validators/execution-workflow.ts',
  'src/contracts/generated/validators/history-evidence.ts',
  'src/contracts/generated/validators/navigation-settings.ts',
  'src/contracts/generated/validators/phase-control.ts',
  'src/contracts/generated/validators/phase-log.ts',
  'src/contracts/generated/validators/queue-core.ts',
  'src/contracts/generated/validators/queue-management.ts',
  'src/contracts/generated/schemas/contract-families.json',
  'src/contracts/generated/schemas/sidebar-ipc.schema.json',
  'src/contracts/generated/schemas/audit-events.schema.json',
  'src/contracts/generated/schemas/settings.schema.json',
  'src/contracts/generated/schemas/queue.schema.json',
  'src/contracts/generated/schemas/state.schema.json',
  'src/contracts/generated/schemas/backend-runner.schema.json',
  'webview-ui/src/lib/retry-condition.ts',
  'webview-ui/src/lib/fatal-signature-registry.ts'
];

function buildSandbox(): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-contracts-check-'));
  for (const relativePath of REQUIRED_FILES) {
    const destination = path.join(sandbox, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relativePath), destination);
  }
  // The generator resolves `typescript` via ordinary Node module resolution
  // from the script's own location, so a symlink is enough — no need to copy
  // node_modules to exercise `--check`.
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir');
  return sandbox;
}

function runGenerator(sandbox: string, args: readonly string[]): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [GENERATOR_SCRIPT, ...args], {
      cwd: sandbox,
      encoding: 'utf8'
    });
    return { status: 0, output };
  } catch (err) {
    const failure = err as { status: number | null; stdout: string; stderr: string };
    return { status: failure.status ?? 1, output: `${failure.stdout}${failure.stderr}` };
  }
}

function runCheck(sandbox: string): { status: number; output: string } {
  return runGenerator(sandbox, ['--check']);
}

function resolveSandboxOverlay(sandbox: string, fileName: string): string {
  const normalized = path.resolve(fileName);
  if (normalized.startsWith(sandbox + path.sep) || normalized === sandbox) {
    if (fs.existsSync(normalized)) return normalized;
    const rel = path.relative(sandbox, normalized);
    const fallback = path.join(REPO_ROOT, rel);
    if (fs.existsSync(fallback)) return fallback;
  }
  return normalized;
}

function createSandboxOverlayProgram(sandbox: string, entryFiles: readonly string[]): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true
  };
  const baseHost = ts.createCompilerHost(options, true);
  const readOverlay = (fileName: string): string | undefined => {
    const target = resolveSandboxOverlay(sandbox, fileName);
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
  };
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (fileName) => fs.existsSync(resolveSandboxOverlay(sandbox, fileName)),
    readFile: readOverlay,
    getSourceFile: (fileName, languageVersion) => {
      const content = readOverlay(fileName);
      return content !== undefined
        ? ts.createSourceFile(fileName, content, languageVersion, true)
        : undefined;
    },
    directoryExists: (dirName) => {
      const normalized = path.resolve(dirName);
      if (fs.existsSync(normalized)) return true;
      if (normalized.startsWith(sandbox + path.sep)) {
        return fs.existsSync(path.join(REPO_ROOT, path.relative(sandbox, normalized)));
      }
      return false;
    },
    realpath: (fileName) => fileName
  };
  return ts.createProgram([...entryFiles], options, host);
}

describe('contract generation freshness — negative controls (T035 & FR-R7-05 / SC-006)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = buildSandbox();
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('sanity check: an unmutated sandbox passes --check', () => {
    const result = runCheck(sandbox);
    expect(result.output, result.output).not.toContain('stale generated file:');
    expect(result.status).toBe(0);
  });

  it('fails and names the stale mirror when a source entry is dropped without regenerating', () => {
    const sourcePath = path.join(sandbox, 'src/contracts/action-keys.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const mutated = source.replace(/'backend\.grant-uncontained',?\s*/, '');
    expect(mutated, 'fixture did not match the expected ACTION_KEYS entry').not.toEqual(source);
    fs.writeFileSync(sourcePath, mutated, 'utf8');

    const result = runCheck(sandbox);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(STALE_ACTION_KEYS_MESSAGE);
  });

  it('fails and names both the stale mirror and its descriptor when snapshot-mirror.ts is hand-edited', () => {
    const mirrorPath = path.join(sandbox, 'webview-ui/src/lib/generated/snapshot-mirror.ts');
    const original = fs.readFileSync(mirrorPath, 'utf8');
    fs.writeFileSync(mirrorPath, `${original}\n// hand-edit drift\n`, 'utf8');

    const result = runCheck(sandbox);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('stale generated file: webview-ui/src/lib/generated/snapshot-mirror.ts');
    expect(result.output).toContain('scripts/contracts/snapshot-descriptors.mjs');
  });

  it('fails and names both the stale validator and its descriptor when an IPC descriptor changes without regenerating', () => {
    const descriptorPath = path.join(sandbox, 'scripts/contracts/ipc-descriptors/queue-core.mjs');
    const original = fs.readFileSync(descriptorPath, 'utf8');
    const mutated = original.replace('const DESCRIPTION_MAX = 4096;', 'const DESCRIPTION_MAX = 2048;');
    expect(mutated, 'fixture did not match DESCRIPTION_MAX in queue-core.mjs').not.toEqual(original);
    fs.writeFileSync(descriptorPath, mutated, 'utf8');

    const result = runCheck(sandbox);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('stale generated file: src/contracts/generated/validators/queue-core.ts');
    expect(result.output).toContain('scripts/contracts/ipc-descriptors/queue-core.mjs');
  });

  it('refuses to regenerate an empty sidebar schema', () => {
    const emitter = path.join(sandbox, 'scripts/contracts/emit-json-schema.mjs');
    const original = fs.readFileSync(emitter, 'utf8');
    const buildSchema = 'export function buildSidebarIpcJsonSchema(spec) {';
    expect(original).toContain(buildSchema);
    fs.writeFileSync(emitter, original.replace(buildSchema, `${buildSchema}\n  return {};`));

    const result = runGenerator(sandbox, []);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('sidebar-ipc.schema.json: generated properties, required, $defs missing or empty');
  });

  it('refuses to generate when a live host message lacks a descriptor', () => {
    const descriptor = path.join(sandbox, 'scripts/contracts/ipc-descriptors/host-messages.mjs');
    const original = fs.readFileSync(descriptor, 'utf8');
    const message = 'MSG_PHASE_LOG_BATCH';
    const definition = new RegExp(`,\\n\\n {2}d\\.hostMessage\\(\\{\\n {4}type: '${message}',[\\s\\S]*?\\n {2}\\}\\)`);
    expect(original).toMatch(definition);
    fs.writeFileSync(descriptor, original.replace(definition, ''));

    const result = runGenerator(sandbox, []);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(`IPC host message descriptor mismatch: missing=[${message}]`);
  });

  it('refuses to regenerate a sidebar schema with an unresolved nested reference', () => {
    const descriptor = path.join(sandbox, 'scripts/contracts/ipc-descriptors/host-messages.mjs');
    const original = fs.readFileSync(descriptor, 'utf8');
    const entryReference = "entry: d.ref('PhaseLogWireEntry')";
    expect(original).toContain(entryReference);
    fs.writeFileSync(descriptor, original.replace(
      entryReference,
      "entry: d.ref('PhaseLogWireEntry', { jsonRef: 'MissingPhaseLogWireEntry' })"
    ));

    const result = runGenerator(sandbox, []);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      'sidebar-ipc.schema.json: unresolved schema reference #/$defs/MissingPhaseLogWireEntry at #/$defs/LiveLogBatchEntry/properties/entry'
    );
  });

  it('generates the separate IPC envelope and snapshot body versions from their descriptors', () => {
    const ipcDescriptor = path.join(sandbox, 'scripts/contracts/ipc-descriptors/host-messages.mjs');
    const snapshotDescriptor = path.join(sandbox, 'scripts/contracts/snapshot-descriptors.mjs');
    const ipcSource = fs.readFileSync(ipcDescriptor, 'utf8');
    const snapshotSource = fs.readFileSync(snapshotDescriptor, 'utf8');
    expect(ipcSource).toContain('SIDEBAR_IPC_SCHEMA_VERSION = 3');
    expect(snapshotSource).toContain('SNAPSHOT_SCHEMA_VERSION = 4');
    fs.writeFileSync(ipcDescriptor, ipcSource.replace('SIDEBAR_IPC_SCHEMA_VERSION = 3', 'SIDEBAR_IPC_SCHEMA_VERSION = 30'));
    fs.writeFileSync(snapshotDescriptor, snapshotSource.replace('SNAPSHOT_SCHEMA_VERSION = 4', 'SNAPSHOT_SCHEMA_VERSION = 40'));

    const result = runGenerator(sandbox, []);
    expect(result.status, result.output).toBe(0);
    const readGenerated = (relativePath: string): string => fs.readFileSync(path.join(sandbox, relativePath), 'utf8');
    expect(readGenerated('src/contracts/generated/sidebar-ipc-types.ts')).toContain('SIDEBAR_IPC_SCHEMA_VERSION = 30');
    expect(readGenerated('src/contracts/generated/snapshot-types.ts')).toContain('SCHEMA_VERSION = 40');
    expect(readGenerated('webview-ui/src/lib/generated/snapshot-mirror.ts')).toContain('SCHEMA_VERSION = 40');
    const schema = JSON.parse(readGenerated('src/contracts/generated/schemas/sidebar-ipc.schema.json')) as JsonSchemaNode;
    expect(schema.properties?.['schemaVersion']?.const).toBe(30);
    expect(schema.properties?.['snapshotSchemaVersion']?.const).toBe(40);
    expect(schema.$defs?.['WorkflowSnapshot']?.properties?.['schemaVersion']?.const).toBe(40);
  });

  it('propagates host message fields into TypeScript and every snapshot wire schema variant', () => {
    const descriptor = path.join(sandbox, 'scripts/contracts/ipc-descriptors/host-messages.mjs');
    const original = fs.readFileSync(descriptor, 'utf8');
    const snapshotFields = 'const stateSnapshotFields = {';
    const logEntryFields = '  PhaseLogWireEntry: d.obj({';
    expect(original).toContain(snapshotFields);
    expect(original).toContain(logEntryFields);
    fs.writeFileSync(
      descriptor,
      original
        .replace(snapshotFields, `${snapshotFields}\n  propagationProbe: d.bool(),`)
        .replace(logEntryFields, `${logEntryFields}\n    propagationProbe: d.int({ min: 0 }),`)
    );

    const stale = runCheck(sandbox);
    expect(stale.output).toContain('stale generated file: src/contracts/generated/sidebar-ipc-types.ts');
    expect(stale.output).toContain('stale generated file: src/contracts/generated/schemas/sidebar-ipc.schema.json');
    expect(stale.output).toContain('scripts/contracts/ipc-descriptors/host-messages.mjs');

    const regen = runGenerator(sandbox, []);
    expect(regen.status, regen.output).toBe(0);
    const generated = fs.readFileSync(
      path.join(sandbox, 'src/contracts/generated/sidebar-ipc-types.ts'), 'utf8'
    );
    expect(generated).toContain('interface StateSnapshotMessage<S> {\n  readonly propagationProbe: boolean;');
    expect(generated).toContain('interface PhaseLogWireEntry {\n  readonly propagationProbe: number;');
    const schema = JSON.parse(
      fs.readFileSync(path.join(sandbox, 'src/contracts/generated/schemas/sidebar-ipc.schema.json'), 'utf8')
    ) as JsonSchemaNode;
    expect(schema.$defs?.['PhaseLogWireEntry']?.properties?.['propagationProbe']).toEqual({
      type: 'integer', minimum: 0
    });
    const variants = schema.$defs?.['HostMessage_STATE_SNAPSHOT']?.oneOf;
    expect(variants).toHaveLength(3);
    for (const variant of variants ?? []) {
      expect(variant.properties?.['propagationProbe']).toEqual({ type: 'boolean' });
      expect(variant.required).toContain('propagationProbe');
    }
  });

  it('emits all 71 inbound commands and 3 host messages as the live IPC types with zero hand-written CommandBase subclasses', () => {
    const generatedIpc = fs.readFileSync(
      path.join(REPO_ROOT, 'src/contracts/generated/sidebar-ipc-types.ts'),
      'utf8'
    );
    const emittedCommands = [...generatedIpc.matchAll(/export interface \w+Command extends GeneratedCommandBase<'CMD_[A-Z0-9_]+'>/g)];
    expect(emittedCommands.length).toBe(71);
    expect(generatedIpc).toContain('export interface StateSnapshotMessage<S>');
    expect(generatedIpc).toContain('export interface CommandAckMessage');
    expect(generatedIpc).toContain('export interface PhaseLogBatchPushMessage');
    expect(generatedIpc).toContain('export type HostMessage<S>');

    const sidebarIpcFiles = [
      path.join(REPO_ROOT, 'src/contracts/sidebar-ipc.ts'),
      ...fs
        .readdirSync(path.join(REPO_ROOT, 'src/contracts/sidebar-ipc'))
        .filter((file) => file.endsWith('.ts'))
        .map((file) => path.join(REPO_ROOT, 'src/contracts/sidebar-ipc', file))
    ];
    for (const file of sidebarIpcFiles) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content, `${path.relative(REPO_ROOT, file)} must not hand-declare a CommandBase subclass`).not.toMatch(
        /extends\s+CommandBase</
      );
    }
  });

  it('propagates a descriptor edit into generated host types, live sidebar-ipc / webview messages.ts exports, validator, and sidebar-ipc.schema.json', () => {
    const descriptorPath = path.join(sandbox, 'scripts/contracts/ipc-descriptors/phase-control.mjs');
    const original = fs.readFileSync(descriptorPath, 'utf8');
    const target = `    type: 'CMD_PAUSE_PHASE',\n    interfaceName: 'PausePhaseCommand',\n    validatorName: 'validatePausePhase',\n    family: 'phase-control',\n    doc: 'Pause the active phase on the addressed queue.',\n    payloadMode: 'required',\n    payload: d.obj({ queueId: queueId() }, { allowArray: true })`;
    const replacement = `    type: 'CMD_PAUSE_PHASE',\n    interfaceName: 'PausePhaseCommand',\n    validatorName: 'validatePausePhase',\n    family: 'phase-control',\n    doc: 'Pause the active phase on the addressed queue.',\n    payloadMode: 'required',\n    payload: d.obj({ queueId: queueId(), propagationProbe: d.field(d.str(), { optional: true }) }, { allowArray: true })`;
    expect(original, 'fixture did not match CMD_PAUSE_PHASE descriptor').toContain(target);
    fs.writeFileSync(descriptorPath, original.replace(target, replacement), 'utf8');

    const regen = runGenerator(sandbox, []);
    expect(regen.status, regen.output).toBe(0);
    const check = runCheck(sandbox);
    expect(check.status, check.output).toBe(0);

    // 1. Generated host types updated.
    const generatedTypes = fs.readFileSync(
      path.join(sandbox, 'src/contracts/generated/sidebar-ipc-types.ts'),
      'utf8'
    );
    expect(generatedTypes).toMatch(
      /export interface PausePhaseCommand extends GeneratedCommandBase<'CMD_PAUSE_PHASE'>[\s\S]*?readonly propagationProbe\?: string;/
    );

    // 2. Generated validator updated.
    const generatedValidator = fs.readFileSync(
      path.join(sandbox, 'src/contracts/generated/validators/phase-control.ts'),
      'utf8'
    );
    expect(generatedValidator).toContain('propagationProbe');

    // 3. Generated JSON Schema updated.
    const schemaJson = JSON.parse(
      fs.readFileSync(path.join(sandbox, 'src/contracts/generated/schemas/sidebar-ipc.schema.json'), 'utf8')
    ) as {
      $defs: {
        Command_CMD_PAUSE_PHASE: {
          properties: {
            payload: {
              properties: Record<string, { type?: string }>;
            };
          };
        };
      };
    };
    expect(
      schemaJson.$defs.Command_CMD_PAUSE_PHASE.properties.payload.properties.propagationProbe
    ).toEqual({ type: 'string' });

    // 4. Live `sidebar-ipc.ts` AND `webview-ui/src/lib/messages.ts` resolve the updated PausePhaseCommand type.
    const hostBarrelPath = path.join(sandbox, 'src/contracts/sidebar-ipc.ts');
    const webviewMessagesPath = path.join(sandbox, 'webview-ui/src/lib/messages.ts');
    const program = createSandboxOverlayProgram(sandbox, [hostBarrelPath, webviewMessagesPath]);
    const checker = program.getTypeChecker();

    for (const entryPath of [hostBarrelPath, webviewMessagesPath]) {
      const sourceFile = program.getSourceFile(entryPath);
      expect(sourceFile, `source file loaded: ${entryPath}`).toBeDefined();
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile!);
      expect(moduleSymbol, `module symbol resolved: ${entryPath}`).toBeDefined();
      const exportsList = checker.getExportsOfModule(moduleSymbol!);
      const pauseSym = exportsList.find((sym) => sym.getName() === 'PausePhaseCommand');
      expect(pauseSym, `PausePhaseCommand exported from ${entryPath}`).toBeDefined();
      const pauseType = checker.getDeclaredTypeOfSymbol(
        pauseSym!.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(pauseSym!) : pauseSym!
      );
      const payloadProp = pauseType.getProperty('payload');
      expect(payloadProp, `payload property on PausePhaseCommand in ${entryPath}`).toBeDefined();
      const payloadType = checker.getTypeOfSymbolAtLocation(payloadProp!, sourceFile!);
      const probeProp = payloadType.getProperty('propagationProbe');
      expect(probeProp, `propagationProbe propagated to ${entryPath}`).toBeDefined();
      const probeTypeStr = checker.typeToString(
        checker.getTypeOfSymbolAtLocation(probeProp!, sourceFile!)
      );
      expect(probeTypeStr).toBe('string | undefined');
    }
  });
});
