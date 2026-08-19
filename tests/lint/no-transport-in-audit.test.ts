// Feature FR-R3-007 (T361) — CLI transport does not go back into `audit.log`.
//
// The defect this guards (blueprint DATA-01) was not a wrong event payload. It
// was a *rate*: `monitor-stdout-line` wrote one structured audit entry for every
// line the CLI emitted, and nothing in the product read one back. In the sample
// the plan measured, 1,245,785 of 1,337,386 bytes — 93.2% — were that one event,
// which capped the metrics horizon at roughly 40 runs against a spec that
// promises "months of activity" (`specs/073-metrics-dashboard/spec.md` SC-001).
//
// Deleting the two writers fixes today. It does not fix tomorrow, and the
// compiler cannot help here: an audit append inside a per-line loop is
// well-typed, passes review as "just a little more evidence", and its cost only
// appears months later as a metrics window that quietly stopped reaching back.
// The event type need not even be the old one — `'monitor-output-line'` would
// reproduce the defect exactly while every grep for the retired names stays
// clean. So the rule is written twice, once on the names and once on the shape:
//
//   A. The retired event types have no *writer*. They stay in the registry
//      forever, because archived logs on operator disks still contain them and
//      the parser must keep parsing them without warning — that is the
//      warn-and-preserve rule, and it is the reason this cannot be a blanket
//      "the string does not appear" scan. Reading them is required; writing one
//      is the violation.
//
//   B. No audit append occurs inside a loop over CLI output lines, whatever the
//      event is called. This is the shape rule, and it is the one that catches a
//      regression written in good faith under a new name.
//
//   C. The sink that replaced the writer does not reach for the audit writer.
//      The two tiers are separate on purpose; a sink that also appended an entry
//      per line would restore the volume while looking like the fix.
//
// Rule B's scope is `src/monitor/` and `src/controller/` — the two directories
// that see CLI output. Every `.append(` in both is an audit write today, which
// is what lets the token list stay short; outside them `.append` means other
// things (string builders, DOM), and a wider scope would need a receiver
// analysis whose failure mode is a quieter lint.
//
// `src/controller/phase-sidecar-reader.ts` is the positive model rather than an
// exemption: `parsePhaseMessageEnv` walks every line of an untrusted env file,
// counts `invalidLines` / `invalidKeys` as it goes, and appends **one**
// `phase-message-invalid` entry afterwards. Per-line work, per-invocation
// evidence. It is anchored below so the scan is known to reach a real loop even
// if the monitor's own two are ever restructured.
//
// Comments are stripped before scanning. Both the monitor and the sink explain
// themselves by quoting `appendAudit('monitor-stdout-line', …)` verbatim — the
// record of what was removed must not read as a violation of its own removal.
// Strings are left intact, because rule A is *about* a string literal.

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The retired per-line event types, by name. */
const RETIRED_EVENT_TYPES = ['monitor-stdout-line', 'monitor-stderr-line'] as const;

/**
 * The only files that may name a retired event type: the registry that keeps it
 * parseable and the generated mirror of that registry. Both are read surfaces —
 * neither appends anything.
 */
const REGISTRY_FILES = [
  'src/contracts/audit-events.ts',
  'src/contracts/generated/boundary-contracts.ts'
] as const;

/** Directories that see CLI output, and so are where rule B can be violated. */
const TRANSPORT_SCOPE = ['src/monitor', 'src/controller'] as const;

/** The sink rule C is about. */
const SINK_FILE = 'src/monitor/cli-transport-sink.ts';

/**
 * Files that must contribute at least one per-line loop. Without them a rename
 * of `lines.complete`, or a change to how loops are written, would empty rule
 * B's scan and pass it forever — the failure a forbidding lint can least afford.
 */
const LOOP_ANCHORS: ReadonlyMap<string, number> = new Map([
  ['src/monitor/claude-cli-monitor.ts', 2],
  ['src/controller/phase-sidecar-reader.ts', 1]
]);

/** An audit write, in either the wrapper form or the writer form. */
const AUDIT_WRITE = /\bappendAudit\s*\(|\.append\s*\(/;

/**
 * `import … from '…audit…'`. Rule C only, where the question is whether one
 * file reaches for another tier's writer at all.
 */
const AUDIT_IMPORT = /\bfrom\s+['"][^'"]*audit[^'"]*['"]/;

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
 * Does this loop header iterate CLI output lines?
 *
 * Identifiers are split on camelCase and compared segment-wise, so `rawLine`,
 * `parsedLines`, and `lines.complete` all match while `pipelineId` does not —
 * `pipeline` is one segment and it is not `line`. A substring test would call
 * every `for (const pipelineId of …)` a per-line loop, and the resulting
 * exemption list would be the real rule.
 */
function iteratesLines(header: string): boolean {
  for (const identifier of header.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    for (const segment of identifier.split(/(?=[A-Z])/)) {
      if (/^lines?$/i.test(segment)) return true;
    }
  }
  return false;
}

/** Index of the character after the `(…)` opening at `open`, or -1. */
function closeParen(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index]!;
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * The loop body that follows the header ending at `afterHeader`. A braced body
 * is brace-matched; a single-statement body runs to the next `;`. Unterminated
 * source yields the remainder, which can only make a body look *longer* — this
 * lint forbids, so over-reach shows up as a failure to investigate rather than
 * as silence.
 */
function loopBody(code: string, afterHeader: number): string {
  let cursor = afterHeader;
  while (cursor < code.length && /\s/.test(code[cursor]!)) cursor += 1;
  if (code[cursor] !== '{') {
    const semicolon = code.indexOf(';', cursor);
    return code.slice(cursor, semicolon === -1 ? code.length : semicolon);
  }
  let depth = 0;
  for (let index = cursor; index < code.length; index += 1) {
    const char = code[index]!;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(cursor + 1, index);
    }
  }
  return code.slice(cursor);
}

interface LineLoop {
  readonly file: string;
  readonly line: number;
  readonly header: string;
  readonly body: string;
}

function lineLoopsIn(file: string): readonly LineLoop[] {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const found: LineLoop[] = [];
  for (const match of code.matchAll(/\b(?:for|while)\s*\(/g)) {
    const open = code.indexOf('(', match.index);
    const close = closeParen(code, open);
    if (close === -1) continue;
    const header = code.slice(open + 1, close);
    if (!iteratesLines(header)) continue;
    found.push({
      file: relative(REPO_ROOT, file),
      line: raw.slice(0, match.index).split('\n').length,
      header: header.replace(/\s+/g, ' ').trim(),
      body: loopBody(code, close + 1)
    });
  }
  return found;
}

const LINE_LOOPS: readonly LineLoop[] = TRANSPORT_SCOPE.flatMap((dir) =>
  typescriptFiles(resolve(REPO_ROOT, dir)).flatMap(lineLoopsIn)
);

const SOURCE_FILES: readonly string[] = typescriptFiles(resolve(REPO_ROOT, 'src'));

interface EventMention {
  readonly file: string;
  readonly line: number;
  readonly eventType: string;
}

const EVENT_MENTIONS: readonly EventMention[] = SOURCE_FILES.flatMap((file) => {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const found: EventMention[] = [];
  for (const eventType of RETIRED_EVENT_TYPES) {
    for (const match of code.matchAll(new RegExp(eventType, 'g'))) {
      found.push({
        file: relative(REPO_ROOT, file),
        line: raw.slice(0, match.index).split('\n').length,
        eventType
      });
    }
  }
  return found;
});

describe('FR-R3-007 — CLI transport stays out of the structured audit log', () => {
  it('scanned the loops and the literals the rules are about', () => {
    for (const [anchor, minimum] of LOOP_ANCHORS) {
      const count = LINE_LOOPS.filter((loop) => loop.file === anchor).length;
      expect(
        count,
        `${anchor} must contribute at least ${minimum} per-line loop(s); rule B is vacuous otherwise`
      ).toBeGreaterThanOrEqual(minimum);
    }
    for (const registry of REGISTRY_FILES) {
      const named = EVENT_MENTIONS.some((mention) => mention.file === registry);
      expect(
        named,
        `${registry} must still name the retired event types; archived logs are parsed from that list`
      ).toBe(true);
    }
  });

  it('A. no file writes a retired per-line event type', () => {
    const offenders = EVENT_MENTIONS.filter(
      (mention) => !(REGISTRY_FILES as readonly string[]).includes(mention.file)
    ).map((mention) => `${mention.file}:${mention.line}  ${mention.eventType}`);
    expect(
      offenders,
      'these files name a retired per-line audit event outside the registry that keeps it ' +
        'parseable. The event types are read-only: they exist so archived logs still parse, ' +
        'not so a new writer can reuse them. Line content belongs in ' +
        `${SINK_FILE}; line volume belongs in monitor-invocation-summary\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('B. no audit append happens inside a loop over CLI output lines', () => {
    const offenders = LINE_LOOPS.filter((loop) => AUDIT_WRITE.test(loop.body)).map(
      (loop) => `${loop.file}:${loop.line}  for (${loop.header})`
    );
    expect(
      offenders,
      'these loops append one audit entry per line of CLI output — the shape of DATA-01, ' +
        'whatever the event is called. One entry per line put 93.2% of audit.log beyond ' +
        'any reader and capped the metrics horizon at ~40 runs. Count in the loop and ' +
        `append once per invocation, as parsePhaseMessageEnv does\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('C. the transport sink does not reach for the audit writer', () => {
    const code = stripComments(readFileSync(resolve(REPO_ROOT, SINK_FILE), 'utf8'));
    expect(
      AUDIT_IMPORT.test(code),
      `${SINK_FILE} imports from the audit tier. It is the other tier: bounded, best-effort, ` +
        'and deliberately unable to fail a phase. Coupling the two gives back the volume ' +
        'while looking like the fix.'
    ).toBe(false);
    expect(
      /\bappendAudit\s*\(/.test(code),
      `${SINK_FILE} appends an audit entry. The sink records transported content; the audit ` +
        'writer records what Schegent did.'
    ).toBe(false);
  });
});
