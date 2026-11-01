import { describe, expect, it } from 'vitest';
import { REDACTION_SENTINEL, SanitizedLogger } from '../../../src/lib/logger';
import {
  BASELINE_REDACTED,
  REDACTION_CASES,
  mask,
  type RedactionCase,
  type RedactionCategory
} from '../../fixtures/redaction-corpus';
import { mulberry32, pick } from '../../fixtures/seeded-rng';

/**
 * FR-R4-F10 (contract test T7; RD2 to RD8; SC-004; FR-019 to FR-023, FR-033) -- every case of the
 * runtime redaction corpus, at `sanitize()` level, against the outcome it declares.
 *
 * WHAT IT PINS. The corpus is the statement of what the host's redactor supports, keeps,
 * over-redacts and does not support (`tests/fixtures/redaction-corpus.ts`). Here each case is run
 * through the real `SanitizedLogger`: a `redacted` case must leave no 8-character part of its secret
 * and every `keep` substring; a `preserved` case must come out byte-identical; an `over-redacted`
 * case must lose its secret, with its reason printed so it is not mistaken for a negative; and an
 * `unsupported` case is recorded and printed, never asserted absent. `BASELINE_REDACTED` is the set
 * the redactor already handled before this feature, and none of it may regress (hard rule 1).
 *
 * A failing assertion prints values only through `mask()` (FR-033): no genuine credential is ever
 * involved, but the habit of masking is what keeps one out of a log.
 */
const logger = new SanitizedLogger();
const MIN_SECRET_LENGTH = 8;

const CATEGORY_MINIMUMS: Readonly<Record<RedactionCategory, number>> = {
  'reproduced-gap': 4,
  'existing-control': 17,
  'vendor-prefix': 5,
  'quoting-casing': 6,
  boundary: 4,
  'multiline-key': 4,
  negative: 12
};

/** Every 8-character part of `secret`. */
function eightCharParts(secret: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start + MIN_SECRET_LENGTH <= secret.length; start += 1) {
    parts.push(secret.slice(start, start + MIN_SECRET_LENGTH));
  }
  return parts;
}

/** The redacted form of a case: a structured case goes through `sanitizeRecord` under its key. */
function redact(testCase: RedactionCase, input: string): string {
  if (testCase.framing !== 'structured') return logger.sanitize(input);
  if (testCase.key === undefined) return JSON.stringify(logger.sanitizeRecord({ list: [input] }));
  return JSON.stringify(logger.sanitizeRecord({ [testCase.key]: input }));
}

/** Assert a `redacted` or `over-redacted` case lost its secret, printing only masked values. */
function expectSecretGone(testCase: RedactionCase, output: string): void {
  const secret = (testCase.secret as () => string)();
  const survivor = eightCharParts(secret).find((part) => output.includes(part));
  expect(survivor, `${testCase.name}: a part of the secret survived (${mask(survivor ?? '')})`).toBeUndefined();
}

function plainStringCases(): RedactionCase[] {
  return REDACTION_CASES.filter((testCase) => testCase.framing === undefined);
}

describe('every corpus case, at sanitize() level, against its declared outcome', () => {
  it.each(REDACTION_CASES.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const input = testCase.build();
    const output = redact(testCase, input);
    if (testCase.expected === 'redacted') {
      expectSecretGone(testCase, output);
      for (const kept of testCase.keep ?? []) {
        expect(output, `${testCase.name}: ${mask(kept)} was removed but must stay readable`).toContain(kept);
      }
    } else if (testCase.expected === 'preserved') {
      expect(output, `${testCase.name}: a negative case was changed`).toBe(input);
    } else if (testCase.expected === 'over-redacted') {
      expectSecretGone(testCase, output);
      console.log(`[FR-R4-F10 corpus] over-redacted, kept as is: ${testCase.name}: ${testCase.reason}`);
    } else {
      console.log(
        `[FR-R4-F10 corpus] unsupported: ${testCase.name}: ${testCase.reason}; the secret ${
          testCase.secret !== undefined && output.includes(testCase.secret()) ? 'remains' : 'was removed'
        }`
      );
    }
  });
});

describe('the corpus is complete and honest', () => {
  it('has unique names', () => {
    const names = REDACTION_CASES.map((testCase) => testCase.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('meets every category minimum and the total (SC-004)', () => {
    const supported = REDACTION_CASES.filter(
      (testCase) => testCase.expected === 'redacted' || testCase.expected === 'preserved'
    );
    const counts = new Map<RedactionCategory, number>();
    for (const testCase of supported) counts.set(testCase.category, (counts.get(testCase.category) ?? 0) + 1);
    for (const [category, minimum] of Object.entries(CATEGORY_MINIMUMS) as Array<[RedactionCategory, number]>) {
      expect(counts.get(category) ?? 0, `category ${category}`).toBeGreaterThanOrEqual(minimum);
    }
    expect(REDACTION_CASES.length).toBeGreaterThanOrEqual(52);
    expect(REDACTION_CASES.length).toBeGreaterThanOrEqual(40);
  });

  it('gives every unsupported and over-redacted case a reason', () => {
    const limits = REDACTION_CASES.filter(
      (testCase) => testCase.expected === 'unsupported' || testCase.expected === 'over-redacted'
    );
    expect(limits.length).toBeGreaterThanOrEqual(6);
    for (const testCase of limits) expect((testCase.reason ?? '').trim().length, testCase.name).toBeGreaterThan(20);
  });

  it('lists the unsupported shapes the spec requires', () => {
    const names = REDACTION_CASES.filter((testCase) => testCase.expected === 'unsupported').map(
      (testCase) => testCase.name
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'a secret split across two records',
        'a lowercase secret_key_base assignment',
        'a bare token as URL userinfo',
        'a token in a format no pattern knows',
        'a string-form keyed value under 8 characters',
        'a string-form camelCase password-suffix key'
      ])
    );
  });

  it('gives every redacted and over-redacted case a secret of at least 8 characters, so the check cannot pass vacuously (AN2)', () => {
    const checked = REDACTION_CASES.filter(
      (testCase) => testCase.expected === 'redacted' || testCase.expected === 'over-redacted'
    );
    expect(checked.length).toBeGreaterThan(0);
    for (const testCase of checked) {
      expect(testCase.secret, `${testCase.name} needs a secret`).toBeDefined();
      expect((testCase.secret as () => string)().length, testCase.name).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH);
    }
  });

  it('builds each value afresh', () => {
    for (const testCase of REDACTION_CASES) expect(testCase.build()).toBe(testCase.build());
  });
});

describe('no case that was redacted before this feature is redacted less now (hard rule 1, RD6)', () => {
  it('names only cases that exist and are meant to be redacted', () => {
    expect(BASELINE_REDACTED.length).toBeGreaterThan(0);
    for (const name of BASELINE_REDACTED) {
      const testCase = REDACTION_CASES.find((candidate) => candidate.name === name);
      expect(testCase, `${name} is in BASELINE_REDACTED but not in the corpus`).toBeDefined();
      expect(['redacted', 'over-redacted']).toContain(testCase?.expected);
    }
  });

  it.each(BASELINE_REDACTED.map((name) => [name] as const))('%s is still redacted', (name) => {
    const testCase = REDACTION_CASES.find((candidate) => candidate.name === name) as RedactionCase;
    expectSecretGone(testCase, redact(testCase, testCase.build()));
  });
});

describe('seeded variants: the same cases wrapped in punctuation (BD6)', () => {
  const PUNCTUATION = ['(', ')', '[', ']', '{', '}', '<', '>', ',', ';', '!', '?', '|', '~', ' ', '\n'];
  const SEED = 257_066;

  function wrap(rng: () => number, text: string): string {
    const prefix = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(rng, PUNCTUATION)).join('');
    const suffix = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(rng, PUNCTUATION)).join('');
    return `${prefix}${text}${suffix}`;
  }

  it('still removes every redacted secret, and keeps every negative whole, with punctuation around it', () => {
    const rng = mulberry32(SEED);
    let variants = 0;
    for (const testCase of plainStringCases()) {
      if (testCase.expected !== 'redacted' && testCase.expected !== 'preserved') continue;
      for (let take = 0; take < 3; take += 1) {
        const wrapped = wrap(rng, testCase.build());
        const output = logger.sanitize(wrapped);
        variants += 1;
        if (testCase.expected === 'preserved') {
          expect(output, `seed ${SEED}: ${testCase.name} changed when wrapped`).toBe(wrapped);
        } else {
          expectSecretGone(testCase, output);
        }
      }
    }
    console.log(`[FR-R4-F10 corpus] seed ${SEED}: ${variants} wrapped variants checked`);
    expect(variants).toBeGreaterThan(100);
  });

  it('writes the sentinel the whole module shares', () => {
    const testCase = REDACTION_CASES.find((candidate) => candidate.name === 'lowercase password assignment');
    expect(logger.sanitize((testCase as RedactionCase).build())).toContain(REDACTION_SENTINEL);
  });
});
