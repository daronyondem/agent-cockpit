#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;

function routeFiles() {
  return [
    path.join(ROOT, 'src', 'routes', 'chat.ts'),
    ...fs.readdirSync(path.join(ROOT, 'src', 'routes', 'chat'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => path.join(ROOT, 'src', 'routes', 'chat', name)),
  ];
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function extractRoutes() {
  const routes = [];
  for (const file of routeFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = ROUTE_RE.exec(source))) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[3],
        file: rel(file),
      });
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function main() {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'spec-api-endpoints.md'), 'utf8');
  const missing = extractRoutes().filter((route) => !spec.includes(route.path));

  if (missing.length > 0) {
    console.error('API spec drift check failed. These route paths are missing from docs/spec-api-endpoints.md:');
    for (const route of missing) {
      console.error(`- ${route.method} ${route.path} (${route.file})`);
    }
    process.exit(1);
  }

  console.log(`API spec drift check ok (${extractRoutes().length} documented route declarations)`);
}

if (require.main === module) main();

module.exports = { extractRoutes };
