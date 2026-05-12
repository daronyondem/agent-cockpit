import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const scriptPath = path.join(process.cwd(), 'scripts/install-macos.sh');

describe('macOS installer script', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  test('has a safe shell entrypoint and help output', () => {
    expect(source).toContain('#!/usr/bin/env bash');
    expect(source).toContain('set -euo pipefail');

    const help = execFileSync(scriptPath, ['--help'], { encoding: 'utf8' });
    expect(help).toContain('--channel production|dev');
    expect(help).toContain('--install-node');
    expect(help).toContain('--skip-open');
  });

  test('guards platform and prerequisite installation', () => {
    expect(source).toContain('uname -s');
    expect(source).toContain('This installer currently supports macOS only.');
    expect(source).toContain('arm64|x86_64');
    expect(source).toContain('process.versions.node.split');
    expect(source).toContain('-ge 22');
    expect(source).toContain('brew install node');
    expect(source).toContain('INSTALL_NODE" == "true"');
  });

  test('uses GitHub Release assets for production installs', () => {
    expect(source).toContain('/releases/latest/download');
    expect(source).toContain('/releases/download/v${VERSION}');
    expect(source).toContain('release-manifest.json');
    expect(source).toContain('SHA256SUMS');
    expect(source).toContain('app-tarball');
    expect(source).toContain('shasum -a 256');
    expect(source).toContain('tar -xzf');
  });

  test('supports dev installs from main', () => {
    expect(source).toContain('git clone "https://github.com/${REPO}.git" "$DEV_DIR"');
    expect(source).toContain('git -C "$DEV_DIR" fetch origin main');
    expect(source).toContain('git -C "$DEV_DIR" checkout main');
    expect(source).toContain('git -C "$DEV_DIR" pull --ff-only origin main');
    expect(source).toContain('"dev" "git-main"');
  });

  test('generates runtime config, install manifest, and local PM2 startup', () => {
    expect(source).toContain('SESSION_SECRET=${session_secret}');
    expect(source).toContain('AUTH_SETUP_TOKEN=${setup_token}');
    expect(source).toContain('AGENT_COCKPIT_DATA_DIR="${data_dir}"');
    expect(source).toContain('WEB_BUILD_MODE=auto');
    expect(source).toContain('ecosystem.config.js');
    expect(source).toContain('interpreter: \'./node_modules/.bin/tsx\'');
    expect(source).toContain('schemaVersion: 1');
    expect(source).toContain('npx pm2 startOrRestart ecosystem.config.js --update-env');
    expect(source).toContain('npx pm2 save');
    expect(source).toContain('http://localhost:${PORT}/auth/setup');
  });
});
