import { beforeAll, describe, expect, it } from 'vitest';
import { CLEAN, PLANTED, type PlantedCase } from '../../fixtures/secret-scan-corpus';

/**
 * FR-R4-F10 (contract test T4; SC2, SC4) -- the local secretlint rule finds the four families the
 * preset cannot detect, even with its options on, and reports nothing for their near-misses.
 *
 * WHAT IT PINS. `findLocalSecrets` is the rule's detection, called directly with text, a file name
 * and options, so a regression names the family and the shape rather than surfacing as a whole-scan
 * failure. Each message id has a planted value whose reported `messageId`, `range` and `value` are
 * checked, every `CLEAN` entry of the corpus must return nothing, and `options.allows` must suppress
 * an exact value and no near variant of it. The rule's metadata and the translator it reports
 * through are checked against a stand-in rule context, because the engine masks a finding only
 * when the matched value is passed as message data (research R6).
 *
 * There is no timing assertion here: wall-clock checks stay out of the hermetic host suite. The
 * linear-cost check is `tests/perf/secretlint-rule-linear.test.ts` (tasks TA4).
 */
const loadRule = () => import('../../../scripts/secretlint-rule-schegent.mjs');
type RuleModule = Awaited<ReturnType<typeof loadRule>>;

let rule: RuleModule;

beforeAll(async () => {
  rule = await loadRule();
});

/** The first element, which the test has already established exists. */
function first<T>(items: ReadonlyArray<T>): T {
  const item = items.at(0);
  if (item === undefined) throw new Error('expected at least one element');
  return item;
}

const LOCAL_FAMILIES: Record<string, string> = {
  anthropic: 'AnthropicApiKey',
  jwt: 'JsonWebToken',
  'password-assignment': 'PasswordAssignment',
  'password-assignment-quoted': 'PasswordAssignment',
  'dotenv-variant': 'DotenvVariantFile',
  'dotenv-variant-nested': 'DotenvVariantFile',
  'anthropic-in-template': 'AnthropicApiKey'
};

describe('findLocalSecrets reports each family with its message id, range and value', () => {
  it('covers every planted family the local rule is responsible for', () => {
    const responsible = PLANTED.filter((planted) => planted.reportedAs === 'secretlint-rule-schegent');
    expect(responsible.map((planted) => planted.family).sort()).toEqual(Object.keys(LOCAL_FAMILIES).sort());
  });

  it.each(Object.keys(LOCAL_FAMILIES).map((family) => [family] as const))(
    'reports the planted %s value once, with a range that selects the reported value',
    (family) => {
      const planted = PLANTED.find((entry) => entry.family === family) as PlantedCase;
      const text = planted.build();
      const found = rule.findLocalSecrets(text, planted.file, {});
      expect(found).toHaveLength(1);
      const finding = first(found);
      expect(finding.messageId).toBe(LOCAL_FAMILIES[family]);
      const range = finding.range;
      if (finding.messageId === 'DotenvVariantFile') {
        expect(finding.value).toBe(planted.file.split('/').at(-1));
      } else {
        expect(text.slice(range[0], range[1])).toBe(finding.value);
        expect(finding.value.length).toBeGreaterThanOrEqual(8);
      }
    }
  );

  it('reports an Anthropic value as the key alone, without the text around it', () => {
    const planted = PLANTED.find((entry) => entry.family === 'anthropic') as PlantedCase;
    const text = planted.build();
    const finding = first(rule.findLocalSecrets(text, planted.file, {}));
    expect(finding.value.startsWith(['sk', '-ant-'].join(''))).toBe(true);
    expect(text).toBe(`key = ${finding.value}\n`);
  });

  it('reports a password assignment as the value alone, so the name stays in the report', () => {
    const planted = PLANTED.find((entry) => entry.family === 'password-assignment-quoted') as PlantedCase;
    const text = planted.build();
    const finding = first(rule.findLocalSecrets(text, planted.file, {}));
    expect(finding.value).toHaveLength(12);
    expect(text).toContain(`'${finding.value}'`);
    const unquoted = PLANTED.find((entry) => entry.family === 'password-assignment') as PlantedCase;
    const bare = first(rule.findLocalSecrets(unquoted.build(), unquoted.file, {}));
    expect(bare.value).toHaveLength(12);
  });

  it('reports a dotenv variant by its base name, wherever the file sits', () => {
    const nested = rule.findLocalSecrets('SOME_SETTING=placeholder\n', 'config/.env.production', {});
    expect(nested.map((finding) => finding.messageId)).toEqual(['DotenvVariantFile']);
    const absolute = rule.findLocalSecrets('', '/tmp/work/.env.staging', {});
    expect(absolute.map((finding) => finding.messageId)).toEqual(['DotenvVariantFile']);
  });
});

describe('findLocalSecrets reports nothing for what is not a secret', () => {
  it.each(CLEAN.map((clean) => [clean.name, clean] as const))('%s', (_name, clean) => {
    expect(rule.findLocalSecrets(clean.text, clean.file, {})).toEqual([]);
  });

  it('leaves the exact file name .env to the dotenv rule', () => {
    expect(rule.findLocalSecrets('SOME_SETTING=placeholder\n', '.env', {})).toEqual([]);
    expect(rule.findLocalSecrets('SOME_SETTING=placeholder\n', 'config/.env', {})).toEqual([]);
  });

  it('does not treat a name that merely contains .env. as a dotenv variant', () => {
    expect(rule.findLocalSecrets('x\n', 'notes.env.local', {})).toEqual([]);
    expect(rule.findLocalSecrets('x\n', '.environment', {})).toEqual([]);
    expect(rule.findLocalSecrets('x\n', '.env.', {})).toEqual([]);
  });

  it('does not report a TOKEN or SECRET assignment, which the scanner leaves to the runtime redactor', () => {
    const name = ['SENTINEL_', 'TOKEN'].join('');
    expect(rule.findLocalSecrets(`${name}=abcdefghijklmnop\n`, 'settings.txt', {})).toEqual([]);
    const secret = ['CANARY_', 'SECRET'].join('');
    expect(rule.findLocalSecrets(`const ${secret} = 'abcdefghijklmnop';\n`, 'canary.txt', {})).toEqual([]);
  });
});

describe('options.allows suppresses an exact value and not a near variant', () => {
  it.each(['anthropic', 'jwt', 'password-assignment-quoted'].map((family) => [family] as const))(
    'for %s: the exact value is allowed, a one-character difference is still reported',
    (family) => {
      const planted = PLANTED.find((entry) => entry.family === family) as PlantedCase;
      const text = planted.build();
      const finding = first(rule.findLocalSecrets(text, planted.file, {}));
      const value = finding.value;
      expect(value.length).toBeGreaterThan(8);
      expect(rule.findLocalSecrets(text, planted.file, { allows: [value] })).toEqual([]);
      expect(rule.findLocalSecrets(text, planted.file, { allows: [value.slice(0, -1)] })).toHaveLength(1);
      expect(rule.findLocalSecrets(text, planted.file, { allows: [`${value}x`] })).toHaveLength(1);
      expect(rule.findLocalSecrets(text, planted.file, { allows: [] })).toHaveLength(1);
    }
  );
});

describe('the rule declaration', () => {
  it('pins the three template names, frozen', () => {
    expect(rule.DOTENV_TEMPLATE_NAMES).toEqual(['.env.example', '.env.sample', '.env.template']);
    expect(Object.isFrozen(rule.DOTENV_TEMPLATE_NAMES)).toBe(true);
  });

  it('declares the engine metadata', () => {
    expect(rule.creator.meta.id).toBe('secretlint-rule-schegent');
    expect(rule.creator.meta.type).toBe('scanner');
    expect(rule.creator.meta.supportedContentTypes).toEqual(['text']);
    expect(Object.keys(rule.creator.messages).sort()).toEqual(
      ['AnthropicApiKey', 'DotenvVariantFile', 'JsonWebToken', 'PasswordAssignment'].sort()
    );
  });

  it('reports each finding through the context with the matched value as message data, so the engine masks it', () => {
    const reports: Array<{ message: { messageId: string; data: Record<string, string> }; range: number[] }> = [];
    const context = {
      createTranslator: (messages: Record<string, (props: Record<string, string>) => string>) =>
        (messageId: string, data: Record<string, string>) => ({
          message: (messages[messageId] as (props: Record<string, string>) => string)(data),
          messageId,
          data
        }),
      report: (descriptor: { message: { messageId: string; data: Record<string, string> }; range: number[] }) => {
        reports.push(descriptor);
      }
    };
    const planted = PLANTED.find((entry) => entry.family === 'anthropic') as PlantedCase;
    const text = planted.build();
    const handlers = rule.creator.create(context, { allows: [] });
    handlers.file({ content: text, filePath: `/tmp/work/${planted.file}` });
    expect(reports).toHaveLength(1);
    const report = first(reports);
    expect(report.message.messageId).toBe('AnthropicApiKey');
    const finding = first(rule.findLocalSecrets(text, planted.file, {}));
    expect(Object.values(report.message.data)).toContain(finding.value);
    expect(report.range).toEqual(finding.range);
  });
});
