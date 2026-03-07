#!/usr/bin/env node
import { spawn } from "child_process";

const [, , timeoutArg, ...commandParts] = process.argv;

if (!timeoutArg || commandParts.length === 0) {
  console.error("Usage: node scripts/run-with-timeout.js <timeout-ms> <command...>");
  process.exit(2);
}

const timeoutMs = Number(timeoutArg);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error(`Invalid timeout '${timeoutArg}'. Expected a positive number.`);
  process.exit(2);
}

const command = commandParts.join(" ");
const child = spawn(command, {
  shell: true,
  stdio: "inherit",
  env: process.env,
});

let finished = false;
const done = (code) => {
  if (finished) return;
  finished = true;
  clearTimeout(timeoutHandle);
  process.exit(code);
};

const timeoutHandle = setTimeout(() => {
  console.error(`❌ Command timed out after ${timeoutMs} ms: ${command}`);
  child.kill("SIGTERM");

  setTimeout(() => {
    if (finished) return;
    child.kill("SIGKILL");
  }, 1000);
}, timeoutMs);

child.on("error", (error) => {
  console.error(`❌ Failed to run command: ${error.message}`);
  done(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    done(1);
    return;
  }
  done(code ?? 1);
});

