import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { atomicWriteFile } from '../utils/atomicWrite';

export interface LocalOwner {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalPasskeyCredential {
  id: string;
  name: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: string;
  lastUsedAt?: string;
}

export interface LocalRecoveryCode {
  id: string;
  codeHash: string;
  createdAt: string;
  usedAt?: string;
}

export interface LocalMobileDevice {
  id: string;
  displayName: string;
  createdAt: string;
  lastSeenAt: string;
  lastIp?: string;
  lastUserAgent?: string;
  platform?: string;
  revokedAt?: string;
}

export interface LocalAuthPolicy {
  passkeyRequired: boolean;
}

export interface LocalAuthState {
  version: 1;
  owner: LocalOwner;
  policy: LocalAuthPolicy;
  passkeys: LocalPasskeyCredential[];
  recoveryCodes: LocalRecoveryCode[];
  mobileDevices: LocalMobileDevice[];
}

export interface CreateOwnerInput {
  email: string;
  displayName: string;
  password: string;
}

export interface CreateMobileDeviceInput {
  displayName?: string;
  ip?: string;
  userAgent?: string;
  platform?: string;
}

export interface CreatePasskeyInput {
  name?: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
}

export interface LocalRecoveryStatus {
  configured: boolean;
  total: number;
  remaining: number;
  createdAt: string | null;
}

const PASSWORD_HASH_ALGORITHM = 'scrypt';
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_MIN_LENGTH = 12;
const DEFAULT_RECOVERY_CODE_COUNT = 10;

export class LocalAuthError extends Error {
  constructor(message: string, public readonly code: 'owner-exists' | 'owner-missing' | 'invalid-input' | 'unsafe-policy' | 'not-found') {
    super(message);
    this.name = 'LocalAuthError';
  }
}

export class LocalAuthStore {
  private readonly filePath: string;

  constructor(private readonly authDir: string) {
    this.filePath = path.join(authDir, 'owner.json');
  }

  async hasOwner(): Promise<boolean> {
    return (await this.readState()) !== null;
  }

  async getOwner(): Promise<LocalOwner | null> {
    return (await this.readState())?.owner ?? null;
  }

  async getPolicy(): Promise<LocalAuthPolicy> {
    return this.requireState().then(state => state.policy);
  }

  async getRecoveryStatus(): Promise<LocalRecoveryStatus> {
    const state = await this.requireState();
    return recoveryStatus(state);
  }

  async listPasskeys(): Promise<LocalPasskeyCredential[]> {
    const state = await this.requireState();
    return [...state.passkeys].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getPasskeyByCredentialId(credentialId: string): Promise<LocalPasskeyCredential | null> {
    const state = await this.requireState();
    return state.passkeys.find(passkey => passkey.credentialId === credentialId) ?? null;
  }

  async listMobileDevices(): Promise<LocalMobileDevice[]> {
    const state = await this.requireState();
    return [...state.mobileDevices].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async getMobileDevice(id: string): Promise<LocalMobileDevice | null> {
    const state = await this.requireState();
    return state.mobileDevices.find(device => device.id === id) ?? null;
  }

  async createOwner(input: CreateOwnerInput): Promise<LocalOwner> {
    const existing = await this.readState();
    if (existing) {
      throw new LocalAuthError('Owner account already exists.', 'owner-exists');
    }

    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    validateOwnerInput(email, displayName, input.password);

    const now = new Date().toISOString();
    const owner: LocalOwner = {
      id: 'local-owner',
      email,
      displayName,
      passwordHash: await hashPassword(input.password),
      createdAt: now,
      updatedAt: now,
    };

    const state: LocalAuthState = {
      version: 1,
      owner,
      policy: {
        passkeyRequired: false,
      },
      passkeys: [],
      recoveryCodes: [],
      mobileDevices: [],
    };

    await this.writeState(state);
    return owner;
  }

  async verifyPassword(email: string, password: string): Promise<LocalOwner | null> {
    const state = await this.readState();
    if (!state) {
      throw new LocalAuthError('Owner account is not configured.', 'owner-missing');
    }

    if (normalizeEmail(email) !== state.owner.email) {
      return null;
    }

    const valid = await verifyPasswordHash(password, state.owner.passwordHash);
    return valid ? state.owner : null;
  }

  async regenerateRecoveryCodes(count = DEFAULT_RECOVERY_CODE_COUNT): Promise<string[]> {
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new LocalAuthError('Recovery code count must be between 1 and 50.', 'invalid-input');
    }
    const state = await this.requireState();
    const now = new Date().toISOString();
    const codes = Array.from({ length: count }, () => generateRecoveryCode());
    state.recoveryCodes = await Promise.all(codes.map(async (code) => ({
      id: crypto.randomUUID(),
      codeHash: await hashSecret(normalizeRecoveryCode(code)),
      createdAt: now,
    })));
    state.owner.updatedAt = now;
    await this.writeState(state);
    return codes;
  }

  async useRecoveryCode(code: string): Promise<LocalOwner | null> {
    const state = await this.requireState();
    const normalized = normalizeRecoveryCode(code);
    if (!normalized) {
      return null;
    }

    for (const recoveryCode of state.recoveryCodes) {
      if (recoveryCode.usedAt) {
        continue;
      }
      if (await verifyPasswordHash(normalized, recoveryCode.codeHash)) {
        const now = new Date().toISOString();
        recoveryCode.usedAt = now;
        state.policy.passkeyRequired = false;
        state.owner.updatedAt = now;
        await this.writeState(state);
        return state.owner;
      }
    }

    return null;
  }

  async setPasskeyRequired(required: boolean): Promise<LocalAuthPolicy> {
    const state = await this.requireState();
    if (required) {
      if (state.passkeys.length === 0) {
        throw new LocalAuthError('Register at least one passkey before requiring passkeys.', 'unsafe-policy');
      }
      if (recoveryStatus(state).remaining === 0) {
        throw new LocalAuthError('Generate recovery codes before requiring passkeys.', 'unsafe-policy');
      }
    }

    state.policy.passkeyRequired = required;
    state.owner.updatedAt = new Date().toISOString();
    await this.writeState(state);
    return state.policy;
  }

  async createPasskey(input: CreatePasskeyInput): Promise<LocalPasskeyCredential> {
    const state = await this.requireState();
    const credentialId = input.credentialId.trim();
    const publicKey = input.publicKey.trim();
    if (!credentialId || !publicKey || !Number.isInteger(input.counter) || input.counter < 0) {
      throw new LocalAuthError('Invalid passkey credential.', 'invalid-input');
    }
    if (state.passkeys.some(passkey => passkey.credentialId === credentialId)) {
      throw new LocalAuthError('This passkey is already registered.', 'invalid-input');
    }

    const now = new Date().toISOString();
    const explicitName = cleanOptional(input.name);
    const passkey: LocalPasskeyCredential = {
      id: crypto.randomUUID(),
      name: explicitName ? normalizePasskeyName(explicitName) : `Passkey ${state.passkeys.length + 1}`,
      credentialId,
      publicKey,
      counter: input.counter,
      transports: normalizeTransports(input.transports),
      createdAt: now,
    };
    state.passkeys.push(passkey);
    state.owner.updatedAt = now;
    await this.writeState(state);
    return passkey;
  }

  async renamePasskey(id: string, name: string): Promise<LocalPasskeyCredential | null> {
    const state = await this.requireState();
    const passkey = state.passkeys.find(candidate => candidate.id === id);
    if (!passkey) {
      return null;
    }
    passkey.name = normalizePasskeyName(name);
    state.owner.updatedAt = new Date().toISOString();
    await this.writeState(state);
    return passkey;
  }

  async updatePasskeyUsage(credentialId: string, counter: number): Promise<LocalPasskeyCredential | null> {
    const state = await this.requireState();
    const passkey = state.passkeys.find(candidate => candidate.credentialId === credentialId);
    if (!passkey) {
      return null;
    }
    passkey.counter = counter;
    passkey.lastUsedAt = new Date().toISOString();
    await this.writeState(state);
    return passkey;
  }

  async deletePasskey(id: string): Promise<LocalPasskeyCredential | null> {
    const state = await this.requireState();
    const index = state.passkeys.findIndex(candidate => candidate.id === id);
    if (index === -1) {
      return null;
    }
    if (state.policy.passkeyRequired && state.passkeys.length <= 1) {
      throw new LocalAuthError('Disable passkey-required mode or register another passkey before deleting this one.', 'unsafe-policy');
    }
    const [deleted] = state.passkeys.splice(index, 1);
    state.owner.updatedAt = new Date().toISOString();
    await this.writeState(state);
    return deleted ?? null;
  }

  async createMobileDevice(input: CreateMobileDeviceInput): Promise<LocalMobileDevice> {
    const state = await this.requireState();
    const now = new Date().toISOString();
    const device: LocalMobileDevice = {
      id: crypto.randomUUID(),
      displayName: cleanOptional(input.displayName) || 'Mobile device',
      createdAt: now,
      lastSeenAt: now,
      ...(cleanOptional(input.ip) ? { lastIp: cleanOptional(input.ip) } : {}),
      ...(cleanOptional(input.userAgent) ? { lastUserAgent: cleanOptional(input.userAgent) } : {}),
      ...(cleanOptional(input.platform) ? { platform: cleanOptional(input.platform) } : {}),
    };
    state.mobileDevices.push(device);
    await this.writeState(state);
    return device;
  }

  async touchMobileDevice(id: string, input: Omit<CreateMobileDeviceInput, 'displayName'>): Promise<LocalMobileDevice | null> {
    const state = await this.requireState();
    const device = state.mobileDevices.find(candidate => candidate.id === id);
    if (!device || device.revokedAt) {
      return null;
    }
    device.lastSeenAt = new Date().toISOString();
    const ip = cleanOptional(input.ip);
    const userAgent = cleanOptional(input.userAgent);
    const platform = cleanOptional(input.platform);
    if (ip) device.lastIp = ip;
    if (userAgent) device.lastUserAgent = userAgent;
    if (platform) device.platform = platform;
    await this.writeState(state);
    return device;
  }

  async revokeMobileDevice(id: string): Promise<LocalMobileDevice | null> {
    const state = await this.requireState();
    const device = state.mobileDevices.find(candidate => candidate.id === id);
    if (!device) {
      return null;
    }
    if (!device.revokedAt) {
      device.revokedAt = new Date().toISOString();
      await this.writeState(state);
    }
    return device;
  }

  async resetOwnerAccess(input: {
    email?: string;
    displayName?: string;
    password?: string;
    disablePasskeyRequired?: boolean;
    revokeMobileDevices?: boolean;
    regenerateRecoveryCodes?: boolean;
  }): Promise<{ owner: LocalOwner; recoveryCodes?: string[] }> {
    const state = await this.requireState();
    const now = new Date().toISOString();
    const nextEmail = input.email === undefined ? state.owner.email : normalizeEmail(input.email);
    const nextDisplayName = input.displayName === undefined ? state.owner.displayName : input.displayName.trim();
    const nextPassword = input.password;

    if (nextPassword !== undefined) {
      validateOwnerInput(nextEmail, nextDisplayName, nextPassword);
      state.owner.passwordHash = await hashPassword(nextPassword);
    } else {
      validateOwnerIdentity(nextEmail, nextDisplayName);
    }

    state.owner.email = nextEmail;
    state.owner.displayName = nextDisplayName;
    state.owner.updatedAt = now;

    if (input.disablePasskeyRequired) {
      state.policy.passkeyRequired = false;
    }
    if (input.revokeMobileDevices) {
      for (const device of state.mobileDevices) {
        if (!device.revokedAt) device.revokedAt = now;
      }
    }

    let recoveryCodes: string[] | undefined;
    if (input.regenerateRecoveryCodes) {
      recoveryCodes = Array.from({ length: DEFAULT_RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
      state.recoveryCodes = await Promise.all(recoveryCodes.map(async (code) => ({
        id: crypto.randomUUID(),
        codeHash: await hashSecret(normalizeRecoveryCode(code)),
        createdAt: now,
      })));
    }

    await this.writeState(state);
    return { owner: state.owner, recoveryCodes };
  }

  private async requireState(): Promise<LocalAuthState> {
    const state = await this.readState();
    if (!state) {
      throw new LocalAuthError('Owner account is not configured.', 'owner-missing');
    }
    return state;
  }

  private async readState(): Promise<LocalAuthState | null> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as LocalAuthState;
      if (parsed.version !== 1 || !parsed.owner?.email || !parsed.owner?.passwordHash) {
        throw new Error('Invalid local auth state file.');
      }
      return normalizeState(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  private async writeState(state: LocalAuthState): Promise<void> {
    await fsp.mkdir(this.authDir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
    await fsp.chmod(this.filePath, 0o600);
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateOwnerInput(email: string, displayName: string, password: string): void {
  validateOwnerIdentity(email, displayName);
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new LocalAuthError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`, 'invalid-input');
  }
}

function validateOwnerIdentity(email: string, displayName: string): void {
  if (!email || !email.includes('@')) {
    throw new LocalAuthError('Enter a valid email address.', 'invalid-input');
  }
  if (!displayName) {
    throw new LocalAuthError('Enter a display name.', 'invalid-input');
  }
}

async function hashPassword(password: string): Promise<string> {
  return hashSecret(password);
}

async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = await scrypt(secret, salt);
  return `${PASSWORD_HASH_ALGORITHM}$${salt}$${derived.toString('base64url')}`;
}

async function verifyPasswordHash(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, salt, encoded] = storedHash.split('$');
  if (algorithm !== PASSWORD_HASH_ALGORITHM || !salt || !encoded) {
    return false;
  }

  const expected = Buffer.from(encoded, 'base64url');
  const actual = await scrypt(password, salt);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function scrypt(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, PASSWORD_KEY_LENGTH, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function normalizeState(state: LocalAuthState): LocalAuthState {
  return {
    version: 1,
    owner: state.owner,
    policy: {
      passkeyRequired: Boolean(state.policy?.passkeyRequired),
    },
    passkeys: Array.isArray(state.passkeys) ? state.passkeys : [],
    recoveryCodes: Array.isArray(state.recoveryCodes) ? state.recoveryCodes : [],
    mobileDevices: Array.isArray(state.mobileDevices) ? state.mobileDevices : [],
  };
}

function recoveryStatus(state: LocalAuthState): LocalRecoveryStatus {
  const total = state.recoveryCodes.length;
  const remaining = state.recoveryCodes.filter(code => !code.usedAt).length;
  return {
    configured: total > 0,
    total,
    remaining,
    createdAt: state.recoveryCodes[0]?.createdAt ?? null,
  };
}

function generateRecoveryCode(): string {
  return crypto.randomBytes(10).toString('hex').match(/.{1,5}/g)?.join('-') ?? crypto.randomBytes(10).toString('hex');
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizePasskeyName(name: string | undefined): string {
  const cleaned = name?.trim() ?? '';
  if (!cleaned) {
    throw new LocalAuthError('Passkey name is required.', 'invalid-input');
  }
  if (cleaned.length > 80) {
    throw new LocalAuthError('Passkey name must be 80 characters or fewer.', 'invalid-input');
  }
  return cleaned;
}

function normalizeTransports(transports: string[] | undefined): string[] | undefined {
  const cleaned = (transports || [])
    .map(transport => transport.trim())
    .filter(Boolean);
  return cleaned.length ? Array.from(new Set(cleaned)) : undefined;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}
