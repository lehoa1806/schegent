/**
 * Review gap GC-11 (2026-11-12) — config overrides every host spawn of git carries.
 *
 * A host git call runs inside the operator's repository, so the repository's own config would
 * otherwise decide what else runs: `core.fsmonitor` names a program git runs on `status` and
 * `diff`, and `.git/hooks` or a repository `core.hooksPath` runs on `merge`, `checkout` and
 * `commit`. Command-line `-c` outranks every config file, so these two switch both off.
 *
 * `/dev/null` as the hooks directory works because git looks hooks up as `<dir>/<name>`, and no
 * such path can exist under it on any platform git runs on.
 */
export const HOST_GIT_CONFIG_OVERRIDES: readonly string[] = Object.freeze([
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null'
]);

/** `args` with {@link HOST_GIT_CONFIG_OVERRIDES} in front, as git's global options. */
export function withHostGitConfig(args: readonly string[]): string[] {
  return [...HOST_GIT_CONFIG_OVERRIDES, ...args];
}
