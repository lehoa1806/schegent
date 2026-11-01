/**
 * FR-R4-F10 (contract SC2 to SC4; research R6) -- the local secretlint rule: the four families the
 * preset cannot detect, even with every option it offers switched on.
 *
 * WHAT IT FINDS. An Anthropic API key (`sk-ant-`, a version tag, a long body), a JSON web token
 * (three base64url segments whose header and payload both begin `eyJ`), a password assignment (a
 * name ending in a password word, `=` or `:`, then a value of at least eight characters), and a
 * dotenv variant FILE NAME (`.env.local`, `config/.env.production`; not the three templates, and not
 * the exact `.env`, which the dotenv rule already reports).
 *
 * WHY IT IS A RULE IN THE CONFIGURATION AND NOT A SECOND REPORTER. `.secretlintrc.json` declares it
 * (`./scripts/secretlint-rule-schegent.mjs`), so the file stays the whole statement of what the
 * scan runs, and the engine does the rest: it masks the matched value in the report, honours
 * `allows`, and prints one format. A finding passes its value as message DATA, which is what makes
 * the engine mask it. `scan-secrets.mjs` resolves the `./` id against its own root before it creates
 * the engine, because the config loader resolves only packages and absolute paths.
 *
 * WHAT IT DELIBERATELY LEAVES OUT. Names ending in TOKEN or SECRET: the tree holds code constants
 * with such names whose values are not credentials, so a rule on them would report the repository.
 * The runtime redactor covers those names, and the corpus records the gap as unsupported.
 *
 * COST. Every expression here either starts only where a token run begins, or has bounded repeats,
 * or can fail only after reading a bounded amount. A long file of near-matches therefore costs time
 * in proportion to its length, which `tests/perf/secretlint-rule-linear.test.ts` holds to a number.
 *
 * This module imports only `node:path`. It holds no regular expression or helper from `src/`: the
 * scanner's rule and the runtime redaction set are separate mechanisms and are not a copy of each
 * other (FR-004).
 */
import { basename } from 'node:path';

/** The dotenv names that are templates: they are not reported by name, and their content still is. */
export const DOTENV_TEMPLATE_NAMES = Object.freeze(['.env.example', '.env.sample', '.env.template']);

const DOTENV_VARIANT_PREFIX = '.env.';
const MIN_VALUE_LENGTH = 8;

/** `sk-ant-`, a lowercase version tag ending in two digits and `-`, then a body of 32 or more token characters. */
const ANTHROPIC_KEY = /sk-ant-[a-z]{1,16}[0-9]{2}-[A-Za-z0-9_-]{32,}/g;

/**
 * A header and a payload that begin `eyJ` (a JSON object, base64url encoded), and a signature.
 * The lookbehind keeps a match from starting inside a run of token characters, which is what keeps
 * a long run of `eyJ` from costing time quadratic in its length.
 */
const JSON_WEB_TOKEN = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** The password words a name may end in. */
const PASSWORD_WORD = '(?:PASSWORD|PASSWD|password|passwd|Password|Passwd)';
/** What may sit between the word and the value: an optional closing quote, spaces, `:` `=` or `=>`, spaces. */
const PASSWORD_LEAD = `${PASSWORD_WORD}["']?[ \\t]{0,8}(?::|=>|=)[ \\t]{0,8}`;
/** A quoted literal after a password word, in either quote style: the value alone is the match. */
const QUOTED_PASSWORD = [
  new RegExp(`(?<=${PASSWORD_LEAD}")[^"\\r\\n]{${MIN_VALUE_LENGTH},}(?=")`, 'g'),
  new RegExp(`(?<=${PASSWORD_LEAD}')[^'\\r\\n]{${MIN_VALUE_LENGTH},}(?=')`, 'g')
];
/**
 * An unquoted value on an env-style line: the line starts with the assignment, so a code line such
 * as `const x = options.password;` is not one. `d` gives the value's own indices.
 */
const UNQUOTED_PASSWORD = new RegExp(
  `^(?:export[ \\t]+)?[A-Za-z_][A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|password|passwd)[ \\t]*=[ \\t]*(?!["'])([^\\s"'#\`]{${MIN_VALUE_LENGTH},})`,
  'gmd'
);

const messages = {
  AnthropicApiKey: (props) => `found Anthropic API key: ${props.VALUE}`,
  JsonWebToken: (props) => `found JSON web token: ${props.VALUE}`,
  PasswordAssignment: (props) => `found password assignment: ${props.VALUE}`,
  DotenvVariantFile: (props) => `found dotenv variant file name: ${props.VALUE}`
};

/** True for a value that refers to another variable or template instead of holding a credential. */
function isInterpolation(value) {
  return value.includes('${') || value.startsWith('$') || value.includes('{{');
}

/**
 * Find the local rule's findings in `text`, a file named `fileName`.
 *
 * @param {string} text the file's content
 * @param {string} fileName the file's path or name; only its base name is read
 * @param {{ allows?: ReadonlyArray<string> }} [options] exact values to allow; a value is allowed only when it equals one
 * @returns {Array<{ messageId: string, range: [number, number], value: string }>} the findings, in order of position
 */
export function findLocalSecrets(text, fileName, options = {}) {
  const allows = new Set(options.allows ?? []);
  const found = [];
  const add = (messageId, start, value) => {
    if (!allows.has(value)) found.push({ messageId, range: [start, start + value.length], value });
  };

  for (const match of text.matchAll(ANTHROPIC_KEY)) add('AnthropicApiKey', match.index, match[0]);
  for (const match of text.matchAll(JSON_WEB_TOKEN)) add('JsonWebToken', match.index, match[0]);
  for (const pattern of QUOTED_PASSWORD) {
    for (const match of text.matchAll(pattern)) {
      if (!isInterpolation(match[0])) add('PasswordAssignment', match.index, match[0]);
    }
  }
  for (const match of text.matchAll(UNQUOTED_PASSWORD)) {
    const value = match[1];
    if (!isInterpolation(value)) add('PasswordAssignment', match.indices[1][0], value);
  }

  const base = basename(String(fileName ?? ''));
  const isVariant =
    base.startsWith(DOTENV_VARIANT_PREFIX) &&
    base.length > DOTENV_VARIANT_PREFIX.length &&
    !DOTENV_TEMPLATE_NAMES.includes(base);
  if (isVariant && !allows.has(base)) {
    found.push({ messageId: 'DotenvVariantFile', range: [0, Math.min(1, text.length)], value: base });
  }

  return found.sort((left, right) => left.range[0] - right.range[0] || left.range[1] - right.range[1]);
}

/** The secretlint rule: reports each finding with its value as message data, so the engine masks it. */
export const creator = {
  messages,
  meta: {
    id: 'secretlint-rule-schegent',
    type: 'scanner',
    supportedContentTypes: ['text']
  },
  create(context, options) {
    const t = context.createTranslator(messages);
    const allows = options?.allows ?? [];
    return {
      file(source) {
        for (const finding of findLocalSecrets(source.content, source.filePath ?? '', { allows })) {
          context.report({ message: t(finding.messageId, { VALUE: finding.value }), range: finding.range });
        }
      }
    };
  }
};
