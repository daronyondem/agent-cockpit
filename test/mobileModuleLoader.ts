import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

export function loadMobileModule(relativePath: string, dependencies: Record<string, unknown> = {}): Record<string, any> {
  return loadFrontendModule(path.join('mobile/AgentCockpitPWA/src', relativePath), dependencies);
}

export function loadFrontendModule(relativePath: string, dependencies: Record<string, unknown> = {}, globals: Record<string, unknown> = {}): Record<string, any> {
  const sourcePath = path.join(ROOT, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transformed = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      isolatedModules: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  const sandbox = {
    exports: module.exports,
    module,
    require: (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected mobile test dependency: ${name}`);
      return dependencies[name];
    },
    URL,
    document: {
      createElement: jest.fn(),
      body: { append: jest.fn() },
    },
    ...globals,
  };
  vm.runInNewContext(transformed, sandbox, { filename: sourcePath });
  return module.exports;
}
