// FR-R3-001 (T258) — nothing but the validator builds an `ExecutionEnvelope`.
//
// The envelope's whole value is that it is constructed once and read by
// reference. A component that rebuilds one — even a faithful copy — reintroduces
// the defect this feature closed, because the copy is a second place a field can
// be forgotten. That is not hypothetical: feature 087 froze five fields and the
// factory harvested one, and nothing failed. The copy compiled, the run
// executed, and the four dropped fields were visible only as work the backend
// was never asked to do.
//
// The compiler cannot state the rule. `ExecutionEnvelope` is a structural type,
// so any object literal with the right members satisfies it, from anywhere. So
// the guard is a shape rule on how an envelope may be *written* under `src/`:
//
//   1. The property key `frozenAt:` may appear only at the type's declaration
//      site and at the single construction site. Every literal that honestly
//      satisfies the type must carry that key — it is required and has no
//      default — so this catches the ordinary rebuild.
//   2. No `as` or `satisfies` assertion to either envelope spelling, anywhere,
//      including the two files rule 1 allows. That is how a hand-built partial
//      is forced past the compiler, and it is the way around rule 1 that does
//      not need to name `frozenAt` at all.
//   3. No spread of an envelope-shaped binding into an object literal. `{ ...plan,
//      outputs: retargeted }` carries `frozenAt` in through the spread, so rule 1
//      never sees it, and it is precisely the "retarget the envelope at drain
//      time" edit the frozen-plan hard rule forbids. This rule keys on the
//      spread operand's name, which is a convention rather than a type — stated
//      plainly here because a naming rule that pretends to be a type rule is
//      worse than one that admits what it is. It costs nothing today: `src/`
//      contains no such spread, so the rule starts at zero and any new one is a
//      deliberate act someone has to argue for.
//
// Scope is `src/` alone, deliberately. Tests build envelope literals as fixtures
// — `planFor()` in `tests/unit/services/workflow-run-factory.test.ts` is one —
// and that is not a construction path, it is how a consumer is exercised against
// what the single construction site produces. A fixture cannot reach a running
// host. Widening the scan to `tests/` would fail the suite that proves the rule
// matters, which is the wrong trade in both directions.
//
// Comments are stripped before scanning: this repo records removed and forbidden
// forms in prose, and the record of what must not be written must not read as an
// instance of it. Strings are left alone, as the other lint guards leave them —
// no string under `src/` writes any of these tokens today, and if one ever does,
// this gate fails loudly pointing at that line rather than quietly masking a
// real site next to it.

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = 'src';

/** Where the type is declared. Its interface members name `frozenAt` by necessity. */
const DECLARATION_SITE = 'src/contracts/run-request.ts';

/** The one function permitted to produce an envelope (T257). */
const CONSTRUCTION_SITE = 'src/services/run-request/run-request-validator.ts';

/**
 * Files that must contribute at least one `frozenAt` site. Without them a path
 * typo, a file move, or a rename would empty the scan and pass every assertion
 * below trivially — the failure a construction-site guard can least afford,
 * since it fails open into exactly the state it exists to prevent.
 */
const ANCHORS = [DECLARATION_SITE, CONSTRUCTION_SITE] as const;

/** The two spellings of the same type. Both are the envelope; see run-request.ts. */
const ENVELOPE_TYPES = ['ExecutionEnvelope', 'FrozenRunPlan'] as const;

/**
 * Identifier names that denote an envelope by convention across the host. The
 * rule-3 heuristic matches a spread whose last path segment is one of these,
 * case-insensitively, so `...plan`, `...feature.runPlan` and `...this.envelope`
 * are all caught and `...run`, `...request` and `...(plan ? {} : {})` are not.
 */
const ENVELOPE_BINDINGS = ['plan', 'runplan', 'frozenplan', 'envelope', 'executionenvelope'];

interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function typescriptFiles(root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = resolve(root, entry.name);
    if (entry.isDirectory()) found.push(...typescriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(absolute);
  }
  return found;
}

/** Blank out comments, preserving offsets and newlines so lines still line up. */
function stripComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };
  let cursor = 0;
  while (cursor < text.length) {
    const pair = text.slice(cursor, cursor + 2);
    if (pair === '//') {
      const newline = text.indexOf('\n', cursor);
      const stop = newline === -1 ? text.length : newline;
      blank(cursor, stop);
      cursor = stop;
    } else if (pair === '/*') {
      const close = text.indexOf('*/', cursor + 2);
      const stop = close === -1 ? text.length : close + 2;
      blank(cursor, stop);
      cursor = stop;
    } else {
      cursor += 1;
    }
  }
  return out.join('');
}

interface ScannedFile {
  readonly file: string;
  readonly code: string;
  readonly lines: readonly string[];
}

const FILES: readonly ScannedFile[] = typescriptFiles(resolve(REPO_ROOT, SCAN_ROOT)).map(
  (absolute) => {
    const raw = readFileSync(absolute, 'utf8');
    return {
      file: relative(REPO_ROOT, absolute),
      code: stripComments(raw),
      lines: raw.split(/\r?\n/)
    };
  }
);

function matches(pattern: RegExp, accept: (match: RegExpExecArray) => boolean): readonly Site[] {
  const found: Site[] = [];
  for (const scanned of FILES) {
    for (const match of scanned.code.matchAll(pattern)) {
      if (!accept(match as RegExpExecArray)) continue;
      const line = scanned.code.slice(0, match.index).split('\n').length;
      found.push({ file: scanned.file, line, text: (scanned.lines[line - 1] ?? '').trim() });
    }
  }
  return found;
}

function describeSite(site: Site): string {
  return `${site.file}:${site.line}  ${site.text}`;
}

const FROZEN_AT_SITES = matches(/\bfrozenAt\s*:/g, () => true);

describe('FR-R3-001 — the envelope has one construction site (T258)', () => {
  it('scanned the files the rule is about, so the scan is not vacuous', () => {
    expect(FILES.length, 'TypeScript files scanned under src/').toBeGreaterThan(100);
    const scanned = new Set(FROZEN_AT_SITES.map((site) => site.file));
    for (const anchor of ANCHORS) {
      expect(scanned, `${anchor} must contribute at least one frozenAt site`).toContain(anchor);
    }
  });

  it('writes frozenAt only where the type is declared and where it is built', () => {
    const offenders = FROZEN_AT_SITES.filter(
      (site) => site.file !== DECLARATION_SITE && site.file !== CONSTRUCTION_SITE
    ).map(describeSite);
    expect(
      offenders,
      `an ExecutionEnvelope is constructed only by validateRunRequest() in ${CONSTRUCTION_SITE}; take the envelope by reference instead of rebuilding one`
    ).toEqual([]);
  });

  it('builds exactly one envelope literal, in the validator', () => {
    const inValidator = FROZEN_AT_SITES.filter((site) => site.file === CONSTRUCTION_SITE);
    expect(
      inValidator.map(describeSite),
      'validateRunRequest() returns one envelope; a second literal here is a second construction site wearing the right filename'
    ).toHaveLength(1);
  });

  it('never asserts a value into the envelope type', () => {
    const pattern = new RegExp(`\\b(?:as|satisfies)\\s+(?:${ENVELOPE_TYPES.join('|')})\\b`, 'g');
    const offenders = matches(pattern, () => true).map(describeSite);
    expect(
      offenders,
      'an `as`/`satisfies` assertion forces a partial past the compiler; construct through validateRunRequest() or thread the existing envelope through'
    ).toEqual([]);
  });

  it('never spreads an envelope into a new object literal', () => {
    const pattern = /\.\.\.\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g;
    const offenders = matches(pattern, (match) => {
      const segments = (match[1] ?? '').split('.').map((part) => part.trim().toLowerCase());
      return ENVELOPE_BINDINGS.includes(segments[segments.length - 1] ?? '');
    }).map(describeSite);
    expect(
      offenders,
      'spreading an envelope produces a retargeted copy the frozen-plan rule forbids; an in-flight envelope is read, never rebuilt'
    ).toEqual([]);
  });
});
