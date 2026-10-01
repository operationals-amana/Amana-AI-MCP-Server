/**
 * Redirect URI registration and matching.
 *
 * Exact string comparison is the rule, with one carve-out: Claude Code is a
 * native client and, per RFC 8252, redirects to a loopback address on an
 * ephemeral port that changes every session. It registers
 * `http://localhost/callback` and `http://127.0.0.1/callback`, so those have to
 * match with the port ignored — otherwise Claude Code can never complete a
 * flow. The carve-out is confined to loopback hosts: everywhere else a port
 * wildcard would let an attacker who controls any port on a registered host
 * receive authorization codes.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

export function isValidRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  // Custom schemes (myapp://) are legitimate for native clients, but this
  // server only ever talks to https clients and loopback ones.
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopback(url);
}

export function matchesRegisteredRedirectUri(
  requested: string,
  registered: readonly string[],
): boolean {
  let requestedUrl: URL;
  try {
    requestedUrl = new URL(requested);
  } catch {
    return false;
  }

  for (const candidate of registered) {
    if (candidate === requested) return true;

    let candidateUrl: URL;
    try {
      candidateUrl = new URL(candidate);
    } catch {
      continue;
    }

    if (!isLoopback(candidateUrl) || !isLoopback(requestedUrl)) continue;
    if (candidateUrl.protocol !== requestedUrl.protocol) continue;
    if (candidateUrl.pathname !== requestedUrl.pathname) continue;
    if (candidateUrl.search !== requestedUrl.search) continue;
    // Both loopback, same scheme and path: the port is the only difference, and
    // that is the part RFC 8252 section 7.3 says to ignore.
    return true;
  }

  return false;
}

/** The hostname shown on the consent screen, as the MCP spec requires. */
export function redirectHost(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return redirectUri;
  }
}

export function isLoopbackRedirect(redirectUri: string): boolean {
  try {
    return isLoopback(new URL(redirectUri));
  } catch {
    return false;
  }
}
