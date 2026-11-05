/** Copilot resumes require a new, explicit native AI-credit window. */
export interface ResumeGoalRequest {
  aiCreditLimit?: number;
}

export function parseGoalAiCreditLimit(value: unknown, required = false): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('Enter a fresh AI credit limit greater than zero to resume this Copilot goal.');
  }
  return value;
}
