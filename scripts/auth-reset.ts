import fsp from 'fs/promises';
import path from 'path';
import { parseArgs } from 'util';
import config from '../src/config';
import { LocalAuthError, LocalAuthStore } from '../src/services/localAuthStore';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    'display-name': { type: 'string' },
    password: { type: 'string' },
    'disable-passkey-required': { type: 'boolean', default: false },
    'revoke-sessions': { type: 'boolean', default: false },
    'regenerate-recovery-codes': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function printUsage(): void {
  console.log(`Usage:
  npm run auth:reset -- --password "new long password" --disable-passkey-required --revoke-sessions --regenerate-recovery-codes

Options:
  --email <email>                    Update the owner email.
  --display-name <name>              Update the owner display name.
  --password <password>              Reset the owner password. Minimum 12 characters.
  --disable-passkey-required         Turn off passkey-required policy.
  --revoke-sessions                  Delete session files under the configured data root.
  --regenerate-recovery-codes        Replace recovery codes and print the new set.
`);
}

async function clearSessions(): Promise<void> {
  const sessionDir = path.join(config.AGENT_COCKPIT_DATA_DIR, 'sessions');
  await fsp.rm(sessionDir, { recursive: true, force: true });
  await fsp.mkdir(sessionDir, { recursive: true });
}

async function main(): Promise<void> {
  if (values.help) {
    printUsage();
    return;
  }

  const requestedReset = Boolean(
    values.email
    || values['display-name']
    || values.password
    || values['disable-passkey-required']
    || values['revoke-sessions']
    || values['regenerate-recovery-codes']
  );
  if (!requestedReset) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const store = new LocalAuthStore(config.AUTH_DATA_DIR);
  const result = await store.resetOwnerAccess({
    email: values.email,
    displayName: values['display-name'],
    password: values.password,
    disablePasskeyRequired: values['disable-passkey-required'],
    regenerateRecoveryCodes: values['regenerate-recovery-codes'],
  });

  if (values['revoke-sessions']) {
    await clearSessions();
  }

  console.log(`Updated local owner: ${result.owner.email}`);
  if (values['disable-passkey-required']) {
    console.log('Passkey-required policy disabled.');
  }
  if (values['revoke-sessions']) {
    console.log('Session files cleared.');
  }
  if (result.recoveryCodes?.length) {
    console.log('\nNew recovery codes:');
    for (const code of result.recoveryCodes) {
      console.log(`  ${code}`);
    }
  }
}

main().catch((err: unknown) => {
  if (err instanceof LocalAuthError) {
    console.error(err.message);
  } else {
    console.error((err as Error).message);
  }
  process.exit(1);
});
