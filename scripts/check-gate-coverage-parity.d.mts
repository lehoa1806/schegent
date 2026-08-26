// Type surface for the gate-coverage parity script, so its unit test can see the pure
// decisions. Same arrangement as `gate-attestation.d.mts`, whose reasoning this follows:
// the script is `.mjs` because it runs from `package.json` without a build step, and a
// declaration file is how a `.test.ts` reaches it without pulling the whole script into
// the TypeScript program.
export declare const GATE_SCRIPT: string;
export declare const BLOCK_START: string;
export declare const BLOCK_END: string;
export declare function reachableScripts(
  all: Record<string, string>,
  entry: string
): readonly string[];
export declare function derivedChecks(
  all: Record<string, string>,
  entry?: string
): readonly string[];
export declare function renderBlock(all: Record<string, string>): string;
export declare function decideParity(
  documentText: string,
  all: Record<string, string>
):
  | { readonly ok: true; readonly checks: number }
  | { readonly ok: false; readonly reason: string; readonly message: string };
