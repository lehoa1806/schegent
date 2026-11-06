// FR-R5-F19 (spec 278, T19.1, FR-004) — opening the decision record changes nothing a backend prompt reads.
//
// The resume prompt a Run sends is `run.resumePrompt`, read by the session dispatch policy. The record's text
// is the operator's to read; it must never become that input, a persisted field, or anything a prompt module
// can import. Two proofs, one behavioral and one structural:
//   - opening a record over a deep-frozen store and a Run holding a resume prompt writes to neither (a write
//     would throw), and the record text reaches the presenter and nowhere else;
//   - no prompt-side module imports the decision-record service, so a value cannot flow that way.
import { promises as fsp, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_RECORD_FILE } from '../../../src/contracts/decision-record';
import {
  createDecisionRecordOpener,
  type RowFeatureDir
} from '../../../src/services/decision-record/decision-record-open';

const FEATURE = 'specs/001-blocked';
const RECORD_TEXT = 'RECORD-TEXT-MARKER: approve the migration';
const RESUME_PROMPT = 'continue from the last checkpoint';

const PROMPT_SIDE_MODULES: readonly string[] = [
  'src/services/session-dispatch-policy.ts',
  'src/services/session-disposition.ts',
  'src/controller/incomplete-turn-resume.ts',
  'src/controller/phase-runner.ts'
];
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'decision-record-prompt-'));
  await fsp.mkdir(path.join(root, FEATURE), { recursive: true });
  await fsp.writeFile(path.join(root, FEATURE, DECISION_RECORD_FILE), RECORD_TEXT);
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('opening a record leaves the resume prompt input alone', () => {
  it('writes to no Run field, and shows the text to the presenter only', async () => {
    const run = deepFreeze({ id: 'run-1', featureDir: FEATURE, resumePrompt: RESUME_PROMPT });
    const before = JSON.stringify(run);
    const presented: string[] = [];
    const opener = createDecisionRecordOpener({
      workspaceRoot: root,
      isTrusted: () => true,
      featureDirOfRow: (): RowFeatureDir => ({ found: true, featureDir: run.featureDir }),
      present: async (text) => {
        presented.push(text);
      },
      logger: { warn: () => undefined }
    });

    const answer = await opener.open('row-1');

    expect(answer).toEqual({ outcome: 'opened' });
    expect(presented).toEqual([RECORD_TEXT]);
    expect(JSON.stringify(run)).toBe(before);
    expect(run.resumePrompt).toBe(RESUME_PROMPT);
    expect(JSON.stringify(answer)).not.toContain('RECORD-TEXT-MARKER');
    expect(JSON.stringify(answer)).not.toContain(FEATURE);
  });
});

describe('no prompt-side module can import the decision record', () => {
  it('control: each prompt-side module exists and is read', () => {
    for (const relative of PROMPT_SIDE_MODULES) {
      const text = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(text.length, relative).toBeGreaterThan(0);
    }
  });

  it.each(PROMPT_SIDE_MODULES)('%s does not import a decision-record module', (relative) => {
    const text = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
    expect(text).not.toMatch(/from\s+['"][^'"]*decision-record(?![a-z])[^'"]*['"]/);
    expect(text).not.toMatch(/require\(\s*['"][^'"]*decision-record(?![a-z])/);
  });

  it('the scan can fail: a fixture import of the service is matched', () => {
    const fixture = "import { createDecisionRecordOpener } from '../services/decision-record/decision-record-open';";
    expect(fixture).toMatch(/from\s+['"][^'"]*decision-record(?![a-z])[^'"]*['"]/);
  });
});
