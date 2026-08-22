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


/**
 * FR-R3-035 — the webview copies of the expression sandbox and the fatal-signature
 * registry are emitted from their host originals rather than maintained beside them.
 *
 * Threat T11 names `src/lib/retry-condition.ts` as the sole entry point for
 * evaluating operator expressions. It existed twice, and parity was inferred from
 * byte equality by a test whose own header recorded that it could not import the
 * webview source across the CJS/ESM line. The host copy is authoritative at run
 * time, so webview-only drift is a UX defect; the dangerous direction is the
 * reverse — a fix applied to the mirror, or an edit made to whichever copy the
 * editor opened first. Generation makes that impossible rather than discouraged.
 *
 * The two files do NOT have the same relationship, and treating them alike would
 * be a regression:
 *
 *   * `retry-condition.ts` is a genuine full-file mirror. It imports nothing, so
 *     the host source is emitted verbatim under a generated banner.
 *   * `fatal-signature-registry.ts` is a deliberate PROJECTION. The host is 253
 *     lines; the webview carries the shared type declarations and the
 *     `SIGNATURE_STREAMS` literal and none of the matching or classification
 *     logic. Emitting the whole host file would drag host-only logic into the
 *     webview bundle.
 *
 * The banner is produced here rather than hand-maintained. A hand-written banner
 * is exactly the kind of delta that makes byte equality brittle — it was the
 * four-line difference the previous parity test had to special-case.
 */
function generatedBanner(sourcePath) {
  return [
    '// GENERATED FILE — do not edit.',
    `//`,
    `// Emitted from ${sourcePath} by scripts/generate-contract-schemas.mjs.`,
    '// Edit the source and run: npm run contracts:generate',
    '//',
    '// `npm run contracts:check` (the first target of verify:all) fails when this',
    '// file and its source disagree, so a fix applied here alone cannot ship.',
    ''
  ].join('\n');
}

/** The host file verbatim, under a generated banner. */
function mirrorWholeFile(sourcePath) {
  const source = readText(sourcePath).replace(/\r\n/g, '\n');
  return `${generatedBanner(sourcePath)}\n${source.replace(/\n+$/, '')}\n`;
}

/**
 * The shared slice of the fatal-signature registry, selected from the AST by
 * declaration name rather than by scanning the text for punctuation.
 *
 * The first version located the end of the `FATAL_SIGNATURES` statement with
 * `indexOf(';', indexOf(')', anchor))`. An ordinary refactor breaks that: give
 * the `.map()` callback a block body and the first `)` belongs to the arrow's
 * parameter list while the first `;` belongs to a statement inside it, so the
 * slice ends mid-declaration and the generator writes syntactically invalid
 * TypeScript while reporting success.
 *
 * `contracts:check` does not catch that, and the reason is worth stating because
 * it applies to every generated artifact here: the check compares a file to a
 * fresh regeneration of itself. Corruption that is deterministic is therefore
 * *stable*, and stable output is exactly what the check calls correct. Staleness
 * and validity are different properties, and only the first was ever being
 * verified. `assertParses` below closes that gap.
 *
 * Selecting whole top-level statements by name also fixes a second problem the
 * text slice had: anything a future edit inserts between the two anchors — a
 * host-only helper, an import — was swept into the projection by position.
 * Nothing between them is copied now, only what is named.
 */
const FATAL_SIGNATURE_PROJECTION = Object.freeze([
  'FatalSignature',
  'FatalStream',
  'BOTH_STREAMS',
  'STDERR_ONLY',
  'FatalSignatureSpec',
  'SIGNATURE_STREAMS',
  'FATAL_SIGNATURES'
]);

/** The declared name of a top-level statement, or null if it has none. */
function declaredName(statement) {
  if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
    return statement.name.text;
  }
  if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations[0];
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
  }
  return null;
}

function projectFatalSignatures(sourcePath) {
  const text = readText(sourcePath).replace(/\r\n/g, '\n');
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);

  const byName = new Map();
  for (const statement of source.statements) {
    const name = declaredName(statement);
    if (name !== null) byName.set(name, statement);
  }

  const missing = FATAL_SIGNATURE_PROJECTION.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${sourcePath}: cannot project ${missing.join(', ')} — no top-level declaration with that ` +
        `name. The projection names what it copies; if a declaration was renamed, rename it in ` +
        `FATAL_SIGNATURE_PROJECTION rather than widening the selection.`
    );
  }

  // Emitted in source order, each statement with its leading comments, so the
  // projection reads like the region it comes from.
  const chosen = FATAL_SIGNATURE_PROJECTION.map((name) => byName.get(name)).sort(
    (a, b) => a.getStart(source, true) - b.getStart(source, true)
  );
  const shared = chosen
    .map((statement) => text.slice(statement.getStart(source, true), statement.getEnd()))
    .join('\n\n');

  const note = [
    '// This is a PROJECTION, not a whole-file mirror: the host module also owns',
    '// the matching and classification surface (FatalSource, EffectiveSignature,',
    '// FatalMatch, and the classifier), which the webview does not need and must',
    '// not carry. Only the declarations named in FATAL_SIGNATURE_PROJECTION appear',
    '// here, selected from the AST by name — not sliced out of a text range.',
    ''
  ].join('\n');
  return `${generatedBanner(sourcePath)}${note}\n${shared}\n`;
}

/**
 * Refuse to write TypeScript that does not parse.
 *
 * `contracts:check` verifies that a generated file matches what the generator
 * would emit today. It cannot verify that what the generator emits is *valid*,
 * because deterministic corruption matches itself. This is where that is caught,
 * at the point of generation, rather than several targets later in a typecheck
 * that names a file the author was told never to edit.
 */
/**
 * Refuse to write a schema with nothing in it.
 *
 * `assertParses` covers the two TypeScript emissions; the JSON artifacts are
 * `JSON.stringify` output and are valid JSON by construction, which is a weaker
 * guarantee than it looks. The failure this catches is the same class:
 * `contracts:check` compares a file to a regeneration of itself, so a generator
 * that deterministically emits `{}` — an extractor that stopped matching, a
 * renamed source symbol — produces a stable empty schema, and stable output is
 * what the check calls correct.
 *
 * Every schema here declares `properties` and `required` today; a family
 * manifest declares `families`. Emitting one of those empty is not a smaller
 * contract, it is a contract that stopped being derived.
 */
function assertSubstantive(relativePath, content) {
  const parsed = JSON.parse(content);
  const emptyOf = (key) => {
    const value = parsed[key];
    if (value === undefined) return false;
    return (Array.isArray(value) ? value.length : Object.keys(value).length) === 0;
  };
  const degenerate = ['properties', 'required', 'families'].filter(emptyOf);
  if (degenerate.length > 0) {
    throw new Error(
      `refusing to write ${relativePath}: ${degenerate.join(' and ')} came out empty. ` +
        `This is a generator defect, not a source defect — contracts:check cannot catch it, ` +
        `because a deterministically empty schema matches a regeneration of itself.`
    );
  }
  return content;
}

function assertParses(relativePath, content) {
  const parsed = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true);
  const diagnostics = parsed.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const { line } = parsed.getLineAndCharacterOfPosition(first.start ?? 0);
    throw new Error(
      `refusing to write ${relativePath}: the generated TypeScript does not parse ` +
        `(line ${line + 1}: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}). ` +
        `This is a generator defect, not a source defect — contracts:check cannot catch it, ` +
        `because deterministic corruption matches a regeneration of itself.`
    );
  }
  return content;
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
  + `export const CONTRACT_FAMILIES = ${tsLiteral(contractFamilies)} as const;\n`;

const generated = new Map([
  ['src/contracts/generated/boundary-contracts.ts', tsBinding],
  [
    'src/contracts/generated/schemas/contract-families.json',
    assertSubstantive(
      'src/contracts/generated/schemas/contract-families.json',
      json({
        generatedBy: 'scripts/generate-contract-schemas.mjs',
        generatedSchemaVersion: GENERATED_SCHEMA_VERSION,
        families: contractFamilies
      })
    )
  ],
  ...Object.entries(schemas).map(([relativePath, schema]) => [
    relativePath,
    assertSubstantive(relativePath, json(schema))
  ]),
  [
    'webview-ui/src/lib/retry-condition.ts',
    assertParses(
      'webview-ui/src/lib/retry-condition.ts',
      mirrorWholeFile('src/lib/retry-condition.ts')
    )
  ],
  [
    'webview-ui/src/lib/fatal-signature-registry.ts',
    assertParses(
      'webview-ui/src/lib/fatal-signature-registry.ts',
      projectFatalSignatures('src/lib/fatal-signature-registry.ts')
    )
  ]
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
