const fs = require('fs');

function replaceFile(file, replacer) {
  const content = fs.readFileSync(file, 'utf8');
  const newContent = replacer(content);
  if (content !== newContent) fs.writeFileSync(file, newContent);
}

replaceFile('webview-ui/src/lib/__tests__/save-catalog-command.test.ts', c => c.replace(/expect\(env\.payload\)\.toEqual\(\{ models: \['claude-sonnet-4-6'\] \}\);/g, "expect(env.payload).toEqual({ models: { claude: ['claude-sonnet-4-6'] } });"));
replaceFile('webview-ui/src/components/__tests__/PipelineBuilder.test.ts', c => c.replace(/textContent\?\.trim\(\) === 'Save Models'/g, "textContent?.trim() === 'Save All Models'"));
