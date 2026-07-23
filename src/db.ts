import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export type AppDatabase = Database.Database;

export type DatabaseOptions = {
  migrationsDirectory?: string;
  migrate?: boolean;
};

export function runMigrations(
  database: AppDatabase,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): string[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = database
    .prepare("SELECT migration_name FROM schema_migrations")
    .all()
    .map((row) => (row as { migration_name: string }).migration_name);
  const appliedNames = new Set(applied);
  const migrationNames = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  const newlyApplied: string[] = [];

  const applyMigration = database.transaction((name: string, sql: string) => {
    database.exec(sql);
    database
      .prepare(
        "INSERT INTO schema_migrations (migration_name, applied_at_ms) VALUES (?, ?)",
      )
      .run(name, Date.now());
  });

  for (const name of migrationNames) {
    if (appliedNames.has(name)) {
      continue;
    }
    applyMigration(name, readFileSync(join(migrationsDirectory, name), "utf8"));
    newlyApplied.push(name);
  }

  return newlyApplied;
}

export function openDatabase(
  path: string,
  options: DatabaseOptions = {},
): AppDatabase {
  const database = new Database(path);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("busy_timeout = 5000");

    if (options.migrate !== false) {
      runMigrations(database, options.migrationsDirectory);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
