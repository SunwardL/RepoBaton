/**
 * Keep credentials out of anything RepoBaton stores or shows: run state, events, logs, API
 * responses and the UI. Upstream providers, git and gh sometimes echo a key back inside an
 * error ("Incorrect API key provided: sk-..."), a header, a URL or a remote address.
 *
 * Two layers:
 *  1. Values: the current value of every environment variable that looks like a secret, and
 *     of any key configured for an agent, is replaced wherever it appears.
 *  2. Shapes: well-known token formats and credential-bearing syntax (bearer headers,
 *     user:password@ URLs, ?key= query strings, "api_key": "..." JSON).
 *
 * Names stay readable: agent ids, environment variable NAMES and error categories are never
 * touched, only values. This module imports nothing from the rest of the project so every
 * layer, including the error classes, can use it.
 */

export const REDACTED = '[redacted]';

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
// Values that are obviously not secrets even under a secret-looking name.
const PATH_LIKE = /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~)/;
const MIN_SECRET_LENGTH = 8;

/** Extra secret values registered by the caller, e.g. an inline apiKey from a config file. */
const registered = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) registered.add(value);
}

export function clearRegisteredSecrets(): void {
  registered.clear();
}

/** Secret values currently present in this process's environment, longest first. */
export function secretValues(): string[] {
  const out = new Set<string>(registered);
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_SECRET_LENGTH || value.length > 4096) continue;
    if (!SECRET_NAME.test(name)) continue;
    if (PATH_LIKE.test(value) || /\s/.test(value)) continue;
    out.add(value);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const SHAPES: Array<[RegExp, string]> = [
  // user:password@ in any URL (git remotes, proxies)
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Authorization-style headers, whole value
  [/\b(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token)(\s*[:=]\s*)[^\r\n"',}]*/gi, `$1$2${REDACTED}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/g, `Bearer ${REDACTED}`],
  // Common token formats
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // "api_key": "value" in JSON-looking text
  [/("(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|token)"\s*:\s*")[^"]*(")/gi, `$1${REDACTED}$2`],
  // ?key=... / &token=... in URLs
  [/([?&](?:api[_-]?key|apikey|key|token|access_token|auth|signature)=)[^&\s"'#]+/gi, `$1${REDACTED}`],
];

// NAME=value assignments, e.g. "OPENAI_API_KEY=abc" in a command line or an env dump.
const ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)=([^\s"']+)/g;

export interface RedactOptions {
  /** Also mask NAME=value assignments. For diagnostic text only: it would damage user prose. */
  assignments?: boolean;
}

export function redactSecrets(text: string, opts: RedactOptions = {}): string {
  if (!text) return text;
  let out = text;
  for (const v of secretValues()) {
    if (out.includes(v)) out = out.split(v).join(REDACTED);
  }
  for (const [re, rep] of SHAPES) out = out.replace(re, rep);
  if (opts.assignments) out = out.replace(ASSIGNMENT, `$1=${REDACTED}`);
  return out;
}

/** Diagnostic text from an upstream or a subprocess: strongest masking. */
export function redactDiagnostic(text: string): string {
  return redactSecrets(text, { assignments: true });
}

/** Copy of any JSON-like value with every string masked. Keys are kept. */
export function redactDeep<T>(value: T, opts: RedactOptions = {}, depth = 0): T {
  if (typeof value === 'string') return redactSecrets(value, opts) as unknown as T;
  if (value === null || typeof value !== 'object' || depth > 24) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, opts, depth + 1);
  return out as T;
}
