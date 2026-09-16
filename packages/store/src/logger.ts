/**
 * Structured logging, shared by the store and the API.
 *
 * A plain `(message: string) => void` callback is useful to a human watching a
 * terminal and useless to anything parsing it — there is no way to find every
 * log line for one request, or to alert on `level === 'error'`, without
 * regexing prose.
 *
 * `createLogger()` renders the same records two ways: readable text by
 * default, and one JSON object per line when `LENS_LOG_FORMAT=json` (or an
 * explicit `format: 'json'`) — which is what a log aggregator actually wants.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Extra structured context: ledger, cursor, duration, request id, and so on. */
export interface LogFields {
  [key: string]: string | number | boolean | undefined;
}

export interface LogRecord {
  level: LogLevel;
  /** A short, stable, machine-matchable name — "batch_indexed", not a sentence. */
  event: string;
  /** The human-readable line. In text mode this is the entire rendered output,
   *  so switching formats never changes what a human reading the default
   *  output sees. */
  message: string;
  fields?: LogFields;
}

export type LogFormat = 'text' | 'json';

export interface Logger {
  debug(event: string, message: string, fields?: LogFields): void;
  info(event: string, message: string, fields?: LogFields): void;
  warn(event: string, message: string, fields?: LogFields): void;
  error(event: string, message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** Defaults to `LENS_LOG_FORMAT` from the environment, else 'text'. */
  format?: LogFormat;
  /** Sink for one already-formatted line (no trailing newline). Defaults to stderr. */
  write?: (line: string) => void;
  /** Clock, swappable in tests. */
  now?: () => Date;
  /** Prefixes every text line, e.g. "[api]". Omit for none. */
  prefix?: string;
}

export function resolveLogFormat(env: NodeJS.ProcessEnv = process.env): LogFormat {
  return env.LENS_LOG_FORMAT === 'json' ? 'json' : 'text';
}

/** Render one record as it would appear via `createLogger()`. Exposed for tests. */
export function formatRecord(record: LogRecord, format: LogFormat, now: Date, prefix = ''): string {
  if (format === 'json') {
    return JSON.stringify({
      time: now.toISOString(),
      level: record.level,
      event: record.event,
      message: record.message,
      ...record.fields,
    });
  }
  // Text mode: the message is the whole line, so this is exactly what every
  // caller already wrote by hand before this existed — the "default output is
  // unchanged" half of the deal. Fields are appended only if the caller passed
  // some that are not already folded into the message.
  const extras = Object.entries(record.fields ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  const line = prefix ? `${prefix} ${record.message}` : record.message;
  return extras ? `${line} (${extras})` : line;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const format = options.format ?? resolveLogFormat();
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const prefix = options.prefix ?? '';

  const emit = (level: LogLevel, event: string, message: string, fields?: LogFields): void => {
    write(formatRecord({ level, event, message, fields }, format, now(), prefix));
  };

  return {
    debug: (event, message, fields) => emit('debug', event, message, fields),
    info: (event, message, fields) => emit('info', event, message, fields),
    warn: (event, message, fields) => emit('warn', event, message, fields),
    error: (event, message, fields) => emit('error', event, message, fields),
  };
}
