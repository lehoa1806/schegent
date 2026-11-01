// FR-R4-F10 (contract L1; RD1; hard rule 23) -- drift guard for the secret-key-name word list.
//
// `AGENTS.md` names `src/lib/logger.ts` as the redaction set's home and forbids forking it. Two things
// in that file need to know which key names denote a secret: the pattern that removes a keyed value from
// a string (`password=...`), and `isSecretKeyName`, the predicate the structured walkers use on a record's
// own keys (`{ client_secret: ... }`). A word written in both places is how the two drift until one
// quietly stops covering a name, and a THIRD copy elsewhere under `src/` or `webview-ui/src/` is the
// fork the hard rule forbids. So: exactly one list, `SECRET_KEY_NAME_WORDS`, and every consumer derives
// from it.
//
// Modelled on `redaction-labels-single-source.test.ts`. It reports how many derivations it checked, so a
// vacuous pass (a rename that makes every check match nothing) is visible, and it proves it can fail:
// the fork detector is run over planted in-memory sources, one per shape it exists to catch.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SECRET_KEY_NAME_WORDS, isSecretKeyName } from '../../src/lib/logger';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCANNED_ROOTS = [path.join(REPO_ROOT, 'src'), path.join(REPO_ROOT, 'webview-ui', 'src')];
const HOME = path.join(REPO_ROOT, 'src', 'lib', 'logger.ts');
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.svelte', '.js', '.mjs'];
const MIN_FORK_WORDS = 3;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__') out.push(...sourceFiles(full));
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * What a fork of the word list looks like in `src`: a re-declaration of the exported name, an array
 * literal of three or more of its words, or an alternation or lookbehind spelling three or more of
 * them. Returns a short description for each, or an empty list.
 */
function findForks(src: string, words: ReadonlyArray<string>): string[] {
  const code = stripComments(src);
  const forks: string[] = [];
  if (/\b(?:const|let|var|function|class)\s+SECRET_KEY_NAME_WORDS\b/.test(code)) {
    forks.push('re-declares SECRET_KEY_NAME_WORDS');
  }
  for (const literal of code.match(/\[[^\]]{0,240}\]/g) ?? []) {
    const named = words.filter((word) => new RegExp(`['"\`]${word}['"\`]`, 'i').test(literal));
    if (named.length >= MIN_FORK_WORDS) forks.push(`an array of ${named.join(', ')}`);
  }
  const alternation = new RegExp(`(?:${words.join('|')})(?:\\|(?:${words.join('|')})){${MIN_FORK_WORDS - 1},}`, 'i');
  if (alternation.test(code)) forks.push('an alternation of the key-name words');
  return forks;
}

describe('redaction-key-names-single-source (RD1, hard rule 23)', () => {
  it('defines and exports the word list once, frozen, and the predicate beside it', () => {
    expect([...SECRET_KEY_NAME_WORDS]).toEqual(['password', 'passwd', 'pwd', 'secret', 'token']);
    expect(Object.isFrozen(SECRET_KEY_NAME_WORDS)).toBe(true);
    expect(typeof isSecretKeyName).toBe('function');
  });

  it('has no second declaration, array or alternation of the words anywhere else under src or webview-ui/src', () => {
    const files = SCANNED_ROOTS.flatMap(sourceFiles);
    expect(files.length, 'the scan found no source files, so it would pass for any tree').toBeGreaterThan(100);
    const forks: string[] = [];
    for (const file of files) {
      if (file === HOME) continue;
      for (const fork of findForks(fs.readFileSync(file, 'utf8'), SECRET_KEY_NAME_WORDS)) {
        forks.push(`${path.relative(REPO_ROOT, file)}: ${fork}`);
      }
    }
    expect(forks, 'the key-name words have one home (src/lib/logger.ts); these files spell them themselves').toEqual([]);
  });

  it('derives both consumers from the exported list, and reports how many derivations it checked', () => {
    const code = stripComments(fs.readFileSync(HOME, 'utf8'));
    const references = code.match(/\bSECRET_KEY_NAME_WORDS\b/g) ?? [];
    // The declaration, then the predicate and the keyed pattern that derive from it.
    const derivations = references.length - 1;
    console.log(`[FR-R4-F10 L1] derivations of SECRET_KEY_NAME_WORDS checked in logger.ts: ${derivations}`);
    expect(derivations, 'isSecretKeyName and the keyed pattern must both reference the list by name').toBeGreaterThanOrEqual(2);
    const predicate = /export function isSecretKeyName[\s\S]*?\n\}\n/.exec(code);
    expect(predicate, 'isSecretKeyName was not found as an exported function').not.toBeNull();
    expect(predicate?.[0]).toContain('SECRET_KEY_NAME_WORDS');
    const pattern = /const KEYED_SECRET_VALUE_RE\b[\s\S]*?;\n/.exec(code);
    expect(pattern, 'the keyed value pattern was not found').not.toBeNull();
    expect(pattern?.[0]).toContain('SECRET_KEY_NAME_WORDS');
  });

  it('CONTROL: the detector catches each shape of fork when one is planted in memory', () => {
    const words = SECRET_KEY_NAME_WORDS;
    const planted = {
      'a re-declaration': "const SECRET_KEY_NAME_WORDS = ['password'];",
      'an array of three words': "const SENSITIVE = ['password', 'secret', 'token'];",
      'a double-quoted array': 'const SENSITIVE = ["passwd", "pwd", "token", "extra"];',
      'an alternation': 'const re = /(password|secret|token)=/;',
      'a lookbehind alternation': 'const re = new RegExp("(?<=(?:passwd|pwd|secret)[:=])x");'
    };
    for (const [shape, source] of Object.entries(planted)) {
      expect(findForks(source, words).length, `the detector missed ${shape}`).toBeGreaterThan(0);
    }
    expect(findForks("const small = ['password', 'secret'];", words)).toEqual([]);
    expect(findForks('// a comment about password, secret and token\nconst x = 1;', words)).toEqual([]);
  });
});
