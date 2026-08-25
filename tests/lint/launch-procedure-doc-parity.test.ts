// FR-R3-073 (feature 152) — two tutorials in one reading path asserted
// contradictory procedures for the same task, and no gate could see it.
//
// `user-quickstart.md` instructed F5 → **Run Extension** while the
// `developer-setup.md` it names as its prerequisite stated, with a verification
// marker, that no such launch configuration existed. The corpus contradicted
// itself in the reader's own path — which is what makes the class gateable
// rather than merely wrong. The resolution added the configuration; this gate
// holds all three surfaces to ONE procedure so the contradiction cannot regrow
// in either direction.
//
// Following `playwright-install-doc-parity.test.ts`: a named producer, a named
// surface list, and matching on fixed literals (the configuration name, the
// launch.json path, the absence sentence) rather than parsing prose — a gate
// that reads prose pressures authors to write worse prose.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The producer: the launch configuration the tutorials describe. */
const PRODUCER = '.vscode/launch.json';

/** The configuration name the quickstart instructs the reader to run. */
const CONFIGURATION_NAME = 'Run Extension';

/** The tutorials that describe the interactive launch procedure. */
const SURFACES = Object.freeze([
  'docs/tutorials/user-quickstart.md',
  'docs/tutorials/developer-setup.md'
]);

function read(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

describe('FR-R3-073 — the tutorials and the launch configuration state one procedure', () => {
  it('the producer exists and defines the named extension-host configuration', () => {
    // launch.json is JSONC (VS Code allows comments); strip line comments
    // before parsing rather than adding a JSONC dependency.
    const raw = read(PRODUCER)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const parsed = JSON.parse(raw) as {
      configurations?: ReadonlyArray<{ name?: string; type?: string; request?: string }>;
    };
    const configuration = (parsed.configurations ?? []).find(
      (candidate) => candidate.name === CONFIGURATION_NAME
    );
    expect(
      configuration,
      `${PRODUCER} must define a configuration named "${CONFIGURATION_NAME}" — it is the ` +
        'procedure the quickstart instructs; removing it re-creates the contradiction this ' +
        'gate was written for'
    ).toBeDefined();
    expect(configuration!.type).toBe('extensionHost');
    expect(configuration!.request).toBe('launch');
  });

  it('the quickstart names exactly the configuration the producer defines', () => {
    const quickstart = read('docs/tutorials/user-quickstart.md');
    expect(
      quickstart.includes(`**${CONFIGURATION_NAME}**`),
      'user-quickstart.md must name the Run Extension configuration; a renamed config with an ' +
        'unrenamed tutorial sends the reader hunting for a launch entry that is not there'
    ).toBe(true);
    expect(quickstart.includes('<kbd>F5</kbd>')).toBe(true);
  });

  it('developer-setup cites the producer and no surface asserts its absence', () => {
    expect(
      read('docs/tutorials/developer-setup.md').includes('`' + PRODUCER + '`'),
      'developer-setup.md must cite .vscode/launch.json as the interactive procedure it ' +
        'documents; it is the page the quickstart names as its prerequisite'
    ).toBe(true);
    // The contradiction's exact prior wording, pinned as forbidden on every
    // surface: a doc claiming the workflow "is not repository-documented" while
    // the producer exists is the two-procedures state this gate removes.
    for (const surface of SURFACES) {
      expect(
        read(surface).includes('is not repository-documented'),
        `${surface} asserts the interactive workflow is undocumented while ${PRODUCER} defines ` +
          'it — the exact contradiction FR-R3-073 removed'
      ).toBe(false);
    }
  });

  it('scanned both surfaces (non-vacuity)', () => {
    for (const surface of SURFACES) {
      expect(read(surface).length, `${surface} must exist and be non-trivial`).toBeGreaterThan(500);
    }
  });
});
