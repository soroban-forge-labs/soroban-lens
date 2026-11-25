import type { Pool } from "pg";

export type ProcessName = "api" | "indexer";

export interface PoolMetrics {
  total: number;
  idle: number;
  waiting: number;
  acquireTimeouts: number;
}

const poolMetrics = new Map<ProcessName, PoolMetrics>();

function ensureMetrics(process: ProcessName): PoolMetrics {
  let metrics = poolMetrics.get(process);
  if (!metrics) {
    metrics = { total: 0, idle: 0, waiting: 0, acquireTimeouts: 0 };
    poolMetrics.set(process, metrics);
  }
  return metrics;
}

/**
 * Register a Postgres connection pool so its gauges are exposed on /metrics.
 * Only call this when the Postgres backend is active.
 */
export function registerPoolMetrics(process: ProcessName, pool: Pool): void {
  const metrics = ensureMetrics(process);

  const update = () => {
    metrics.total = pool.totalCount;
    metrics.idle = pool.idleCount;
    metrics.waiting = pool.waitingCount;
  };

  update();
  pool.on("connect", update);
  pool.on("acquire", update);
  pool.on("release", update);
  pool.on("remove", update);
}

/**
 * Record a connection acquire timeout for the given process.
 */
export function recordAcquireTimeout(process: ProcessName): void {
  ensureMetrics(process).acquireTimeouts += 1;
}

/**
 * Render pool metrics in Prometheus text exposition format.
 * Returns an empty string when no Postgres pool has been registered.
 */
export function renderPoolMetrics(): string {
  if (poolMetrics.size === 0) {
    return "";
  }

  const lines: string[] = [];

  lines.push("# HELP pg_pool_connections_total Total connections in the Postgres pool.");
  lines.push("# TYPE pg_pool_connections_total gauge");
  for (const [process, metrics] of poolMetrics) {
    lines.push(`pg_pool_connections_total{process="${process}"} ${metrics.total}`);
  }

  lines.push("# HELP pg_pool_connections_idle Idle connections in the Postgres pool.");
  lines.push("# TYPE pg_pool_connections_idle gauge");
  for (const [process, metrics] of poolMetrics) {
    lines.push(`pg_pool_connections_idle{process="${process}"} ${metrics.idle}`);
  }

  lines.push("# HELP pg_pool_connections_waiting Clients waiting for a Postgres connection.");
  lines.push("# TYPE pg_pool_connections_waiting gauge");
  for (const [process, metrics] of poolMetrics) {
    lines.push(`pg_pool_connections_waiting{process="${process}"} ${metrics.waiting}`);
  }

  lines.push("# HELP pg_pool_acquire_timeouts_total Connection acquire timeouts.");
  lines.push("# TYPE pg_pool_acquire_timeouts_total counter");
  for (const [process, metrics] of poolMetrics) {
    lines.push(`pg_pool_acquire_timeouts_total{process="${process}"} ${metrics.acquireTimeouts}`);
  }

  return lines.join("\n") + "\n";
}
