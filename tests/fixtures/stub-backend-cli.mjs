#!/usr/bin/env node
// FR-R4-F06 (FR-029; T31; contract Q, Q3) -- a harmless stand-in for a backend CLI, for the offline
// help capture's test.
//
// WHAT IT IS. `--version` prints one version line. `--help` prints every capability flag the
// planner's `SURFACES` table names, each on its own line, and one more line that holds an absolute
// path under THIS file's own directory, so the capture's path redaction has something to redact. It
// reads no file, writes none, makes no network call and starts no process. Anything else it is
// asked prints nothing and exits 2.
//
// WHAT IT IS NOT. Evidence about any real CLI. The qualification record never marks a cell
// `observed` on this script's behaviour (FR-033): it exists to show the capture script's output has
// the right shape, and nothing else.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The flags of `SURFACES[kind]` across the three backends (src/services/capability-enforcement-plan.ts),
// one list because the stub stands in for whichever backend the test names.
const FLAGS = ['--dangerously-skip-permissions', '--disallowedTools', '--permission-mode', '--sandbox'];

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('stub-backend 9.9.9 (Stub CLI)\n');
} else if (args.includes('--help')) {
  process.stdout.write('Usage: stub-backend [options]\n\nOptions:\n');
  // The path rides on each flag's own line as well as on a line of its own, so the capture's
  // redaction is exercised on the lines it prints, not only on the ones it skips.
  const config = join(here, 'stub.config');
  for (const flag of FLAGS) {
    process.stdout.write(`  ${flag} <value>   stub description of ${flag} (default from ${config})\n`);
  }
  process.stdout.write(`      read from ${config} when present\n`);
} else {
  process.exit(2);
}
