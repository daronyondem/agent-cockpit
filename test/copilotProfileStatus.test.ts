import { startCopilotSdkRuntime } from '../src/services/backends/copilotSdkRuntime';
import { probeCopilotProfile } from '../src/services/backends/copilotProfileStatus';
import type { CliProfile } from '../src/types';

jest.mock('../src/services/backends/copilotSdkRuntime', () => ({
  ...jest.requireActual('../src/services/backends/copilotSdkRuntime'), startCopilotSdkRuntime: jest.fn(),
}));

const profile: CliProfile = { id: 'copilot-check', name: 'Copilot', harness: 'copilot', authMode: 'server-configured', createdAt: '', updatedAt: '' };
const start = jest.mocked(startCopilotSdkRuntime);
let getAuthStatus: jest.Mock;
let listModels: jest.Mock;
let stop: jest.Mock;

beforeEach(() => {
  getAuthStatus = jest.fn().mockResolvedValue({ isAuthenticated: true });
  listModels = jest.fn().mockResolvedValue([{ id: 'enabled', policy: { state: 'enabled' } }, { id: 'disabled', policy: { state: 'disabled' } }, { id: 'unconfigured', policy: { state: 'unconfigured' } }]);
  stop = jest.fn().mockResolvedValue(undefined);
  start.mockResolvedValue({ client: { getAuthStatus, listModels }, stop } as never);
});

test('checks real account status and enabled catalog entries using the selected profile', async () => {
  const signal = new AbortController().signal;
  expect(await probeCopilotProfile(profile, signal)).toEqual({ authenticated: true, modelsAvailable: true, modelCount: 1 });
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ profileKey: expect.stringContaining(profile.id) }), process.cwd(), { abortSignal: signal });
  expect(stop).toHaveBeenCalledTimes(1);
});

test('does not query protected catalog access when the CLI reports no credentials', async () => {
  getAuthStatus.mockResolvedValue({ isAuthenticated: false });
  expect(await probeCopilotProfile(profile, new AbortController().signal)).toEqual({ authenticated: false, modelsAvailable: false, modelCount: 0 });
  expect(listModels).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(1);
});

test('preserves a valid credential result when catalog access is forbidden', async () => {
  listModels.mockRejectedValue(new Error('Request models.list failed: GenericFailure, {"kind":"http","status":403,"body":"not authorized\\n","headers":[{"name":"private","value":"omit"}]}'));
  expect(await probeCopilotProfile(profile, new AbortController().signal)).toEqual({
    authenticated: true, modelsAvailable: false, modelCount: 0,
    modelListError: 'Copilot model discovery failed (HTTP 403). not authorized',
  });
  expect(stop).toHaveBeenCalledTimes(1);
});

test.each([new Error('Catalog unavailable'), 'Catalog unavailable'])('retains non-HTTP native diagnostics: %s', async error => {
  listModels.mockRejectedValue(error);
  expect(await probeCopilotProfile(profile, new AbortController().signal)).toMatchObject({ modelListError: 'Catalog unavailable' });
  expect(stop).toHaveBeenCalledTimes(1);
});

test('an empty catalog is not advertised as usable model access', async () => {
  listModels.mockResolvedValue([]);
  expect(await probeCopilotProfile(profile, new AbortController().signal)).toMatchObject({ authenticated: true, modelsAvailable: false, modelCount: 0, modelListError: expect.stringContaining('no enabled models') });
});

test('releases the runtime when native auth verification fails', async () => {
  getAuthStatus.mockRejectedValue(new Error('Auth status failed'));
  await expect(probeCopilotProfile(profile, new AbortController().signal)).rejects.toThrow('Auth status failed');
  expect(stop).toHaveBeenCalledTimes(1);
});

test('marks unproved probe cleanup so guided auth retains its admission barrier', async () => {
  stop.mockRejectedValue(new Error('Worker survived'));
  await expect(probeCopilotProfile(profile, new AbortController().signal)).rejects.toMatchObject({
    message: expect.stringContaining('probe cleanup failed'), cause: expect.any(Error),
  });
});
