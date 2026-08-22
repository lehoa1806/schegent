// Feature 029 T032 — Activity Feed render-path performance budget.
//
// Per research.md Decision 6 and the spec's "<150ms synchronous render"
// goal, this test exercises the dominant cost on the path from a raw
// `stream.jsonl` byte buffer to the renderable per-entry projections
// the UI consumes:
//
//   raw line  →  parseStreamJsonlBytes  (host: line-tokenisation +
//                                        JSON.parse, with skipped-line
//                                        recovery)
//             →  projectStreamJsonlLine (host: kind classification +
//                                        body shape extraction, incl.
//                                        the per-tool-call `toolArguments`
//                                        sanitization walk)
//             →  truncateDisplayEntryBody
//                                       (host: per-field byte cap)
//
// The webview-side helpers (`parseToolArguments`,
// `detectMetadataLinesFromSummary`, `detectAuditFooter`) are pure,
// O(n) over the per-entry body, and benchmarked alongside their
// component renderers by the unit tests under
// `webview-ui/src/.../__tests__/`. The cross-package boundary is
// CommonJS host ↔ ESM webview, so the perf test exercises only the
// host chain — but that chain dominates the budget on a 500-entry /
// ~100KB manifest because JSON.parse + projection are the heavy steps.
//
// Budget: end-to-end host work for a synthetic 500-entry manifest of
// mixed kinds (assistant-text incl. audit footer, tool-use,
// tool-result, system, result) MUST complete in <150 ms.

import { describe, it, expect } from 'vitest';
import { parseStreamJsonlBytes } from '../../src/services/phase-log/phase-log-jsonl-parser';
import { projectStreamJsonlLine } from '../../src/services/phase-log/phase-log-display-projector';
import { truncateDisplayEntryBody } from '../../src/services/phase-log/phase-log-truncator';
import type { PhaseLogDisplayEntry } from '../../src/services/phase-log/types';

const ENTRY_COUNT = 500;
const BUDGET_MS = 150;
const MIN_BYTES = 100_000;

function buildSyntheticLines(n: number): unknown[] {
  // A repeating mixed-kind shape that includes:
  //  - assistant-text with a fenced SCHEGENT AUDIT LOG footer
  //  - tool-use with a multi-line `content` argument (mimics Write)
  //  - tool-use with array + object args (mimics Edit-style)
  //  - tool-result
  //  - system init with cwd/session_id/model/tools
  //  - result with duration_ms/num_turns/total_cost_usd
  //  - truncated-head sentinel (not emitted by projector; instead we
  //    emit another assistant-text near the bottom carrying the audit
  //    footer)
  const lines: unknown[] = [];
  const multiLine = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: lorem ipsum dolor sit amet`).join('\n');
  const longArray = Array.from({ length: 12 }, (_, i) => `item-${i}`);
  for (let i = 0; i < n; i++) {
    const r = i % 6;
    if (r === 0) {
      lines.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `Assistant chunk ${i}: doing real work here…` }] }
      });
    } else if (r === 1) {
      lines.push({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: {
                file_path: `/repo/file-${i}.md`,
                content: multiLine,
                allowed_extensions: longArray
              }
            }
          ]
        }
      });
    } else if (r === 2) {
      lines.push({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: {
                file_path: `/repo/file-${i}.ts`,
                edits: [
                  { old_string: 'foo', new_string: 'bar' },
                  { old_string: 'baz', new_string: 'qux' }
                ],
                options: { dry_run: false, replace_all: false }
              }
            }
          ]
        }
      });
    } else if (r === 3) {
      lines.push({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: `id-${i}`,
              content: `Tool output ${i}: ok\nproduced 3 lines\ndone.`,
              is_error: false
            }
          ]
        }
      });
    } else if (r === 4) {
      lines.push({
        type: 'system',
        subtype: 'init',
        cwd: '/Users/dev/workspaces/schegent',
        session_id: `sess-${i}`,
        model: 'claude-opus-4-7',
        tools: 'Read,Write,Edit,Bash,Glob,Grep'
      });
    } else {
      lines.push({
        type: 'result',
        subtype: 'success',
        duration_ms: 1200 + i,
        num_turns: 3,
        total_cost_usd: 0.0042
      });
    }
  }
  // Append a synthetic assistant-text carrying an audit footer so the
  // detectAuditFooter scan has a real match in the path budget.
  lines.push({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text:
            'pipeline complete\n\n=== SCHEGENT AUDIT LOG ===\n' +
            '[SCHEGENT_STATUS: CLEAR]\n' +
            'phase: speckit-implement\nstatus: ok\n' +
            '=== END SCHEGENT AUDIT LOG ===\n'
        }
      ]
    }
  });
  return lines;
}

function bytesOf(lines: unknown[]): number {
  let total = 0;
  for (const line of lines) total += JSON.stringify(line).length + 1;
  return total;
}

const SAMPLES = 3;

/**
 * Elapsed time of the fastest of several samples, after a warmup call.
 *
 * FR-R3-042 — this assertion was a single cold measurement against a 150 ms
 * budget, and a single cold sample measures machine load as much as it measures
 * the render path: it pays V8 JIT warmup and, until this item, ran inside
 * `test:host` alongside eight thousand other tests competing for the same cores.
 *
 * The minimum is the standard robust statistic for "how fast can this go" —
 * scheduler preemption and GC can only ever make a sample slower, never faster.
 * It does not weaken what is being asserted: the property under test is that the
 * parse-project-truncate path is linear in input size, and a regression there is
 * a change in complexity rather than a few milliseconds. Such a regression cannot
 * hide behind the minimum of three samples.
 *
 * The same helper and the same reasoning are in `rate-limit-extractor.test.ts`,
 * which is the house pattern for a defensible timing statistic. The budget is
 * unchanged: this item changes the statistic, never the bound — a budget found
 * too tight is a separate decision with its own evidence, not something to
 * absorb into a de-duplication.
 */
function bestElapsedMs(work: () => void, samples = SAMPLES): number {
  work();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    work();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe('Feature 029 T032 — Activity Feed render-path perf budget', () => {
  it(`processes ${ENTRY_COUNT}-entry / ~100KB manifest in <${BUDGET_MS}ms`, () => {
    const rawLines = buildSyntheticLines(ENTRY_COUNT);
    const totalBytes = bytesOf(rawLines);
    expect(totalBytes).toBeGreaterThanOrEqual(MIN_BYTES);

    // Serialize to the same wire shape the host actually reads from
    // disk (newline-delimited JSON) so parseStreamJsonlBytes does its
    // real work.
    const wire = rawLines.map((l) => JSON.stringify(l)).join('\n') + '\n';

    // The whole render path, as one unit of work, so it can be sampled.
    let entries: PhaseLogDisplayEntry[] = [];
    const render = (): void => {
      const { parsedLines } = parseStreamJsonlBytes(wire, '');
      const built: PhaseLogDisplayEntry[] = [];
      for (const line of parsedLines) {
        const projected = projectStreamJsonlLine(line);
        if (projected === null) continue;
        built.push(truncateDisplayEntryBody(projected, { perFieldBytes: 4096 }));
      }
      entries = built;
    };

    const elapsed = bestElapsedMs(render);

    expect(entries.length).toBeGreaterThan(0);
    expect(
      elapsed,
      `best of ${SAMPLES} samples was ${elapsed.toFixed(2)} ms against a ${BUDGET_MS} ms budget`
    ).toBeLessThan(BUDGET_MS);
  });
});
