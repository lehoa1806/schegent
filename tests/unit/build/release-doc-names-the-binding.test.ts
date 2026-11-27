// FR-R3-100 follow-up — the release procedure names the command the release binding reads.
//
// THE DEFECT THIS REPLACES, and it is the same shape twice over. `check-docs.mjs` required
// `RELEASE.md` to contain the literal `npm run verify:all`, which was the pre-tag gate on the day
// that line was written. `GATE_COMMAND` moved to `npm run gate` when FR-R3-100 widened the
// perimeter, and the check went on passing a document that named the old command and never
// mentioned the new one. A gate pinned to the wrong string is worse than no gate: it reads as
// coverage while asserting nothing anybody depends on.
//
// It also missed the larger thing. Until 2026-08-27 `RELEASE.md` described GitHub Actions verifying,
// packaging, attesting and publishing the extension — a machine deleted a day earlier. A maintainer
// following it would have pushed a tag and waited for a release that could never appear. No gate
// caught that, because no gate asked whether the procedure described a process that exists.
//
// These cases ask the two questions that are machine-answerable: does the document name the command
// the binding actually checks for, and does it still describe the retired machine as current?
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const release = (): string => readFileSync(resolve(REPO_ROOT, 'RELEASE.md'), 'utf8');

let gateCommand: string;

beforeAll(async () => {
  ({ GATE_COMMAND: gateCommand } = await import('../../../scripts/gate-attestation.mjs'));
});

describe('the release procedure describes the release that exists', () => {
  it('names the attested command, derived from the binding', () => {
    expect(gateCommand.length, 'the binding must name a command').toBeGreaterThan(3);
    expect(
      release(),
      `RELEASE.md must name ${gateCommand} — the command require-local-gate.mjs matches exactly`
    ).toContain(gateCommand);
  });

  it('names the second binding, so a maintainer is not surprised by its refusal', () => {
    // `release:preflight` refuses on backend qualification as well as on the gate attestation. A
    // procedure that documents one of two refusals sends a maintainer to debug the wrong thing.
    const text = release();
    expect(text).toContain('npm run canary');
    expect(text).toContain('SCHEGENT_RELEASE_UNQUALIFIED');
  });

  it('does not present the retired Actions machinery as current', () => {
    // The claims that were live in this document until 2026-08-27. Each names something the tree
    // cannot do: there is no workflow to dispatch, no tag trigger, and no attestation to verify.
    //
    // Scoped to the sections that tell a maintainer what to DO. Section 5 lists what a release no
    // longer does, and quoting the retired verbs there is the point of it.
    const text = release();
    const procedure = text.slice(0, text.indexOf('## 5. What a release no longer does'));
    for (const claim of [
      'workflow_dispatch',
      'Pushing the tag is the deployment trigger',
      'gh attestation verify',
      'creates a durable GitHub Release'
    ]) {
      expect(
        procedure,
        `RELEASE.md still instructs a maintainer using "${claim}", which the retired workflows owned`
      ).not.toContain(claim);
    }
  });

  it('says plainly that a tag triggers nothing', () => {
    // The single most dangerous stale instruction was "push the tag and wait". Its replacement is
    // asserted rather than assumed, because silence here reads exactly like the old behaviour.
    expect(release()).toContain('The tag\ntriggers nothing.');
  });

  it('points at the two records rather than restating them', () => {
    const text = release();
    expect(text).toContain('withdrawn-ci-controls.md');
    expect(text).toContain('actions-terminal-record.md');
  });
});
