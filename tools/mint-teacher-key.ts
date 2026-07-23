import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { openDatabase } from "../src/db.js";
import { MetaAdminService } from "../src/meta-admin.js";

const USAGE = "Usage: mint-teacher-key --label <teacher label> [--request-id <request id>]";

export function runMintTeacherKeyCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  writeOutput: (value: string) => void = (value) => process.stdout.write(`${value}\n`),
): void {
  if (arguments_.includes("--help")) {
    writeOutput(USAGE);
    return;
  }
  const labelIndex = arguments_.indexOf("--label");
  const label = labelIndex < 0 ? undefined : arguments_[labelIndex + 1]?.trim();
  if (label === undefined || label.length === 0) {
    throw new Error(USAGE);
  }
  const requestIdIndex = arguments_.indexOf("--request-id");
  const suppliedRequestId =
    requestIdIndex < 0 ? undefined : arguments_[requestIdIndex + 1]?.trim();
  if (requestIdIndex >= 0 && (suppliedRequestId === undefined || suppliedRequestId.length === 0)) {
    throw new Error(USAGE);
  }
  if (suppliedRequestId !== undefined && suppliedRequestId.length > 100) {
    throw new Error(USAGE);
  }
  const databasePath = environment.DATABASE_PATH?.trim() || environment.DB_PATH?.trim();
  if (databasePath === undefined || databasePath.length === 0) {
    throw new Error(
      "Missing required environment variable: DATABASE_PATH (legacy alias DB_PATH)",
    );
  }

  const database = openDatabase(databasePath);
  try {
    const service = new MetaAdminService(database, "");
    const result = service.mintTeacher(label, suppliedRequestId ?? randomUUID(), Date.now(), true);
    if (!result.ok) throw new Error(result.message ?? `Could not mint teacher key: ${result.code}`);
    if (result.key === null) {
      throw new Error(
        "This request id already minted a key, and keys are shown only once. Reissue the teacher to get a new key.",
      );
    }
    writeOutput(result.key);
  } finally {
    database.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    runMintTeacherKeyCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
