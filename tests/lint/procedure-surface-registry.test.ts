// FR-R3-088, follow-up (b) — a registry of procedure surfaces, replacing two
// single-instance doc-contradiction gates.
//
// THE CLASS. `user-quickstart.md` instructed F5 → **Run Extension** while the
// `developer-setup.md` it names as its prerequisite stated, with a verification
// marker, that no such launch configuration existed. The corpus contradicted
// itself in the reader's own path. `launch-procedure-doc-parity.test.ts` closed
// that one pair; `playwright-install-doc-parity.test.ts` closed another. Feature
// 152's own code review filed the shape:
//
//   "the launch-procedure doc gate is the second single-instance
//    doc-contradiction gate — the class-level shape is a registry of procedure
//    surfaces, the pattern `asserted-counts.test.ts` already models."
//
// WHAT A REGISTRY BUYS OVER TWO GATES. Two gates means the third contradiction
// needs a third file, and the person who writes the third document does not know
// that. **What is registered is checked, and what is registered is visible.**
// Adding a surface to the table below is what puts it under the gate; nothing
// else is needed, and `registering a surface has effect` proves that.
//
// NOTHING IS LOST IN THE MIGRATION. FR-030 forbids deleting a gate for being
// hard to control; neither deleted gate was hard to control and neither check is
// gone. Each producer's bespoke validation — JSONC parsing for `launch.json`,
// version resolution for the Playwright command — travels with its entry as a
// `verifyProducer` function, because a registry that could only compare fixed
// strings would have had to drop exactly the parts those gates were written for.
//
// IT READS CODE SPANS AND FIXED LITERALS, NEVER PROSE. Carried over verbatim
// from `playwright-install-doc-parity.test.ts`, whose reasoning has not changed:
// a gate that reads prose pressures authors to write worse prose.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

/** A document pair (or set) that must agree about one procedure. */
interface ProcedureSurface {
  /** Stable id, used in failure messages. */
  readonly id: string;
  /** The artifact the documents describe. */
  readonly producer: string;
  /** Documents that must agree about it. */
  readonly surfaces: readonly string[];
  /** Fixed strings every surface must contain. Never prose. */
  readonly literals: readonly string[];
  /** Strings no surface may contain — the contradiction, stated. */
  readonly forbidden?: readonly string[];
  /** Why this pair is registered. A reader must be able to act on it. */
  readonly reason: string;
  /** Producer-specific validation, where a fixed string cannot express it. */
  readonly verifyProducer?: (producerSource: string) => void;
}

const REGISTRY: readonly ProcedureSurface[] = [
  {
    id: 'extension-host-launch',
    producer: '.vscode/launch.json',
    surfaces: ['docs/tutorials/user-quickstart.md', 'docs/tutorials/developer-setup.md'],
    literals: ['Run Extension'],
    forbidden: ['no such launch configuration', 'no launch configuration exists'],
    reason:
      'FR-R3-073: the quickstart instructed F5 -> Run Extension while its own stated ' +
      'prerequisite asserted the configuration did not exist',
    verifyProducer: (source) => {
      // launch.json is JSONC (VS Code allows comments); strip line comments
      // rather than adding a JSONC dependency for a gate.
      const raw = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      const parsed = JSON.parse(raw) as {
        configurations?: ReadonlyArray<{ name?: string; type?: string; request?: string }>;
      };
      const configuration = (parsed.configurations ?? []).find(
        (candidate) => candidate.name === 'Run Extension'
      );
      expect(
        configuration,
        '.vscode/launch.json must define a configuration named "Run Extension" — it is the ' +
          'procedure the quickstart instructs; removing it re-creates the contradiction'
      ).toBeDefined();
      expect(configuration?.type).toBe('extensionHost');
      expect(configuration?.request).toBe('launch');
    }
  },
  {
    id: 'playwright-browser-install',
    producer: 'scripts/check-playwright-browser.mjs',
    surfaces: ['docs/tutorials/developer-setup.md', 'CONTRIBUTING.md'],
    literals: ['playwright install'],
    reason:
      'the preflight and the setup documents must offer the same install command; a ' +
      'documented command the preflight does not recognise sends a contributor in a circle',
    verifyProducer: (source) => {
      // The preflight declares the command it offers; the documents must offer
      // the same one. Comparing against the DECLARED command rather than
      // against what is installed on this machine — the manifest is the
      // contract, and `npm ci` is the remedy for a tree out of step with it.
      const constant = /const INSTALL_COMMAND = '([^']+)'/.exec(source);
      expect(
        constant,
        'scripts/check-playwright-browser.mjs must declare INSTALL_COMMAND — it is what the ' +
          'documents are held to'
      ).not.toBeNull();
      expect((constant as RegExpExecArray)[1]).toContain('playwright install');
    }
  }
];

/** Code spans only — a gate that reads prose pressures authors to write worse prose. */
const codeSpans = (source: string): string =>
  [...source.matchAll(/`([^`]+)`/g), ...source.matchAll(/```[\w]*\n([\s\S]*?)```/g)]
    .map((match) => match[1] as string)
    .join('\n');

/** The shared check. Everything a registry entry means, in one place. */
function checkSurface(entry: ProcedureSurface, load: (path: string) => string): void {
  if (entry.verifyProducer) entry.verifyProducer(load(entry.producer));
  for (const surface of entry.surfaces) {
    const source = load(surface);
    const spans = codeSpans(source);
    for (const literal of entry.literals) {
      expect(
        `${spans}\n${source}`.includes(literal),
        `${entry.id}: ${surface} must state '${literal}' — ${entry.reason}`
      ).toBe(true);
    }
    for (const forbidden of entry.forbidden ?? []) {
      expect(
        source.toLowerCase().includes(forbidden.toLowerCase()),
        `${entry.id}: ${surface} still asserts '${forbidden}', contradicting ${entry.producer}`
      ).toBe(false);
    }
  }
}

describe('FR-R3-088 — registered procedure surfaces agree with their producer', () => {
  it('the registry is non-empty and every entry carries a reason a reader can act on', () => {
    // The rule applied to the rule: an empty registry would report perfect
    // compliance over nothing, which is the shape this tier exists to forbid.
    expect(REGISTRY.length).toBeGreaterThanOrEqual(2);
    for (const entry of REGISTRY) {
      expect(entry.surfaces.length, `${entry.id} must register at least two surfaces`).toBeGreaterThan(1);
      expect(entry.reason.length, `${entry.id} needs a reason`).toBeGreaterThan(40);
    }
  });

  it.each(REGISTRY.map((entry) => [entry.id, entry] as const))(
    '%s: every registered surface agrees with the producer',
    (_id, entry) => {
      checkSurface(entry, read);
    }
  );

  it('the two single-instance gates this replaces are gone, and their checks are not', () => {
    // A migration, not a removal (FR-030). Both producers and every surface each
    // gate covered are registered above; the deletion is only of the two files.
    const registeredProducers = REGISTRY.map((entry) => entry.producer);
    expect(registeredProducers).toContain('.vscode/launch.json');
    expect(registeredProducers).toContain('scripts/check-playwright-browser.mjs');
    const registeredSurfaces = REGISTRY.flatMap((entry) => entry.surfaces);
    expect(registeredSurfaces).toContain('docs/tutorials/user-quickstart.md');
    expect(registeredSurfaces).toContain('docs/tutorials/developer-setup.md');
  });

  it('NON-VACUITY: registering a surface is what makes it checked', () => {
    // A third entry, checked against an in-memory corpus rather than the tree,
    // so the proof needs no permanent third surface. Disagree -> red; agree ->
    // green. Both directions, which is what makes this a control rather than a
    // demonstration.
    const third: ProcedureSurface = {
      id: 'probe',
      producer: 'probe/producer.json',
      surfaces: ['probe/a.md', 'probe/b.md'],
      literals: ['Do The Thing'],
      forbidden: ['there is no such thing'],
      reason: 'a registered probe proving that registration is what puts a surface under the gate'
    };

    const agreeing = new Map([
      ['probe/producer.json', '{}'],
      ['probe/a.md', 'Run `Do The Thing` to start.'],
      ['probe/b.md', 'Its prerequisite is `Do The Thing`.']
    ]);
    expect(() => checkSurface(third, (path) => agreeing.get(path) as string)).not.toThrow();

    const contradicting = new Map(agreeing);
    contradicting.set('probe/b.md', 'There is no such thing as `Do The Thing`.');
    expect(() => checkSurface(third, (path) => contradicting.get(path) as string)).toThrow();

    const missing = new Map(agreeing);
    missing.set('probe/a.md', 'Run something else entirely.');
    expect(() => checkSurface(third, (path) => missing.get(path) as string)).toThrow();

    // And an UNREGISTERED surface is not checked at all — which is the other
    // half of "what is registered is checked".
    const unregistered = { ...third, surfaces: ['probe/a.md'] };
    expect(() => checkSurface(unregistered, (path) => contradicting.get(path) as string)).not.toThrow();
  });
});
