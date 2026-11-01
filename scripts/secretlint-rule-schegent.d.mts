// FR-R4-F10 (contract SC2) -- the declaration side of `secretlint-rule-schegent.mjs`, so
// `typecheck:tests` can see the local rule's detection and its engine declaration without the script
// becoming TypeScript. It declares the module's exports and nothing else.

/** The message ids the rule reports. */
export type LocalMessageId = 'AnthropicApiKey' | 'JsonWebToken' | 'PasswordAssignment' | 'DotenvVariantFile';

/** One finding: which family, where in the text, and the matched value (which the engine masks). */
export interface LocalFinding {
  messageId: LocalMessageId;
  range: readonly [number, number];
  value: string;
}

/** The rule's options: exact values to allow. */
export interface LocalRuleOptions {
  allows?: ReadonlyArray<string>;
}

/** The dotenv template names, which are not reported by name. Frozen. */
export declare const DOTENV_TEMPLATE_NAMES: readonly string[];

/** Find the local rule's findings in `text`, a file named `fileName`, in order of position. */
export declare function findLocalSecrets(text: string, fileName: string, options?: LocalRuleOptions): LocalFinding[];

/** The secretlint rule declaration. */
export declare const creator: {
  messages: Record<LocalMessageId, (props: Record<string, string>) => string>;
  meta: { id: 'secretlint-rule-schegent'; type: 'scanner'; supportedContentTypes: readonly ['text'] };
  create(
    context: unknown,
    options?: LocalRuleOptions
  ): { file(source: { content: string; filePath?: string }): void };
};
