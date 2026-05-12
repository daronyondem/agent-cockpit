#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_FILES = [
  '.env.example',
  'AGENTS.md',
  'BACKENDS.md',
  'CLAUDE.md',
  'ONBOARDING.md',
  'README.md',
  'SPEC.md',
  'jest.config.js',
  'package-lock.json',
  'package.json',
  'server.ts',
  'tsconfig.json',
];

const ROOT_DIRECTORIES = [
  'docs',
  'mobile',
  'public',
  'scripts',
  'src',
  'web',
];

const INSTALLER_ASSET_PATH = 'scripts/install-macos.sh';
const INSTALLER_ASSET_NAME = 'install-macos.sh';

const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.github',
  '.claude',
  '.kiro',
  'coverage',
  'data',
  'dist',
  'node_modules',
  'plans',
]);

const EXCLUDED_ROOT_FILES = new Set([
  '.DS_Store',
  '.env',
  'ecosystem.config.js',
  'plan.md',
  'TASK.md',
]);

function parseArgs(argv) {
  const args = {
    outDir: path.join(process.cwd(), 'dist', 'release'),
    root: process.cwd(),
    sourceRef: process.env.GITHUB_REF_NAME || 'main',
    commit: process.env.GITHUB_SHA || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--version') {
      args.version = next;
      i += 1;
    } else if (arg === '--out-dir') {
      args.outDir = next;
      i += 1;
    } else if (arg === '--root') {
      args.root = next;
      i += 1;
    } else if (arg === '--source-ref') {
      args.sourceRef = next;
      i += 1;
    } else if (arg === '--commit') {
      args.commit = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/package-release.js --version <version> [options]

Options:
  --out-dir <path>      Directory for release assets. Defaults to dist/release.
  --root <path>         Repository root to package. Defaults to the current directory.
  --source-ref <ref>    Source ref recorded in release-manifest.json. Defaults to main.
  --commit <sha>        Source commit recorded in release-manifest.json.
`);
}

function normalizeVersion(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('Missing required --version value');
  }
  const version = value.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return version;
}

function relativePath(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function isExcluded(relPath) {
  if (!relPath || relPath === '.') {
    return false;
  }

  const segments = relPath.split('/');
  if (EXCLUDED_ROOT_FILES.has(relPath)) {
    return true;
  }
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
    return true;
  }
  if (segments.some((segment) => segment.startsWith('.v2-built-') || segment.startsWith('.mobile-built-'))) {
    return true;
  }
  if (segments.some((segment) => segment.endsWith('.log'))) {
    return true;
  }
  return false;
}

function assertRequiredFile(root, relPath) {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error(`Required release file is missing: ${relPath}`);
  }
}

function assertRequiredDirectory(root, relPath) {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    throw new Error(`Required release directory is missing: ${relPath}`);
  }
}

function copyEntry(sourceRoot, destRoot, relPath) {
  if (isExcluded(relPath)) {
    return;
  }

  const source = path.join(sourceRoot, relPath);
  const dest = path.join(destRoot, relPath);
  const stat = fs.lstatSync(source);

  if (stat.isSymbolicLink()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(fs.readlinkSync(source), dest);
    return;
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    const names = fs.readdirSync(source).sort();
    for (const name of names) {
      copyEntry(sourceRoot, destRoot, path.posix.join(relPath, name));
    }
    return;
  }

  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function listFiles(root) {
  const files = [];

  function walk(dir) {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const fullPath = path.join(dir, name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        files.push({
          path: relativePath(root, fullPath),
          size: stat.size,
          sha256: sha256File(fullPath),
        });
      }
    }
  }

  walk(root);
  return files;
}

function resolveGitCommit(root, explicitCommit) {
  if (explicitCommit) {
    return explicitCommit;
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function makeReleasePackage(options) {
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  const version = normalizeVersion(options.version);
  const packageRootName = `agent-cockpit-v${version}`;
  const tarballName = `${packageRootName}.tar.gz`;
  const installerAssetPath = path.join(outDir, INSTALLER_ASSET_NAME);
  const manifestName = 'release-manifest.json';
  const checksumsName = 'SHA256SUMS';
  const tarballPath = path.join(outDir, tarballName);
  const manifestPath = path.join(outDir, manifestName);
  const checksumsPath = path.join(outDir, checksumsName);
  const stagingParent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-release-'));
  const stagingRoot = path.join(stagingParent, packageRootName);

  try {
    assertRequiredFile(root, 'package.json');
    assertRequiredFile(root, 'package-lock.json');
    assertRequiredFile(root, 'public/v2-built/index.html');
    assertRequiredFile(root, 'public/mobile-built/index.html');

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(stagingRoot, { recursive: true });

    for (const relPath of ROOT_FILES) {
      if (fs.existsSync(path.join(root, relPath))) {
        copyEntry(root, stagingRoot, relPath);
      }
    }
    for (const relPath of ROOT_DIRECTORIES) {
      assertRequiredDirectory(root, relPath);
      copyEntry(root, stagingRoot, relPath);
    }

    const files = listFiles(stagingRoot);
    execFileSync('tar', ['-czf', tarballPath, '-C', stagingParent, packageRootName], {
      stdio: 'pipe',
    });

    const tarballStat = fs.statSync(tarballPath);
    const tarballSha256 = sha256File(tarballPath);
    const artifacts = [
      {
        name: tarballName,
        role: 'app-tarball',
        size: tarballStat.size,
        sha256: tarballSha256,
      },
    ];

    if (fs.existsSync(path.join(root, INSTALLER_ASSET_PATH))) {
      fs.copyFileSync(path.join(root, INSTALLER_ASSET_PATH), installerAssetPath);
      fs.chmodSync(installerAssetPath, 0o755);
      const installerStat = fs.statSync(installerAssetPath);
      artifacts.push({
        name: INSTALLER_ASSET_NAME,
        role: 'macos-installer',
        size: installerStat.size,
        sha256: sha256File(installerAssetPath),
      });
    }

    const manifest = {
      schemaVersion: 1,
      name: 'agent-cockpit',
      version,
      channel: 'production',
      source: 'github-release',
      sourceRef: options.sourceRef || 'main',
      sourceCommit: resolveGitCommit(root, options.commit),
      generatedAt: new Date().toISOString(),
      packageRoot: packageRootName,
      requiredBuilds: {
        web: 'public/v2-built/index.html',
        mobile: 'public/mobile-built/index.html',
      },
      artifacts,
      files,
    };

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestSha256 = sha256File(manifestPath);
    const checksumLines = [
      `${tarballSha256}  ${tarballName}`,
      `${manifestSha256}  ${manifestName}`,
    ];
    if (fs.existsSync(installerAssetPath)) {
      checksumLines.push(`${sha256File(installerAssetPath)}  ${INSTALLER_ASSET_NAME}`);
    }
    fs.writeFileSync(checksumsPath, `${checksumLines.join('\n')}\n`);

    return {
      outDir,
      tarballPath,
      manifestPath,
      checksumsPath,
      manifest,
    };
  } finally {
    fs.rmSync(stagingParent, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const result = makeReleasePackage(args);
  console.log(`Release tarball: ${result.tarballPath}`);
  console.log(`Release manifest: ${result.manifestPath}`);
  console.log(`Release checksums: ${result.checksumsPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  isExcluded,
  makeReleasePackage,
  normalizeVersion,
  sha256File,
};
