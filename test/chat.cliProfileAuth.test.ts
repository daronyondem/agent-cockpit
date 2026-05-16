/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { CliProfileAuthService, redactCliAuthText } from '../src/services/cliProfileAuthService';

let env: ChatRouterEnv;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

function writeExecutable(name: string, body: string): string {
  const file = path.join(env.tmpDir, name);
  fs.writeFileSync(file, body, 'utf8');
  fs.chmodSync(file, 0o755);
  return file;
}

function mockProcessPlatform(platform: NodeJS.Platform): () => void {
  Object.defineProperty(process, 'platform', { value: platform });
  return () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

async function addProfile(profile: Record<string, any>): Promise<void> {
  const settings = await env.chatService.getSettings();
  await env.chatService.saveSettings({
    ...settings,
    cliProfiles: [...(settings.cliProfiles || []), profile],
  } as any);
}

async function waitForJob(jobId: string): Promise<any> {
  let last: any = null;
  for (let i = 0; i < 40; i++) {
    const res = await env.request('GET', `/api/chat/cli-profiles/auth-jobs/${jobId}`);
    last = res.body.job;
    if (last && last.status !== 'running') return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return last;
}

async function waitForServiceJob(service: CliProfileAuthService, jobId: string): Promise<any> {
  let last: any = null;
  for (let i = 0; i < 40; i++) {
    last = service.getJob(jobId);
    if (last && last.status !== 'running') return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return last;
}

describe('CLI profile auth endpoints', () => {
  test('checks an account profile and creates a default config directory', async () => {
    const command = writeExecutable('fake-claude-status.sh', [
      '#!/bin/sh',
      'printf \'{"loggedIn":true,"config":"%s"}\\n\' "$CLAUDE_CONFIG_DIR"',
      'exit 0',
      '',
    ].join('\n'));
    await addProfile({
      id: 'profile-claude-auth',
      name: 'Claude Auth',
      vendor: 'claude-code',
      authMode: 'account',
      command,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    const res = await env.request('POST', '/api/chat/cli-profiles/profile-claude-auth/test', {});

    expect(res.status).toBe(200);
    expect(res.body.result.available).toBe(true);
    expect(res.body.result.authenticated).toBe(true);
    expect(res.body.result.modelsAvailable).toBe(true);
    expect(res.body.result.modelCount).toBe(3);
    expect(res.body.profile.configDir).toContain('profile-claude-auth');
    expect(res.body.result.output).toContain(res.body.profile.configDir);
    expect(fs.existsSync(res.body.profile.configDir)).toBe(true);
  });

  test('does not verify Claude auth when status JSON reports logged out with exit zero', async () => {
    const command = writeExecutable('fake-claude-status-logged-out.sh', [
      '#!/bin/sh',
      'echo \'{"loggedIn":false,"authMethod":null}\'',
      'exit 0',
      '',
    ].join('\n'));
    await addProfile({
      id: 'profile-claude-logged-out',
      name: 'Claude Logged Out',
      vendor: 'claude-code',
      authMode: 'account',
      command,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    const res = await env.request('POST', '/api/chat/cli-profiles/profile-claude-logged-out/test', {});

    expect(res.status).toBe(200);
    expect(res.body.result.available).toBe(true);
    expect(res.body.result.authenticated).toBe(false);
    expect(res.body.result.status).toBe('not-authenticated');
    expect(res.body.result.output).toContain('"loggedIn":false');
  });

  test('starts an auth job and exposes emitted login text for polling', async () => {
    const command = writeExecutable('fake-codex-auth.sh', [
      '#!/bin/sh',
      'printf "\\033[90mCODEX_HOME=$CODEX_HOME\\033[0m\\n"',
      'printf "Open \\033[94mhttps://example.test/device\\033[0m and enter \\033[94mABCD-EFGH\\033[0m\\n"',
      'exit 0',
      '',
    ].join('\n'));
    await addProfile({
      id: 'profile-codex-auth',
      name: 'Codex Auth',
      vendor: 'codex',
      authMode: 'account',
      command,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    const start = await env.request('POST', '/api/chat/cli-profiles/profile-codex-auth/auth/start', {});
    expect(start.status).toBe(200);
    expect(start.body.profile.configDir).toContain('profile-codex-auth');

    const job = await waitForJob(start.body.job.id);
    expect(job.status).toBe('succeeded');
    const output = job.events.map((event: any) => event.text).join('\n');
    expect(output).toContain('https://example.test/device');
    expect(output).toContain('ABCD-EFGH');
    expect(output).toContain(`CODEX_HOME=${start.body.profile.configDir}`);
    expect(output).not.toContain('\u001b[');
  });

  test('checks Windows installer-managed Codex package through node script', async () => {
    const restorePlatform = mockProcessPlatform('win32');
    const root = path.join(env.tmpDir, 'Agent Cockpit');
    const originalDataDir = process.env.AGENT_COCKPIT_DATA_DIR;
    const codexJs = path.join(root, 'cli-tools', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(codexJs), { recursive: true });
    fs.writeFileSync(codexJs, '');
    process.env.AGENT_COCKPIT_DATA_DIR = path.join(root, 'data');
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawn = ((command: string, args: string[]) => {
      calls.push({ command, args });
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('logged in'));
        proc.emit('close', 0);
      });
      return proc;
    }) as any;
    try {
      const service = new CliProfileAuthService(env.tmpDir, { spawn });
      const result = await service.checkProfile({
        id: 'profile-codex-win-auth',
        name: 'Codex Windows Auth',
        vendor: 'codex',
        authMode: 'account',
        configDir: path.join(env.tmpDir, 'codex-win-auth'),
        createdAt: '2026-04-30T00:00:00.000Z',
        updatedAt: '2026-04-30T00:00:00.000Z',
      } as any);

      expect(result.status).toBe('ok');
      expect(calls[0]).toEqual({
        command: process.execPath,
        args: [codexJs, 'login', 'status'],
      });
    } finally {
      if (originalDataDir === undefined) {
        delete process.env.AGENT_COCKPIT_DATA_DIR;
      } else {
        process.env.AGENT_COCKPIT_DATA_DIR = originalDataDir;
      }
      restorePlatform();
    }
  });

  test('rejects Kiro auth jobs while Kiro is self-configured only', async () => {
    await addProfile({
      id: 'profile-kiro-auth',
      name: 'Kiro Auth',
      vendor: 'kiro',
      authMode: 'server-configured',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    const res = await env.request('POST', '/api/chat/cli-profiles/profile-kiro-auth/auth/start', {});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Remote authentication is not supported for Kiro');
  });

  test('setup auth creates an account profile and promotes the default vendor profile', async () => {
    const originalPath = process.env.PATH;
    writeExecutable('claude', [
      '#!/bin/sh',
      'if [ -n "$CLAUDE_CONFIG_DIR" ]; then',
      '  echo "CONFIG=$CLAUDE_CONFIG_DIR"',
      '  exit 1',
      'fi',
      'echo \'{"loggedIn":true,"config":"system"}\'',
      'exit 0',
      '',
    ].join('\n'));
    process.env.PATH = `${env.tmpDir}${path.delimiter}${originalPath || ''}`;
    try {
      const res = await env.request('POST', '/api/chat/cli-profiles/setup-auth/claude-code/test', {});

      expect(res.status).toBe(200);
      expect(res.body.profile).toEqual(expect.objectContaining({
        id: 'setup-claude-code-account',
        vendor: 'claude-code',
        authMode: 'account',
      }));
      expect(res.body.profile.configDir).toBeUndefined();
      expect(res.body.settings.defaultCliProfileId).toBe('setup-claude-code-account');
      expect(res.body.result.output).toContain('"config":"system"');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('Windows setup auth marks Claude Code terminal onboarding complete after credentials verify', async () => {
    const restorePlatform = mockProcessPlatform('win32');
    const originalUserProfile = process.env.USERPROFILE;
    const originalDataDir = process.env.AGENT_COCKPIT_DATA_DIR;
    const installRoot = path.join(env.tmpDir, 'Agent Cockpit');
    const claudeExe = path.join(installRoot, 'cli-tools', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    process.env.USERPROFILE = env.tmpDir;
    process.env.AGENT_COCKPIT_DATA_DIR = path.join(installRoot, 'data');
    fs.mkdirSync(path.dirname(claudeExe), { recursive: true });
    fs.writeFileSync(claudeExe, [
      '#!/bin/sh',
      'if [ -n "$CLAUDE_CONFIG_DIR" ]; then',
      '  echo "CONFIG=$CLAUDE_CONFIG_DIR"',
      '  exit 1',
      'fi',
      'echo \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\'',
      'exit 0',
      '',
    ].join('\n'));
    fs.chmodSync(claudeExe, 0o755);
    try {
      const res = await env.request('POST', '/api/chat/cli-profiles/setup-auth/claude-code/test', {});

      expect(res.status).toBe(200);
      expect(res.body.result.authenticated).toBe(true);
      expect(res.body.result.output).toContain('skips first-run onboarding');
      const globalConfig = JSON.parse(fs.readFileSync(path.join(env.tmpDir, '.claude.json'), 'utf8'));
      expect(globalConfig.hasCompletedOnboarding).toBe(true);
      expect(res.body.settings.cliProfiles.find((profile: any) => profile.id === 'setup-claude-code-account').configDir).toBeUndefined();
    } finally {
      if (originalDataDir === undefined) {
        delete process.env.AGENT_COCKPIT_DATA_DIR;
      } else {
        process.env.AGENT_COCKPIT_DATA_DIR = originalDataDir;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      restorePlatform();
    }
  });

  test('setup auth migrates old setup profiles back to system CLI auth', async () => {
    const originalPath = process.env.PATH;
    const oldConfigDir = path.join(env.tmpDir, 'old-setup-claude-config');
    fs.mkdirSync(oldConfigDir, { recursive: true });
    writeExecutable('claude', [
      '#!/bin/sh',
      'if [ -n "$CLAUDE_CONFIG_DIR" ]; then',
      '  echo "CONFIG=$CLAUDE_CONFIG_DIR"',
      '  exit 1',
      'fi',
      'echo \'{"loggedIn":true,"config":"system"}\'',
      'exit 0',
      '',
    ].join('\n'));
    await addProfile({
      id: 'setup-claude-code-account',
      name: 'Claude Code Account',
      vendor: 'claude-code',
      authMode: 'account',
      env: { CLAUDE_CONFIG_DIR: oldConfigDir },
      configDir: oldConfigDir,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    process.env.PATH = `${env.tmpDir}${path.delimiter}${originalPath || ''}`;
    try {
      const res = await env.request('POST', '/api/chat/cli-profiles/setup-auth/claude-code/test', {});

      expect(res.status).toBe(200);
      expect(res.body.profile.id).toBe('setup-claude-code-account');
      expect(res.body.profile.configDir).toBeUndefined();
      expect(res.body.profile.env).toBeUndefined();
      expect(res.body.result.output).toContain('"config":"system"');
      const savedProfile = res.body.settings.cliProfiles.find((profile: any) => profile.id === 'setup-claude-code-account');
      expect(savedProfile.configDir).toBeUndefined();
      expect(savedProfile.env).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('direct setup profile check does not restore isolated configDir', async () => {
    const originalPath = process.env.PATH;
    const oldConfigDir = path.join(env.tmpDir, 'old-direct-setup-claude-config');
    writeExecutable('claude', [
      '#!/bin/sh',
      'if [ -n "$CLAUDE_CONFIG_DIR" ]; then',
      '  echo "CONFIG=$CLAUDE_CONFIG_DIR"',
      '  exit 1',
      'fi',
      'echo \'{"loggedIn":true,"config":"system"}\'',
      'exit 0',
      '',
    ].join('\n'));
    const settingsFile = path.join(env.tmpDir, 'data', 'chat', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      defaultBackend: 'claude-code',
      defaultCliProfileId: 'setup-claude-code-account',
      cliProfiles: [{
        id: 'setup-claude-code-account',
        name: 'Claude Code Account',
        vendor: 'claude-code',
        authMode: 'account',
        protocol: 'standard',
        configDir: oldConfigDir,
        env: { CLAUDE_CONFIG_DIR: oldConfigDir },
        createdAt: '2026-04-30T00:00:00.000Z',
        updatedAt: '2026-04-30T00:00:00.000Z',
      }],
    }, null, 2));
    process.env.PATH = `${env.tmpDir}${path.delimiter}${originalPath || ''}`;
    try {
      const res = await env.request('POST', '/api/chat/cli-profiles/setup-claude-code-account/test', {});

      expect(res.status).toBe(200);
      expect(res.body.profile.id).toBe('setup-claude-code-account');
      expect(res.body.profile.configDir).toBeUndefined();
      expect(res.body.profile.env).toBeUndefined();
      expect(res.body.result.output).toContain('"config":"system"');
      const loaded = await env.chatService.getSettings();
      const loadedProfile = loaded.cliProfiles!.find((profile: any) => profile.id === 'setup-claude-code-account')!;
      expect(loadedProfile.configDir).toBeUndefined();
      expect(loadedProfile.env).toBeUndefined();
      const persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      expect(persisted.cliProfiles[0].configDir).toBeUndefined();
      expect(persisted.cliProfiles[0].env).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('setup auth reuses an existing account profile for login jobs', async () => {
    const command = writeExecutable('fake-codex-setup-auth.sh', [
      '#!/bin/sh',
      'if [ -n "$CODEX_HOME" ]; then',
      '  echo "CODEX_HOME=$CODEX_HOME"',
      '  exit 1',
      'fi',
      'if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then',
      '  echo "Open https://example.test/codex and enter SETUP-CODE"',
      '  exit 0',
      'fi',
      'echo "logged in"',
      'exit 0',
      '',
    ].join('\n'));
    await addProfile({
      id: 'existing-codex-account',
      name: 'Existing Codex Account',
      vendor: 'codex',
      authMode: 'account',
      command,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    const start = await env.request('POST', '/api/chat/cli-profiles/setup-auth/codex/start', {});
    expect(start.status).toBe(200);
    expect(start.body.profile.id).toBe('existing-codex-account');
    expect(start.body.profile.configDir).toBeUndefined();

    const job = await waitForJob(start.body.job.id);
    expect(job.status).toBe('succeeded');
    const output = job.events.map((event: any) => event.text).join('\n');
    expect(output).toContain('https://example.test/codex');
    expect(output).toContain('SETUP-CODE');
  });

  test('setup auth keeps Kiro explicitly self-configured', async () => {
    const res = await env.request('POST', '/api/chat/cli-profiles/setup-auth/kiro/start', {});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Remote authentication is not supported for Kiro');
  });

  test('cancels a running auth job', async () => {
    const command = writeExecutable('fake-codex-slow-auth.sh', [
      '#!/bin/sh',
      'echo "waiting"',
      'sleep 5',
      '',
    ].join('\n'));
    await addProfile({
      id: 'profile-codex-cancel',
      name: 'Codex Cancel',
      vendor: 'codex',
      authMode: 'account',
      command,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    const start = await env.request('POST', '/api/chat/cli-profiles/profile-codex-cancel/auth/start', {});
    expect(start.status).toBe(200);

    const cancelled = await env.request('POST', `/api/chat/cli-profiles/auth-jobs/${start.body.job.id}/cancel`, {});

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.job.status).toBe('cancelled');
  });

  test('prevents duplicate auth jobs for the same profile', async () => {
    const command = writeExecutable('fake-codex-running-auth.sh', [
      '#!/bin/sh',
      'sleep 5',
      '',
    ].join('\n'));
    const service = new CliProfileAuthService(env.tmpDir, { authTimeoutMs: 5_000 });
    const profile = {
      id: 'profile-codex-duplicate',
      name: 'Codex Duplicate',
      vendor: 'codex',
      authMode: 'account',
      command,
      configDir: path.join(env.tmpDir, 'codex-duplicate'),
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    } as any;

    const first = await service.startAuth(profile);
    await expect(service.startAuth(profile)).rejects.toThrow('Authentication is already running');
    service.cancelJob(first.id);
    service.shutdown();
  });

  test('fails an auth job when final status never verifies', async () => {
    const command = writeExecutable('fake-codex-auth-status-fail.sh', [
      '#!/bin/sh',
      'if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then',
      '  echo "login flow exited"',
      '  exit 0',
      'fi',
      'echo "not logged in"',
      'exit 1',
      '',
    ].join('\n'));
    const service = new CliProfileAuthService(env.tmpDir, {
      statusPollTimeoutMs: 75,
      statusPollIntervalMs: 10,
    });

    const started = await service.startAuth({
      id: 'profile-codex-status-fail',
      name: 'Codex Status Fail',
      vendor: 'codex',
      authMode: 'account',
      command,
      configDir: path.join(env.tmpDir, 'codex-status-fail'),
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    } as any);

    const job = await waitForServiceJob(service, started.id);

    expect(job.status).toBe('failed');
    expect(job.error).toContain('did not verify before timeout');
    expect(job.error).toContain('not logged in');
    service.shutdown();
  });

  test('fails a Claude auth job when final status JSON still reports logged out', async () => {
    const command = writeExecutable('fake-claude-auth-status-false.sh', [
      '#!/bin/sh',
      'if [ "$1" = "auth" ] && [ "$2" = "login" ]; then',
      '  echo "login flow exited"',
      '  exit 0',
      'fi',
      'echo \'{"loggedIn":false}\'',
      'exit 0',
      '',
    ].join('\n'));
    const service = new CliProfileAuthService(env.tmpDir, {
      statusPollTimeoutMs: 75,
      statusPollIntervalMs: 10,
    });

    const started = await service.startAuth({
      id: 'profile-claude-status-false',
      name: 'Claude Status False',
      vendor: 'claude-code',
      authMode: 'account',
      command,
      configDir: path.join(env.tmpDir, 'claude-status-false'),
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    } as any);

    const job = await waitForServiceJob(service, started.id);

    expect(job.status).toBe('failed');
    expect(job.error).toContain('did not verify before timeout');
    expect(job.error).toContain('"loggedIn":false');
    service.shutdown();
  });

  test('fails a long-running auth job after timeout', async () => {
    const command = writeExecutable('fake-codex-timeout-auth.sh', [
      '#!/bin/sh',
      'sleep 5',
      '',
    ].join('\n'));
    const service = new CliProfileAuthService(env.tmpDir, {
      authTimeoutMs: 50,
      statusPollTimeoutMs: 50,
      statusPollIntervalMs: 10,
    });

    const started = await service.startAuth({
      id: 'profile-codex-timeout',
      name: 'Codex Timeout',
      vendor: 'codex',
      authMode: 'account',
      command,
      configDir: path.join(env.tmpDir, 'codex-timeout'),
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    } as any);

    const job = await waitForServiceJob(service, started.id);

    expect(job.status).toBe('failed');
    expect(job.error).toContain('authentication timed out');
    service.shutdown();
  });

  test('redacts tokens from auth output', () => {
    const redacted = redactCliAuthText([
      'Bearer abcdefghijklmnopqrstuvwxyz',
      'access_token="access-secret"',
      'refresh_token=refresh-secret',
      'api_key=sk-1234567890abcdef',
    ].join('\n'));

    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).toContain('access_token="[REDACTED]');
    expect(redacted).toContain('refresh_token=[REDACTED]');
    expect(redacted).toContain('api_key=[REDACTED]');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redacted).not.toContain('refresh-secret');
  });
});
