import { readFile, writeFile, mkdir, rename, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RetentionSnapshot } from './retention.js';

/** Everything we need to resume a stream exactly where it stopped. */
export interface CursorState {
  /** Opaque REC paging token returned by the previous `getEvents` call. */
  cursor: string;
  /** Last ledger we have seen, for humans and for metrics. */
  ledger: number;
  /** ISO timestamp of the last successful save. */
  updatedAt: string;
  /**
   * The node's retention window when this position was saved (#17). Optional
   * because stores that predate it — including `stream_state` rows written by
   * the CLI — carry no window, and a missing one must not stop a resume.
   */
  retention?: RetentionSnapshot;
}

/**
 * Where a poller remembers its position. Keyed by a caller-chosen string so one
 * process can run several independent streams (per network, per contract set).
 */
export interface CursorStore {
  load(key: string): Promise<CursorState | null>;
  save(key: string, state: CursorState): Promise<void>;
  clear(key: string): Promise<void>;
}

/** Non-persistent store, for tests and for one-shot `--no-resume` runs. */
export class MemoryCursorStore implements CursorStore {
  readonly #state = new Map<string, CursorState>();
  async load(key: string): Promise<CursorState | null> {
    return this.#state.get(key) ?? null;
  }
  async save(key: string, state: CursorState): Promise<void> {
    this.#state.set(key, state);
  }
  async clear(key: string): Promise<void> {
    this.#state.delete(key);
  }
}

/**
 * JSON-file-backed cursor store. Writes atomically (temp file + rename) so a
 * process killed mid-write resumes from the previous good cursor rather than
 * from a truncated file.
 *
 * Deliberately a flat file and not the SQLite database: Module 1 must be usable
 * on its own, with no storage backend attached.
 */
export class FileCursorStore implements CursorStore {
  readonly #dir: string;
  readonly #cleanup: Promise<void>;
  constructor(dir: string) {
    this.#dir = dir;
    this.#cleanup = this.#removeOrphanedTemps();
    void this.#cleanup.catch(() => {});
  }

  async #removeOrphanedTemps(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.#dir);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    await Promise.all(files.map(async (file) => {
      const match = /^.+\.cursor\.json\.(\d+)\.tmp$/.exec(file);
      if (!match) return;
      const pid = Number(match[1]);
      if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) return;
      try {
        await unlink(join(this.#dir, file));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }));
  }

  #path(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(this.#dir, `${safe}.cursor.json`);
  }

  async load(key: string): Promise<CursorState | null> {
    await this.#cleanup;
    try {
      const text = await readFile(this.#path(key), 'utf8');
      const parsed = JSON.parse(text) as Partial<CursorState>;
      if (typeof parsed.cursor !== 'string' || parsed.cursor === '') return null;
      const retention = parseRetention(parsed.retention);
      return {
        cursor: parsed.cursor,
        ledger: typeof parsed.ledger === 'number' ? parsed.ledger : 0,
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
        ...(retention ? { retention } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async save(key: string, state: CursorState): Promise<void> {
    await this.#cleanup;
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  }

  async clear(key: string): Promise<void> {
    await this.#cleanup;
    try {
      await unlink(this.#path(key));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

/**
 * Build a per-chunk cursor key from a base key and a chunk index.
 *
 * When `buildFilters()` splits a contract set across multiple filters, each
 * chunk is polled independently and needs its own cursor. The single-filter
 * path keys the store exactly as before (the bare base key), so existing
 * persisted cursors and the single-contract path are unchanged.
 */
export function chunkCursorKey(baseKey: string, chunkIndex: number, totalChunks: number): string {
  if (totalChunks <= 1) return baseKey;
  return `${baseKey}#chunk-${chunkIndex}-of-${totalChunks}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH' || code === 'EINVAL') return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * A snapshot read back from disk is untrusted input: a truncated write or a
 * hand-edited file must cost the comparison, not the resume. A malformed
 * snapshot is dropped rather than thrown on.
 */
function parseRetention(value: unknown): RetentionSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { latestLedger, oldestLedger } = value as Partial<RetentionSnapshot>;
  if (!isLedger(latestLedger) || !isLedger(oldestLedger)) return undefined;
  if (oldestLedger > latestLedger) return undefined;
  return { latestLedger, oldestLedger };
}

function isLedger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
