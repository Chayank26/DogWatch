/** Authenticate the exact HTTP bytes using the shared GitHub webhook secret. */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubSignature(
  body: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  // Validate length/encoding first: timingSafeEqual throws for unequal lengths.
  // Do not accept SHA-1, truncated digests, comma-joined duplicate headers, or junk.
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/i.test(signature))
    return false;
  const received = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(received, expected);
}
