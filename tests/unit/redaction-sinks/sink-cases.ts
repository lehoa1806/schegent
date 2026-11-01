import { expect } from 'vitest';
import {
  REDACTION_CASES,
  mask,
  type RedactionCase,
  type RedactionFraming,
  type SinkCategory
} from '../../fixtures/redaction-corpus';

/**
 * FR-R4-F10 (contract SK1, SK3; tasks AN5) -- the case selector and the read-back assertions the five
 * sink tests share.
 *
 * WHY ONE HELPER. Each sink test drives a different real caller and reads a different artifact (an
 * audit line, a transport file, a runtime-log file, a posted message, an exported file), but the claim
 * is the same for all of them: a supported case leaves no 8-character part of its secret in what the
 * sink wrote and keeps what it must keep, and a negative case comes out byte-identical. So the
 * selection and the two assertions live here, and every failure prints values only through `mask()`
 * (FR-033).
 *
 * THE SELECTION CANNOT BE EMPTY (AN5). A sink test that selected no `redacted` or no `preserved` case
 * would pass while testing nothing, so `casesFor` throws when called without a framing and the
 * selection lacks either. A missing `sinks` entry in the corpus therefore fails loudly.
 */
const MIN_PART_LENGTH = 8;

/**
 * The corpus cases that apply to `sink`. With a `framing`, only the cases of that framing. Without one,
 * the plain string cases (no framing, or `line`), which must include a supported case and a negative
 * one.
 */
export function casesFor(sink: SinkCategory, framing?: RedactionFraming): RedactionCase[] {
  const selected = REDACTION_CASES.filter((testCase) => {
    if (!testCase.sinks.includes(sink)) return false;
    if (framing !== undefined) return testCase.framing === framing;
    return testCase.framing === undefined || testCase.framing === 'line';
  });
  if (framing === undefined) {
    const hasRedacted = selected.some((testCase) => testCase.expected === 'redacted');
    const hasPreserved = selected.some((testCase) => testCase.expected === 'preserved');
    if (!hasRedacted || !hasPreserved) {
      throw new Error(
        `the corpus selects ${selected.length} plain case(s) for the ${sink} sink, with ` +
          `${hasRedacted ? 'a' : 'no'} redacted case and ${hasPreserved ? 'a' : 'no'} preserved case; ` +
          'a sink test over that selection would test nothing'
      );
    }
  }
  return selected;
}

/** Every 8-character part of a secret. */
function eightCharParts(secret: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start + MIN_PART_LENGTH <= secret.length; start += 1) {
    parts.push(secret.slice(start, start + MIN_PART_LENGTH));
  }
  return parts;
}

/** Assert that what a sink wrote holds no 8-character part of the case's secret. */
export function assertAbsentIn(readBack: string, testCase: RedactionCase, where: string): void {
  const secret = (testCase.secret as () => string)();
  const survivor = eightCharParts(secret).find((part) => readBack.includes(part));
  expect(survivor, `${where}: ${testCase.name}: a part of the secret reached the sink (${mask(survivor ?? '')})`).toBeUndefined();
}

/**
 * Assert that what a sink wrote holds no 8-character part of the case's secret, and holds every `keep`
 * substring. `where` names the sink for the failure message.
 */
export function assertRedactedIn(readBack: string, testCase: RedactionCase, where: string): void {
  assertAbsentIn(readBack, testCase, where);
  for (const kept of testCase.keep ?? []) {
    expect(readBack, `${where}: ${testCase.name}: ${mask(kept)} must stay readable`).toContain(kept);
  }
}

/** Assert that a negative case reached the sink byte-identical, in the field or line where it was placed. */
export function assertPreservedIn(readBack: string, testCase: RedactionCase, where: string): void {
  expect(readBack, `${where}: ${testCase.name}: a negative case was changed`).toContain(testCase.build());
}

/**
 * Apply the right assertion for a case's declared outcome. An `unsupported` case is recorded and
 * printed with its reason, never asserted absent; an `over-redacted` case must lose its secret.
 */
export function assertOutcomeIn(readBack: string, testCase: RedactionCase, where: string): void {
  if (testCase.expected === 'redacted' || testCase.expected === 'over-redacted') {
    assertRedactedIn(readBack, testCase, where);
  } else if (testCase.expected === 'preserved') {
    assertPreservedIn(readBack, testCase, where);
  } else {
    console.log(`[FR-R4-F10 sinks] ${where}: unsupported, recorded: ${testCase.name}: ${testCase.reason}`);
  }
}
