// FR-R5-F21 (FR-005): the failure message of the dependency-change scope gate. A moved range
// that the gate refuses is either an accident or an intentional change missing its companions;
// the message names those companions, so the second case is fixed in one pass rather than found
// one red gate at a time. The list is the one in `docs/release/held-major-upgrades.md`, section
// "Intentional dependency change".

/** The files an intentional range change updates in the same change, in the order to edit them. */
const COMPANION_EDITS: readonly string[] = [
  'the `PINNED` range in tests/lint/dependency-change-scope.test.ts',
  'the pin counts in .github/dependabot.yml and docs/operations/gate-recording.md, ' +
    'when the number of pinned ranges changes',
  "the package's row in docs/release/held-major-upgrades.md, when it is a held major",
  'package.json and package-lock.json',
  'webview-ui/package.json and webview-ui/package-lock.json, when the package is declared there'
];

/**
 * The message for one pinned range that no longer matches the manifest.
 *
 * @param name the package whose declared range moved
 * @param pinned the range the gate pins
 * @param actual the range the manifest now declares
 */
export function pinMismatchMessage(name: string, pinned: string, actual: string): string {
  const edits = COMPANION_EDITS.map((edit) => `  - ${edit}`).join('\n');
  return (
    `${name} is pinned at ${pinned} but the manifest declares ${actual}. ` +
    'If the move is an accident, restore the pinned range. If it is intended, it is its own change ' +
    'with its own verification, and per "Intentional dependency change" in ' +
    'docs/release/held-major-upgrades.md it updates, in the same change:\n' +
    edits
  );
}
