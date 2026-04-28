import dotenv from 'dotenv';
import type { AppConfig, CodexApprovalPolicy, CodexSandboxMode } from '../types';

dotenv.config({ override: true });

const CODEX_APPROVAL_POLICIES: CodexApprovalPolicy[] = ['untrusted', 'on-failure', 'on-request', 'never'];
const CODEX_SANDBOX_MODES: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

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
  DEFAULT_WORKSPACE: process.env.DEFAULT_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`,
  BASE_PATH: process.env.BASE_PATH || '',
  CODEX_APPROVAL_POLICY: parseEnum(process.env.CODEX_APPROVAL_POLICY, CODEX_APPROVAL_POLICIES, 'on-request', 'CODEX_APPROVAL_POLICY'),
  CODEX_SANDBOX_MODE: parseEnum(process.env.CODEX_SANDBOX_MODE, CODEX_SANDBOX_MODES, 'workspace-write', 'CODEX_SANDBOX_MODE'),
};

export default config;
