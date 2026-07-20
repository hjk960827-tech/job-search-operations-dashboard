import process from "node:process";
import { runDoctor } from "../lib/doctor.mjs";

const modeArgument = process.argv.find((value) => value.startsWith("--mode="));
const result = runDoctor({ mode: modeArgument?.slice("--mode=".length) });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
