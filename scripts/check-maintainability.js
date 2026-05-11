#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const CONTRACT_ALLOWED_IMPORTS = [
  /^\.\//,
  /^\.\.\/types$/,
];

const LEGACY_BACKEND_CONSOLE_ALLOWLIST = new Set([
  'src/config/index.ts',
  'src/middleware/auth.ts',
  'src/services/backends/claudeCode.ts',
  'src/services/backends/codex.ts',
  'src/services/backends/kiro.ts',
  'src/services/claudePlanUsageService.ts',
  'src/services/cliUpdateService.ts',
  'src/services/codexPlanUsageService.ts',
  'src/services/contextMap/mcp.ts',
  'src/services/kbSearchMcp/index.ts',
  'src/services/kiroPlanUsageService.ts',
  'src/services/knowledgeBase/db.ts',
  'src/services/knowledgeBase/digest.ts',
  'src/services/knowledgeBase/dream.ts',
  'src/services/knowledgeBase/handlers/docx.ts',
  'src/services/knowledgeBase/handlers/passthrough.ts',
  'src/services/knowledgeBase/handlers/pdf.ts',
  'src/services/knowledgeBase/handlers/pptx.ts',
  'src/services/knowledgeBase/ingestion.ts',
  'src/services/knowledgeBase/ingestion/pptxSlideRender.ts',
  'src/services/memoryMcp/index.ts',
  'src/services/updateService.ts',
  'src/utils/logger.ts',
]);

const FRONTEND_IMPORT_RE = /(?:import(?:\s+type)?[\s\S]*?\sfrom\s*|import\s*\()\s*['"]([^'"]+)['"]/g;
const CONTRACT_IMPORT_RE = /import(?:\s+type)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g;
const CONSOLE_RE = /\bconsole\.(log|warn|error|info|debug)\s*\(/g;

function walk(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, predicate, out);
    } else if (!predicate || predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function checkContractImports(violations) {
  const files = walk(path.join(ROOT, 'src', 'contracts'), (file) => /\.(ts|tsx|js|jsx)$/.test(file));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = CONTRACT_IMPORT_RE.exec(source))) {
      const specifier = match[1];
      if (!CONTRACT_ALLOWED_IMPORTS.some((allowed) => allowed.test(specifier))) {
        violations.push(`${rel(file)}:${lineNumber(source, match.index)} imports ${specifier}; contracts must stay browser-safe`);
      }
    }
  }
}

function checkFrontendImports(violations) {
  const roots = [
    path.join(ROOT, 'web', 'AgentCockpitWeb', 'src'),
    path.join(ROOT, 'mobile', 'AgentCockpitPWA', 'src'),
  ];
  for (const root of roots) {
    const files = walk(root, (file) => /\.(ts|tsx|js|jsx)$/.test(file));
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      let match;
      while ((match = FRONTEND_IMPORT_RE.exec(source))) {
        const specifier = match[1];
        if (specifier.includes('/src/') && !specifier.includes('/src/contracts/')) {
          violations.push(`${rel(file)}:${lineNumber(source, match.index)} imports ${specifier}; browser clients may import only shared contracts from server src`);
        }
      }
    }
  }
}

function checkBackendConsole(violations) {
  const roots = [
    path.join(ROOT, 'server.ts'),
    path.join(ROOT, 'src'),
  ];
  const files = roots.flatMap((root) => {
    if (fs.statSync(root).isFile()) return [root];
    return walk(root, (file) => /\.(ts|tsx|js|jsx)$/.test(file));
  });
  for (const file of files) {
    const relative = rel(file);
    if (relative === 'server.ts' || LEGACY_BACKEND_CONSOLE_ALLOWLIST.has(relative)) continue;
    const source = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = CONSOLE_RE.exec(source))) {
      violations.push(`${relative}:${lineNumber(source, match.index)} uses console.${match[1]}; use src/utils/logger.ts`);
    }
  }
}

function main() {
  const violations = [];
  checkContractImports(violations);
  checkFrontendImports(violations);
  checkBackendConsole(violations);

  if (violations.length > 0) {
    console.error('Maintainability check failed:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }

  console.log('Maintainability check ok');
}

if (require.main === module) main();

module.exports = {
  checkBackendConsole,
  checkContractImports,
  checkFrontendImports,
};
