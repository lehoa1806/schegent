/** One half of the build, its output, and the sources that date it. */
export type BuildHalf = {
  half: 'host' | 'webview';
  output: string;
  sources: readonly string[];
  rebuild: string;
};

export type FoundFile = {
  path: string;
  mtimeMs: number;
};

export type FreshnessState = 'fresh' | 'stale' | 'absent' | 'unscannable';

/**
 * The found files are named apart from the configured paths on purpose. Declaring
 * them as `output`/`source` made this an intersection of `string` with
 * `FoundFile | null` — that is, `never` — which is why the collision it describes
 * reached a failure message before anything objected. See `buildFreshness`.
 */
export type HalfFreshness = BuildHalf & {
  state: FreshnessState;
  newestOutput: FoundFile | null;
  newestSource: FoundFile | null;
};

export const BUILD_HALVES: readonly BuildHalf[];
export function buildFreshness(root?: string): readonly HalfFreshness[];
export function assertBuildOutputIsFresh(root?: string): void;
