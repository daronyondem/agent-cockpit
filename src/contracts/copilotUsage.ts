/** Copilot amounts retain their native units; no token or currency conversion. */
export type UsageAvailability = 'complete' | 'partial' | 'unavailable';

export interface CopilotUsage {
  tokensStatus: UsageAvailability;
  aiCreditsStatus: UsageAvailability;
  /** Reported subtotal when status is partial. Omitted when unavailable. */
  aiCredits?: number;
  premiumRequests?: number;
}

export interface ContextWindowUsage {
  status: 'available' | 'unavailable';
  observedAt: string;
  usedTokens?: number;
  tokenLimit?: number;
}

export interface CopilotQuotaRow {
  id: string;
  label: string;
  unit: 'premium_requests' | 'requests' | 'ai_credits' | 'tokens' | 'unknown';
  observedAt: string;
  kind: 'account_snapshot' | 'admission_state';
  access: string;
  capacity: string;
  used?: number;
  entitlement?: number;
  usedPercentage?: number;
  unlimited?: boolean;
  resetAt?: string;
}

export interface CopilotQuotaSnapshot {
  status: 'available' | 'unavailable';
  fetchedAt: string | null;
  stale: boolean;
  rows: CopilotQuotaRow[];
  message?: string;
}

export interface CopilotQuotaResponse {
  profileId: string;
  quota: CopilotQuotaSnapshot;
}
