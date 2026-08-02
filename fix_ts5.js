const fs = require('fs');

function replaceFile(file, replacer) {
  const content = fs.readFileSync(file, 'utf8');
  const newContent = replacer(content);
  if (content !== newContent) fs.writeFileSync(file, newContent);
}

replaceFile('webview-ui/src/components/PipelineBuilder.svelte', c => c.replace(/snapModels\[kind as BackendRunnerKind\]/g, "snapModels[kind as keyof typeof snapModels]"));
replaceFile('webview-ui/src/lib/__tests__/save-catalog-command.test.ts', c => c.replace(/saveModels\(\['claude-sonnet-4-6'\]/g, "saveModels({ claude: ['claude-sonnet-4-6'] }"));
