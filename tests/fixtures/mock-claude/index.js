#!/usr/bin/env node
/* Mock Claude CLI that emits a contract-compliant response per phase. */

const phase = process.env.SCHEGENT_PHASE || 'specify';

function emit(filesCreated = []) {
  process.stdout.write('Mock Claude: pretending to do work\n');
  process.stdout.write('[SCHEGENT_STATUS: CLEAR]\n');
  process.stdout.write('=== SCHEGENT AUDIT LOG ===\n');
  process.stdout.write(`phase: ${phase}\n`);
  process.stdout.write(`files_created: [${filesCreated.map((f) => `"${f}"`).join(', ')}]\n`);
  process.stdout.write('files_modified: []\n');
  process.stdout.write('files_deleted: []\n');
  process.stdout.write(`commands_executed: ["mock ${phase}"]\n`);
  process.stdout.write('network_calls: ["none"]\n');
  process.stdout.write('ruleset_switches: ["none"]\n');
  process.stdout.write(`notes: mock invocation for ${phase}\n`);
  process.stdout.write('=== END AUDIT LOG ===\n');
}

const fileMap = {
  specify: ['specs/001-mock/spec.md'],
  clarify: ['specs/001-mock/spec.md'],
  plan: ['specs/001-mock/plan.md'],
  tasks: ['specs/001-mock/tasks.md'],
  analyze: [],
  implement: ['src/mock.ts'],
  finalize: []
};

emit(fileMap[phase] || []);
process.exit(0);
