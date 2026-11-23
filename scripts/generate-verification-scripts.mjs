/**
 * FR-R7-08 — Generates and verifies the seven aggregate verification scripts in
 * `repo/package.json` from the single machine-readable declaration in
 * `repo/scripts/verification-steps.json`.
 *
 * Modes:
 *   - Default (write): validates the step list, computes the seven aggregate
 *     script bodies, and rewrites ONLY those seven entries in `package.json`.
 *   - `--check`: performs the same validation and compares generated entries
 *     plus declared step commands against `package.json`, exiting 1 on drift.
 *
 * Independent proof boundary (FR-004): `tests/lint/verification-tiers.test.ts`
 * reads `package.json` directly and MUST NOT import this module or the step list.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { invokedAsScript } from './invoked-as-script.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const STEPS_PATH = resolve(ROOT, 'scripts', 'verification-steps.json');
export const PACKAGE_JSON_PATH = resolve(ROOT, 'package.json');

export const GENERATED_AGGREGATES = Object.freeze([
  'verify:edit',
  'verify:push',
  'verify:release',
  'verify:all',
  'ci:fast',
  'ci',
  'gate'
]);

const EXPECTED_TIERS = ['gates', 'edit', 'push', 'release'];
const TIER_ORDER = new Map(EXPECTED_TIERS.map((tier, index) => [tier, index]));
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/;
const FORBIDDEN_CACHE_FLAGS = ['--cache', '--no-clean', 'if [ -d dist', 'skip-build'];
const REPORT_ONLY_SCRIPTS = new Set(['review:due', 'security:advisory-diff']);
const NPM_RUN_PATTERN = /npm run ([\w:-]+)/g;

/**
 * Loads `repo/scripts/verification-steps.json`.
 */
export function loadStepList(path = STEPS_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Expands a single aggregate definition into its ordered list of direct `npm run`
 * targets (one level deep).
 */
function directTargetsOf(agg) {
  if (agg.kind === 'tier') {
    return [agg.extends, ...agg.extraSteps];
  }
  if (agg.kind === 'composite') {
    return [...agg.steps];
  }
  throw new Error(`Unknown aggregate kind: ${String(agg.kind)}`);
}

/**
 * Generates the seven aggregate script strings from `spec`.
 */
export function generateAggregateScripts(spec) {
  const out = Object.create(null);
  const aggregates = spec.aggregates;
  for (const name of GENERATED_AGGREGATES) {
    if (!aggregates || !Object.hasOwn(aggregates, name)) {
      throw new Error(`verification-steps.json is missing aggregate "${name}"`);
    }
    const agg = aggregates[name];
    const targets = directTargetsOf(agg);
    for (const target of targets) {
      if (typeof target !== 'string' || !SAFE_SCRIPT_NAME.test(target)) {
        throw new Error(`aggregate "${name}" contains unsafe target name "${String(target)}"`);
      }
    }
    out[name] = targets.map((target) => `npm run ${target}`).join(' && ');
  }
  return out;
}

/**
 * Collects every script name transitively reached from `entry` in execution order,
 * using `scripts` for command expansion.
 */
function expandOrder(entry, scripts, reportCycle, ancestors = []) {
  const out = [];
  if (ancestors.includes(entry)) {
    reportCycle([...ancestors, entry]);
    return out;
  }
  const path = [...ancestors, entry];
  out.push(entry);
  const body = Object.hasOwn(scripts, entry) ? scripts[entry] : undefined;
  if (typeof body !== 'string') return out;
  for (const match of body.matchAll(NPM_RUN_PATTERN)) {
    const target = match[1];
    if (target) out.push(...expandOrder(target, scripts, reportCycle, path));
  }
  return out;
}

/**
 * Validates `spec` structurally and against `manifestScripts`.
 * Returns an array of error strings (empty when valid).
 */
export function validateStepList(spec, manifestScripts) {
  const errors = [];

  if (!spec || spec.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1 (got ${String(spec?.schemaVersion)})`);
    return errors;
  }

  if (
    !Array.isArray(spec.tiers) ||
    spec.tiers.length !== EXPECTED_TIERS.length ||
    spec.tiers.some((t, i) => t !== EXPECTED_TIERS[i])
  ) {
    errors.push(`tiers must equal ${JSON.stringify(EXPECTED_TIERS)}`);
  }

  const tierSet = new Set(EXPECTED_TIERS);
  const stepsByName = new Map();

  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    errors.push('steps must be a non-empty array');
    return errors;
  }

  for (const step of spec.steps) {
    if (!step || typeof step.name !== 'string' || step.name.trim() === '') {
      errors.push('step entry is missing a non-empty name');
      continue;
    }
    if (!SAFE_SCRIPT_NAME.test(step.name)) {
      errors.push(`step "${step.name}" has unsafe script name (allowed: [A-Za-z0-9:_-]+)`);
      continue;
    }
    if (stepsByName.has(step.name)) {
      errors.push(`duplicate step name "${step.name}"`);
    }
    stepsByName.set(step.name, step);

    if (typeof step.command !== 'string' || step.command.trim() === '') {
      errors.push(`step "${step.name}" must declare a non-empty command`);
    }
    if (!tierSet.has(step.firstTier)) {
      errors.push(`step "${step.name}" has invalid firstTier "${String(step.firstTier)}"`);
    }
    if (typeof step.requiresWebviewBuild !== 'boolean') {
      errors.push(`step "${step.name}" must declare boolean requiresWebviewBuild`);
    }
    if (REPORT_ONLY_SCRIPTS.has(step.name)) {
      errors.push(`report-only script "${step.name}" must not appear in verification-steps.json`);
    }
    for (const flag of FORBIDDEN_CACHE_FLAGS) {
      if (typeof step.command === 'string' && step.command.includes(flag)) {
        errors.push(`step "${step.name}" contains forbidden build-cache marker "${flag}"`);
      }
    }
    if (manifestScripts) {
      const actual = Object.hasOwn(manifestScripts, step.name)
        ? manifestScripts[step.name]
        : undefined;
      if (actual === undefined) {
        errors.push(`step "${step.name}" is missing from package.json scripts`);
      } else if (actual !== step.command) {
        errors.push(
          `step "${step.name}" command in package.json drifted from verification-steps.json ` +
            `(expected "${step.command}", actual "${actual}")`
        );
      }
    }
  }

  const aggregateNames = new Set(Object.keys(spec.aggregates ?? {}));
  for (const required of GENERATED_AGGREGATES) {
    if (!aggregateNames.has(required)) {
      errors.push(`missing required aggregate "${required}"`);
    }
  }
  for (const extra of aggregateNames) {
    if (!GENERATED_AGGREGATES.includes(extra)) {
      errors.push(`unexpected aggregate "${extra}" outside GENERATED_AGGREGATES`);
    }
  }

  if (errors.length > 0) return errors;

  const generated = generateAggregateScripts(spec);
  const combinedScripts = Object.create(null);
  for (const [name, step] of stepsByName) {
    combinedScripts[name] = step.command;
  }
  for (const [name, body] of Object.entries(generated)) {
    combinedScripts[name] = body;
  }

  const orders = new Map();
  const readOrder = (entry) => expandOrder(entry, combinedScripts, (path) => {
    errors.push(`recursive verification script chain: ${path.join(' → ')}`);
  });

  // Every target referenced by an aggregate must be a declared step or aggregate.
  for (const aggName of GENERATED_AGGREGATES) {
    const agg = spec.aggregates[aggName];
    for (const target of directTargetsOf(agg)) {
      if (typeof target !== 'string' || !SAFE_SCRIPT_NAME.test(target)) {
        errors.push(`aggregate "${aggName}" has unsafe target name "${String(target)}"`);
      } else if (REPORT_ONLY_SCRIPTS.has(target)) {
        errors.push(`aggregate "${aggName}" references report-only script "${target}"`);
      } else if (!stepsByName.has(target) && !aggregateNames.has(target)) {
        errors.push(`aggregate "${aggName}" references undeclared target "${target}"`);
      }
    }

    // Enforce requiresWebviewBuild ordering in every generated aggregate.
    const order = readOrder(aggName);
    orders.set(aggName, order);
    const buildIdx = order.indexOf('build:webview');
    for (let idx = 0; idx < order.length; idx += 1) {
      const step = stepsByName.get(order[idx]);
      if (step?.requiresWebviewBuild && (buildIdx === -1 || buildIdx > idx)) {
        errors.push(
          `aggregate "${aggName}" runs "${step.name}" (requiresWebviewBuild: true) without an earlier build:webview`
        );
      }
    }
  }

  // Every step whose firstTier is T must be reached by the tier aggregate for T,
  // and no tier aggregate may reach a step whose firstTier is strictly higher than T.
  const tierToScript = {
    gates: 'test:gates',
    edit: 'verify:edit',
    push: 'verify:push',
    release: 'verify:release'
  };
  for (const tier of EXPECTED_TIERS) {
    const entry = tierToScript[tier];
    const reached = new Set(orders.get(entry) ?? readOrder(entry));
    const currentRank = TIER_ORDER.get(tier) ?? 0;
    for (const step of spec.steps) {
      if (step.firstTier === tier && !reached.has(step.name)) {
        errors.push(
          `step "${step.name}" declares firstTier "${tier}" but "${entry}" does not reach it`
        );
      }
      const stepRank = TIER_ORDER.get(step.firstTier) ?? 0;
      if (reached.has(step.name) && stepRank > currentRank) {
        errors.push(
          `tier "${tier}" ("${entry}") reaches "${step.name}" whose firstTier is "${step.firstTier}"`
        );
      }
    }
  }

  return errors;
}

/**
 * Checks that `manifestScripts` matches the generated aggregate scripts and
 * declared step commands in `spec`.
 */
export function checkManifestParity(spec, manifestScripts) {
  const errors = validateStepList(spec, manifestScripts);
  const drifted = [];
  let generated = {};
  try {
    generated = generateAggregateScripts(spec);
  } catch (err) {
    return { ok: false, errors: [...errors, err instanceof Error ? err.message : String(err)], drifted };
  }

  for (const name of GENERATED_AGGREGATES) {
    const expected = generated[name];
    const actual = Object.hasOwn(manifestScripts, name) ? manifestScripts[name] : undefined;
    if (actual !== expected) {
      drifted.push({ name, expected, actual });
    }
  }

  return {
    ok: errors.length === 0 && drifted.length === 0,
    errors,
    drifted
  };
}

/**
 * Rewrites ONLY the seven generated aggregate entries in `packageJsonText` via
 * targeted replacement inside the `"scripts"` block, preserving all unrelated
 * entries, key order, unicode escapes (`\u2014`, `\u2192`), and whitespace verbatim.
 */
export function applyGeneratedScripts(packageJsonText, generated) {
  JSON.parse(packageJsonText);
  const source = ts.parseJsonText('package.json', packageJsonText);
  const root = source.statements[0];
  const manifest = root && ts.isExpressionStatement(root) ? root.expression : undefined;
  const propertiesNamed = (object, name) => object.properties.filter(
    (property) => ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) && property.name.text === name
  );
  const scripts = manifest && ts.isObjectLiteralExpression(manifest)
    ? propertiesNamed(manifest, 'scripts')
    : [];
  const scriptObject = scripts[0]?.initializer;
  if (scripts.length !== 1 || !scriptObject || !ts.isObjectLiteralExpression(scriptObject)) {
    throw new Error('Expected exactly one top-level scripts object in package.json');
  }

  const edits = [];
  for (const name of GENERATED_AGGREGATES) {
    if (!Object.hasOwn(generated, name)) continue;
    const entries = propertiesNamed(scriptObject, name);
    const value = entries[0]?.initializer;
    if (entries.length !== 1 || !value || !ts.isStringLiteral(value)) {
      throw new Error(`Expected exactly one string entry for "${name}" in package.json scripts`);
    }
    edits.push({ start: value.getStart(source), end: value.getEnd(), text: JSON.stringify(generated[name]) });
  }

  let updated = packageJsonText;
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, start) + text + updated.slice(end);
  }
  return updated;
}

if (invokedAsScript(import.meta.url)) {
  const checkMode = process.argv.includes('--check');
  const spec = loadStepList();
  const pkgText = readFileSync(PACKAGE_JSON_PATH, 'utf8');
  const pkg = JSON.parse(pkgText);
  const manifestScripts = pkg.scripts ?? {};

  if (checkMode) {
    const result = checkManifestParity(spec, manifestScripts);
    if (!result.ok) {
      for (const err of result.errors) {
        console.error(`verification-scripts: ${err}`);
      }
      for (const item of result.drifted) {
        console.error(
          `verification-scripts: "${item.name}" in package.json drifted from scripts/verification-steps.json.\n` +
            `  expected: ${item.expected}\n` +
            `  actual:   ${String(item.actual)}`
        );
      }
      console.error('Run `node scripts/generate-verification-scripts.mjs` to regenerate.');
      process.exit(1);
    }
    console.log(
      `verification-scripts: ok (${GENERATED_AGGREGATES.length} generated aggregates and ${spec.steps.length} steps match).`
    );
    process.exit(0);
  }

  const validationErrors = validateStepList(spec, manifestScripts);
  if (validationErrors.length > 0) {
    for (const err of validationErrors) {
      console.error(`verification-scripts: ${err}`);
    }
    process.exit(1);
  }
  const generated = generateAggregateScripts(spec);
  const nextText = applyGeneratedScripts(pkgText, generated);
  if (nextText !== pkgText) {
    writeFileSync(PACKAGE_JSON_PATH, nextText, 'utf8');
    console.log(
      `verification-scripts: updated ${GENERATED_AGGREGATES.length} aggregate scripts in package.json.`
    );
  } else {
    console.log('verification-scripts: package.json is already up to date.');
  }
}
