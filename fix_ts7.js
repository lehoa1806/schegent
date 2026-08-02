const fs = require('fs');

function replaceFile(file, replacer) {
  const content = fs.readFileSync(file, 'utf8');
  const newContent = replacer(content);
  if (content !== newContent) fs.writeFileSync(file, newContent);
}

replaceFile('webview-ui/src/components/__tests__/PipelineBuilder.test.ts', c => c.replace(/expect\(vi\.mocked\(saveModelsHelper\)\.mock\.calls\[0\]\[0\]\)\.toEqual\(\[\s*'claude-sonnet-4-6',\s*'claude-opus-4-6'\s*\]\);/g, "expect(vi.mocked(saveModelsHelper).mock.calls[0][0]).toEqual({\n      claude: ['claude-sonnet-4-6', 'claude-opus-4-6'],\n      codex: [],\n      agy: []\n    });"));
