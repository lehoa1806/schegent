// Feature 103 (T079, T080, T081, US8 — FR-046, FR-047, FR-048) — what the
// history surface is allowed to carry.
//
// Three prohibitions that fail in three different places, so they are tested in
// three different places rather than by one scan:
//
//   * FR-046 — operator text is sanitized **once, at the boundary**, and the
//     boundary is `buildHistoryEntry`. Everything downstream copies. The render
//     half of this requirement is pinned in the webview package, where the
//     components can actually be mounted (`history-text-is-inert.test.ts`);
//     what is testable here is that nothing unsanitized is ever handed to them.
//   * FR-047 — no workspace root reaches the wire or a log line. The record
//     holds exactly one path-shaped field and the projector does not ship it;
//     the log lines are the harder half, because a caught filesystem error
//     quotes the absolute path it was addressing and reads as harmless.
//   * FR-048 — no raw error object, stack, or request body. The record's only
//     error-shaped field is a sanitized string, and the writers that catch
//     exceptions log a code rather than a message.
//
// Where a claim is negative, the case first shows the unwanted value existing,
// so a green result means it was dropped rather than that there was nothing to
// drop.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import { writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AUDIT_POINTER_PREFIX,
  DESCRIPTION_PREVIEW_MAX,
  buildAuditLogPointer,
  buildHistoryEntry,
  ensureHistoryEntry,
  parseAuditLogPointer,
  type HistoryRecord
} from '../../src/state/history-entry';
import { HistoryDescriptionStore } from '../../src/services/history/history-description-store';
import { historyErrorCode } from '../../src/services/history/error-code';
import { SanitizedLogger, type LogSink } from '../../src/lib/logger';
import { projectHistory } from '../../src/ui/sidebar/history-projector';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Every line the logger emitted, after its own redaction pass. */
class CapturingSink implements LogSink {
  public readonly lines: string[] = [];
  appendLine(line: string): void {
    this.lines.push(line);
  }
}

const RUN_ID = 'run-sanitize-1';

// A real token shape from `SECRET_PATTERNS`, long enough to match the
// `ghp_[A-Za-z0-9]{30,}` rule: 4 + 40 characters.
const SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const REDACTED = '[REDACTED]';

function logger(): { logger: SanitizedLogger; sink: CapturingSink } {
  const sink = new CapturingSink();
  return { logger: new SanitizedLogger([sink]), sink };
}

function build(overrides: Partial<Parameters<typeof buildHistoryEntry>[0]> = {}) {
  const { logger: log } = logger();
  return buildHistoryEntry({
    runId: RUN_ID,
    featureId: 'task-1',
    description: 'ship the release',
    terminalStatus: 'completed',
    startedAt: Date.parse('2026-05-10T12:00:00.000Z'),
    completedAt: Date.parse('2026-05-10T12:00:42.000Z'),
    logger: log,
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// T079 / FR-046 — sanitized at the boundary, before anything can render it
// ---------------------------------------------------------------------------

describe('Feature 103 T079 — operator text is sanitized at the boundary (FR-046)', () => {
  it('redacts a secret in the description before it reaches the preview', () => {
    const built = build({ description: `deploy with ${SECRET} now` });

    expect(built.entry.descriptionPreview).toContain(REDACTED);
    expect(built.entry.descriptionPreview).not.toContain(SECRET);
    expect(built.entry.descriptionPreview).not.toContain('ghp_');
  });

  it('sanitizes before truncating, so a secret straddling the cut cannot survive it', () => {
    // 60 characters of ordinary text, then the token. The preview window ends
    // at character 80, twenty characters into a 44-character token — and the
    // twenty-character fragment `ghp_` + 16 alphanumerics matches no pattern,
    // because the rule requires thirty. Truncate first and those sixteen
    // characters of a live credential ship as ordinary description text.
    //
    // The prefix ends in a space because every token rule is anchored on a word
    // boundary: `…wordsghp_AAA…` is deliberately not a match (see the `sk-`
    // pattern's comment), so butting the two together would test the anchor
    // rather than the order of the two steps.
    const prefix = `${'r'.repeat(59)} `;
    const built = build({ description: `${prefix}${SECRET}` });

    expect(prefix.length + SECRET.length).toBeGreaterThan(DESCRIPTION_PREVIEW_MAX);
    expect(built.entry.descriptionPreview).not.toContain('ghp_');
    expect(built.entry.descriptionPreview).toContain(REDACTED);
  });

  it('reports the length of the text it kept, not of the text it was handed', () => {
    const raw = `deploy with ${SECRET} now`;
    const built = build({ description: raw });

    // The detail states how much of the original the preview is. Reporting the
    // pre-redaction length would make that arithmetic describe a string no
    // reader will ever be shown, and would leak how long the unredacted text
    // was into a surface that redacted it.
    expect(built.entry.descriptionLength).toBe(built.fullDescription.length);
    expect(built.entry.descriptionLength).not.toBe(raw.length);
  });

  it('writes the sanitized text to evidence, not the raw text', () => {
    const built = build({ description: `deploy with ${SECRET} now` });

    // `fullDescription` is what the description store persists. A second
    // sanitization site would be a second answer; an unsanitized one would put
    // the credential on disk under the record that redacted it.
    expect(built.fullDescription).toContain(REDACTED);
    expect(built.fullDescription).not.toContain(SECRET);
  });

  it('routes the error summary through the same sanitizer', () => {
    const built = build({ lastErrorSummary: `auth failed for ${SECRET}` });

    expect(built.entry.lastErrorSummary).toContain(REDACTED);
    expect(built.entry.lastErrorSummary).not.toContain(SECRET);
  });

  it('the projector copies fields and composes none', () => {
    const built = build({ description: `deploy with ${SECRET} now` });
    const record: HistoryRecord = { ...built.entry, queueId: 'release' };
    const [row] = projectHistory({ list: () => [record] });

    // Every string the wire carries is a field of the record, byte for byte.
    // That is what makes one sanitization site sufficient: a projector that
    // concatenated, re-cased, or re-truncated would be a second place text is
    // shaped, and the boundary's guarantee would stop at its input.
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string') continue;
      expect(value, `projector composed \`${key}\``).toBe(
        (record as unknown as Record<string, unknown>)[key]
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T080 / FR-047 — no workspace root, rendered or logged
// ---------------------------------------------------------------------------

describe('Feature 103 T080 — no workspace root reaches the surface (FR-047)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-history-sanitize-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('the projector ships no path-shaped field, though the record holds two', () => {
    const built = build();
    const record: HistoryRecord = {
      ...built.entry,
      queueId: 'release',
      // The two path-shaped fields a record can hold, both populated so their
      // absence downstream is a decision rather than an empty input.
      descriptionRef: `.schegent/history/${RUN_ID}.txt`,
      originalDescription: 'the full untruncated operator text',
      runOutputs: [{ name: 'report', status: 'resolved', reference: 'docs/report.md' }]
    };

    const [row] = projectHistory({ list: () => [record] });

    expect(Object.keys(row).sort()).toEqual(
      [
        'auditLogPointer',
        'completedAt',
        'descriptionLength',
        'descriptionPreview',
        'durationMs',
        'featureId',
        'lastErrorSummary',
        'queueId',
        'runId',
        'startedAt',
        'terminalStatus'
      ].sort()
    );
  });

  it('the audit pointer addresses a run by id, not by file', () => {
    const pointer = buildAuditLogPointer(RUN_ID);

    expect(pointer).toBe(`${AUDIT_POINTER_PREFIX}${RUN_ID}`);
    expect(pointer).not.toContain(path.sep);
    expect(parseAuditLogPointer(pointer)).toEqual({ runId: RUN_ID });
  });

  it('a written description is referenced relative to the root, never through it', async () => {
    const { logger: log } = logger();
    const store = new HistoryDescriptionStore({ workspaceRoot: root, logger: log });

    const ref = await store.write(RUN_ID, 'the full operator text');

    // The store holds the root — it has to, to resolve and containment-check
    // the write — and the reference it hands back still does not carry it. That
    // is the whole reason a record can be shown to someone without disclosing
    // where the workspace lives.
    expect(ref).toBe(`.schegent/history/${RUN_ID}.txt`);
    expect(path.isAbsolute(ref as string)).toBe(false);
    expect(ref).not.toContain(root);
  });

  it('a failed write logs the code and the relative reference, not the absolute path', async () => {
    const { logger: log, sink } = logger();
    // `.schegent` as a file, so the recursive mkdir fails with ENOTDIR — and
    // the message Node attaches quotes the absolute directory it tried to make.
    writeFileSync(path.join(root, '.schegent'), 'not a directory');
    const store = new HistoryDescriptionStore({ workspaceRoot: root, logger: log });

    const ref = await store.write(RUN_ID, 'the full operator text');

    expect(ref).toBeNull();
    expect(sink.lines).toHaveLength(1);
    const [line] = sink.lines;
    expect(line).toContain('ENOTDIR');
    expect(line).toContain(`.schegent/history/${RUN_ID}.txt`);
    expect(line, 'the workspace root reached a log line').not.toContain(root);
    expect(line).not.toContain(os.tmpdir());
  });

  it('`historyErrorCode` keeps the code and drops whatever the message quoted', () => {
    const errno = Object.assign(new Error(`ENOENT: no such file, open '${root}/secret.log'`), {
      code: 'ENOENT'
    });

    expect(historyErrorCode(errno)).toBe('ENOENT');
    // A non-errno error has no code to keep, and its message is free text from
    // wherever it was thrown — a parser quoting its input would put the
    // description this surface sanitizes straight back into the log.
    expect(historyErrorCode(new TypeError(`cannot parse ${root}/plan.json`))).toBe('TypeError');
    expect(historyErrorCode('a bare string')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// T081 / FR-048 — no raw error object, stack, or request body
// ---------------------------------------------------------------------------

describe('Feature 103 T081 — no raw error reaches the surface (FR-048)', () => {
  it('an absent error summary is null, not an empty string', () => {
    expect(build({ lastErrorSummary: undefined }).entry.lastErrorSummary).toBeNull();
    expect(build({ lastErrorSummary: '' }).entry.lastErrorSummary).toBeNull();
  });

  it('a persisted row carrying an error object loses it rather than rendering it', () => {
    const thrown = new Error('deploy failed');
    const record = ensureHistoryEntry(
      {
        runId: RUN_ID,
        featureId: 'task-1',
        startedAt: '2026-05-10T12:00:00.000Z',
        completedAt: '2026-05-10T12:00:42.000Z',
        terminalStatus: 'failed',
        // What a writer that reached for the error itself would leave behind.
        // The normaliser keeps strings and nothing else, so this becomes the
        // same `null` as a run that failed without a summary — an absence the
        // surface already knows how to show.
        lastErrorSummary: { message: thrown.message, stack: thrown.stack }
      },
      'release'
    );

    expect(record).not.toBeNull();
    expect(record?.lastErrorSummary).toBeNull();
  });

  it('a summary that quotes a stack is sanitized text and stays a bounded string', () => {
    const built = build({
      lastErrorSummary: `deploy failed: ${SECRET}\n    at run (/w/s/src/x.ts:12:3)`
    });

    expect(typeof built.entry.lastErrorSummary).toBe('string');
    expect(built.entry.lastErrorSummary).not.toContain(SECRET);
    // The frame itself is not redacted — `sanitize` matches secrets, not paths —
    // which is exactly why the writers that catch exceptions must never hand one
    // in. `historyErrorCode` is what enforces that at the only sites that can.
    expect(built.entry.lastErrorSummary).toContain(REDACTED);
  });

  it('the history writers log a code, never a caught message', async () => {
    const sources = await Promise.all(
      [
        'src/services/history-recorder.ts',
        'src/services/history/history-description-store.ts',
        'src/ui/sidebar/commands/cmd-resolve-audit-pointer.ts'
      ].map(async (rel) => ({
        rel,
        text: await fsp.readFile(path.resolve(__dirname, '..', '..', rel), 'utf8')
      }))
    );

    for (const { rel, text } of sources) {
      // The `error-code` module quotes the forbidden form in its own header to
      // explain what it replaced, so the check is scoped to code: a line that
      // interpolates a caught error's `message` or `stack` into a log call.
      const offenders = text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .filter((line) => /\$\{[^}]*\b(?:err|error)\b[^}]*\.(?:message|stack)\b/.test(line));

      expect(offenders, `${rel} interpolates a caught error`).toEqual([]);
    }
  });
});
