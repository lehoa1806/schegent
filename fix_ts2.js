const fs = require('fs');

function replaceFile(file, replacer) {
  const content = fs.readFileSync(file, 'utf8');
  const newContent = replacer(content);
  if (content !== newContent) fs.writeFileSync(file, newContent);
}

replaceFile('src/config/pipeline-config.ts', c => c.replace(/buildCatalog\([^,]+,\s*[^,]+,\s*\[\s*\]/g, match => match.replace(/\[\s*\]$/, "{ claude: [], codex: [], agy: [] }")));
replaceFile('src/contracts/runtime-validators.ts', c => c.replace(/models: rawCommand\.payload\.models as string\[\]/g, "models: rawCommand.payload.models as Record<string, readonly string[]>").replace(/payload: \{\s*models: any\[\];\s*\}/g, "payload: { models: Record<string, readonly string[]>; }"));
replaceFile('src/extension.ts', c => c.replace(/getCatalog: \(\) => \{\s*phases: readonly PhaseDef\[\];\s*pipelines: readonly PipelineDef\[\];\s*models: readonly string\[\];\s*\}/g, "getCatalog: () => { phases: readonly PhaseDef[]; pipelines: readonly PipelineDef[]; models: Record<import('./runner/backend-runner-factory').BackendRunnerKind, readonly string[]>; }"));
replaceFile('src/extension.ts', c => c.replace(/models: readonly string\[\];/g, "models: Record<import('./runner/backend-runner-factory').BackendRunnerKind, readonly string[]>;"));
replaceFile('tests/integration/retry-condition.test.ts', c => c.replace(/models: \s*\[\s*\]/g, "models: { claude: [], codex: [], agy: [] }"));
replaceFile('tests/integration/retry-condition.test.ts', c => c.replace(/buildCatalog\(.*?,\s*\[\]/g, match => match.replace(/\[\]$/, "{ claude: [], codex: [], agy: [] }")));
