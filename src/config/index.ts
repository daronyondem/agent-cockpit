import path from 'path';
import dotenv from 'dotenv';
import type { AppConfig, CodexApprovalPolicy, CodexSandboxMode, WebBuildMode } from '../types';

dotenv.config({ override: process.env.NODE_ENV !== 'test' });

const CODEX_APPROVAL_POLICIES: CodexApprovalPolicy[] = ['untrusted', 'on-failure', 'on-request', 'never'];
const CODEX_SANDBOX_MODES: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const WEB_BUILD_MODES: WebBuildMode[] = ['auto', 'skip'];
const AGENT_COCKPIT_DATA_DIR = path.resolve(process.env.AGENT_COCKPIT_DATA_DIR || path.join(process.cwd(), 'data'));

function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, envName: string): T {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  console.warn(`[config] Ignoring invalid ${envName}=${JSON.stringify(value)}; expected one of: ${allowed.join(', ')}`);
  return fallback;
}

const config: AppConfig = {
  PORT: Number(process.env.PORT) || 3334,
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL || '',
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  GITHUB_CALLBACK_URL: process.env.GITHUB_CALLBACK_URL,
  ALLOWED_EMAIL: process.env.ALLOWED_EMAIL || '',
  AGENT_COCKPIT_DATA_DIR,
  AUTH_DATA_DIR: process.env.AUTH_DATA_DIR || path.join(AGENT_COCKPIT_DATA_DIR, 'auth'),
  AUTH_SETUP_TOKEN: process.env.AUTH_SETUP_TOKEN || '',
  AUTH_ENABLE_LEGACY_OAUTH: process.env.AUTH_ENABLE_LEGACY_OAUTH === 'true',
  DEFAULT_WORKSPACE: process.env.DEFAULT_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`,
  BASE_PATH: process.env.BASE_PATH || '',
  CODEX_APPROVAL_POLICY: parseEnum(process.env.CODEX_APPROVAL_POLICY, CODEX_APPROVAL_POLICIES, 'on-request', 'CODEX_APPROVAL_POLICY'),
  CODEX_SANDBOX_MODE: parseEnum(process.env.CODEX_SANDBOX_MODE, CODEX_SANDBOX_MODES, 'workspace-write', 'CODEX_SANDBOX_MODE'),
  WEB_BUILD_MODE: parseEnum(
    process.env.WEB_BUILD_MODE,
    WEB_BUILD_MODES,
    process.env.NODE_ENV === 'test' ? 'skip' : 'auto',
    'WEB_BUILD_MODE',
  ),
};

export default config;
