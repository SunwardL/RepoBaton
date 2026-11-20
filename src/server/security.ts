import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Guards for a local-only server. Anything on this machine can reach 127.0.0.1,
 * including web pages open in your browser, so the port alone is not protection.
 *  - Host header must name a loopback address (blocks DNS rebinding).
 *  - A browser request must come from our own origin (blocks other sites).
 *  - Every API call needs the per-launch token.
 */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function isLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  return allowed.has(hostHeader.toLowerCase());
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  // Non-browser clients (curl, the CLI) send no Origin; the token still protects them.
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerOf(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return undefined;
}

export type GuardResult = { ok: true } | { ok: false; status: number; message: string };

export function guard(req: IncomingMessage, port: number, token: string, opts: { needToken: boolean }): GuardResult {
  if (!isLoopbackHost(req.headers.host, port)) return { ok: false, status: 403, message: 'bad Host header' };
  if (!isAllowedOrigin(req.headers.origin, port)) return { ok: false, status: 403, message: 'bad Origin' };
  if (opts.needToken && !tokenMatches(bearerOf(req), token)) return { ok: false, status: 401, message: 'missing or wrong token' };
  return { ok: true };
}
