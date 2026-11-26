import type { IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export type ApiKeyScope = 'read' | 'admin';

interface ApiKeyEntry {
  name: string;
  digest: Buffer;
  scope: ApiKeyScope;
}

/**
 * Parse a configured key entry.
 *
 * Supported formats:
 * - `name:key:scope` — named key with an explicit `read` or `admin` scope.
 * - `key` — legacy plain key, treated as `admin` for backward compatibility.
 */
const parseEntry = (raw: string): ApiKeyEntry | undefined => {
  const value = raw.trim();
  if (value === '') return undefined;
  const parts = value.split(':');
  if (parts.length === 3) {
    const [name, key, scope] = parts.map((p) => p.trim());
    if (name && key && (scope === 'read' || scope === 'admin')) {
      return { name, digest: digest(key), scope };
    }
  }
  return { name: 'legacy', digest: digest(value), scope: 'admin' };
};

/**
 * Optional API-key check.
 *
 * Keys are compared as SHA-256 digests with `timingSafeEqual`, so neither a key's
 * length nor how many leading characters matched leaks through response time.
 *
 * Keys may be configured as `name:key:scope` (scopes `read`, `admin`). A plain
 * `key` entry keeps working and is treated as `admin`.
 */
export class ApiKeyAuthenticator {
  readonly #entries: ApiKeyEntry[];

  constructor(keys: string[]) {
    this.#entries = keys.map(parseEntry).filter((e): e is ApiKeyEntry => e !== undefined);
  }

  /** Whether any key is configured. When false every request is allowed, as before auth existed. */
  get enabled(): boolean {
    return this.#entries.length > 0;
  }

  /** `X-API-Key: <key>` or `Authorization: Bearer <key>`. */
  presentedKey(req: IncomingMessage): string | undefined {
    const header = req.headers['x-api-key'];
    const direct = (Array.isArray(header) ? header[0] : header)?.trim();
    if (direct) return direct;
    const authorization = req.headers.authorization;
    const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
    return match?.[1]?.trim();
  }

  /** Resolve the presented key to its configured entry, or `undefined` when unknown. */
  identify(req: IncomingMessage): ApiKeyEntry | undefined {
    const presented = this.presentedKey(req);
    if (!presented) return undefined;
    const candidate = digest(presented);
    // No early exit: every configured key is compared.
    let match: ApiKeyEntry | undefined;
    for (const entry of this.#entries) {
      if (timingSafeEqual(entry.digest, candidate)) match = entry;
    }
    return match;
  }

  /** Name of the key that made the request, for logging/counting. Never the key itself. */
  keyName(req: IncomingMessage): string | undefined {
    return this.identify(req)?.name;
  }

  /** Whether the presented key is known and carries the required scope. */
  hasScope(req: IncomingMessage, scope: ApiKeyScope): boolean {
    if (!this.enabled) return true;
    const entry = this.identify(req);
    if (!entry) return false;
    return scope === 'read' ? entry.scope === 'read' || entry.scope === 'admin' : entry.scope === 'admin';
  }

  isAuthorized(req: IncomingMessage): boolean {
    if (!this.enabled) return true;
    return this.identify(req) !== undefined;
  }
}
