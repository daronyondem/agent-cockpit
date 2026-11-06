/** Private ownership extracted from the native authorization URL. */
export interface CortexOAuthOwner { authorizationUrl: string; callback: string; state: string; issuer: string }

function one(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) throw new Error('Invalid native OAuth handoff');
  return values[0];
}

function loopback(raw: string): URL {
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\//.test(raw)) throw new Error('Invalid native OAuth callback');
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/' || url.hash) throw new Error('Invalid native OAuth callback');
  return url;
}

export function cortexOAuthOwner(raw: string): CortexOAuthOwner {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !/^[a-z0-9_-]+\.snowflakecomputing\.(?:com|cn)$/i.test(url.hostname)
    || url.port || url.username || url.password || url.hash || url.pathname !== '/oauth/authorize') throw new Error('Invalid native OAuth issuer');
  if (one(url, 'response_type') !== 'code' || one(url, 'code_challenge_method') !== 'S256') throw new Error('Invalid native OAuth flow');
  one(url, 'code_challenge');
  const callback = loopback(one(url, 'redirect_uri'));
  if (callback.search) throw new Error('Invalid native OAuth callback');
  return { authorizationUrl: raw, callback: callback.href, state: one(url, 'state'), issuer: `${url.origin}/oauth` };
}

/** Never fetch a user URL. Only return a validated string for native stdin. */
export function cortexOwnedRedirect(raw: string, owner: CortexOAuthOwner): string {
  try {
    if (raw.length > 16_384 || /[\p{Cc}\p{Cs}]/u.test(raw)) throw new Error();
    const url = loopback(raw);
    if (`${url.origin}${url.pathname}` !== owner.callback || one(url, 'state') !== owner.state || one(url, 'iss') !== owner.issuer) throw new Error();
    if ([...url.searchParams.keys()].some(key => !['code', 'state', 'iss'].includes(key))) throw new Error();
    const code = one(url, 'code');
    if (code.length > 4096) throw new Error();
    return url.href;
  } catch { throw new Error('The redirect does not match this active login. Paste its complete loopback redirect URL.'); }
}
