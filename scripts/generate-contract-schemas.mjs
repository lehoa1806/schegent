#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');
const GENERATED_SCHEMA_VERSION = 1;

function repoPath(...parts) {
  return path.join(REPO_ROOT, ...parts);
}

function readText(relativePath) {
  return fs.readFileSync(repoPath(relativePath), 'utf8');
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.getText() === 'Object.freeze'
    && current.arguments.length > 0
  ) {
    return unwrapExpression(current.arguments[0]);
  }
  return current;
}

class SourceExtractor {
  constructor(relativePath) {
    this.relativePath = relativePath;
    this.text = readText(relativePath);
    this.sourceFile = ts.createSourceFile(
      relativePath,
      this.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    this.initializers = new Map();
    this.stringConstants = new Map();
    this.numberConstants = new Map();
    this.collectConstants(this.sourceFile);
  }

  collectConstants(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      const initializer = unwrapExpression(node.initializer);
      this.initializers.set(name, initializer);
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        this.stringConstants.set(name, initializer.text);
      }
      if (ts.isNumericLiteral(initializer)) {
        this.numberConstants.set(name, Number(initializer.text));
      }
    }
    ts.forEachChild(node, (child) => this.collectConstants(child));
  }

  stringConst(name) {
    const value = this.stringConstants.get(name);
    if (value === undefined) {
      throw new Error(`${this.relativePath}: missing string constant ${name}`);
    }
    return value;
  }

  numberConst(name) {
    const value = this.numberConstants.get(name);
    if (value === undefined) {
      throw new Error(`${this.relativePath}: missing number constant ${name}`);
    }
    return value;
  }

  stringArray(name, seen = new Set()) {
    if (seen.has(name)) {
      throw new Error(`${this.relativePath}: circular const array ${name}`);
    }
    seen.add(name);
    const initializer = this.initializers.get(name);
    if (!initializer) {
      throw new Error(`${this.relativePath}: missing const array ${name}`);
    }
    const arrayNode = unwrapExpression(initializer);
    if (!ts.isArrayLiteralExpression(arrayNode)) {
      throw new Error(`${this.relativePath}: ${name} is not an array literal`);
    }
    const values = [];
    for (const element of arrayNode.elements) {
      if (ts.isSpreadElement(element)) {
        const spreadExpression = unwrapExpression(element.expression);
        if (!ts.isIdentifier(spreadExpression)) {
          throw new Error(`${this.relativePath}: unsupported spread in ${name}`);
        }
        values.push(...this.stringArray(spreadExpression.text, seen));
        continue;
      }
      const valueExpression = unwrapExpression(element);
      if (ts.isStringLiteral(valueExpression) || ts.isNoSubstitutionTemplateLiteral(valueExpression)) {
        values.push(valueExpression.text);
        continue;
      }
      if (ts.isIdentifier(valueExpression)) {
        values.push(this.stringConst(valueExpression.text));
        continue;
      }
      throw new Error(`${this.relativePath}: unsupported array element in ${name}`);
    }
    seen.delete(name);
    return values;
  }

  stringUnion(name) {
    let result = null;
    const collect = (node) => {
      if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
        return [node.literal.text];
      }
      if (ts.isUnionTypeNode(node)) {
        return node.types.flatMap((child) => collect(child));
      }
      return [];
    };
    const visit = (node) => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
        result = collect(node.type);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sourceFile);
    if (!result) {
      throw new Error(`${this.relativePath}: missing string union ${name}`);
    }
    return result;
  }

  interfaceProperties(name) {
    let result = null;
    const visit = (node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
        result = node.members
          .filter(ts.isPropertySignature)
          .map((member) => ({
            name: member.name.getText(this.sourceFile),
            optional: Boolean(member.questionToken),
            type: member.type ? normalizeWhitespace(member.type.getText(this.sourceFile)) : 'unknown'
          }));
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sourceFile);
    if (!result) {
      throw new Error(`${this.relativePath}: missing interface ${name}`);
    }
    return result;
  }
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function tsLiteral(value) {
  return JSON.stringify(value, null, 2);
}

function makeSchema(name, title, generatedFrom, properties, required = Object.keys(properties)) {
  return {
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    '$id': `https://schegent.local/contracts/${name}.schema.json`,
    title,
    'x-generatedBy': 'scripts/generate-contract-schemas.mjs',
    'x-generatedSchemaVersion': GENERATED_SCHEMA_VERSION,
    'x-generatedFrom': generatedFrom,
    type: 'object',
    additionalProperties: false,
    required,
    properties
  };
}

function enumProperty(values) {
  return {
    type: 'array',
    items: { type: 'string', enum: values },
    uniqueItems: true
  };
}

function interfaceProperty(properties) {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'optional', 'type'],
      properties: {
        name: { type: 'string' },
        optional: { type: 'boolean' },
        type: { type: 'string' }
      }
    },
    default: properties
  };
}

function settingsPropertyFromPackage(key, property) {
  const type = Array.isArray(property.type) ? property.type.join('|') : property.type;
  return {
    key,
    type: property.enum ? 'enum' : type,
    default: property.default,
    scope: property.scope ?? 'resource',
    enum: property.enum ?? null,
    minimum: property.minimum ?? null,
    maximum: property.maximum ?? null,
    pattern: property.pattern ?? null,
    itemType: property.items?.type ?? null,
    itemPattern: property.items?.pattern ?? null
  };
}

function writeOrCheck(relativePath, content) {
  const absolutePath = repoPath(relativePath);
  if (CHECK_ONLY) {
    let existing = '';
    try {
      existing = fs.readFileSync(absolutePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [`missing generated file: ${relativePath}`];
      }
      throw err;
    }
    return existing === content ? [] : [`stale generated file: ${relativePath}`];
  }
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
  return [];
}

const sidebar = new SourceExtractor('src/contracts/sidebar-ipc.ts');
const audit = new SourceExtractor('src/contracts/audit-events.ts');
const state = new SourceExtractor('src/state/workflow-run.ts');
const stateSchema = new SourceExtractor('src/contracts/state-schema.ts');
const queueSnapshot = new SourceExtractor('src/contracts/queue-snapshot.ts');
const featureRequest = new SourceExtractor('src/queue/feature-request.ts');
const runner = new SourceExtractor('src/runner/invocation-result.ts');
const wakeupSettings = new SourceExtractor('src/wakeup/settings.ts');
const wakeupInvocation = new SourceExtractor('src/wakeup/invocation-log.ts');
const snapshot = new SourceExtractor('src/ui/sidebar/snapshot.ts');

const packageJson = JSON.parse(readText('package.json'));
const settingsProperties = packageJson.contributes.configuration.properties;
const settings = Object.keys(settingsProperties)
  .sort()
  .map((key) => settingsPropertyFromPackage(key, settingsProperties[key]));

const commandTypes = sidebar.stringArray('COMMAND_TYPES');
const hostMessageTypes = sidebar.stringArray('HOST_MESSAGE_TYPES');
const auditEventTypes = audit.stringArray('ALL_AUDIT_EVENT_TYPES');
const queueStatuses = queueSnapshot.stringArray('QUEUE_STATUS');
const featureRequestStatuses = featureRequest.stringUnion('FeatureRequestStatus');
const workflowRunStatuses = state.stringUnion('WorkflowRunStatus');
const manualPauseCauses = state.stringUnion('ManualPauseCause');
const delayedRetryCauses = state.stringUnion('DelayedRetryCause');
const wakeupModels = wakeupSettings.stringArray('WAKEUP_SUPPORTED_MODELS');
const runnerDefaultModel = wakeupSettings.stringConst('RUNNER_DEFAULT_MODEL');
const schedulerTypes = wakeupSettings.stringUnion('SchedulerType');
const wakeupRejectReasons = wakeupSettings.stringUnion('WakeUpRejectReason');
const wakeupAttemptStatuses = wakeupInvocation.stringUnion('WakeUpAttemptStatus');
const wakeupTriggerSources = wakeupInvocation.stringUnion('WakeUpTriggerSource');

const schemas = {
  'src/contracts/generated/schemas/sidebar-ipc.schema.json': makeSchema(
    'sidebar-ipc',
    'Schegent Sidebar IPC Contract',
    ['src/contracts/sidebar-ipc.ts'],
    {
      schemaVersion: { type: 'integer', const: sidebar.numberConst('SCHEMA_VERSION') },
      commandTypes: enumProperty(commandTypes),
      hostMessageTypes: enumProperty(hostMessageTypes),
      workflowSnapshotFields: interfaceProperty(snapshot.interfaceProperties('WorkflowSnapshot'))
    }
  ),
  'src/contracts/generated/schemas/audit-events.schema.json': makeSchema(
    'audit-events',
    'Schegent Audit Event Contract',
    ['src/contracts/audit-events.ts'],
    {
      auditSchemaVersion: { type: 'integer', const: audit.numberConst('AUDIT_SCHEMA_VERSION') },
      auditEventTypes: enumProperty(auditEventTypes),
      unknownAuditEventPolicy: {
        type: 'string',
        const: 'warn-and-preserve'
      }
    }
  ),
  'src/contracts/generated/schemas/settings.schema.json': makeSchema(
    'settings',
    'Schegent Settings Contract',
    ['package.json', 'src/config/settings-schema.ts'],
    {
      settings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'type', 'default', 'scope', 'enum', 'minimum', 'maximum', 'pattern', 'itemType', 'itemPattern'],
          properties: {
            key: { type: 'string' },
            type: { type: 'string' },
            default: {},
            scope: { type: 'string' },
            enum: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
            minimum: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            maximum: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            pattern: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            itemType: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            itemPattern: { anyOf: [{ type: 'string' }, { type: 'null' }] }
          }
        },
        default: settings
      }
    }
  ),
  'src/contracts/generated/schemas/queue.schema.json': makeSchema(
    'queue',
    'Schegent Queue Contract',
    ['src/contracts/queue-snapshot.ts', 'src/queue/feature-request.ts'],
    {
      queueStatuses: enumProperty(queueStatuses),
      featureRequestStatuses: enumProperty(featureRequestStatuses),
      featureRequestFields: interfaceProperty(featureRequest.interfaceProperties('FeatureRequest')),
      queueStateFields: interfaceProperty(featureRequest.interfaceProperties('QueueState'))
    }
  ),
  'src/contracts/generated/schemas/state.schema.json': makeSchema(
    'state',
    'Schegent Workflow State Contract',
    ['src/contracts/state-schema.ts', 'src/state/workflow-run.ts'],
    {
      stateSchemaVersion: { type: 'integer', const: stateSchema.numberConst('STATE_SCHEMA_VERSION') },
      workflowRunStatuses: enumProperty(workflowRunStatuses),
      manualPauseCauses: enumProperty(manualPauseCauses),
      delayedRetryCauses: enumProperty(delayedRetryCauses),
      workflowRunFields: interfaceProperty(state.interfaceProperties('WorkflowRun'))
    }
  ),
  'src/contracts/generated/schemas/backend-runner.schema.json': makeSchema(
    'backend-runner',
    'Schegent Backend Runner Contract',
    ['src/contracts/backend-runner.ts', 'src/runner/invocation-result.ts'],
    {
      invocationRequestFields: interfaceProperty(runner.interfaceProperties('InvocationRequest')),
      rawInvocationOutputFields: interfaceProperty(runner.interfaceProperties('RawInvocationOutput'))
    }
  ),
  'src/contracts/generated/schemas/wakeup.schema.json': makeSchema(
    'wakeup',
    'Schegent Wake-up Contract',
    ['src/wakeup/settings.ts', 'src/wakeup/invocation-log.ts'],
    {
      supportedModels: enumProperty(wakeupModels),
      runnerDefaultModel: { type: 'string', const: runnerDefaultModel },
      schedulerTypes: enumProperty(schedulerTypes),
      rejectReasons: enumProperty(wakeupRejectReasons),
      triggerSources: enumProperty(wakeupTriggerSources),
      attemptStatuses: enumProperty(wakeupAttemptStatuses),
      wakeUpSettingsFields: interfaceProperty(wakeupSettings.interfaceProperties('WakeUpSettings')),
      invocationRecordFields: interfaceProperty(wakeupInvocation.interfaceProperties('InvocationRecord'))
    }
  )
};

const contractFamilies = [
  {
    family: 'sidebar-ipc',
    status: 'generated',
    description: 'Webview commands, acknowledgements, host push message literals, and snapshot field names.',
    sourceFiles: ['src/contracts/sidebar-ipc.ts', 'src/ui/sidebar/snapshot.ts'],
    schemaFiles: ['src/contracts/generated/schemas/sidebar-ipc.schema.json'],
    typescriptBinding: 'src/contracts/generated/boundary-contracts.ts',
    reviewPolicy: 'Regenerate and review literal diffs with every IPC contract change.'
  },
  {
    family: 'settings',
    status: 'generated',
    description: 'Schegent configuration keys and contribution constraints.',
    sourceFiles: ['package.json', 'src/config/settings-schema.ts'],
    schemaFiles: ['src/contracts/generated/schemas/settings.schema.json'],
    typescriptBinding: 'src/contracts/generated/boundary-contracts.ts',
    reviewPolicy: 'Regenerate after adding or changing any schegent.* setting.'
  },
  {
    family: 'queue',
    status: 'generated',
    description: 'Queue snapshot and persisted feature request status literals.',
    sourceFiles: ['src/contracts/queue-snapshot.ts', 'src/queue/feature-request.ts'],
    schemaFiles: ['src/contracts/generated/schemas/queue.schema.json'],
    typescriptBinding: 'src/contracts/generated/boundary-contracts.ts',
    reviewPolicy: 'Regenerate when queue status or feature request fields change.'
  },
  {
    family: 'workflow-state',
    status: 'generated',
    description: 'Workflow run status, pause causes, retry causes, and state schema version.',
    sourceFiles: ['src/contracts/state-schema.ts', 'src/state/workflow-run.ts'],
    schemaFiles: ['src/contracts/generated/schemas/state.schema.json'],
    typescriptBinding: 'src/contracts/generated/boundary-contracts.ts',
    reviewPolicy: 'Regenerate with every persisted workflow state shape change.'
  },
  {
    family: 'audit-events',
    status: 'generated',
    description: 'Structured audit event literals and audit schema version.',
    sourceFiles: ['src/contracts/audit-events.ts'],
    schemaFiles: ['src/contracts/generated/schemas/audit-events.schema.json'],
    typescriptBinding: 'src/contracts/generated/boundary-contracts.ts',
    reviewPolicy: 'Regenerate with every audit taxonomy change; unknown events must remain warn-and-preserve.'
  },
  {
    family: 'backend-runner',
    status: 'generated',
    description: 'Backend runner request and raw invocation result field names.',
    sourceFiles: ['src/contracts/backend-runner.ts', 'src/runner/invocation-result.ts'],
    schemaFiles: ['src/contracts/generated/schemas/backend-runner.schema.json'],
    typescriptBinding: 'src/contracts/generated/boundary-contracts.ts',
    reviewPolicy: 'Regenerate with every runner request/result boundary change.'
  },
  {
    family: 'wakeup',
    status: 'generated',
    description: 'Wake-up settings, model literals, invocation record fields, and trigger/status literals.',
    sourceFiles: ['src/wakeup/settings.ts', 'src/wakeup/invocation-log.ts'],
    schemaFiles: ['src/contracts/generated/schemas/wakeup.schema.json'],
    typescriptBinding: 'src/contracts/generated/boundary-contracts.ts',
    reviewPolicy: 'Regenerate with every wake-up settings or invocation-log boundary change.'
  },
  {
    family: 'raw-transcript-bytes',
    status: 'typescript-only',
    description: 'Unredacted raw transcript sink bytes under .schegent/sessions/raw-<runId>.log.',
    sourceFiles: ['src/audit/raw-transcript-writer.ts'],
    schemaFiles: [],
    typescriptBinding: null,
    reviewPolicy: 'Do not generate UI-facing schemas for raw transcript bytes.',
    exclusionReason: 'Sink-only unredacted bytes are intentionally never surfaced to UI or generated cross-release schemas.'
  }
];

const tsBinding = `// AUTO-GENERATED by scripts/generate-contract-schemas.mjs. Do not edit by hand.\n`
  + `// Run npm run contracts:generate from repo/ to refresh.\n\n`
  + `export const GENERATED_CONTRACT_SCHEMA_VERSION = ${GENERATED_SCHEMA_VERSION} as const;\n\n`
  + `export const SIDEBAR_COMMAND_TYPES = ${tsLiteral(commandTypes)} as const;\n\n`
  + `export const HOST_MESSAGE_TYPES = ${tsLiteral(hostMessageTypes)} as const;\n\n`
  + `export const AUDIT_EVENT_TYPES = ${tsLiteral(auditEventTypes)} as const;\n\n`
  + `export const SETTINGS_KEYS = ${tsLiteral(settings.map((entry) => entry.key))} as const;\n\n`
  + `export const QUEUE_STATUSES = ${tsLiteral(queueStatuses)} as const;\n\n`
  + `export const FEATURE_REQUEST_STATUSES = ${tsLiteral(featureRequestStatuses)} as const;\n\n`
  + `export const WORKFLOW_RUN_STATUSES = ${tsLiteral(workflowRunStatuses)} as const;\n\n`
  + `export const WAKEUP_SUPPORTED_MODELS = ${tsLiteral(wakeupModels)} as const;\n\n`
  + `export const RUNNER_DEFAULT_MODEL = ${JSON.stringify(runnerDefaultModel)} as const;\n\n`
  + `export const CONTRACT_FAMILIES = ${tsLiteral(contractFamilies)} as const;\n`;

const generated = new Map([
  ['src/contracts/generated/boundary-contracts.ts', tsBinding],
  ['src/contracts/generated/schemas/contract-families.json', json({
    generatedBy: 'scripts/generate-contract-schemas.mjs',
    generatedSchemaVersion: GENERATED_SCHEMA_VERSION,
    families: contractFamilies
  })],
  ...Object.entries(schemas).map(([relativePath, schema]) => [relativePath, json(schema)])
]);

const failures = [];
for (const [relativePath, content] of generated) {
  failures.push(...writeOrCheck(relativePath, content));
}

if (failures.length > 0) {
  console.error('Generated contract artifacts are stale.');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error('Run: npm run contracts:generate');
  process.exit(1);
}

if (!CHECK_ONLY) {
  console.log(`Generated ${generated.size} contract artifact(s).`);
}
