import fs from "node:fs";
import process from "node:process";
import { loadConfig } from "../lib/config.mjs";
import {
  cancelCompanionTask,
  claimNextCompanionTask,
  completeCompanionTask,
  createCompanionTask,
  failCompanionTask,
  heartbeatCompanionTask,
  listCompanionTasks,
  retryCompanionTask,
} from "../lib/companion-queue.mjs";
import { initializeDatabase, openDatabase } from "../lib/database.mjs";
import { companionTaskPath, databasePath } from "../lib/paths.mjs";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const command = process.argv[2] || "list";
const context = {
  profileConfig: loadConfig("profile"),
  searchConfig: loadConfig("search"),
  sourcesConfig: loadConfig("sources"),
};
const dbPath = databasePath("personal");
if (!fs.existsSync(dbPath)) {
  throw new Error("Personal database is not initialized. Complete onboarding, or run setup followed by db:init.");
}
initializeDatabase(dbPath, { mode: "personal" });
const db = openDatabase(dbPath);

try {
  let result;
  if (command === "list") result = { tasks: listCompanionTasks(db) };
  else if (command === "create") {
    result = createCompanionTask(db, { kind: argument("kind"), jobId: argument("job"), documentIds: argument("documents")?.split(",") }, context);
  } else if (command === "claim") {
    const claimed = claimNextCompanionTask(db, { workerId: argument("worker") });
    result = claimed ? { task: claimed.task, requestPath: claimed.task.requestPath } : { task: null };
  } else {
    const taskId = argument("task");
    if (!taskId) throw new Error(`${command} requires --task=<id>`);
    if (command === "heartbeat") result = heartbeatCompanionTask(db, taskId, { workerId: argument("worker") });
    else if (command === "complete") {
      const candidatePath = companionTaskPath(taskId, "candidate-result.json");
      const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
      result = completeCompanionTask(db, taskId, {
        workerId: argument("worker"),
        requestChecksum: argument("request-checksum"),
        result: candidate.result || candidate,
      });
    } else if (command === "fail") {
      result = failCompanionTask(db, taskId, { workerId: argument("worker"), code: argument("code"), message: argument("message") });
    } else if (command === "retry") result = retryCompanionTask(db, taskId);
    else if (command === "cancel") result = cancelCompanionTask(db, taskId);
    else throw new Error("Usage: companion.mjs list|create|claim|heartbeat|complete|fail|retry|cancel");
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
