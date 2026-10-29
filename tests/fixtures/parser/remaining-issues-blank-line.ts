/**
 * FR-R4-F15 (feature 243, contract T5) — a phase that writes `Remaining issues:`, then one blank
 * line, then two tagged bullets, and no other contract block.
 *
 * WHAT TODAY'S PARSER DOES WITH IT. `extractRemainingIssues` stops at the first blank line after the
 * heading, so it reads no bullet at all. With no termination token and no open questions either, no
 * contract block is present, and the parser substitutes its own issue: `tag: 'constitution'`,
 * `summary: 'no contract block detected'`. FR-R4-F15 marks that issue `source: 'host'`, which is how
 * a record can tell it from an agent bullet that happens to carry the same tag.
 *
 * WHO OWNS THE EXPECTED VALUE. FR-R4-104 (FR-R4-F12) owns parser semantics, and with them
 * `expectedParse`. The provenance field is FR-R4-F15's. When F12 changes how the parser reads a blank
 * line, it updates `expectedParse` here and FR-R4-F15's test follows: the record test imports this
 * fixture precisely so that the record's behavior is the parser's, and is not a second copy of it.
 * That shared-fixture arrangement is the one the FR-R4-F15 filing asks for ("share the expected
 * parse fixture with F12 / 104"); F12 was pending when this file was created (research R14).
 *
 * `expectedParse` is the parse of `stdout` with `exitCode: 0`, empty stderr, no audit entry, no audit
 * warnings, no declared evidence policy, no region and no turn-end facts. The `warnings` entry is the
 * missing-audit-log warning the parser pushes for a null audit entry under the default policy.
 */

/** The phase's stdout: the heading, one blank line, then two bullets the parser does not read. */
export const stdout = [
  'The phase is done.',
  '',
  'Remaining issues:',
  '',
  '- [regression] one case in the cap suite still fails',
  '- [needs-decision] pick a retry budget for the flaky probe',
  ''
].join('\n');

/** What `parseInvocation` returns for `stdout` under the inputs the header names. */
export const expectedParse = {
  kind: 'remaining_issues',
  issues: [{ tag: 'constitution', summary: 'no contract block detected', source: 'host' }],
  auditEntry: null,
  warnings: ['[constitution] missing audit log']
} as const;

/** The two bullet texts, so a test can assert that neither reached a record. */
export const unreadBulletTexts = [
  'one case in the cap suite still fails',
  'pick a retry budget for the flaky probe'
] as const;
