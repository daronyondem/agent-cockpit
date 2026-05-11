import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebBuildService } from '../src/services/webBuildService';

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-build-'));
  const webRoot = path.join(root, 'web', 'AgentCockpitWeb');
  const buildDir = path.join(root, 'public', 'v2-built');
  fs.mkdirSync(path.join(webRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<div id="root"></div>');
  fs.writeFileSync(path.join(webRoot, 'vite.config.ts'), 'export default {};');
  fs.writeFileSync(path.join(webRoot, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(webRoot, 'src', 'main.jsx'), 'window.__v = 1;');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"test"}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  return { root, webRoot, buildDir };
}

function writeBuild(buildDir: string, body = '<!doctype html>built') {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'index.html'), body);
}

function writeNpmBuildScript(root: string, scriptSource: string) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'test',
    scripts: { 'web:build': 'node build.js' },
  }));
  fs.writeFileSync(path.join(root, 'build.js'), scriptSource);
}

describe('WebBuildService', () => {
  test('missing build triggers build and writes marker', async () => {
    const env = makeEnv();
    let builds = 0;
    const service = new WebBuildService(env.root, {
      webRoot: env.webRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        writeBuild(env.buildDir);
        return 'built';
      },
      now: () => new Date('2026-05-11T12:00:00.000Z'),
    });

    const status = await service.ensureBuilt();

    expect(builds).toBe(1);
    expect(status.didBuild).toBe(true);
    expect(status.fresh).toBe(true);
    expect(fs.existsSync(path.join(env.buildDir, '.agent-cockpit-build.json'))).toBe(true);
  });

  test('fresh marker skips build', async () => {
    const env = makeEnv();
    let builds = 0;
    const service = new WebBuildService(env.root, {
      webRoot: env.webRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        writeBuild(env.buildDir);
        return 'built';
      },
    });

    await service.ensureBuilt();
    const second = await service.ensureBuilt();

    expect(builds).toBe(1);
    expect(second.didBuild).toBe(false);
    expect(second.fresh).toBe(true);
  });

  test('source hash change triggers rebuild', async () => {
    const env = makeEnv();
    let builds = 0;
    const service = new WebBuildService(env.root, {
      webRoot: env.webRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        writeBuild(env.buildDir, `build ${builds}`);
        return 'built';
      },
    });

    await service.ensureBuilt();
    fs.writeFileSync(path.join(env.webRoot, 'src', 'main.jsx'), 'window.__v = 2;');
    const second = await service.ensureBuilt();

    expect(builds).toBe(2);
    expect(second.didBuild).toBe(true);
  });

  test('package-lock change triggers rebuild', async () => {
    const env = makeEnv();
    let builds = 0;
    const service = new WebBuildService(env.root, {
      webRoot: env.webRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        writeBuild(env.buildDir, `build ${builds}`);
        return 'built';
      },
    });

    await service.ensureBuilt();
    fs.writeFileSync(path.join(env.root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
    const second = await service.ensureBuilt();

    expect(builds).toBe(2);
    expect(second.didBuild).toBe(true);
  });

  test('build failure without previous assets fails preflight', async () => {
    const env = makeEnv();
    const service = new WebBuildService(env.root, {
      webRoot: env.webRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        throw new Error('build broke');
      },
    });

    await expect(service.ensureBuilt()).rejects.toThrow('V2 web build failed and no previous build is available: build broke');
  });

  test('build failure with previous assets keeps previous build', async () => {
    const env = makeEnv();
    let fail = false;
    const service = new WebBuildService(env.root, {
      webRoot: env.webRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        if (fail) throw new Error('build broke');
        writeBuild(env.buildDir);
        return 'built';
      },
    });

    await service.ensureBuilt();
    fail = true;
    fs.writeFileSync(path.join(env.webRoot, 'src', 'main.jsx'), 'window.__v = 3;');
    const second = await service.ensureBuilt();

    expect(second.didBuild).toBe(false);
    expect(second.fresh).toBe(false);
    expect(second.previousBuildAvailable).toBe(true);
    expect(second.error).toBe('build broke');
    expect(fs.existsSync(path.join(env.buildDir, 'index.html'))).toBe(true);
  });

  test('skip mode bypasses build', async () => {
    const env = makeEnv();
    let builds = 0;
    const service = new WebBuildService(env.root, {
      mode: 'skip',
      webRoot: env.webRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        writeBuild(env.buildDir);
        return 'built';
      },
    });

    const status = await service.ensureBuilt();

    expect(builds).toBe(0);
    expect(status.skipped).toBe(true);
    expect(status.fresh).toBe(false);
  });

  test('force build overrides skip mode for self-update', async () => {
    const env = makeEnv();
    let builds = 0;
    const service = new WebBuildService(env.root, {
      mode: 'skip',
      webRoot: env.webRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        writeBuild(env.buildDir);
        return 'forced build';
      },
    });

    const status = await service.ensureBuilt({ force: true });

    expect(builds).toBe(1);
    expect(status.skipped).toBe(false);
    expect(status.didBuild).toBe(true);
    expect(status.output).toBe('forced build');
  });

  test('coalesces concurrent preflight calls into one build', async () => {
    const env = makeEnv();
    let builds = 0;
    let releaseBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const service = new WebBuildService(env.root, {
      webRoot: env.webRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        await buildStarted;
        writeBuild(env.buildDir);
        return 'built';
      },
    });

    const first = service.ensureBuilt();
    const second = service.ensureBuilt();
    releaseBuild();
    const [firstStatus, secondStatus] = await Promise.all([first, second]);

    expect(builds).toBe(1);
    expect(firstStatus.didBuild).toBe(true);
    expect(secondStatus).toBe(firstStatus);
  });

  test('default runner builds into staging and swaps over previous build only after success', async () => {
    const env = makeEnv();
    writeBuild(env.buildDir, '<!doctype html>previous');
    writeNpmBuildScript(env.root, `
      const fs = require('fs');
      const path = require('path');
      const outDir = process.argv[process.argv.indexOf('--outDir') + 1];
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'index.html'), '<!doctype html>fresh');
    `);
    const service = new WebBuildService(env.root, {
      webRoot: env.webRoot,
      buildDir: env.buildDir,
    });

    const status = await service.ensureBuilt({ force: true });

    expect(status.didBuild).toBe(true);
    expect(fs.readFileSync(path.join(env.buildDir, 'index.html'), 'utf8')).toBe('<!doctype html>fresh');
    expect(fs.readdirSync(path.dirname(env.buildDir)).filter((name) => name.startsWith('.v2-built-'))).toEqual([]);
  });

  test('default runner preserves previous build when staging build fails', async () => {
    const env = makeEnv();
    writeBuild(env.buildDir, '<!doctype html>previous');
    writeNpmBuildScript(env.root, `
      const fs = require('fs');
      const path = require('path');
      const outDir = process.argv[process.argv.indexOf('--outDir') + 1];
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'index.html'), '<!doctype html>partial');
      process.exit(1);
    `);
    const service = new WebBuildService(env.root, {
      webRoot: env.webRoot,
      buildDir: env.buildDir,
    });

    const status = await service.ensureBuilt({ force: true });

    expect(status.didBuild).toBe(false);
    expect(status.error).toBeTruthy();
    expect(fs.readFileSync(path.join(env.buildDir, 'index.html'), 'utf8')).toBe('<!doctype html>previous');
    expect(fs.readdirSync(path.dirname(env.buildDir)).filter((name) => name.startsWith('.v2-built-'))).toEqual([]);
  });
});
