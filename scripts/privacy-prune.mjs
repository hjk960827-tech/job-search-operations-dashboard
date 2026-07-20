import path from "node:path";
import process from "node:process";
import { openDatabase } from "../lib/database.mjs";
import {
  PRIVACY_DELETE_CONFIRMATION,
  deleteExpiredPrivateDocuments,
  planPrivateDocumentDeletion,
} from "../lib/privacy-retention.mjs";
import { databasePath, runtimeMode } from "../lib/paths.mjs";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const mode = runtimeMode(argument("mode") || process.env.APP_MODE || "personal");
if (mode !== "personal") throw new Error("Private document retention runs only in personal mode");
const days = argument("older-than-days");
const db = openDatabase(databasePath(mode));
try {
  const result = process.argv.includes("--write")
    ? deleteExpiredPrivateDocuments(db, { olderThanDays: days, confirm: argument("confirm") })
    : planPrivateDocumentDeletion(db, { olderThanDays: days });
  console.log(JSON.stringify({
    cutoff: result.cutoff,
    count: result.count,
    documents: result.documents?.map((item) => ({ ...item, path: path.basename(item.path) })),
    deleted: result.deleted,
  }, null, 2));
  if (!process.argv.includes("--write")) {
    console.error(`Dry-run only. Deletion requires --write --confirm=${PRIVACY_DELETE_CONFIRMATION}.`);
  }
} finally {
  db.close();
}
