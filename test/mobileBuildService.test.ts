import fs from 'fs';
import os from 'os';
import path from 'path';
import { MobileBuildService } from '../src/services/mobileBuildService';

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-build-'));
  const mobileRoot = path.join(root, 'mobile', 'AgentCockpitPWA');
  const buildDir = path.join(root, 'public', 'mobile-built');
  fs.mkdirSync(path.join(mobileRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(mobileRoot, 'index.html'), '<div id="root"></div>');
  fs.writeFileSync(path.join(mobileRoot, 'vite.config.ts'), 'export default {};');
  fs.writeFileSync(path.join(mobileRoot, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(mobileRoot, 'src', 'App.tsx'), 'export default function App(){ return null; }');
  fs.writeFileSync(path.join(mobileRoot, 'package.json'), '{"name":"mobile-test"}');
  fs.writeFileSync(path.join(mobileRoot, 'package-lock.json'), '{"lockfileVersion":3}');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"test"}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  return { root, mobileRoot, buildDir };
}

function writeBuild(buildDir: string, body = '<!doctype html>mobile') {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'index.html'), body);
}

describe('MobileBuildService', () => {
  test('missing mobile build triggers build and writes marker', async () => {
    const env = makeEnv();
    let builds = 0;
    const service = new MobileBuildService(env.root, {
      mobileRoot: env.mobileRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        writeBuild(env.buildDir);
        return 'mobile built';
      },
      now: () => new Date('2026-05-11T12:00:00.000Z'),
    });

    const status = await service.ensureBuilt();

    expect(builds).toBe(1);
    expect(status.didBuild).toBe(true);
    expect(status.fresh).toBe(true);
    expect(fs.existsSync(path.join(env.buildDir, '.agent-cockpit-build.json'))).toBe(true);
  });

  test('mobile package-lock change triggers rebuild', async () => {
    const env = makeEnv();
    let builds = 0;
    const service = new MobileBuildService(env.root, {
      mobileRoot: env.mobileRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        writeBuild(env.buildDir, `mobile ${builds}`);
        return 'mobile built';
      },
    });

    await service.ensureBuilt();
    fs.writeFileSync(path.join(env.mobileRoot, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
    const second = await service.ensureBuilt();

    expect(builds).toBe(2);
    expect(second.didBuild).toBe(true);
  });

  test('skip mode bypasses mobile build', async () => {
    const env = makeEnv();
    let builds = 0;
    const service = new MobileBuildService(env.root, {
      mode: 'skip',
      mobileRoot: env.mobileRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        writeBuild(env.buildDir);
        return 'mobile built';
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
    const service = new MobileBuildService(env.root, {
      mode: 'skip',
      mobileRoot: env.mobileRoot,
      buildDir: env.buildDir,
      buildRunner: async () => {
        builds += 1;
        writeBuild(env.buildDir);
        return 'mobile forced';
      },
    });

    const status = await service.ensureBuilt({ force: true });

    expect(builds).toBe(1);
    expect(status.skipped).toBe(false);
    expect(status.didBuild).toBe(true);
    expect(status.output).toBe('mobile forced');
  });

  test('default command targets the mobile package with staged outDir', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'mobileBuildService.ts'), 'utf8');

    expect(src).toContain("path.join(appRoot, 'public', 'mobile-built')");
    expect(src).toContain("args: ['--prefix', 'mobile/AgentCockpitPWA', 'run', 'build', '--', '--outDir', stagingDir]");
    expect(src).toContain("stagingPrefix: 'mobile-built'");
  });
});
