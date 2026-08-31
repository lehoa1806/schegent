import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  UNEXPECTED_MESSAGE_MAX,
  classifyStartFailure
} from '../../src/controller/start-failure-classification';
import { AuditPathRefusedError } from '../../src/audit/audit-log-writer';
import { CapabilityNotEnforceableError } from '../../src/services/capability-refusal';
import { OutputTargetRefusedAtDispatch } from '../../src/services/dispatch-output-guard';
import { UncontainedBackendRefusedError } from '../../src/services/backend-containment-policy';
import { ALL_PHASE_CAPABILITIES } from '../../src/contracts/phase-capabilities';

/**
 * A product-authored refusal whose message outruns the catch-all bound must be
 * classified — the rule `UNEXPECTED_MESSAGE_MAX` states, now checked.
 *
 * WHAT WENT WRONG WITHOUT THIS. `classifyStartFailure` bounds an ARBITRARY throw
 * at 240 characters, correctly: an unexpected error's message is whatever a
 * dependency chose to put in it. Its docblock then exempts the classified shapes
 * "because each is built by this product from constants and each is cut mid-remedy
 * by it" — a precise membership rule, written in prose, checked by nothing.
 *
 * `CapabilityNotEnforceableError` satisfied that rule word for word and was not a
 * member. Every capability refusal that ever fired reached the operator as
 * `workflow … failed unexpectedly`, severed mid-sentence, with the whole remedy
 * ("Widen the phase's capability set, or run it on a backend whose CLI can express
 * the withheld capability") deleted. Its shortest possible message is 370
 * characters, so there was no input for which the cut was harmless.
 *
 * That is the SECOND time this exact defect shipped. FR-R3-146 fixed it for
 * `UncontainedBackendRefusedError` — same bound, same severed remedy, same
 * "failed unexpectedly" — and fixed the instance. This file fixes the class.
 *
 * WHY BEHAVIOURAL AND NOT A SUBSTRING SCAN. The harm is not "a name is missing
 * from a list", it is "this message loses its remedy". So each refusal is
 * constructed and put through the real classifier, and the rule is applied to what
 * comes back. A substring gate would pass a classified type whose branch returned
 * a truncated message.
 */
const SRC = resolve(__dirname, '..', '..', 'src');

/**
 * Every product-authored refusal error, constructed at its WORST case.
 *
 * Worst case, not typical: the bound is a length, so a type is only proved safe by
 * the longest message it can raise. `make` is the widest input each constructor
 * accepts.
 */
const REFUSALS: ReadonlyArray<{ readonly name: string; readonly make: () => Error }> = [
  {
    name: 'UncontainedBackendRefusedError',
    // The real policy message, which is 482 characters at its longest backend id.
    make: () =>
      new UncontainedBackendRefusedError(
        'claude',
        `The 'claude' backend runs without an OS-enforced bound on what it can reach: ` +
          'model-generated actions execute with your local user authority. Add ' +
          "'claude' to 'schegent.backend.uncontainedBackends' to accept that for this " +
          'backend only, or choose a backend that carries a sandbox. The setting is ' +
          'application-scoped, so it applies to every workspace in this installation.'
      )
  },
  {
    name: 'CapabilityNotEnforceableError',
    make: () => new CapabilityNotEnforceableError('claude', [...ALL_PHASE_CAPABILITIES])
  },
  {
    name: 'OutputTargetRefusedAtDispatch',
    make: () => new OutputTargetRefusedAtDispatch('a-long-output-port-id', 'symlink-component')
  },
  {
    name: 'AuditPathRefusedError',
    make: () => new AuditPathRefusedError('symlink-component', 'ELOOP')
  }
];

const identity = (raw: string): string => raw;

describe('a refusal that cannot fit the catch-all bound is classified', () => {
  for (const { name, make } of REFUSALS) {
    it(`${name}: over the bound implies classified, and classified implies untruncated`, () => {
      const err = make();
      const report = classifyStartFailure(err, 'feat-1', identity);
      if (err.message.length <= UNEXPECTED_MESSAGE_MAX) {
        // Short enough that the bound cannot sever anything. It is allowed to fall
        // to the catch-all; it is listed here so that GROWING its message — the
        // change that would make it unsafe — fails this test rather than shipping.
        return;
      }
      expect(
        report.kind,
        `${name} builds a ${err.message.length}-character message from constants and lands in ` +
          `the catch-all, which cuts it at ${UNEXPECTED_MESSAGE_MAX}. That is the defect ` +
          'FR-R3-146 fixed once already. Give it a branch in start-failure-classification.ts.'
      ).not.toBe('unexpected');
      expect(
        report.message,
        `${name} is classified but its branch still truncates. The point of the branch is the ` +
          'remedy at the end of the message.'
      ).toBe(err.message);
      expect(
        report.announcement,
        `${name} is a deliberate refusal; "failed unexpectedly" sends an operator looking for a fault`
      ).not.toContain('failed unexpectedly');
    });
  }

  it('holds the status bar to one line for every classified refusal', () => {
    // The reason the branches exist is that a toast can carry a long remedy and a
    // status bar cannot. A branch that put the full message on the bar would fix
    // the truncation by making the bar unusable.
    for (const { name, make } of REFUSALS) {
      const report = classifyStartFailure(make(), 'feat-1', identity);
      expect(report.statusDetail, name).not.toContain('\n');
      expect(report.statusDetail.length, name).toBeLessThanOrEqual(120);
    }
  });
});

describe('the list above is the whole population', () => {
  /**
   * Names that mark a deliberate refusal, as opposed to a fault.
   *
   * A blunt name scan, on purpose and in this directory's idiom: it cannot know
   * intent, so it errs toward asking. A class it catches that is genuinely not a
   * start-path refusal is added to `REFUSALS` anyway — the behavioural test above
   * exempts it in one line when its message is short, and that costs nothing.
   */
  const REFUSAL_NAME = /^export class (\w*(?:Refused|Refusal|NotEnforceable)\w*) extends /gm;

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
    );

  it('names every refusal error declared in src/, so a new one forces a decision', () => {
    const files = walk(SRC);
    const found = new Map<string, string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(REFUSAL_NAME)) {
        found.set(m[1] as string, relative(SRC, file));
      }
    }

    // THE FLOORS ARE THE CONTROL. The assertion below compares a filtered list to
    // `[]`, which is the shape that passes loudest when the list is empty for the
    // wrong reason: a moved directory makes `walk` return nothing, `found` empty,
    // and the check green over a tree it never read. Both floors are far from the
    // observed values (494 sources, 4 classes) so neither churns on ordinary work.
    expect(files.length, 'the walk found almost no sources, so the check below reads nothing').toBeGreaterThan(200);
    expect(
      found.size,
      'the scan found no refusal class at all — the name shape changed, or the walk missed the tree'
    ).toBeGreaterThanOrEqual(REFUSALS.length);

    const listed = new Set(REFUSALS.map((r) => r.name));
    const missing = [...found].filter(([name]) => !listed.has(name));
    expect(
      missing.map(([name, file]) => `${name} (${file})`),
      'a refusal error this file does not know about. Add it to REFUSALS: if its message is ' +
        'short the test passes immediately, and if it is not, it needed a branch.'
    ).toEqual([]);
  });

  it('does not list a class that no longer exists, which would make the checks above vacuous', () => {
    const declared = new Set<string>();
    for (const file of walk(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(REFUSAL_NAME)) {
        declared.add(m[1] as string);
      }
    }
    for (const { name } of REFUSALS) {
      expect(declared.has(name), `${name} is listed here but declared nowhere in src/`).toBe(true);
    }
  });

  it('catches the name shape it claims to catch', () => {
    // The scan is the only thing standing between a new refusal type and the
    // catch-all, so it is proved against a sample rather than trusted.
    const sample = [
      'export class SomethingRefusedError extends Error {',
      'export class ThingNotEnforceableError extends Error {',
      'export class PlainError extends Error {'
    ].join('\n');
    const hits = [...sample.matchAll(REFUSAL_NAME)].map((m) => m[1]);
    expect(hits).toEqual(['SomethingRefusedError', 'ThingNotEnforceableError']);
  });
});
