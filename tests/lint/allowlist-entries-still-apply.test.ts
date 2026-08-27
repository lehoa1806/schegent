// An exemption must still be excusing something.
//
// `lint-anchor-grounding.test.ts` is the outside view for a lint suite's path
// claims, and it already catches an allowlist entry naming a file that no longer
// EXISTS. This is the case it cannot see: the file is still there, and no longer
// does the thing it was excused for.
//
// That is a live defect, not a tidiness question. An allowlist entry is a
// standing permission attached to a path. When the reason expires, the
// permission does not — the path keeps its exemption, and the next author to put
// a violation in that file finds it pre-excused by a decision nobody made about
// their code.
//
// Eight such entries existed on 2026-08-23:
//
//   * `no-running-state-literal` excused four files — `state-projector.ts`,
//     `state-projector-runtime.ts`, `sidebar-ipc.ts` and
//     `MetricsDashboard.svelte` — for a `running` literal none of them still
//     contained. All four sat in a bare block with no per-entry rationale, which
//     is how an exemption outlives its reason unnoticed.
//   * `queue-lifecycle-literal-allowlist` excused three more for the same
//     literal.
//   * `no-inline-save-general-settings` excused `messages.ts` for a constant it
//     no longer carries. That one is a pattern rather than an accident: several
//     gates allowlist the messages shim by habit, and three of them were found
//     the same day excusing it for constants it does not reference.
//
// The first four were found by making one gate assert its own allowlist. This
// file generalises that, so the next one is found without anyone thinking to
// look.
//
// SCOPE, stated because it is narrow. This checks gates it can read
// unambiguously: exactly one fixed-string scan pattern, and an allowlist of
// repo-relative paths. Gates with several patterns, a computed pattern, or a
// regex are skipped — a wrong claim about which pattern excuses which file
// would be worse than no claim. So a clean run here does NOT mean no stale
// exemptions remain; it means none remain among the entries this can check.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const LINT_DIR = resolve(__dirname);
const SELF = 'allowlist-entries-still-apply.test.ts';

/** Repo-relative source paths a gate names, as string literals. */
const ALLOWLIST_PATH = /['"]((?:src|webview-ui)\/[\w./-]+\.(?:ts|svelte))['"]/g;

/**
 * A fixed-string scan: `filesMatching(root, 'LITERAL', { fixed: true })`. Both
 * quote styles, because this suite uses both and an earlier version of this
 * regex read only single quotes — which silently halved the set it checked and
 * would have reported compliance over the smaller half.
 *
 * FR-R3-121 follow-up (2026-08-27) — two more shapes, for the same reason. Ten
 * inline-IPC gates now reach the scan through `matchingRelativePaths(repoRoot,
 * root, 'LITERAL')` or the thin local `matchRel('LITERAL')` that wraps it. Read
 * only the original form, this check found 2 gates where it expects at least 3
 * and said so — an idiom change is invisible to a regex that predates it.
 */
const FIXED_SCAN =
  /(?:(?:files|lines)Matching\([^,]+,|matchingRelativePaths\([^,]+,[^,]+,|\bmatchRel\()\s*['"]([^'"]{4,60})['"]/g;

/** Characters that make a pattern a regex rather than a literal. */
const REGEX_CHARS = /[[\]()\\|*+^$]/;

interface Stale {
  readonly gate: string;
  readonly file: string;
  readonly pattern: string;
}

function gateFiles(): readonly string[] {
  return filesUnder(LINT_DIR, { extensions: ['.ts'] })
    .map((abs) => abs.slice(LINT_DIR.length + 1))
    .filter((name) => name.endsWith('.test.ts') && name !== SELF)
    .sort();
}

/** Source with `//` comments stripped, so prose citations are not read as claims. */
function code(gate: string): string {
  return readFileSync(resolve(LINT_DIR, gate), 'utf8').replace(/\/\/.*/g, '');
}

/** Gates carrying exactly one fixed pattern and at least one allowlisted path. */
function checkableGates(): readonly { gate: string; pattern: string; paths: string[] }[] {
  const out: { gate: string; pattern: string; paths: string[] }[] = [];
  for (const gate of gateFiles()) {
    const src = code(gate);
    const patterns = new Set([...src.matchAll(FIXED_SCAN)].map((m) => m[1]));
    if (patterns.size !== 1) continue;
    const pattern = [...patterns][0];
    if (REGEX_CHARS.test(pattern)) continue;
    const paths = [...new Set([...src.matchAll(ALLOWLIST_PATH)].map((m) => m[1]))]
      .filter((p) => existsSync(resolve(REPO_ROOT, p)))
      .sort();
    if (paths.length > 0) out.push({ gate, pattern, paths });
  }
  return out;
}

/**
 * FR-R3-088 §3 — every path claim in the directory, checkable or not.
 *
 * The reviewer brief's measurement: this gate checks **69 of the 316** path
 * claims made across 62 gates, "because only gates with exactly one fixed-string
 * pattern can be read unambiguously. A clean run says nothing about the other
 * 247."
 *
 * That is a true and load-bearing limit, and until now it lived only in a
 * comment. FR-R3-088 requires the fraction **in the gate's own output**, so a
 * clean run cannot be read as a clean sweep. The numbers below are re-derived on
 * every run rather than transcribed — the brief first stated "roughly 319" from
 * a sweep it did not repeat, and re-measuring gave 316. A number stated once and
 * not re-derived was wrong by three, which is the smallest possible version of
 * what this whole round is about.
 */
function allPathClaims(): number {
  let total = 0;
  for (const gate of gateFiles()) {
    total += [...code(gate).matchAll(ALLOWLIST_PATH)].length;
  }
  return total;
}

describe('an allowlist entry still excuses something', () => {
  it('prints how many path claims it checked, out of how many exist', () => {
    const checkable = checkableGates();
    const checked = checkable.reduce((sum, entry) => sum + entry.paths.length, 0);
    const total = allPathClaims();
    const gatesWithClaims = gateFiles().filter(
      (gate) => [...code(gate).matchAll(ALLOWLIST_PATH)].length > 0
    ).length;

    process.stdout.write(
      `\n[allowlist-entries-still-apply] coverage:\n` +
        `  checked ${checked} of ${total} path claim(s) ` +
        `(${total === 0 ? '0.0' : ((checked / total) * 100).toFixed(1)}%) ` +
        `across ${gatesWithClaims} gate(s) that make one\n` +
        `  readable gates: ${checkable.length} — a gate is readable only when it has EXACTLY ONE\n` +
        `  fixed-string scan pattern. Gates with several patterns, a computed pattern, or a regex\n` +
        `  are SKIPPED: a wrong claim about which pattern excuses which file would be worse than\n` +
        `  no claim.\n` +
        `  A clean run here does NOT mean no stale exemptions remain. It means none remain among\n` +
        `  the ${checked} entries this can check.\n`
    );

    // The fraction is reported, not thresholded. A floor here would create
    // pressure to shrink the denominator, which is the failure FR-R3-088 names.
    expect(total).toBeGreaterThan(checked - 1);
    expect(checked).toBeGreaterThan(0);
  });

  it('finds gates it can check, so an empty sweep cannot read as compliance', () => {
    const gates = checkableGates();
    expect(
      gates.length,
      'No gate matched the shape this check reads (one fixed pattern plus a path ' +
        'allowlist). Either the suite changed idiom or the extraction broke — both ' +
        'mean the assertion below is passing over an empty set.'
    ).toBeGreaterThanOrEqual(3);
    const entries = gates.reduce((sum, g) => sum + g.paths.length, 0);
    expect(
      entries,
      'Fewer allowlist entries were extracted than this suite is known to carry. ' +
        'The extraction has narrowed, and a narrower sweep reports compliance over ' +
        'the part it stopped reading.'
    ).toBeGreaterThan(40);
  });

  it('every checkable allowlist entry still contains what it is excused for', () => {
    const stale: Stale[] = [];
    for (const { gate, pattern, paths } of checkableGates()) {
      for (const file of paths) {
        if (!readFileSync(resolve(REPO_ROOT, file), 'utf8').includes(pattern)) {
          stale.push({ gate, file, pattern });
        }
      }
    }
    expect(
      stale.map((s) => `${s.gate}: ${s.file} no longer contains ${s.pattern}`),
      `These files are allowlisted for something they no longer do:\n  ` +
        stale.map((s) => `${s.gate}: ${s.file} — ${s.pattern}`).join('\n  ') +
        `\n\nRemove the entry. Until it goes, that path keeps a standing permission ` +
        `whose reason has expired, and the next violation written there is ` +
        `pre-excused by a decision nobody made about it.`
    ).toEqual([]);
  });

  it('the extraction reads a real gate correctly', () => {
    // Proves the two regexes still match this suite's idiom. Without it, an
    // extraction that silently stops matching reports every gate as compliant —
    // which is the defect this whole directory now guards against by default.
    // A REAL constant, deliberately. `lint-anchor-grounding.test.ts` treats an
    // IPC-shaped name in a lint file as a claim that the name exists, and fails
    // when it does not — a lint scanning for a renamed constant can never find
    // an offender. A made-up `CMD_REORDER` in this fixture tripped exactly that,
    // correctly. `CMD_REORDER_TASK` is what `no-inline-reorder-ipc` scans for.
    const src = "filesMatching(SCAN_ROOT, 'CMD_REORDER_TASK', { fixed: true })";
    expect([...src.matchAll(FIXED_SCAN)].map((m) => m[1])).toEqual(['CMD_REORDER_TASK']);
    const allow = "const ALLOWED = new Set(['webview-ui/src/lib/reorder-task.ts']);";
    expect([...allow.matchAll(ALLOWLIST_PATH)].map((m) => m[1])).toEqual([
      'webview-ui/src/lib/reorder-task.ts'
    ]);
    // A regex pattern must be rejected rather than compared as a literal.
    expect(REGEX_CHARS.test('appendFile.*syslog')).toBe(true);
    expect(REGEX_CHARS.test('CMD_REORDER_TASK')).toBe(false);
  });
});
