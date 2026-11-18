import { describe, expect, it } from 'vitest';
import { splitAtJoins } from '../split-at-joins';

describe('splitAtJoins — where a long word in a host sentence may break', () => {
  it('starts a run at each dot of a setting key', () => {
    expect(splitAtJoins("Add 'claude' to 'sample.section.longSettingKey' to accept it.")).toEqual([
      "Add 'claude' to 'sample",
      '.section',
      ".longSettingKey' to accept it."
    ]);
  });

  it('starts a run at each slash and dot of a file path', () => {
    expect(splitAtJoins('See docs/operations/untrusted-repositories.md.')).toEqual([
      'See docs',
      '/operations',
      '/untrusted-repositories',
      '.md.'
    ]);
  });

  it('leaves alone a dot or slash at a word’s edge, beside another or as a decimal point', () => {
    for (const text of [
      'This entry grants nothing. Supported ids are claude, codex, agy.',
      'a .hidden file',
      'and/ or',
      'wait... then',
      'a // b',
      'between 1.5 and 2.25',
      ''
    ]) {
      expect(splitAtJoins(text)).toEqual([text]);
    }
  });

  it('gives back the sentence it was given when its runs are joined', () => {
    const sentence = "'x.y.z' and docs/a/b.md, then e.g. 1.5 and https://example.com/a";
    expect(splitAtJoins(sentence).join('')).toBe(sentence);
  });
});
