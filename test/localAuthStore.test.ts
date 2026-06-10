import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalAuthError, LocalAuthStore, type LocalAuthState } from '../src/services/localAuthStore';

describe('LocalAuthStore', () => {
  let tmpDir: string;
  let authDir: string;
  let ownerFile: string;
  let store: LocalAuthStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-auth-'));
    authDir = path.join(tmpDir, 'auth');
    ownerFile = path.join(authDir, 'owner.json');
    store = new LocalAuthStore(authDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createOwner(overrides: Partial<{ email: string; displayName: string; password: string }> = {}) {
    return store.createOwner({
      email: overrides.email ?? ' Daron@Example.Test ',
      displayName: overrides.displayName ?? ' Daron ',
      password: overrides.password ?? 'correct horse battery staple',
    });
  }

  function readState(): LocalAuthState {
    return JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as LocalAuthState;
  }

  function writeState(state: Partial<LocalAuthState>): void {
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(ownerFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async function expectLocalAuthError(action: Promise<unknown>, code: LocalAuthError['code']): Promise<void> {
    await expect(action).rejects.toMatchObject({ name: 'LocalAuthError', code });
  }

  test('createOwner normalizes identity, hashes passwords, rejects duplicates, and writes restrictive modes', async () => {
    const owner = await createOwner();

    expect(owner).toMatchObject({
      id: 'local-owner',
      email: 'daron@example.test',
      displayName: 'Daron',
    });
    expect(owner.passwordHash).toMatch(/^scrypt\$/);
    expect(readState().owner.passwordHash).toBe(owner.passwordHash);
    await expectLocalAuthError(createOwner({ email: 'second@example.test' }), 'owner-exists');

    if (process.platform !== 'win32') {
      expect(fs.statSync(authDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(ownerFile).mode & 0o777).toBe(0o600);
    }
  });

  test('createOwner validates email, display name, and password length', async () => {
    await expectLocalAuthError(createOwner({ email: 'not-an-email' }), 'invalid-input');
    await expectLocalAuthError(createOwner({ displayName: '   ' }), 'invalid-input');
    await expectLocalAuthError(createOwner({ password: 'short' }), 'invalid-input');
  });

  test('missing owners and unsupported password hashes have explicit behavior', async () => {
    expect(await store.hasOwner()).toBe(false);
    expect(await store.getOwner()).toBeNull();
    await expectLocalAuthError(store.getPolicy(), 'owner-missing');
    await expectLocalAuthError(store.verifyPassword('daron@example.test', 'anything'), 'owner-missing');

    await createOwner();
    const state = readState();
    state.owner.passwordHash = 'argon2$not-supported';
    writeState(state);

    expect(await store.verifyPassword(' daron@example.test ', 'correct horse battery staple')).toBeNull();
  });

  test('verifyPassword matches normalized email and rejects wrong credentials', async () => {
    await createOwner();

    expect(await store.verifyPassword(' DARON@example.test ', 'correct horse battery staple')).toMatchObject({
      email: 'daron@example.test',
    });
    expect(await store.verifyPassword('daron@example.test', 'wrong password')).toBeNull();
    expect(await store.verifyPassword('other@example.test', 'correct horse battery staple')).toBeNull();
  });

  test('state loading validates owner files and normalizes optional arrays and policy', async () => {
    writeState({
      version: 1,
      owner: {
        id: 'local-owner',
        email: 'owner@example.test',
        displayName: 'Owner',
        passwordHash: 'scrypt$unsupported$shell',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      policy: { passkeyRequired: 1 as unknown as boolean },
      passkeys: null as unknown as [],
      recoveryCodes: 'bad' as unknown as [],
    });

    expect(await store.hasOwner()).toBe(true);
    expect(await store.getPolicy()).toEqual({ passkeyRequired: true });
    expect(await store.listPasskeys()).toEqual([]);
    expect(await store.getRecoveryStatus()).toEqual({
      configured: false,
      total: 0,
      remaining: 0,
      createdAt: null,
    });

    fs.writeFileSync(ownerFile, '{ nope', 'utf8');
    await expect(store.hasOwner()).rejects.toThrow(SyntaxError);

    writeState({ version: 2 as 1, owner: null as unknown as LocalAuthState['owner'] });
    await expect(store.hasOwner()).rejects.toThrow('Invalid local auth state file.');
  });

  test('recovery codes are hashed, single-use, normalized, and disable passkey-required policy', async () => {
    await createOwner();
    const passkey = await store.createPasskey({
      credentialId: 'cred-1',
      publicKey: 'public-key-1',
      counter: 0,
    });
    const codes = await store.regenerateRecoveryCodes(2);

    expect(codes).toHaveLength(2);
    expect(codes[0]).toMatch(/^[a-f0-9]{5}(?:-[a-f0-9]{5}){3}$/);
    const persisted = readState();
    expect(persisted.recoveryCodes).toHaveLength(2);
    expect(persisted.recoveryCodes[0].codeHash).toMatch(/^scrypt\$/);
    expect(persisted.recoveryCodes[0].codeHash).not.toContain(codes[0]);
    expect(await store.getRecoveryStatus()).toMatchObject({ configured: true, total: 2, remaining: 2 });

    await store.setPasskeyRequired(true);
    const formattedCode = codes[0].toUpperCase().replace(/-/g, ' ');
    expect(await store.useRecoveryCode(formattedCode)).toMatchObject({ email: 'daron@example.test' });
    expect(await store.getPolicy()).toEqual({ passkeyRequired: false });
    expect(await store.getRecoveryStatus()).toMatchObject({ total: 2, remaining: 1 });
    expect(await store.useRecoveryCode(formattedCode)).toBeNull();
    expect(await store.useRecoveryCode('')).toBeNull();
    expect(await store.useRecoveryCode('unknown-code')).toBeNull();
    expect(await store.deletePasskey(passkey.id)).toMatchObject({ id: passkey.id });
  });

  test('regenerateRecoveryCodes validates count bounds', async () => {
    await createOwner();

    await expectLocalAuthError(store.regenerateRecoveryCodes(0), 'invalid-input');
    await expectLocalAuthError(store.regenerateRecoveryCodes(51), 'invalid-input');
    await expectLocalAuthError(store.regenerateRecoveryCodes(1.5), 'invalid-input');
  });

  test('passkeys validate inputs, normalize names/transports, list newest first, and update usage', async () => {
    await createOwner();
    await expectLocalAuthError(store.createPasskey({ credentialId: '', publicKey: 'pk', counter: 0 }), 'invalid-input');
    await expectLocalAuthError(store.createPasskey({ credentialId: 'cred', publicKey: '', counter: 0 }), 'invalid-input');
    await expectLocalAuthError(store.createPasskey({ credentialId: 'cred', publicKey: 'pk', counter: -1 }), 'invalid-input');
    await expectLocalAuthError(store.createPasskey({ credentialId: 'cred', publicKey: 'pk', counter: 1.25 }), 'invalid-input');

    const first = await store.createPasskey({
      credentialId: 'cred-1',
      publicKey: 'pk-1',
      counter: 0,
      transports: ['usb', '', 'usb', ' nfc '],
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await store.createPasskey({
      name: ' Work Key ',
      credentialId: 'cred-2',
      publicKey: 'pk-2',
      counter: 5,
    });

    expect(first.name).toBe('Passkey 1');
    expect(first.transports).toEqual(['usb', 'nfc']);
    expect(second.name).toBe('Work Key');
    expect((await store.listPasskeys()).map(passkey => passkey.id)).toEqual([second.id, first.id]);
    expect(await store.getPasskeyByCredentialId('cred-1')).toMatchObject({ id: first.id });
    await expectLocalAuthError(store.createPasskey({ credentialId: 'cred-1', publicKey: 'pk-copy', counter: 0 }), 'invalid-input');
    await expectLocalAuthError(store.renamePasskey(first.id, 'x'.repeat(81)), 'invalid-input');

    expect(await store.renamePasskey(first.id, ' Renamed Key ')).toMatchObject({ name: 'Renamed Key' });
    expect(await store.updatePasskeyUsage('cred-1', 9)).toMatchObject({ counter: 9, lastUsedAt: expect.any(String) });
    expect(await store.renamePasskey('missing', 'Nope')).toBeNull();
    expect(await store.updatePasskeyUsage('missing', 1)).toBeNull();
    expect(await store.deletePasskey('missing')).toBeNull();
  });

  test('passkey-required policy requires recovery codes and blocks deleting the last passkey', async () => {
    await createOwner();
    await expectLocalAuthError(store.setPasskeyRequired(true), 'unsafe-policy');

    const passkey = await store.createPasskey({
      credentialId: 'cred-1',
      publicKey: 'pk-1',
      counter: 0,
    });
    await expectLocalAuthError(store.setPasskeyRequired(true), 'unsafe-policy');

    await store.regenerateRecoveryCodes(2);
    expect(await store.setPasskeyRequired(true)).toEqual({ passkeyRequired: true });
    await expectLocalAuthError(store.deletePasskey(passkey.id), 'unsafe-policy');

    expect(await store.setPasskeyRequired(false)).toEqual({ passkeyRequired: false });
    expect(await store.deletePasskey(passkey.id)).toMatchObject({ id: passkey.id });
  });

  test('resetOwnerAccess updates owner credentials, disables passkey policy, and replaces recovery codes', async () => {
    await createOwner();
    await store.createPasskey({
      credentialId: 'cred-1',
      publicKey: 'pk-1',
      counter: 0,
    });
    const oldCodes = await store.regenerateRecoveryCodes(2);
    await store.setPasskeyRequired(true);

    const result = await store.resetOwnerAccess({
      email: ' NewOwner@Example.Test ',
      displayName: ' New Owner ',
      password: 'new correct horse battery staple',
      disablePasskeyRequired: true,
      regenerateRecoveryCodes: true,
    });

    expect(result.owner).toMatchObject({
      email: 'newowner@example.test',
      displayName: 'New Owner',
    });
    expect(result.recoveryCodes).toHaveLength(10);
    expect(await store.getPolicy()).toEqual({ passkeyRequired: false });
    expect(await store.verifyPassword('newowner@example.test', 'new correct horse battery staple')).toMatchObject({
      email: 'newowner@example.test',
    });
    expect(await store.verifyPassword('daron@example.test', 'correct horse battery staple')).toBeNull();
    expect(await store.useRecoveryCode(oldCodes[0])).toBeNull();
    expect(await store.useRecoveryCode(result.recoveryCodes![0])).toMatchObject({ email: 'newowner@example.test' });

    await expectLocalAuthError(store.resetOwnerAccess({ email: 'bad-email' }), 'invalid-input');
    await expectLocalAuthError(store.resetOwnerAccess({ displayName: ' ' }), 'invalid-input');
    await expectLocalAuthError(store.resetOwnerAccess({ password: 'short' }), 'invalid-input');
  });
});
