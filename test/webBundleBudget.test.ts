import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkBudget, normalizeAssetName } = require('../scripts/check-web-bundle-size.js');

const tmpBuilds: string[] = [];

function makeBuild(files: Record<string, number>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-budget-'));
  tmpBuilds.push(root);
  const assets = path.join(root, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(assets, name), Buffer.alloc(bytes, 'x'));
  }
  return root;
}

describe('web bundle budget', () => {
  afterEach(() => {
    for (const dir of tmpBuilds.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizes Vite hashed chunk names', () => {
    expect(normalizeAssetName('react-vendor-68Ltgy9u.js')).toBe('react-vendor.js');
    expect(normalizeAssetName('index-CxCf_pmJ.css')).toBe('index.css');
    expect(normalizeAssetName('rolldown-runtime-jpDsebLB.js')).toBe('rolldown-runtime.js');
  });

  test('passes when named assets and totals stay within budget', () => {
    const buildDir = makeBuild({
      'index-abc123.js': 100,
      'react-vendor-def456.js': 100,
      'index-abc123.css': 50,
    });

    const result = checkBudget({
      buildDir,
      budgets: {
        totalJs: 250,
        totalCss: 75,
        maxJsAsset: 200,
        maxCssAsset: 75,
        assets: {
          'index.js': 150,
          'react-vendor.js': 150,
          'index.css': 75,
        },
      },
    });

    expect(result.violations).toEqual([]);
    expect(result.totals).toEqual({ js: 200, css: 50 });
  });

  test('reports named and total budget violations', () => {
    const buildDir = makeBuild({
      'index-abc123.js': 160,
      'react-vendor-def456.js': 120,
      'index-abc123.css': 90,
    });

    const result = checkBudget({
      buildDir,
      budgets: {
        totalJs: 250,
        totalCss: 80,
        maxJsAsset: 200,
        maxCssAsset: 100,
        assets: {
          'index.js': 150,
        },
      },
    });

    expect(result.violations).toEqual([
      expect.stringContaining('index-abc123.js'),
      expect.stringContaining('total JS'),
      expect.stringContaining('total CSS'),
    ]);
  });

  test('fails empty build asset directories', () => {
    const buildDir = makeBuild({});

    const result = checkBudget({
      buildDir,
      budgets: {
        totalJs: 250,
        totalCss: 80,
        maxJsAsset: 200,
        maxCssAsset: 100,
        assets: {},
      },
    });

    expect(result.violations).toEqual([
      'no JS or CSS assets found in V2 build output',
      'no JS assets found in V2 build output',
      'no CSS assets found in V2 build output',
    ]);
  });
});
