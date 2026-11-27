/**
 * Refuse a workflow that references a third-party action by anything but an
 * immutable 40-character commit SHA.
 *
 * FR-R3-099 / FR-R3-100 (FR-019) — this gate outlived the workflows it checks.
 * Item 099 retired GitHub Actions by operator decision and deleted all eight
 * workflow files, which left this script in two failure modes it was never
 * written for:
 *
 *   - `readdirSync` on an absent `.github/workflows` throws ENOENT, so the whole
 *     attested gate chain would fail on a repository that legitimately has no
 *     workflows. That is a gate refusing over its own subject being absent.
 *   - With the directory present but empty it printed `check passed (0
 *     workflows)` — the same words as a real pass. A control that cannot tell
 *     `verified` from `nothing to verify` is precisely the vacuity defect
 *     FR-R3-088 measured, and reporting it as a pass is how a gate becomes
 *     decoration.
 *
 * So the script keeps its place in the chain and says which of three things
 * happened. Its live job now is to refuse a *re-added* workflow that is not
 * pinned: Actions are off by decision, not by impossibility, and settings are
 * reversible by anyone with admin. The count is printed on every path so the
 * scope is declared rather than implied.
 *
 *   no workflows present   exit 0, named as such — not "passed"
 *   N workflows, pinned    exit 0 with the count
 *   any unpinned reference exit 1 naming file, line and reference
 */
import { readFileSync, readdirSync } from 'node:fs';

const WORKFLOW_DIR = '.github/workflows';

/** `uses: owner/action@ref` — `./local` actions are ours and carry no SHA. */
const USES = /\buses:\s*([^\s#]+)@([^\s#]+)/;
const IMMUTABLE_SHA = /^[0-9a-f]{40}$/;

let names;
try {
  names = readdirSync(WORKFLOW_DIR);
} catch (error) {
  // ENOENT is the expected state after FR-R3-099 and is NOT a failure. Anything
  // else — a permission error, a file where the directory should be — is
  // unanswerable, and an unanswerable check is a refusal, never a pass.
  if (error.code === 'ENOENT') {
    console.log(`Workflow action pin check: no workflows present, nothing to pin (${WORKFLOW_DIR} absent).`);
    process.exit(0);
  }
  console.error(`Workflow action pin check could not read ${WORKFLOW_DIR}: ${error.code ?? 'unknown error'}`);
  process.exit(1);
}

const workflows = names
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => `${WORKFLOW_DIR}/${name}`)
  .sort();

if (workflows.length === 0) {
  console.log(`Workflow action pin check: no workflows present, nothing to pin (${WORKFLOW_DIR} is empty).`);
  process.exit(0);
}

const failures = [];
for (const file of workflows) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    const match = line.match(USES);
    if (!match || match[1].startsWith('./')) continue;
    if (!IMMUTABLE_SHA.test(match[2])) {
      failures.push(`${file}:${index + 1}: ${match[1]}@${match[2]}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Workflow actions must use immutable 40-character commit SHAs:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log(`Workflow action pin check passed (${workflows.length} workflow(s), all pinned).`);
