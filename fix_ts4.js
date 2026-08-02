const fs = require('fs');

function replaceFile(file, replacer) {
  const content = fs.readFileSync(file, 'utf8');
  const newContent = replacer(content);
  if (content !== newContent) fs.writeFileSync(file, newContent);
}

replaceFile('src/contracts/runtime-validators.ts', c => {
  let s = c.replace(/function validateSaveModels\(\s*obj: Record<string, unknown>,\s*correlationId: string,\s*payload: unknown\s*\): SidebarCommandValidationResult \{/g, "function validateSaveModels(obj: Record<string, unknown>, correlationId: string): IpcValidationResult { const payload = obj['payload'];");
  s = s.replace(/function validateSaveModels\(\s*obj: Record<string, unknown>,\s*correlationId: string\s*\): IpcValidationResult \{\s*const payload = obj\['payload'\];\s*if \(\!payload \|\| typeof payload \!\=\= 'object'\) \{/g, "function validateSaveModels(obj: Record<string, unknown>, correlationId: string): IpcValidationResult {\n  const payload = obj['payload'];\n  if (!payload || typeof payload !== 'object') {");
  return s;
});

replaceFile('src/extension.ts', c => c.replace(/getCatalog: \(\) => \{\s*phases: readonly PhaseDef\[\];\s*pipelines: readonly PipelineDef\[\];\s*models: readonly string\[\];\s*\}/g, "getCatalog: () => { phases: readonly PhaseDef[]; pipelines: readonly PipelineDef[]; models: Record<import('./runner/backend-runner-factory').BackendRunnerKind, readonly string[]>; }"));
replaceFile('src/extension.ts', c => c.replace(/getCatalog: \(\) => \{\s*phases: readonly PhaseDef\[\];\s*pipelines: readonly PipelineDef\[\];\s*models: Record<string, readonly string\[\]>;\s*\}/g, "getCatalog: () => { phases: readonly PhaseDef[]; pipelines: readonly PipelineDef[]; models: Record<import('./runner/backend-runner-factory').BackendRunnerKind, readonly string[]>; }"));

