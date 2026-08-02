const fs = require('fs');

function replaceFile(file, replacer) {
  const content = fs.readFileSync(file, 'utf8');
  const newContent = replacer(content);
  if (content !== newContent) fs.writeFileSync(file, newContent);
}

replaceFile('src/config/pipeline-config.ts', c => c.replace(/Object\.freeze\(\[\]\),/g, "{ claude: [], codex: [], agy: [] },"));
replaceFile('src/contracts/runtime-validators.ts', c => c.replace(/payload: {\s*models: any\[\];\s*}/g, "payload: { models: Record<string, readonly string[]>; }"));
replaceFile('src/extension.ts', c => c.replace(/models: readonly string\[\]/g, "models: Record<import('./runner/backend-runner-factory').BackendRunnerKind, readonly string[]>"));
