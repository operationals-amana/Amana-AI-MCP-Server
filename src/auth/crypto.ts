import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits of entropy, url-safe. Long enough that tokens need no rate limit. */
export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function randomId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Tokens and authorization codes are stored as their SHA-256 digest, so a
 * database dump cannot be replayed against the server. A plain hash with no
 * salt is right here — the inputs are already 256-bit random, so there is
 * nothing for a dictionary attack to work with.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare so a wrong secret cannot be found a byte at a time. */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Comparing against itself keeps the work constant for a length mismatch,
    // which would otherwise leak the expected length.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** RFC 7636 S256: the challenge is base64url(sha256(verifier)). */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return secretsMatch(computed, challenge);
}
