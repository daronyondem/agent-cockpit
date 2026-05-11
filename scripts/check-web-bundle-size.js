#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_BUILD_DIR = path.join(ROOT, 'public', 'v2-built');
const KIB = 1024;

const DEFAULT_BUDGETS = {
  totalJs: 850 * KIB,
  totalCss: 230 * KIB,
  maxJsAsset: 230 * KIB,
  maxCssAsset: 230 * KIB,
  assets: {
    'index.js': 210 * KIB,
    'react-vendor.js': 230 * KIB,
    'markdown-vendor.js': 160 * KIB,
    'kbBrowser.js': 115 * KIB,
    'workspaceSettings.js': 95 * KIB,
    'settingsScreen.js': 75 * KIB,
    'dialog.js': 60 * KIB,
    'filesBrowser.js': 45 * KIB,
    'memoryReview.js': 35 * KIB,
    'sessionsModal.js': 20 * KIB,
    'tooltip.js': 10 * KIB,
    'rolldown-runtime.js': 5 * KIB,
    'index.css': 220 * KIB,
  },
};

function formatBytes(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`;
}

function normalizeAssetName(fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext).replace(/-[A-Za-z0-9_]{6,}$/, '');
  return `${stem}${ext}`;
}

function collectAssets(buildDir = DEFAULT_BUILD_DIR) {
  const assetsDir = path.join(buildDir, 'assets');
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`V2 assets directory not found: ${assetsDir}. Run npm run web:build first.`);
  }

  return fs.readdirSync(assetsDir)
    .filter((fileName) => fileName.endsWith('.js') || fileName.endsWith('.css'))
    .map((fileName) => {
      const filePath = path.join(assetsDir, fileName);
      return {
        fileName,
        key: normalizeAssetName(fileName),
        ext: path.extname(fileName),
        bytes: fs.statSync(filePath).size,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key) || a.fileName.localeCompare(b.fileName));
}

function checkBudget(options = {}) {
  const buildDir = options.buildDir || DEFAULT_BUILD_DIR;
  const budgets = options.budgets || DEFAULT_BUDGETS;
  const assets = collectAssets(buildDir);
  const violations = [];
  let totalJs = 0;
  let totalCss = 0;

  for (const asset of assets) {
    if (asset.ext === '.js') totalJs += asset.bytes;
    if (asset.ext === '.css') totalCss += asset.bytes;

    const genericLimit = asset.ext === '.css' ? budgets.maxCssAsset : budgets.maxJsAsset;
    const namedLimit = budgets.assets?.[asset.key];
    const limit = namedLimit || genericLimit;
    if (limit && asset.bytes > limit) {
      violations.push(`${asset.fileName} is ${formatBytes(asset.bytes)} over ${formatBytes(limit)} budget (${asset.key})`);
    }
  }

  if (assets.length === 0) {
    violations.push('no JS or CSS assets found in V2 build output');
  }
  if (totalJs === 0) {
    violations.push('no JS assets found in V2 build output');
  }
  if (totalCss === 0) {
    violations.push('no CSS assets found in V2 build output');
  }

  if (totalJs > budgets.totalJs) {
    violations.push(`total JS is ${formatBytes(totalJs)} over ${formatBytes(budgets.totalJs)} budget`);
  }
  if (totalCss > budgets.totalCss) {
    violations.push(`total CSS is ${formatBytes(totalCss)} over ${formatBytes(budgets.totalCss)} budget`);
  }

  return {
    assets,
    violations,
    totals: { js: totalJs, css: totalCss },
    budgets,
  };
}

function main() {
  const result = checkBudget();
  if (result.violations.length > 0) {
    console.error('V2 bundle budget failed:');
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log([
    `V2 bundle budget ok: JS ${formatBytes(result.totals.js)} / ${formatBytes(result.budgets.totalJs)}`,
    `CSS ${formatBytes(result.totals.css)} / ${formatBytes(result.budgets.totalCss)}`,
  ].join('; '));
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_BUDGETS,
  checkBudget,
  collectAssets,
  formatBytes,
  normalizeAssetName,
};
