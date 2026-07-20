import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../lib/config.mjs";
import {
  collectionAdapterContract,
  getCollectionRun,
  publishCollectionRun,
  stageCollectionBatch,
} from "../lib/collection-pipeline.mjs";
import { initializeDatabase, openDatabase } from "../lib/database.mjs";
import { assertPathInside, databasePath, PRIVATE_DATA_DIR } from "../lib/paths.mjs";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

const command = process.argv[2] || "contract";
if (command === "contract") {
  console.log(JSON.stringify(collectionAdapterContract(), null, 2));
  process.exit(0);
}

const sourcesConfig = loadConfig("sources");
const profileConfig = loadConfig("profile");
const timeZone = profileConfig.location?.timezone || "Asia/Seoul";
const dbPath = databasePath("personal");
initializeDatabase(dbPath, { mode: "personal" });
const db = openDatabase(dbPath);
try {
  let result;
  if (command === "stage") {
    const supplied = argument("input");
    if (!supplied) throw new Error("stage requires --input=<ignored private JSON path>");
    const inputPath = assertPathInside(PRIVATE_DATA_DIR, path.resolve(supplied), "collection input");
    const stat = fs.lstatSync(inputPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Collection input must be a regular private JSON file");
    result = stageCollectionBatch(db, JSON.parse(fs.readFileSync(inputPath, "utf8")), { sourcesConfig, timeZone });
  } else if (command === "publish") {
    result = publishCollectionRun(db, argument("run"), {
      expectedChecksum: argument("expected-checksum"),
      sourcesConfig,
      timeZone,
    });
  } else if (command === "show") {
    result = { run: getCollectionRun(argument("run"), { db }) };
  } else {
    throw new Error("Usage: collection.mjs contract | stage --input=<private.json> | show --run=<id> | publish --run=<id> --expected-checksum=<sha256>");
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
