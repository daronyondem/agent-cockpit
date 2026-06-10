// ── App Config Types ─────────────────────────────────────────────────

export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type WebBuildMode = 'auto' | 'skip';

export interface AppConfig {
  PORT: number;
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_CALLBACK_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_CALLBACK_URL?: string;
  ALLOWED_EMAIL: string;
  AGENT_COCKPIT_DATA_DIR: string;
  AUTH_DATA_DIR: string;
  AUTH_SETUP_TOKEN: string;
  AUTH_ENABLE_LEGACY_OAUTH: boolean;
  DEFAULT_WORKSPACE: string;
  BASE_PATH: string;
  CODEX_APPROVAL_POLICY: CodexApprovalPolicy;
  CODEX_SANDBOX_MODE: CodexSandboxMode;
  WEB_BUILD_MODE: WebBuildMode;
}
