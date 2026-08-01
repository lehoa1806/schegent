import { describe, expect, it } from 'vitest';
describe('exact VSIX content policy', () => {
  it('accepts exactly the audited runtime/release files', async () => {
    const { ALLOWED_VSIX_ENTRIES, assertAllowedEntryNames } =
      await import('../../../scripts/check-vsix-smoke.mjs');
    expect(() => assertAllowedEntryNames(ALLOWED_VSIX_ENTRIES)).not.toThrow();
  });

  it('rejects a deliberate development-only junk file', async () => {
    const { ALLOWED_VSIX_ENTRIES, assertAllowedEntryNames } =
      await import('../../../scripts/check-vsix-smoke.mjs');
    expect(() =>
      assertAllowedEntryNames([
        ...ALLOWED_VSIX_ENTRIES,
        'extension/test_output.txt'
      ])
    ).toThrow(/unexpected packaged file extension\/test_output\.txt/);
  });

  it('rejects a missing runtime file and unsafe archive paths', async () => {
    const { ALLOWED_VSIX_ENTRIES, assertAllowedEntryNames } =
      await import('../../../scripts/check-vsix-smoke.mjs');
    expect(() =>
      assertAllowedEntryNames(
        ALLOWED_VSIX_ENTRIES.filter((name) => name !== 'extension/dist/extension.js')
      )
    ).toThrow(/missing required packaged file extension\/dist\/extension\.js/);
    expect(() =>
      assertAllowedEntryNames([...ALLOWED_VSIX_ENTRIES, '../outside'])
    ).toThrow(/unsafe ZIP entry path/);
  });
});
