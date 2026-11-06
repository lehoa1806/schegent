import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R5-F21 (FR-014) -- `npm run review:due` is report-only, and stays outside every chain that
 * gives a verdict.
 *
 * The report lists each dated obligation with the instant it starts failing, and exits 1 when one
 * needs attention. The two lint gates (`held-major-staleness`, `dated-review-records`) are the
 * enforcement. If a gate, a verify tier, the release or the package step ever ran the report, its
 * exit code would become a second verdict on the same dates, one that fails a day earlier than
 * nothing and on obligations (an unregistered marker) the gates judge differently. So no chain may
 * reach it, by script name or by the file it runs.
 *
 * The chains are the fixed verdict scripts plus every `verify:*` script in the manifest, read at
 * run time, so a new tier is covered without editing this file. It is hermetic: nothing is
 * spawned, and a planted manifest proves the assertion can go red.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

const COMMAND = 'review:due';
const ENTRY_FILE = 'review-due-report.mjs';
const COMMAND_BODY = `node scripts/${ENTRY_FILE}`;
/** The verdict scripts named outright; every `verify:*` script is added from the manifest. */
const FIXED_CHAINS = ['gate', 'ci', 'ci:fast', 'release', 'package'] as const;
const VERIFY_PREFIX = 'verify:';
/** The gate composes others; a closure this small would mean the walk returned only its entry. */
const MIN_GATE_CLOSURE = 5;

type ScriptRecord = Readonly<Record<string, string>>;

let reachableScripts: (all: ScriptRecord, entry: string) => readonly string[];

beforeAll(async () => {
  // A computed specifier: the module is `.mjs`, and a literal one from this CommonJS test is TS1479.
  const parity = (await import(
    pathToFileURL(resolve(REPO_ROOT, 'scripts', 'check-gate-coverage-parity.mjs')).href
  )) as Record<string, unknown>;
  reachableScripts = parity['reachableScripts'] as typeof reachableScripts;
});

function realScripts(): ReadonlyMap<string, string> {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: ScriptRecord;
  };
  return new Map(Object.entries(manifest.scripts ?? {}));
}

function chainsOf(scripts: ReadonlyMap<string, string>): string[] {
  const verify = [...scripts.keys()].filter((name) => name.startsWith(VERIFY_PREFIX)).sort();
  return [...FIXED_CHAINS, ...verify];
}

/** Every chain whose closure names the report, by script name or by the file it runs. */
function chainViolations(scripts: ReadonlyMap<string, string>): string[] {
  const record: ScriptRecord = Object.fromEntries(scripts);
  const found: string[] = [];
  for (const chain of chainsOf(scripts)) {
    for (const name of reachableScripts(record, chain)) {
      if (name === COMMAND) found.push(`${chain} reaches the script ${COMMAND}`);
      else if ((scripts.get(name) ?? '').includes(ENTRY_FILE)) {
        found.push(`${chain} reaches ${name}, whose body runs ${ENTRY_FILE}`);
      }
    }
  }
  return found;
}

describe('review:due is report-only', () => {
  it('exists and runs the report script', () => {
    expect(realScripts().get(COMMAND)).toBe(COMMAND_BODY);
  });

  it('walks every chain, and each closure is a real walk rather than an empty one', () => {
    const scripts = realScripts();
    const record: ScriptRecord = Object.fromEntries(scripts);
    const chains = chainsOf(scripts);
    expect(chains.length, 'no verify:* script was found').toBeGreaterThan(FIXED_CHAINS.length);
    for (const chain of chains) {
      expect(scripts.has(chain), `${chain} must exist`).toBe(true);
      expect(reachableScripts(record, chain), chain).toContain(chain);
    }
    expect(reachableScripts(record, 'gate').length).toBeGreaterThan(MIN_GATE_CLOSURE);
  });

  it('finds neither the script name nor its file in any closure', () => {
    expect(chainViolations(realScripts())).toEqual([]);
  });

  it('NON-VACUITY: a gate that runs the command is reported', () => {
    const scripts = new Map(realScripts());
    scripts.set('gate', `${scripts.get('gate') ?? ''} && npm run ${COMMAND}`);
    expect(chainViolations(scripts).some((line) => line.startsWith('gate reaches the script'))).toBe(true);
  });

  it('NON-VACUITY: a verify tier that reaches a helper running the file is reported', () => {
    const scripts = new Map(realScripts());
    const tier = [...scripts.keys()].find((name) => name.startsWith(VERIFY_PREFIX));
    expect(tier, 'no verify:* script to plant into').toBeDefined();
    if (tier === undefined) return;
    scripts.set('planted:helper', COMMAND_BODY);
    scripts.set(tier, `${scripts.get(tier) ?? ''} && npm run planted:helper`);
    expect(chainViolations(scripts)).toContain(`${tier} reaches planted:helper, whose body runs ${ENTRY_FILE}`);
  });
});
