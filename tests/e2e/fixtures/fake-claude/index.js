#!/usr/bin/env node
/* eslint-env node */
/* eslint-disable no-console, @typescript-eslint/no-var-requires */
/*
 * Feature 034 Item 055 — deterministic Claude CLI stub for the Speckit
 * pipeline E2E test. Reads the operator prompt from one of the three
 * supported transports (`--prompt-file <path>`, `--prompt-stdin`, or
 * `-p <prompt>`) and emits a contract-compliant phase response.
 *
 * The stub classifies the active phase by matching the leading
 * `Run /<phase-id>` string the prompt-builder produces (see
 * `src/runner/prompt-builder.ts`). It deterministically emits:
 *   - [SCHEGENT_STATUS: CLEAR] (or [SCHEGENT_STATUS: ISSUES_REMAIN]
 *     once per loopable phase to exercise the clarify/analyze loop)
 *   - the SCHEGENT AUDIT LOG fenced block with the seven required fields
 *
 * Environment knobs (used by the E2E test runner only):
 *   - SCHEGENT_E2E_MODE = 'happy' | 'loop-once' | 'fatal' | 'rate-limit'
 *       'happy'      — every phase exits CLEAN on the first call.
 *       'loop-once'  — clarify + analyze return ISSUES_REMAIN once.
 *       'fatal'      — the first speckit-implement invocation exits 1
 *                      with an operator-defined fatal signature.
 *       'rate-limit' — the first invocation exits 1 with the standard
 *                      "rate limit reached" message + a reset timestamp.
 *   - SCHEGENT_E2E_STATE_DIR — writable directory the stub uses to
 *       remember its call counter across invocations (one file per
 *       phase id). Required for loop-once / fatal / rate-limit modes.
 */

const fs = require('node:fs');
const path = require('node:path');

const MODE = process.env.SCHEGENT_E2E_MODE || 'happy';
const STATE_DIR = process.env.SCHEGENT_E2E_STATE_DIR || null;

function readPrompt() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prompt-file') {
      const filePath = argv[i + 1];
      if (!filePath) return '';
      return fs.readFileSync(filePath, 'utf8');
    }
    if (argv[i] === '--prompt-stdin') {
      return fs.readFileSync(0, 'utf8');
    }
    if (argv[i] === '-p') {
      return argv[i + 1] || '';
    }
  }
  return '';
}

// PromptBuilder writes the `SCHEGENT_PHASE: <phase-id>` line as the very
// first line of every prompt. Parse it directly — far more reliable than
// substring-matching the body, which can drift as prompts change.
const KNOWN_PHASES = [
  'speckit-specify',
  'speckit-clarify',
  'speckit-plan',
  'speckit-tasks',
  'speckit-analyze',
  'speckit-implement',
  'finalize'
];

function classifyPhase(prompt) {
  const match = /^\s*SCHEGENT_PHASE:\s*([a-z0-9-]+)/im.exec(prompt);
  if (match && KNOWN_PHASES.includes(match[1])) return match[1];
  // Fallback: scan for any known phase id anywhere in the prompt body.
  const body = prompt.toLowerCase();
  for (const phase of KNOWN_PHASES) {
    if (body.includes(`/${phase}`)) return phase;
  }
  return 'speckit-specify';
}

function bumpCallCount(phase) {
  if (!STATE_DIR) return 0;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, `${phase}.count`);
    const prev = fs.existsSync(file) ? parseInt(fs.readFileSync(file, 'utf8'), 10) || 0 : 0;
    fs.writeFileSync(file, String(prev + 1));
    return prev;
  } catch {
    return 0;
  }
}

// Emit the contract-compliant transcript shape. The parser recognises:
//   - `[SCHEGENT_STATUS: CLEAR]` for clean termination (via TERMINATION_REGEX
//     which accepts CLEAR/DONE/RESOLVED only).
//   - A `Remaining issues:` heading followed by bullets for loop-back.
// The stub emits CLEAR for happy / fatal / rate-limit paths and emits a
// `Remaining issues:` heading + bullet for the first loopable call in
// `loop-once` mode.
function emitClean(phase, filesCreated) {
  process.stdout.write(`Mock Claude (fake-claude/index.js): ${phase}\n`);
  process.stdout.write('[SCHEGENT_STATUS: CLEAR]\n');
  emitAuditBlock(phase, filesCreated);
}

function emitLoopBack(phase, filesCreated) {
  process.stdout.write(`Mock Claude (fake-claude/index.js): ${phase}\n`);
  process.stdout.write('Remaining issues:\n');
  process.stdout.write(`- [stub-loop] deterministic ${phase} loop signal\n`);
  process.stdout.write('\n');
  
  const metrics = {};
  if (phase === 'speckit-clarify') metrics.open_questions = 1;
  else if (phase === 'speckit-analyze') metrics.critical_issues = 1;
  else metrics.issues_remain = 1;
  
  emitAuditBlock(phase, filesCreated, metrics);
}

function emitAuditBlock(phase, filesCreated, metrics = null) {
  process.stdout.write('=== SCHEGENT AUDIT LOG ===\n');
  process.stdout.write(`phase: ${phase}\n`);
  process.stdout.write(`files_created: [${filesCreated.map((f) => `"${f}"`).join(', ')}]\n`);
  process.stdout.write('files_modified: []\n');
  process.stdout.write('files_deleted: []\n');
  process.stdout.write(`commands_executed: ["fake-claude ${phase}"]\n`);
  process.stdout.write('network_calls: ["none"]\n');
  process.stdout.write('ruleset_switches: ["none"]\n');
  process.stdout.write(`notes: deterministic-stub phase=${phase} mode=${MODE}\n`);
  if (metrics) {
    for (const [key, val] of Object.entries(metrics)) {
      process.stdout.write(`${key}: ${val}\n`);
    }
  }
  process.stdout.write('=== END AUDIT LOG ===\n');
}

const FILE_MAP = {
  'speckit-specify': ['specs/e2e-001/spec.md'],
  'speckit-clarify': ['specs/e2e-001/spec.md'],
  'speckit-plan': ['specs/e2e-001/plan.md'],
  'speckit-tasks': ['specs/e2e-001/tasks.md'],
  'speckit-analyze': [],
  'speckit-implement': ['src/e2e-001/feature.ts'],
  finalize: []
};

(function main() {
  const prompt = readPrompt();
  const phase = classifyPhase(prompt);
  const callIndex = bumpCallCount(phase);
  const files = FILE_MAP[phase] || [];

  if (MODE === 'fatal' && phase === 'speckit-implement' && callIndex === 0) {
    // Emit a built-in fatal signature ("error: unknown option") so the
    // controller's classify-fatal path matches against
    // src/lib/fatal-signature-registry.ts FATAL_SIGNATURES.
    process.stderr.write('error: unknown option --schegent-fake-fatal\n');
    process.exit(1);
  }

  if (MODE === 'rate-limit' && callIndex === 0) {
    // Emit a parseable rate-limit message with a near-future reset
    // timestamp so the controller computes a finite backoff.
    const resetEpoch = Math.floor(Date.now() / 1000) + 3;
    process.stderr.write(`Claude AI rate limit reached. Resets at ${resetEpoch}\n`);
    process.exit(1);
  }

  const loopable = phase === 'speckit-clarify' || phase === 'speckit-analyze';
  if (MODE === 'loop-once' && loopable && callIndex === 0) {
    emitLoopBack(phase, files);
  } else {
    emitClean(phase, files);
  }
  process.exit(0);
})();
