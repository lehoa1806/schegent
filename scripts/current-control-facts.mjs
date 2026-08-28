/**
 * FR-R3-138 (FR-010, FR-014a, FR-017) — what release controls this repository
 * actually has is DERIVED from the tree, and stated in exactly one place.
 *
 * THE DEFECT THIS PREVENTS. `FR-R3-099` retired every hosted workflow: the
 * `.github/workflows` directory was deleted, and with it CodeQL, dependency review,
 * the scheduled `npm audit` and the hosted full gate. The documents that described
 * those controls were not all retired with them. A reader of `CONTRIBUTING.md`,
 * `SECURITY.md`, `RELEASE.md` and `docs/development/…` was told, in the present
 * tense, about controls that no longer run. Four documents each asserting the
 * current state of the same machinery is four chances to be wrong, and after a
 * retirement all four were.
 *
 * WHY A DERIVATION AND NOT A CORRECTION. Correcting the four pages fixes today and
 * guarantees nothing about the next retirement — the same class of defect has now
 * been introduced by `FR-R3-066`, `FR-R3-090` and `FR-R3-099` in turn. The facts
 * below are read out of the tree on every run, so the next deletion moves the
 * document instead of stranding it.
 *
 * THE TWO ABSENCE FACTS, and why they name a candidate set. `emitsChecksums` and
 * `emitsIndependentProvenance` are absences, and an absence measured over an
 * unstated candidate set can never flip — a claim shaped exactly like the vacuous
 * gates `tests/lint/gate-integrity/vacuity-detector.ts` exists to catch. Both are
 * therefore evaluated over a set this module states, returns, and lets its caller
 * assert on: the bodies of the npm scripts reachable from `release`, plus every
 * file under `scripts/`. Adding a producer to either half flips the fact, and
 * `tests/lint/current-control-claims.test.ts` proves that with a mutation rather
 * than asserting it.
 *
 * ONE AUTHORITY ON THE SCRIPT CLOSURE. `reachableScripts` is imported, not
 * reimplemented. A second npm-script walker is the duplicate-authority defect this
 * repository has removed three times; the gate entry point comes from the same
 * import for the same reason.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachableScripts, GATE_SCRIPT } from './check-gate-coverage-parity.mjs';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The markers that fence the derived block in the current-controls page. */
export const BLOCK_START = '<!-- BEGIN DERIVED: release-controls -->';
export const BLOCK_END = '<!-- END DERIVED: release-controls -->';

/** The page that carries the block. The single present-tense authority (FR-017). */
export const CONTROLS_DOC = 'docs/release/current-release-controls.md';

/** The entry point whose closure is the release pipeline. */
export const RELEASE_SCRIPT = 'release';

/**
 * A dependency audit anywhere in the attested gate's closure, by what it runs
 * rather than by what it is called. `security:audit` exists as a script; the
 * question an operator asks is whether the gate reaches an `npm audit`, and a
 * name-matched check would pass while a renamed script changed the answer.
 */
const RUNS_NPM_AUDIT = /\bnpm\s+(?:--prefix\s+\S+\s+)?audit\b/;

/** A producer of release checksums. Absent here; present the moment one is added. */
const EMITS_CHECKSUM = /sha256sum|\bshasum\b|createHash\(\s*['"`]sha(?:256|512)['"`]|checksums?\.txt|\.sha256\b/i;

/**
 * A producer of provenance a third party can verify, which the local gate
 * attestation deliberately is not — `scripts/gate-attestation.mjs` records that a
 * gate ran on this machine, and matching the bare word `attestation` would let that
 * local record answer a question about signed build provenance.
 */
const EMITS_PROVENANCE = /\bcosign\b|\bsigstore\b|in-toto|\bslsa\b|gh\s+attestation|actions\/attest|--provenance\b/i;

/**
 * Enforcement of the declared Node floor. Reading the floor is the necessary first
 * move of any enforcement, so a candidate file that reads `engines` counts, as does
 * npm's own install-time enforcement via `engine-strict`. Recording the running
 * version in a payload — `backend-canary-run.mjs` does — is not enforcement, which
 * is why the pattern is not `process.versions.node`.
 *
 * A *read* of the field, not the word, and of the `node` key rather than any key under
 * it. `\bengines\b` would be satisfied by any comment or message containing it, including
 * one explaining that nothing enforces the floor. `\.engines\b` alone would be satisfied
 * by a read of `engines.vscode`, which three files in this repository already do — that
 * is a floor on the editor, not on Node, and a `scripts/` file doing the same would have
 * made this page claim an enforced Node floor on the strength of an unrelated check.
 * Both mistakes point the same way, and it is the dangerous one: a true value here makes
 * the generated page assert a control that does not exist.
 */
const ENFORCES_ENGINES =
  /engine-strict\s*=\s*true|(?:\.engines\b|\[\s*['"`]engines['"`]\s*\]|['"`]engines['"`]\s*:)[^\n]{0,40}?\bnode\b/i;

const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

/**
 * This module, excluded from its own candidate set.
 *
 * The patterns above are written out as regex literals here, so a detector that
 * scanned itself would find `sha256sum` and `cosign` in its own source and report
 * that the repository produces both. The one exclusion is named rather than
 * pattern-based so it cannot quietly widen.
 */
const SELF = 'scripts/current-control-facts.mjs';

/** Every regular file under `scripts/`, repository-relative, sorted, minus this one. */
function scriptFiles(root) {
  const dir = resolve(root, 'scripts');
  let entries = [];
  try {
    entries = readdirSync(dir, { recursive: true });
  } catch {
    return [];
  }
  return entries
    .map((name) => join(dir, String(name)))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .map((path) => relative(root, path).split(sep).join('/'))
    .filter((path) => path !== SELF)
    .sort();
}

/** Workflow files as GitHub would count them: `.yml`/`.yaml` directly under the dir. */
function workflowFiles(root) {
  try {
    return readdirSync(resolve(root, '.github', 'workflows'))
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * `^22 || ^24` → `22`. The lowest major any alternative in the range admits.
 *
 * Per alternative, and only the first number in it. Taking the minimum of every digit
 * in the string reads `^22 || ^24` correctly and `>=22.11.0` as **0** — an ordinary
 * range, and the page would have printed "floor 0" the day someone wrote one.
 */
function floorFrom(range) {
  const majors = String(range ?? '')
    .split('||')
    .map((clause) => clause.match(/(\d+)/)?.[1])
    .filter((major) => major !== undefined)
    .map(Number);
  return majors.length === 0 ? null : String(Math.min(...majors));
}

/**
 * The facts, read out of the tree at `root`.
 *
 * `root` is a parameter rather than a constant so the mutation tests can build a
 * tree that has a checksum producer in it and prove the absence facts flip. A fact
 * that cannot be made false by any input is not a measurement.
 */
export function controlFacts(root = HERE) {
  const pkg = JSON.parse(read(resolve(root, 'package.json')) || '{}');
  const all = pkg.scripts ?? {};

  const gateClosure = reachableScripts(all, GATE_SCRIPT);
  const releaseClosure = reachableScripts(all, RELEASE_SCRIPT);

  // The stated candidate set for the two absence facts: the release closure's own
  // command bodies, plus every file under `scripts/`.
  const scriptBodies = releaseClosure
    .filter((name) => typeof all[name] === 'string')
    .map((name) => ({ id: `package.json#scripts.${name}`, text: all[name] }));
  const files = scriptFiles(root).map((path) => ({ id: path, text: read(resolve(root, path)) }));
  const candidates = [...scriptBodies, ...files];

  const matches = (pattern) => candidates.filter((c) => pattern.test(c.text)).map((c) => c.id);

  const npmrc = read(resolve(root, '.npmrc'));
  const nodeFloorEvidence = [
    ...matches(ENFORCES_ENGINES),
    ...(/engine-strict\s*=\s*true/.test(npmrc) ? ['.npmrc'] : [])
  ];

  const workflows = workflowFiles(root);
  const checksumEvidence = matches(EMITS_CHECKSUM);
  const provenanceEvidence = matches(EMITS_PROVENANCE);

  return {
    workflowFileCount: workflows.length,
    workflowFiles: workflows,
    auditInGateClosure: gateClosure.some((name) => RUNS_NPM_AUDIT.test(all[name] ?? '')),
    releaseReachesSbom: releaseClosure.includes('sbom'),
    emitsChecksums: checksumEvidence.length > 0,
    emitsIndependentProvenance: provenanceEvidence.length > 0,
    nodeFloor: floorFrom(pkg.engines?.node),
    nodeFloorRange: pkg.engines?.node ?? null,
    nodeFloorIsExecuted: nodeFloorEvidence.length > 0,
    // Returned so a caller can refuse a measurement taken over nothing.
    candidateSet: candidates.map((c) => c.id),
    evidence: {
      checksums: checksumEvidence,
      provenance: provenanceEvidence,
      nodeFloor: nodeFloorEvidence
    }
  };
}

const yesNo = (fact, yes, no) => (fact ? yes : no);

/** The block the current-controls page must carry, generated. */
export function renderControlBlock(facts) {
  const rows = [
    [
      'Hosted CI workflows',
      facts.workflowFileCount === 0
        ? 'None. The `.github/workflows` directory holds no workflow file, so no CodeQL scan, dependency review, scheduled audit or hosted gate runs on push, on pull request or on a schedule.'
        : `${facts.workflowFileCount} workflow file(s): ${facts.workflowFiles.map((f) => `\`${f}\``).join(', ')}.`
    ],
    [
      'Dependency audit in the attested gate',
      yesNo(
        facts.auditInGateClosure,
        `Reached. \`npm run ${GATE_SCRIPT}\` runs an \`npm audit\`.`,
        `Not reached. \`npm run ${GATE_SCRIPT}\` runs no \`npm audit\`; \`npm run security:audit\` exists and must be run deliberately.`
      )
    ],
    [
      'SBOM for a release',
      yesNo(
        facts.releaseReachesSbom,
        `Produced. \`npm run ${RELEASE_SCRIPT}\` reaches \`sbom\`, so packaging cannot skip it.`,
        `Not produced. \`npm run ${RELEASE_SCRIPT}\` does not reach \`sbom\`.`
      )
    ],
    [
      'Checksums for the released artifact',
      yesNo(
        facts.emitsChecksums,
        `Produced by ${facts.evidence.checksums.map((e) => `\`${e}\``).join(', ')}.`,
        'Not produced. Nothing in the release closure or in `scripts/` writes a digest for the packaged `.vsix`.'
      )
    ],
    [
      'Independently verifiable build provenance',
      yesNo(
        facts.emitsIndependentProvenance,
        `Produced by ${facts.evidence.provenance.map((e) => `\`${e}\``).join(', ')}.`,
        'Not produced. The gate attestation records that a gate ran on the releasing machine; it is a local record, not a signature a third party can verify.'
      )
    ],
    [
      'Node version floor',
      `Declared as \`${String(facts.nodeFloorRange).replaceAll('|', '\\|')}\` (floor ${facts.nodeFloor}). ` +
        yesNo(
          facts.nodeFloorIsExecuted,
          `Enforced by ${facts.evidence.nodeFloor.map((e) => `\`${e}\``).join(', ')}.`,
          'Not enforced: no executed check reads it, and `.npmrc` does not set `engine-strict`, so a release built on an older Node is refused by nothing.'
        )
    ]
  ];

  return [
    BLOCK_START,
    '',
    '<!-- Generated by scripts/current-control-facts.mjs. Do not edit by hand. -->',
    '',
    '| Control | State of this repository |',
    '|---|---|',
    ...rows.map(([control, state]) => `| ${control} | ${state} |`),
    '',
    `The two absence rows are measured over a stated candidate set — the ${facts.candidateSet.length} ` +
      'command bodies and files reachable from `npm run release` or living under `scripts/` — so adding ' +
      'a producer to either half changes the row rather than leaving it true by never having looked.',
    '',
    BLOCK_END
  ].join('\n');
}

/** Whether the page states exactly the facts, in both directions. */
export function decideControlParity(documentText, facts) {
  const start = documentText.indexOf(BLOCK_START);
  const end = documentText.indexOf(BLOCK_END);
  if (start === -1 || end === -1) {
    return {
      ok: false,
      reason: 'block-missing',
      message:
        `${CONTROLS_DOC} carries no derived release-controls block. Insert ${BLOCK_START} … ` +
        `${BLOCK_END} and run \`node scripts/current-control-facts.mjs --write\`.`
    };
  }
  const actual = documentText.slice(start, end + BLOCK_END.length);
  const expected = renderControlBlock(facts);
  if (actual.trim() !== expected.trim()) {
    return {
      ok: false,
      reason: 'drifted',
      message:
        `${CONTROLS_DOC} no longer states the controls this repository has. The tree is the ` +
        'authority; regenerate with `node scripts/current-control-facts.mjs --write`.'
    };
  }
  return { ok: true, facts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const facts = controlFacts(HERE);
  const docPath = resolve(HERE, CONTROLS_DOC);
  const text = read(docPath);
  if (process.argv.includes('--write')) {
    const start = text.indexOf(BLOCK_START);
    const end = text.indexOf(BLOCK_END);
    if (start === -1 || end === -1) {
      console.error(`${CONTROLS_DOC} carries no derived release-controls block to write into.`);
      process.exit(1);
    }
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      docPath,
      text.slice(0, start) + renderControlBlock(facts) + text.slice(end + BLOCK_END.length)
    );
    console.log(`release-controls block regenerated (${facts.candidateSet.length} candidates scanned).`);
    process.exit(0);
  }
  const verdict = decideControlParity(text, facts);
  if (!verdict.ok) {
    console.error(`release-controls parity: ${verdict.reason} — ${verdict.message}`);
    process.exit(1);
  }
  console.log('release-controls parity: ok.');
}
