// FR-R4-F06 (FR-013; L5; contract G, G5) -- no text calls a tool denial OS containment.
//
// WHY THIS EXISTS. A Phase's capability set is enforced by the BACKEND: a Claude `--disallowedTools` is the CLI's
// tool layer applying a denylist to itself, and only the vendor's own sandbox (`codex --sandbox`, `agy --sandbox`)
// is even claimed to sit below it. "OS/CLI-enforced containment" and "network sandbox" describe a boundary the
// operating system holds; saying them of a tool denial tells an operator they are protected by something that is
// not there, and the failure is silent: the Run starts, and the shell can still reach the network. The product
// had that wording in its capability architecture record and in the contract module's own header.
//
// WHAT FAILS. A phrase from FORBIDDEN, in a capability context, without a negation:
//
//   - `network` or `filesystem` followed by `containment`, `isolation` or `sandbox`; and
//   - `OS/CLI-enforced containment`, the exact phrase G5 retires.
//
// HOW "CAPABILITY CONTEXT" IS DECIDED. The phrase's paragraph (text between blank lines) mentions `capabilit` or
// `withhold`, or the file's own path contains `capabilit`. A page about audit-log rotation that says "filesystem
// containment" is not describing a Phase's capability and is not read.
//
// HOW "NEGATION" IS DECIDED. The phrase's SENTENCE (text between `.`, `!` or `?` and the next) contains one of
// not, no, never, neither, nor, without, cannot, or an `n't` contraction. "A tool denial is not filesystem
// isolation" passes and "the CLI gives you filesystem isolation" fails. This is a word list over a sentence, not
// a parse, and a sentence that negates something else while asserting the phrase would pass: the gate catches
// the shape the defect had, and a reviewer reads the rest.
//
// WHERE IT LOOKS. Every Markdown file under `repo/docs/`, `src/contracts/phase-capabilities.ts`, and the
// non-test sources of `webview-ui/src` (where the text an operator reads in a component lives).
//
// It is seeded: a positive fixture that must fail and a negated one that must pass, so a gate that stopped
// matching would be caught here and not by an operator.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

const FORBIDDEN = /(?:network|filesystem)\s+(?:containment|isolation|sandbox)|OS\/CLI-enforced\s+containment/gi;
const CAPABILITY_CONTEXT = /capabilit|withhold/i;
const NEGATION = /\b(?:not|no|never|neither|nor|without|cannot)\b|n't\b/i;

/** The sentences of one paragraph, each with its offset. */
function sentencesOf(paragraph: string): Array<{ readonly text: string; readonly start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  const boundary = /(?<=[.!?])\s+/g;
  let start = 0;
  for (const match of paragraph.matchAll(boundary)) {
    out.push({ text: paragraph.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  out.push({ text: paragraph.slice(start), start });
  return out;
}

function wordingViolations(text: string, path: string): string[] {
  const found: string[] = [];
  const pathIsCapability = /capabilit/i.test(path);
  let paragraphStart = 0;
  for (const paragraph of text.split(/\n\s*\n/)) {
    const inContext = pathIsCapability || CAPABILITY_CONTEXT.test(paragraph);
    if (inContext) {
      for (const sentence of sentencesOf(paragraph)) {
        FORBIDDEN.lastIndex = 0;
        const hit = FORBIDDEN.exec(sentence.text);
        if (hit === null || NEGATION.test(sentence.text)) continue;
        const line = text.slice(0, paragraphStart + sentence.start + hit.index).split('\n').length;
        found.push(`${path}:${line}: "${hit[0]}"`);
      }
    }
    paragraphStart += paragraph.length + 2;
  }
  return found;
}

function scannedFiles(): string[] {
  const docs = filesUnder(resolve(REPO_ROOT, 'docs'), { extensions: ['.md'] });
  const contract = [resolve(REPO_ROOT, 'src', 'contracts', 'phase-capabilities.ts')];
  const webview = filesUnder(resolve(REPO_ROOT, 'webview-ui', 'src'), {
    extensions: ['.svelte', '.ts'],
    skipDirectories: ['__tests__']
  }).filter((file) => !/\.test\.ts$/.test(file));
  return [...docs, ...contract, ...webview];
}

describe('no capability text calls a tool denial OS containment (L5)', () => {
  it('finds no unnegated phrase in the docs, the contract module or the webview strings', () => {
    const files = scannedFiles();
    // Vacuity control: a scan that found no files would pass.
    expect(files.length).toBeGreaterThan(100);
    const violations = files.flatMap((file) =>
      wordingViolations(readFileSync(file, 'utf8'), relative(REPO_ROOT, file))
    );
    expect(
      violations,
      'These lines tell an operator a tool denial is an operating-system boundary. A Claude restriction is a ' +
        "tool-access restriction, not OS isolation (docs/operations/backends.md, 'Per-phase capability sets'); " +
        'reword the line, or negate the claim, rather than adjusting this gate.'
    ).toEqual([]);
  });

  describe('the check itself (seeded)', () => {
    it('fails a positive fixture: a capability page that claims filesystem isolation', () => {
      const text = 'A Phase that withholds workspace-write gets filesystem isolation from the CLI.';
      expect(wordingViolations(text, 'docs/example.md')).toHaveLength(1);
    });

    it('fails the retired phrase in a capability context', () => {
      const text = '### Route A — OS/CLI-enforced containment, driven by a host-declared capability set';
      expect(wordingViolations(text, 'docs/architecture/agent-capability-posture.md')).toHaveLength(1);
    });

    it('passes a negated fixture: the same words, denied', () => {
      const text = 'A tool denial is not filesystem isolation, and a capability set provides no network sandbox.';
      expect(wordingViolations(text, 'docs/example.md')).toEqual([]);
    });

    it('passes a negation that follows the phrase in its sentence', () => {
      const text = 'The gap would close with a CLI-side network sandbox, which does not exist for a withheld capability.';
      expect(wordingViolations(text, 'docs/example.md')).toEqual([]);
    });

    it('does not read a paragraph that is not about capabilities', () => {
      const text = 'Rotation is refused when filesystem containment cannot be established for the log directory.';
      expect(wordingViolations(text, 'docs/operations/inspect-audit-logs.md')).toEqual([]);
    });

    it('reads a file whose own path is about capabilities, whatever the paragraph says', () => {
      const text = 'This route gives network containment.';
      expect(wordingViolations(text, 'docs/architecture/agent-capability-posture.md')).toHaveLength(1);
    });

    it('reports the line of the phrase', () => {
      const text = 'First line.\n\nA withheld capability gives network isolation.';
      expect(wordingViolations(text, 'docs/x.md')[0]).toMatch(/^docs\/x\.md:3:/);
    });
  });
});
