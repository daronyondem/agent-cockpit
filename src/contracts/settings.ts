import type { Settings } from '../types';
import { validateSettingsRequest } from './chat';

export interface SettingsRequest extends Settings {}

export function validateSettingsPayload(body: unknown): SettingsRequest {
  return validateSettingsRequest(body);
}
