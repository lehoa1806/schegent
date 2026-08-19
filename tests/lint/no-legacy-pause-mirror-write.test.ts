// FR-R3-011 (T424) — the legacy `QueueState.paused` mirror stays migration
// input, and live code never writes one.
//
// The collapse made `paused` optional. Optionality is what lets a pre-v13
// record be recognised by shape and lifted, and it is also the hole this guard
// closes: an optional field can be *added back* by any object literal without
// the compiler saying a word. A single `paused: true` written beside a
// `queueLifecycle` would restore a second persisted answer to "is this queue
// paused" — silently, and only in the workspaces that took that code path, which
// is the least reproducible way for the divergence to come back.
//
// The rule is shape-based rather than name-based, because `paused` is a common
// field name in this codebase and a bare token scan would be mostly noise: the
// credit watchdog persists a `paused` flag, `WorkflowRun` has one, and the
// webview wire snapshot publishes one that is *derived* and legitimate. So a
// literal is judged by what else is in it:
//
//   a `QueueState` literal is one with a top-level `queueLifecycle:` or
//   `inFlightId:` key, and no such literal may carry a top-level `paused:` key.
//
// Both markers are required on `QueueState` and appear on no other record in the
// host, which makes either one reliable. Two are needed rather than one because
// the common way to write a queue is `{ ...queue, <the fields being changed> }`,
// and a spread carries `queueLifecycle` without naming it — `clearAll` wrote
// `paused: false` inside exactly such a literal and a single-marker scan let it
// through. Matching a marker as a *key* and not as a member access is what keeps
// `paused: state.queueLifecycle === '…'` — the derived wire field and the derived
// registry pause view, both correct — out of the scan.
//
// Scope is `src/` only. `tests/` builds pre-v13 fixtures on purpose: a fixture
// carrying `paused` beside `queueLifecycle` *is* the input `migrateV12ToV13()`
// is tested against, so scanning tests would fail the build on the evidence that
// the migration works.

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = 'src';

/**
 * This file, excluded from its own scan — its prose and failure messages have to
 * quote the forbidden shape to be worth reading.
 */
const SELF = 'tests/lint/no-legacy-pause-mirror-write.test.ts';

/**
 * The one file allowed to write the mirror, and the reason.
 *
 * The migrator constructs the *intermediate* v5/v6/v7 shapes on the way to the
 * collapse, and those shapes have a `paused` boolean by definition — refusing it
 * there would mean the migration could not read the state it exists to migrate.
 * `migrateV12ToV13()` is in the same file and is the code that removes the
 * field, so the writer and the eliminator are read together.
 */
const ALLOWED: ReadonlySet<string> = new Set(['src/state/queue-state-migrator.ts']);

/**
 * Files allowed to *read* a `.paused` property, each with the reason.
 *
 * Reads needed their own gate, and the reason is the one regression this rule
 * was written a step too late to prevent. The write gate above stops a second
 * answer reaching disk; it says nothing about code that keeps *asking* the
 * retired one. Because the collapse made `paused` optional rather than absent,
 * every surviving read compiled, evaluated to `undefined`, and read as "not
 * paused" — so a paused queue drained, accepted schedules, and lost its
 * clear-all escape hatch, with no type error and no failing shape assertion.
 * Three live sites were in exactly that state
 * (`auto-drain-coordinator`, `guarded-run-service`, `queue-manager`) and each
 * one failed *open*, which is the direction that starts work nobody asked for.
 *
 * The entries below are the reads that are not the queue mirror at all. They
 * are listed by file because `.paused` is a field name three unrelated records
 * share, and a token scan cannot tell them apart:
 */
const READ_ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    'src/state/queue-state-migrator.ts',
    'reads the mirror as migration input, off the legacy record it is lifting'
  ],
  [
    'src/state/workspace-state.ts',
    'reads the mirror as migration input in `ensureExtendedQueueShape` and the ' +
      'v6 → v7 step, both of which run on records that predate the discriminator'
  ],
  [
    'src/queue/queue-registry.ts',
    'reads `QueuePauseView.paused` — the derived view the projection is handed, ' +
      'not a persisted field'
  ],
  [
    'src/watchdog/credit-watchdog.ts',
    'reads `WatchdogState.paused` — the credit watchdog has its own pause, ' +
      'unrelated to a queue lifecycle'
  ],
  [
    'src/queue/queue-manager.ts',
    'reads `WatchdogState.paused` when clear-all decides whether the watchdog ' +
      'needs clearing; the queue pause on the line below it reads `queueLifecycle`'
  ]
]);

/**
 * Files that must contribute at least one scanned literal. Without them a path
 * typo or a marker rename would empty the scan and pass every assertion below
 * trivially, which is the failure a shape guard can least afford.
 */
const ANCHORS = [
  'src/state/queue-state-migrator.ts',
  'src/state/workspace-state.ts',
  'src/queue/queue-manager.ts'
] as const;

interface QueueStateLiteral {
  readonly file: string;
  readonly line: number;
  readonly body: string;
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

/**
 * The `{ … }` that immediately encloses `index`, or null when the braces do not
 * balance before the file ends. Scanning backwards for the opening brace and
 * forwards for its match is enough here: both ends are inside the same file and
 * the depth counter is symmetric, so a mismatch yields null rather than a
 * mis-scoped body.
 */
function enclosingBraces(code: string, index: number): { start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const char = code[cursor]!;
    if (char === '}') depth += 1;
    else if (char === '{') {
      if (depth === 0) {
        start = cursor;
        break;
      }
      depth -= 1;
    }
  }
  if (start === -1) return null;
  depth = 0;
  for (let cursor = start; cursor < code.length; cursor += 1) {
    const char = code[cursor]!;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: cursor };
    }
  }
  return null;
}

/** Top-level `key:` names of a `{ … }` body, ignoring nested literals. */
function topLevelKeys(body: string): readonly string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let cursor = 0; cursor < body.length; cursor += 1) {
    const char = body[cursor]!;
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') depth -= 1;
    else if (depth === 0) {
      const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(cursor));
      if (match && (cursor === 0 || /[\s,;{]/.test(body[cursor - 1]!))) {
        keys.push(match[1]!);
        cursor += match[0].length - 1;
      }
    }
  }
  return keys;
}

function queueStateLiteralsIn(file: string): readonly QueueStateLiteral[] {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const found: QueueStateLiteral[] = [];
  const seen = new Set<number>();
  for (const match of code.matchAll(/\b(?:queueLifecycle|inFlightId)\s*:/g)) {
    const braces = enclosingBraces(code, match.index);
    if (braces === null || seen.has(braces.start)) continue;
    const body = code.slice(braces.start + 1, braces.end);
    // The marker has to be a *top-level* key of this literal. A marker nested
    // one level down belongs to an inner record, and judging the outer one by it
    // would scope the rule to the wrong braces.
    const keys = topLevelKeys(body);
    if (!keys.includes('queueLifecycle') && !keys.includes('inFlightId')) continue;
    seen.add(braces.start);
    found.push({
      file: relative(REPO_ROOT, file),
      line: raw.slice(0, braces.start).split('\n').length,
      body
    });
  }
  return found;
}

const LITERALS: readonly QueueStateLiteral[] = typescriptFiles(resolve(REPO_ROOT, SCAN_ROOT))
  .filter((file) => relative(REPO_ROOT, file) !== SELF)
  .flatMap(queueStateLiteralsIn);

describe('FR-R3-011 — the legacy queue-pause mirror is never written by live code', () => {
  it('scanned the files the rule is about, so the scan is not vacuous', () => {
    const scanned = new Set(LITERALS.map((literal) => literal.file));
    for (const anchor of ANCHORS) {
      expect(scanned, `${anchor} must contribute at least one QueueState literal`).toContain(
        anchor
      );
    }
  });

  it('no QueueState literal outside the migrator carries the `paused` mirror', () => {
    const offenders = LITERALS.filter(
      (literal) => !ALLOWED.has(literal.file) && topLevelKeys(literal.body).includes('paused')
    ).map((literal) => `${literal.file}:${literal.line}`);
    expect(
      offenders,
      'A QueueState literal must not carry `paused`. The queue is paused when ' +
        "`queueLifecycle === 'operator-paused'`, and that is the only persisted answer " +
        '(FR-R3-011). Writing the mirror back re-creates a second value that no ' +
        'transaction keeps in step with the first.'
    ).toEqual([]);
  });

  it('no live code assigns to the mirror through a property write', () => {
    const offenders: string[] = [];
    for (const file of typescriptFiles(resolve(REPO_ROOT, SCAN_ROOT))) {
      const relativePath = relative(REPO_ROOT, file);
      if (relativePath === SELF || ALLOWED.has(relativePath)) continue;
      const raw = readFileSync(file, 'utf8');
      const code = stripComments(raw);
      // `x.paused = …`, but not `x.paused === …` or `x.paused ==  …`: an
      // assignment writes the mirror, a comparison reads it, and only the write
      // can put a second answer on disk.
      for (const match of code.matchAll(/\.paused\s*=(?!=)/g)) {
        offenders.push(`${relativePath}:${raw.slice(0, match.index).split('\n').length}`);
      }
    }
    expect(
      offenders,
      'Assigning `.paused` writes the retired mirror. Write `queueLifecycle` ' +
        'and `pauseSource` in the one `updateQueue` call that carries the pause.'
    ).toEqual([]);
  });

  it('no live code reads the mirror outside the files that read something else', () => {
    const offenders: string[] = [];
    for (const file of typescriptFiles(resolve(REPO_ROOT, SCAN_ROOT))) {
      const relativePath = relative(REPO_ROOT, file);
      if (relativePath === SELF || READ_ALLOWED.has(relativePath)) continue;
      const raw = readFileSync(file, 'utf8');
      const code = stripComments(raw);
      // `.paused` as a member access, and not the prefix of a longer name —
      // `pausedReason`, `pausedSince`, `pausedAt` are all live fields.
      for (const match of code.matchAll(/\.paused\b(?!\s*:)/g)) {
        offenders.push(`${relativePath}:${raw.slice(0, match.index).split('\n').length}`);
      }
    }
    expect(
      offenders,
      'Reading `.paused` asks the retired mirror. It is absent from every record ' +
        'written after the v13 collapse, so the read is `undefined` — falsy, and ' +
        'indistinguishable from a queue that is genuinely running. Ask ' +
        "`queueLifecycle === 'operator-paused'` instead. If the field belongs to " +
        'some other record, add the file to READ_ALLOWED with the reason.'
    ).toEqual([]);
  });

  it('every READ_ALLOWED entry still has a read to justify, so the list cannot go stale', () => {
    const unused: string[] = [];
    for (const [relativePath] of READ_ALLOWED) {
      const code = stripComments(readFileSync(resolve(REPO_ROOT, relativePath), 'utf8'));
      if (!/\.paused\b(?!\s*:)/.test(code)) unused.push(relativePath);
    }
    expect(
      unused,
      'A READ_ALLOWED entry with no matching read is an exemption nobody needs. ' +
        'Remove it, so the next reader is not told the file legitimately reads the ' +
        'mirror when it no longer does.'
    ).toEqual([]);
  });

  it('`QueueState.paused` is declared optional, which is what makes the shape gate work', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src', 'queue', 'feature-request.ts'), 'utf8');
    // `migrateV12ToV13()` recognises an uncollapsed record by the field being
    // present. Making it required again would put it on every record written
    // from here on, and the migration would have nothing left to key on.
    expect(source).toContain('paused?: boolean;');
  });
});
