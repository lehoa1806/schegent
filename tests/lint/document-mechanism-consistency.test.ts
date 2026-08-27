import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * FR-R3-116 / FR-025 — **no shipped document may deny a mechanism the tree exports.**
 *
 * WHY THIS CLASS OF GATE DID NOT EXIST.
 *
 * FR-R3-112 landed the audit hash chain. `src/audit/audit-chain.ts` shipped, it was
 * wired into the writer, and `npm run audit:verify` shipped with it. Five documents
 * went on saying the log had no chain — and one of them,
 * `docs/security/threat-model.md`, asserted the chain at line 22, denied it at line
 * 70, and asserted it again at line 163. A reader who found line 70 concluded the
 * control was absent. A reader who found the contradiction could not tell which
 * half was current.
 *
 * Roughly 141 lint gates were green throughout, and a pre-push liveness check
 * resolved every backticked source path in both envelope documents. None of that
 * could have caught it: the machinery checks **path liveness** and **constant
 * parity** — whether a cited path exists, whether two copies of a literal agree. It
 * had no instrument for **semantic claim consistency**: whether a document asserts
 * something the tree contradicts. The five sentences were where the blind spot
 * surfaced; the blind spot is the finding.
 *
 * WHY A GATE RATHER THAN A PROOFREAD. A proofread fixes five sentences. It does not
 * change the fact that a mechanism can land and four documents describing its
 * absence can stay shipped with a full gate chain green, which is what happened.
 * The next mechanism lands the same way unless something checks the class. This is
 * the argument FR-R3-113 made about advisory stages, applied to prose.
 *
 * WHAT THIS GATE IS NOT — and this is load-bearing, not modesty. It is a
 * **seeded-pair detector**. It knows three mechanisms and the shapes of sentence
 * that deny them. It cannot detect arbitrary contradiction between two documents,
 * it does not parse prose, and it will not notice a denial phrased outside its
 * regexes. A gate that overstated its own reach would be the exact defect this
 * feature exists to close, reproduced inside the fix.
 *
 * SCOPE: THE EXECUTION REPOSITORY'S OWN DOCUMENTS. The planning envelope is
 * deliberately excluded. Its `docs/audits/` and `docs/features/` exist to QUOTE
 * claims — an audit that reproduces a false sentence in order to report it is doing
 * its job, and the review that produced this very item quotes all five denials
 * verbatim. Scanning them would make the gate fail on the document that asked for
 * the gate. "Shipped" therefore means what the extension ships: `repo/`.
 *
 * A DENIAL IS NOT A LIMIT. Every corrected document in this feature states the
 * mechanism's *limit* — tampering is evident, not impossible; the chain head sits
 * on the same disk. Those sentences must pass. The corrected tree is therefore this
 * gate's own negative fixture: if it flags corrected text, the regex is wrong, not
 * the text.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

interface MechanismSeed {
  /** Stable id, used in failure output and by the self-test. */
  readonly id: string;
  /** The mechanism: a module in this tree and a symbol it exports. */
  readonly mechanism: { readonly module: string; readonly export: string };
  /** Sentence shapes that assert the mechanism is ABSENT. */
  readonly denials: readonly RegExp[];
  /** Document roots scanned for this seed, repo-relative. */
  readonly scope: readonly string[];
  /** FR-027 — why this pair, recorded rather than assumed. */
  readonly why: string;
}

/**
 * THE THREE SEEDS, and why each was chosen (FR-027).
 *
 * The selection rule: a mechanism with a named export that is unambiguously
 * present, and a denial with a recognisable textual form. A mechanism whose
 * presence is a matter of degree, or whose absence is phrased freely, cannot be
 * seeded without producing false positives — and a gate that cries wolf is deleted.
 */
const SEEDS: readonly MechanismSeed[] = [
  {
    id: 'audit-chain',
    mechanism: { module: 'src/audit/audit-chain.ts', export: 'digestOf' },
    denials: [
      /\b(?:has|have|with|is|are|carries|carry|provides?)\s+no\s+(?:signature\s+or\s+)?hash\s+chain\b/i,
      /\bneither\s+hashes\s+the\s+log\s+as\s+a\s+chain\b/i,
      /\b(?:log|file|format|ledger)\s+is\s+not\s+tamper-evident\b/i,
      /\bnot\s+a\s+tamper-evident\s+(?:guarantee|ledger)\b/i,
      /\bno\s+chain,?\s+signature\s+or\s+post-write\s+detection\b/i
    ],
    scope: ['docs', 'ARCHITECTURE.md', 'SECURITY.md', 'README.md', 'RELEASE.md'],
    why:
      'The pair that produced the finding. Five shipped documents denied it, one of them ' +
      'twice-contradicting itself, while the mechanism was wired and its verifier shipped.'
  },
  {
    id: 'process-tree',
    mechanism: { module: 'src/runner/process-tree.ts', export: 'signalProcessTree' },
    denials: [
      /\bonly\s+the\s+direct\s+child\s+is\s+(?:signall?ed|killed|terminated)\b/i,
      /\bdoes\s+not\s+(?:signal|kill|terminate|reach)\s+(?:the\s+)?(?:whole\s+)?(?:process\s+)?(?:tree|group|descendants)\b/i,
      /\bdescendants?\s+(?:always\s+)?survive\s+(?:cancellation|termination)\b/i,
      /\bno\s+process[- ]tree\s+(?:termination|kill)\b/i
    ],
    scope: ['docs', 'ARCHITECTURE.md', 'README.md'],
    why:
      'Chosen because its true statement is PLATFORM-QUALIFIED — POSIX kills the group, ' +
      'Windows uses taskkill /T, and the tree-degradation report is deliberately not ' +
      'implemented on Windows. An unqualified denial is therefore a real defect and a ' +
      'qualified one is correct prose, which makes it a good test of whether the ' +
      'denial-versus-limit distinction actually holds.'
  },
  {
    id: 'ownership-fence',
    mechanism: { module: 'src/state/ownership-registry.ts', export: 'OwnershipRegistry' },
    denials: [
      /\bno\s+(?:workspace\s+)?ownership\s+fenc(?:e|ing)\b/i,
      /\bdoes\s+not\s+fence\s+(?:workspace\s+)?ownership\b/i,
      /\bconcurrent\s+windows?\s+(?:are\s+)?ungated\b/i,
      /\bnothing\s+prevents?\s+(?:two|multiple)\s+windows?\s+from\s+(?:owning|mutating)\b/i
    ],
    scope: ['docs', 'ARCHITECTURE.md', 'README.md'],
    why:
      'The third mechanism whose absence the tree used to claim and no longer can. Included ' +
      'so the gate covers a state-layer mechanism as well as an evidence one and a runner ' +
      'one, rather than three instances of the same shape.'
  }
];

function markdownUnder(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      markdownUnder(full, out);
      continue;
    }
    if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function documentsFor(seed: MechanismSeed): readonly string[] {
  const files: string[] = [];
  for (const entry of seed.scope) {
    const absolute = resolve(REPO_ROOT, entry);
    if (entry.endsWith('.md')) {
      if (existsSync(absolute)) files.push(absolute);
      continue;
    }
    markdownUnder(absolute, files);
  }
  return [...new Set(files)];
}

/**
 * A denial that is EXPLICITLY PAST TENSE is not a denial — it is history, and this
 * repository's convention (FR-R3-067) is to leave a superseded observation standing
 * and annotate it rather than rewrite it. `threat-model.md`'s T3 anchor says
 * "Until FR-R3-112 that was a write discipline and nothing more: ... there was no
 * chain, signature or post-write detection", which is both true and the clearest
 * explanation of the mechanism in the tree. A gate that forced that sentence out
 * would be destroying the documentation it exists to protect.
 *
 * The qualifier must be in the SAME sentence, not merely the same paragraph: a
 * paragraph-scoped rule lets one dated clause excuse an unrelated live denial
 * three sentences later.
 */
const HISTORICAL = [
  /\buntil\s+FR-[A-Z0-9-]+/i,
  /\bbefore\s+FR-[A-Z0-9-]+/i,
  /\bused\s+to\b/i,
  /\bno\s+longer\b/i,
  /\bpreviously\b/i,
  /\bwas\s+correct\s+(?:before|when)\b/i,
  /\bhistorical(?:ly)?\b/i,
  /\bsuperseded\b/i,
  /\buntil\s+then\b/i
] as const;

/**
 * Quoted material is not a claim the document makes.
 *
 * A document that reproduces a false sentence in order to REPORT it is doing its
 * job — `gate-integrity-measurements.md` quotes the very denials this gate was
 * built to catch, in the entry explaining why it was built. So a match inside a
 * fenced code block, a backticked span, or a double-quoted span is skipped. This
 * is the exclusion `single-platform-qualifier.sh` and `envelope-doc-liveness.sh`
 * already apply, adopted rather than re-decided.
 *
 * The failure mode of getting this wrong in the other direction — excusing a real
 * denial because someone wrapped it in quotes — is why the self-test plants its
 * denials as bare prose.
 */
function quotedSpans(text: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  for (const pattern of [/`[^`]*`/g, /"[^"]*"/g, /\u201c[^\u201d]*\u201d/g, /\*[^*\n]+\*/g]) {
    for (const match of text.matchAll(pattern)) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  return spans;
}

/** The sentence containing `index`, bounded by terminators rather than by line. */
function sentenceAround(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEndRaw = text.indexOf('\n', index);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const before = text.lastIndexOf('. ', index);
  const start = Math.max(lineStart, before === -1 ? lineStart : before + 1);
  const after = text.indexOf('. ', index);
  const end = Math.min(lineEnd, after === -1 ? lineEnd : after + 1);
  return text.slice(start, end);
}

interface Finding {
  readonly seed: string;
  readonly file: string;
  readonly line: number;
  readonly matched: string;
  readonly refutedBy: string;
}

/** Byte offsets of every fenced code block, over the whole document. */
function fencedSpans(text: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  const fence = /^[ \t]*```/gm;
  let open: number | null = null;
  for (const match of text.matchAll(fence)) {
    if (open === null) open = match.index;
    else {
      spans.push([open, match.index + match[0].length]);
      open = null;
    }
  }
  if (open !== null) spans.push([open, text.length]);
  return spans;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function scan(seed: MechanismSeed): readonly Finding[] {
  const findings: Finding[] = [];
  for (const absolute of documentsFor(seed)) {
    const text = readFileSync(absolute, 'utf8');
    // Whole-document offsets, not per-line. A quotation that opens on one line and
    // closes on the next is exactly the shape this file's own measurements entry
    // uses when it quotes the denials it exists to catch, and a line-scoped scan
    // cannot see it.
    const excluded = [...fencedSpans(text), ...quotedSpans(text)];
    const inExcluded = (index: number): boolean =>
      excluded.some(([from, to]) => index >= from && index < to);

    for (const denial of seed.denials) {
      const pattern = new RegExp(denial.source, denial.flags.includes('g') ? denial.flags : `${denial.flags}g`);
      for (const match of text.matchAll(pattern)) {
        if (inExcluded(match.index)) continue;
        const sentence = sentenceAround(text, match.index);
        if (HISTORICAL.some((marker) => marker.test(sentence))) continue;
        findings.push({
          seed: seed.id,
          file: relative(REPO_ROOT, absolute).split(/[/\\]/).join('/'),
          line: lineOf(text, match.index),
          matched: match[0],
          refutedBy: `${seed.mechanism.module} exports ${seed.mechanism.export}`
        });
      }
    }
  }
  return findings;
}

describe('no shipped document denies a mechanism the tree exports (FR-R3-116)', () => {
  it.each(SEEDS.map((seed) => [seed.id, seed] as const))(
    'the %s seed points at a mechanism that is actually here',
    (_id, seed) => {
      // A seed whose export has been deleted is a VACUOUS seed: it would scan for
      // denials of something that is in fact absent, and pass forever while saying
      // nothing. This is the check that stops the gate quietly emptying itself as
      // the tree moves underneath it.
      const module = resolve(REPO_ROOT, seed.mechanism.module);
      expect(existsSync(module), `${seed.id}: ${seed.mechanism.module} does not exist`).toBe(true);
      const body = readFileSync(module, 'utf8');
      expect(
        new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class|type|interface)\\s+${seed.mechanism.export}\\b`).test(body),
        `${seed.id}: ${seed.mechanism.module} no longer exports ${seed.mechanism.export}. ` +
          `Either the mechanism moved — repoint the seed — or it was removed, in which case ` +
          `the documents denying it became correct and this seed must go with it.`
      ).toBe(true);
    }
  );

  it.each(SEEDS.map((seed) => [seed.id, seed] as const))(
    'the %s seed scans a non-empty document set',
    (_id, seed) => {
      // Vacuity control per seed. A scope that resolves to nothing passes the
      // assertion below by measuring nothing.
      expect(documentsFor(seed).length, `${seed.id}: scanned no documents`).toBeGreaterThan(10);
    }
  );

  it('no document denies a shipped mechanism', () => {
    const findings = SEEDS.flatMap(scan);
    const report = findings.map(
      (finding) =>
        `[${finding.seed}] ${finding.file}:${finding.line} says "${finding.matched}" — ` +
        `refuted by ${finding.refutedBy}. State the mechanism's LIMIT if that is what you ` +
        `mean; do not assert its absence.`
    );
    // All findings, not the first: five documents were wrong at once last time.
    expect(report).toEqual([]);
  });
});
