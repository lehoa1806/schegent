// Feature 065 BUG-010 / T086 — defense-in-depth lint pin against
// `as QueueProjection` casts in the host-side TypeScript sources.
//
// Why this lint exists:
//   The `as QueueProjection` cast is the documented escape-hatch
//   mechanism by which BUG-010 slipped past the original T077 work.
//   The original T077 lint pin verified the TYPE DECLARATION of
//   `QueueProjection.orderedItems` (a required `readonly QueueItem[]`),
//   but did not detect that the snapshot-construction site at
//   `repo/src/ui/sidebar/state-projector.ts:812` used `as QueueProjection`
//   to bypass field-completeness checking. The cast quietly produced a
//   `QueueProjection`-typed value at compile time that lacked the
//   required `orderedItems` field at runtime; the webview's `?? []`
//   fallback then yielded an empty array, and the dashboard's Active
//   Queue panel rendered the empty-state placeholder ("☕ The queue is
//   waiting for your next big idea.") even while a pipeline phase was
//   actively running.
//
// Contract enforced here:
//   No `.ts` file under `repo/src/**/*.ts` may contain the literal text
//   `as QueueProjection`. Cast removal at the snapshot-construction
//   site (T084) means the TypeScript compiler statically enforces
//   field-completeness against the `QueueProjection` interface; this
//   lint baselines that enforcement at zero casts.
//
// Allowlist mechanism:
//   A line carrying the inline comment marker
//   `// @lint-allow-queueprojection-cast: <reason>` is exempted from the
//   prohibition. The `<reason>` MUST be non-empty (e.g.,
//   "test fixture", "documented IPC boundary", etc.) so reviewers can
//   verify the field-completeness invariant holds at the cast site.
//   Any future use of the cast MUST be justified inline.
//
// This test follows the established repo-grep pattern from
// `tests/lint/no-inline-reorder-ipc.test.ts`.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { linesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src');

const ALLOW_MARKER = '@lint-allow-queueprojection-cast:';

interface CastMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function scanForCasts(): readonly CastMatch[] {
  // Iterated structurally rather than flattened to `file:line:text` and split
  // back apart. `source-scan.ts` returns `{ file, line, text }` precisely because
  // every `-n` caller used to round-trip through a colon-joined string, and a
  // Windows absolute path has a colon after the drive letter: `C:\repo\x.ts`
  // re-parsed that way yields file `C`, line `NaN`, and a text field with a
  // stray `\d+:` glued on. The pass/fail verdict survived that; the failure
  // message a contributor reads on the Windows leg did not — and the Windows leg
  // is what the move off `grep` was for.
  return linesMatching(SCAN_ROOT, 'as QueueProjection', {
    fixed: true,
    extensions: ['.ts']
  }).map(({ file, line, text }) => ({
    file: file.startsWith(`${REPO_ROOT}/`) ? file.slice(REPO_ROOT.length + 1) : file,
    line,
    text: text.trim()
  }));
}

// A grep hit only counts as a real cast when `as QueueProjection` appears
// in code context (preceding char is `)`, `}`, `]`, alphanumeric, or `_`),
// not inside a comment or backtick-quoted prose. Without this filter, the
// lint flags its own documentation (e.g., the BUG-010 explanatory comment
// in `state-projector.ts` that names the cast it explicitly removed).
function isCastInCode(lineText: string): boolean {
  const castIdx = lineText.indexOf('as QueueProjection');
  if (castIdx === -1) return false;
  const lineCommentIdx = lineText.indexOf('//');
  if (lineCommentIdx !== -1 && lineCommentIdx < castIdx) return false;
  // Block-comment lines from a multi-line comment block typically begin
  // with a leading `*` (e.g., ` * BUG-010 (2026-05-24): No \`as
  // QueueProjection\` cast here.`). Skip those.
  const trimmed = lineText.trimStart();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
  // The cast must follow an expression terminator or identifier char.
  const preceding = lineText.slice(0, castIdx).trimEnd();
  if (preceding.length === 0) return false;
  const lastChar = preceding[preceding.length - 1];
  if (lastChar === '`') return false;
  return /[)\]}A-Za-z0-9_]/.test(lastChar);
}

function isAllowed(match: CastMatch): boolean {
  if (!match.text.includes(ALLOW_MARKER)) return false;
  // The marker MUST be followed by a non-empty reason string. We extract
  // the substring after the marker and trim it; an empty (or
  // whitespace-only) reason fails the allowlist check.
  const idx = match.text.indexOf(ALLOW_MARKER);
  const reason = match.text.slice(idx + ALLOW_MARKER.length).trim();
  return reason.length > 0;
}

describe('Feature 065 BUG-010 T086 — no `as QueueProjection` cast in repo/src/**/*.ts', () => {
  it('does not contain any unallowlisted `as QueueProjection` cast', () => {
    const matches = scanForCasts();
    const offenders = matches.filter((match) => !isAllowed(match));
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Found ${offenders.length} \`as QueueProjection\` cast(s) without the required allowlist marker:\n` +
            offenders
              .map(
                (offender) =>
                  `  ${offender.file}:${offender.line}\n    ${offender.text.trim()}\n` +
                  `    (add \`// ${ALLOW_MARKER} <reason>\` on the same line to allowlist, with a non-empty reason)`
              )
              .join('\n')
    ).toEqual([]);
  });

  it('after T084, the codebase has zero `as QueueProjection` casts (baseline)', () => {
    // BUG-010 baseline assertion: T084 removed the sole `as QueueProjection`
    // cast at `repo/src/ui/sidebar/state-projector.ts`. The codebase
    // SHOULD now have zero casts of this type. Any addition of a cast
    // (allowlisted or not) flips this assertion and forces a deliberate
    // review of the field-completeness invariant.
    const matches = scanForCasts();
    expect(
      matches,
      matches.length === 0
        ? ''
        : `Baseline broken: \`as QueueProjection\` cast reintroduced at:\n` +
            matches
              .map((m) => `  ${m.file}:${m.line}\n    ${m.text.trim()}`)
              .join('\n')
    ).toEqual([]);
  });

  it('the allowlist marker requires a non-empty reason string', () => {
    // Self-test: an empty reason MUST NOT pass the allowlist filter.
    // This guards against a future change that weakens the marker
    // semantics (e.g., accepting `// @lint-allow-queueprojection-cast:`
    // with no reason).
    const fakeMatch: CastMatch = {
      file: 'fake.ts',
      line: 1,
      text: '  foo as QueueProjection; // @lint-allow-queueprojection-cast: '
    };
    expect(isAllowed(fakeMatch)).toBe(false);

    const fakeMatchWithReason: CastMatch = {
      file: 'fake.ts',
      line: 1,
      text: '  foo as QueueProjection; // @lint-allow-queueprojection-cast: documented'
    };
    expect(isAllowed(fakeMatchWithReason)).toBe(true);
  });

  it('the state-projector.ts construction site no longer uses the cast (T084 regression guard)', () => {
    // BUG-010 root cause site. After T084, this file MUST NOT contain
    // an actual `as QueueProjection` cast expression. The comment-aware
    // scanner above already enforces this across all of src/; this
    // assertion narrows the guard to the original offender for clearer
    // diagnostics when the regression recurs at the same site.
    const stateProjectorPath = resolve(
      REPO_ROOT,
      'src/ui/sidebar/state-projector.ts'
    );
    const src = readFileSync(stateProjectorPath, 'utf8');
    const offenders = src
      .split('\n')
      .map((text, idx) => ({ file: stateProjectorPath, line: idx + 1, text }))
      .filter((entry) => entry.text.includes('as QueueProjection'))
      .filter((entry) => isCastInCode(entry.text));
    expect(
      offenders,
      `state-projector.ts contains \`as QueueProjection\` cast(s):\n` +
        offenders
          .map((entry) => `  line ${entry.line}: ${entry.text.trim()}`)
          .join('\n')
    ).toEqual([]);
  });
});
