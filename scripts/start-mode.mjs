import process from "node:process";

const mode = String(process.argv[2] || "").trim().toLowerCase();
if (!new Set(["demo", "onboarding", "personal"]).has(mode)) {
  throw new Error("Mode must be demo, onboarding, or personal");
}

process.env.APP_MODE = mode;
await import("../web-dashboard/server.mjs");
