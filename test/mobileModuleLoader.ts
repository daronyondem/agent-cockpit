import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

export function loadMobileModule(relativePath: string): Record<string, any> {
  const sourcePath = path.join(ROOT, 'mobile/AgentCockpitPWA/src', relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transformed = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      isolatedModules: true,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  const sandbox = {
    exports: module.exports,
    module,
    URL,
    document: {
      createElement: jest.fn(),
      body: { append: jest.fn() },
    },
  };
  vm.runInNewContext(transformed, sandbox, { filename: sourcePath });
  return module.exports;
}
