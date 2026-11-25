import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config";
import { openDatabase, getSchemaVersion, CURRENT_SCHEMA_VERSION } from "@lens/store";
import { checkPostgres } from "../postgres-doctor";

export interface DoctorOptions {
  dataDir?: string;
  configPath?: string;
}

export interface DoctorResult {
  ok: boolean;
  messages: string[];
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const messages: string[] = [];
  let ok = true;

  const config = loadConfig(options.configPath);
  const dataDir = options.dataDir ?? config.dataDir;

  if (!existsSync(dataDir)) {
    ok = false;
    messages.push(
      `data directory not found: ${dataDir} (create it or set dataDir in the config)`,
    );
  } else if (!statSync(dataDir).isDirectory()) {
    ok = false;
    messages.push(`data directory is not a directory: ${dataDir}`);
  } else {
    messages.push(`data directory ok: ${dataDir}`);
  }

  if (config.backend === "postgres") {
    const pg = await checkPostgres(config.postgres);
    if (!pg.ok) {
      ok = false;
    }
    messages.push(...pg.messages);
  } else {
    const dbPath = join(dataDir, "lens.db");
    if (!existsSync(dbPath)) {
      ok = false;
      messages.push(
        `database not found: ${dbPath} (run \`lens index\` to create it)`,
      );
    } else {
      try {
        const db = openDatabase(dbPath);
        const version = getSchemaVersion(db);
        db.close();
        if (version > CURRENT_SCHEMA_VERSION) {
          ok = false;
          messages.push(
            `database schema version ${version} is newer than this build (${CURRENT_SCHEMA_VERSION}); upgrade lens`,
          );
        } else {
          messages.push(`database ok: schema version ${version}`);
        }
      } catch (err) {
        ok = false;
        messages.push(
          `database unreadable: ${dbPath} (${(err as Error).message})`,
        );
      }
    }
  }

  return { ok, messages };
}
