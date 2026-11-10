import { cortexOAuthOwner, cortexOwnedRedirect } from '../src/services/cortexOAuth';
import { CortexLoginOutput } from '../src/services/cortexLogin';

export function nativeAuthUrl(port = 54321, state = 'fixture-state'): string {
  const url = new URL('https://fixture-account.snowflakecomputing.com/oauth/authorize');
  for (const [key, value] of Object.entries({ redirect_uri: `http://127.0.0.1:${port}/`, state,
    response_type: 'code', code_challenge_method: 'S256', code_challenge: 'fixture-pkce', client_id: 'fixture' })) url.searchParams.set(key, value);
  return url.href;
}
export function nativeRedirect(port = 54321, state = 'fixture-state'): string {
  const url = new URL(`http://127.0.0.1:${port}/`);
  for (const [key, value] of Object.entries({ code: 'fixture-code', state, iss: 'https://fixture-account.snowflakecomputing.com/oauth' })) url.searchParams.set(key, value);
  return url.href;
}

describe('Cortex OAuth ownership', () => {
  const owner = cortexOAuthOwner(nativeAuthUrl());
  test('accepts the native PKCE handoff and exact owned redirect', () => {
    expect(owner.callback).toBe('http://127.0.0.1:54321/');
    expect(cortexOwnedRedirect(nativeRedirect(), owner)).toBe(nativeRedirect());
  });
  test.each([
    'https://evil.invalid/oauth/authorize', nativeAuthUrl().replace('https:', 'http:'), nativeAuthUrl().replace('/authorize', '/other'),
    nativeAuthUrl().replace('S256', 'plain'), nativeAuthUrl().replace('127.0.0.1', 'localhost'),
    nativeAuthUrl().replace('54321', ''), `${nativeAuthUrl()}&state=other`, `${nativeAuthUrl()}#fragment`,
    nativeAuthUrl().replace('response_type=code', 'response_type=token'),
  ])('rejects an untrusted or ambiguous native URL %#', url => { expect(() => cortexOAuthOwner(url)).toThrow(); });
  test.each([
    'file:///etc/passwd', 'not a URL', nativeRedirect(54322), nativeRedirect(54321, 'other'),
    nativeRedirect().replace('127.0.0.1', 'localhost'), nativeRedirect().replace('127.0.0.1', 'evil.invalid'),
    nativeRedirect().replace('http:', 'https:'), nativeRedirect().replace('/?code', '/other?code'),
    nativeRedirect().replace('fixture-account.snowflakecomputing.com', 'evil.invalid'),
    `${nativeRedirect()}&code=duplicate`, `${nativeRedirect()}&state=duplicate`, `${nativeRedirect()}&iss=duplicate`,
    `${nativeRedirect()}&target=evil`, `${nativeRedirect()}#fragment`, nativeRedirect().replace('fixture-code', ''),
    nativeRedirect().replace('127.0.0.1', 'user@127.0.0.1'), `${nativeRedirect()}\r\n`, 'x'.repeat(16385),
    nativeRedirect().replace('127.0.0.1', '127.1'), nativeRedirect().replace('127.0.0.1', '0x7f000001'),
  ])('rejects a foreign, injected, duplicate or malformed redirect without echoing it %#', url => {
    expect(() => cortexOwnedRedirect(url, owner)).toThrow('The redirect does not match');
  });

  test('terminal parser tolerates split URLs/ANSI, handles only known onboarding, and never exports raw text', () => {
    const callbacks = { owner: jest.fn(), received: jest.fn(), ready: jest.fn(), failed: jest.fn(), exit: jest.fn() };
    const write = jest.fn();
    const parser = new CortexLoginOutput(callbacks, write, 'second');
    parser.read('\x1b[32m[N] Skip\x1b[0m'); parser.read('1-3 select'); parser.read('[Y] I understand and accept');
    parser.read('\nChoose your agent account:\nYour connections:\nNAME    ACCOUNT    USER    USAGE\n> first   PRIVATE    PRIVATE   -\n  second  PRIVATE    PRIVATE   -\nMore options...\n');
    expect(write.mock.calls.map(call => call[0])).toEqual(['n', '\r', 'y', '\x1b[B\r']);
    const url = nativeAuthUrl();
    parser.read(`\n${url.slice(0, 100)}`); expect(callbacks.owner).not.toHaveBeenCalled();
    parser.read(`${url.slice(100)}\nredirect URL> `);
    expect(callbacks.owner).toHaveBeenCalledTimes(1);
    parser.read('\nReceived — completing sign-in…\n');
    expect(callbacks.received).toHaveBeenCalledTimes(1);
    expect(callbacks.ready).not.toHaveBeenCalled();
    parser.read('All tests passed!'); expect(callbacks.ready).toHaveBeenCalledTimes(1);
    parser.read('Authentication timed out'); expect(callbacks.failed).toHaveBeenCalledTimes(1);
    parser.read('Authentication timed out'); expect(callbacks.failed).toHaveBeenCalledTimes(1);
    parser.clear();
  });
  test('unrecognized issuer and missing selected connection stop the native wizard', () => {
    const callbacks = { owner: jest.fn(), received: jest.fn(), ready: jest.fn(), failed: jest.fn(), exit: jest.fn() };
    const parser = new CortexLoginOutput(callbacks, jest.fn(), 'missing');
    parser.read(`${nativeAuthUrl().replace('snowflakecomputing.com', 'evil.invalid')}\n`);
    parser.read('Choose your agent account:\nYour connections:\nNAME  ACCOUNT  USER  USAGE\n> other  x  y  -\nMore options...\n');
    expect(callbacks.failed).toHaveBeenCalledTimes(2);
    expect(callbacks.owner).not.toHaveBeenCalled();
  });
});
