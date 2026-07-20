import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertPathInside, READ_RUNS_DIR } from "./paths.mjs";

function readError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function checksum(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function taskDefinition(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw readError(`tasks[${index}] must be an object`);
  const taskKey = String(value.taskKey || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(taskKey)) throw readError(`tasks[${index}].taskKey is invalid`);
  return { taskKey, input: value.input ?? {} };
}

function deterministicReduce(results) {
  const byJobKey = new Map();
  for (const result of [...results].sort((left, right) => left.taskKey.localeCompare(right.taskKey))) {
    for (const job of result.jobs) {
      if (!job || typeof job !== "object" || Array.isArray(job)) throw readError(`Worker ${result.taskKey} returned an invalid job`);
      const jobKey = String(job.jobKey || "").trim();
      if (!jobKey) throw readError(`Worker ${result.taskKey} returned a job without jobKey`);
      const normalized = stable(job);
      const existing = byJobKey.get(jobKey);
      if (existing && checksum(existing) !== checksum(normalized)) throw readError(`Workers returned conflicting facts for jobKey: ${jobKey}`, 409);
      byJobKey.set(jobKey, normalized);
    }
  }
  return [...byJobKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, job]) => job);
}

export async function runLimitedJobReads(tasks, worker, {
  concurrency = 2,
  runRoot = READ_RUNS_DIR,
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 100) throw readError("tasks must contain 1 to 100 items");
  if (typeof worker !== "function") throw readError("worker must be a function");
  const limit = Number(concurrency);
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw readError("concurrency must be between 1 and 4");
  const normalized = tasks.map(taskDefinition);
  if (new Set(normalized.map((item) => item.taskKey)).size !== normalized.length) throw readError("taskKey values must be unique");
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(runRoot).isSymbolicLink()) throw readError("Read run root must not be a symbolic link", 409);
  fs.chmodSync(runRoot, 0o700);
  const id = crypto.randomUUID();
  const directory = assertPathInside(runRoot, path.join(runRoot, id), "read run directory");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const startedAt = now().toISOString();
  const results = new Array(normalized.length);
  let cursor = 0;
  let failure = null;

  async function consume() {
    while (!failure) {
      const index = cursor;
      cursor += 1;
      if (index >= normalized.length) return;
      const task = normalized[index];
      try {
        const value = await worker({ taskKey: task.taskKey, input: structuredClone(task.input) });
        if (!value || typeof value !== "object" || !Array.isArray(value.jobs)) throw readError(`Worker ${task.taskKey} must return { jobs: [] }`);
        results[index] = { taskKey: task.taskKey, jobs: value.jobs };
        writeJson(path.join(directory, `task-${String(index + 1).padStart(3, "0")}.json`), results[index]);
      } catch (error) {
        failure = { taskKey: task.taskKey, message: String(error?.message || "Worker failed") };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, normalized.length) }, () => consume()));
  if (failure) {
    const manifest = { version: 1, id, status: "failed", startedAt, completedAt: now().toISOString(), taskCount: normalized.length, failure };
    writeJson(path.join(directory, "manifest.json"), manifest);
    throw Object.assign(readError(`Read worker failed: ${failure.taskKey}`, 409), { run: manifest });
  }
  let jobs;
  try {
    jobs = deterministicReduce(results);
  } catch (error) {
    const manifest = {
      version: 1,
      id,
      status: "failed",
      startedAt,
      completedAt: now().toISOString(),
      taskCount: normalized.length,
      failure: { taskKey: "deterministic-reducer", message: String(error?.message || "Reducer failed") },
    };
    writeJson(path.join(directory, "manifest.json"), manifest);
    throw Object.assign(error, { run: manifest });
  }
  const combined = { schemaVersion: 1, jobs };
  writeJson(path.join(directory, "combined.json"), combined);
  const manifest = {
    version: 1,
    id,
    status: "succeeded",
    startedAt,
    completedAt: now().toISOString(),
    taskCount: normalized.length,
    jobCount: jobs.length,
    resultChecksum: checksum(combined),
  };
  writeJson(path.join(directory, "manifest.json"), manifest);
  return { run: manifest, combined };
}

export function reduceJobReadResults(results) {
  return deterministicReduce(results);
}
