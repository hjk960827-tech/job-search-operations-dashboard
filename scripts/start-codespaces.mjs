import process from "node:process";
import { configStatus } from "../lib/config.mjs";

if (String(process.env.CODESPACES || "").toLowerCase() !== "true") {
  throw new Error("This command is available only inside GitHub Codespaces");
}

process.env.HOST = "127.0.0.1";
process.env.PORT = "8766";

try {
  const response = await fetch("http://127.0.0.1:8766/api/health", { signal: AbortSignal.timeout(800) });
  const health = await response.json();
  if (response.ok && health.product === "Job Search Operations Dashboard") {
    console.log(`Dashboard is already running in ${health.mode} mode`);
    process.exit(0);
  }
} catch {
  // The expected first-start path continues below.
}

process.env.APP_MODE = configStatus().complete ? "personal" : "onboarding";
console.log(`Starting ${process.env.APP_MODE} mode for this private Codespace`);
await import("../web-dashboard/server.mjs");
