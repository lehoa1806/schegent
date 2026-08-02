const fs = require('fs');

function replaceFile(file, replacer) {
  const content = fs.readFileSync(file, 'utf8');
  const newContent = replacer(content);
  if (content !== newContent) fs.writeFileSync(file, newContent);
}

// 1. src/config/pipeline-config.ts
replaceFile('src/config/pipeline-config.ts', c => c.replace(/buildCatalog\(\[\], \[\], \[\]/g, "buildCatalog([], [], { claude: [], codex: [], agy: [] }"));

// 2. src/contracts/runtime-validators.ts
replaceFile('src/contracts/runtime-validators.ts', c => c.replace(/models: rawCommand\.payload\.models as string\[\]/g, "models: rawCommand.payload.models as Record<string, readonly string[]>").replace(/payload: {\s*models: any\[\];\s*}/g, "payload: { models: Record<string, readonly string[]>; }"));

// 3. src/extension.ts
replaceFile('src/extension.ts', c => c.replace(/getCatalog: \(\) => \{\s*phases: readonly PhaseDef\[\];\s*pipelines: readonly PipelineDef\[\];\s*models: readonly string\[\];\s*\}/g, "getCatalog: () => { phases: readonly PhaseDef[]; pipelines: readonly PipelineDef[]; models: Record<import('./runner/backend-runner-factory').BackendRunnerKind, readonly string[]>; }"));
replaceFile('src/extension.ts', c => c.replace(/getCatalog: \(\) => {\s*phases: readonly PhaseDef\[\];\s*pipelines: readonly PipelineDef\[\];\s*models: readonly string\[\];\s*}/g, "getCatalog: () => { phases: readonly PhaseDef[]; pipelines: readonly PipelineDef[]; models: Record<string, readonly string[]>; }"));

// 4. tests
const testFiles = [
  'tests/integration/dynamic-pipelines.test.ts',
  'tests/integration/retry-condition.test.ts',
  'tests/unit/config/pipeline-config.test.ts',
  'tests/unit/controller/workflow-controller.test.ts',
  'tests/unit/ui/sidebar/save-commands-primary-gate.test.ts'
];

testFiles.forEach(f => {
  if (fs.existsSync(f)) {
    replaceFile(f, c => c.replace(/buildCatalog\([^,]+,\s*[^,]+,\s*\[\s*\]/g, match => match.replace(/\[\s*\]$/, "{ claude: [], codex: [], agy: [] }")));
    replaceFile(f, c => c.replace(/models: \[\]/g, "models: { claude: [], codex: [], agy: [] }"));
  }
});

const guardedServiceTest = 'tests/unit/services/guarded-run-service.test.ts';
if (fs.existsSync(guardedServiceTest)) {
  replaceFile(guardedServiceTest, c => c.replace(/models: \[\]/g, "models: { claude: [], codex: [], agy: [] }"));
}

const enqueueTest = 'tests/integration/enqueue-start-separation.helpers.ts';
if (fs.existsSync(enqueueTest)) {
  replaceFile(enqueueTest, c => c.replace(/models: \[\]/g, "models: { claude: [], codex: [], agy: [] }"));
}

