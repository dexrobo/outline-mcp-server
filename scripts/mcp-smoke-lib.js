import { spawn as nodeSpawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultServerPath = path.join(__dirname, "..", "src", "index.js");

export function runMcpSmokeTest(options = {}) {
  const {
    spawnFn = nodeSpawn,
    env = process.env,
    serverPath = defaultServerPath,
    timeoutMs = Number(env.MCP_SMOKE_TIMEOUT_MS || 30000),
    log = console.log.bind(console),
    warn = console.warn.bind(console),
    error = console.error.bind(console),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  return new Promise((resolve) => {
    try {
      fs.chmodSync(serverPath, "755");
    } catch (e) {
      // Ignore chmod failures; node can still execute the script.
    }

    log("🚀 Starting local MCP smoke test...");
    log(`📍 Server path: ${serverPath}`);

    const server = spawnFn("node", [serverPath], {
      env: {
        ...env,
        LOG_LEVEL: "debug",
      },
    });

    let id = 1;
    let step = "initialize";
    let finished = false;
    let stdoutBuffer = "";

    const cleanup = (code = 0) => {
      if (finished) return;
      finished = true;
      clearTimeoutFn(timeoutHandle);
      if (typeof server.kill === "function") server.kill();
      resolve(code);
    };

    const timeoutHandle = setTimeoutFn(() => {
      error(`\x1b[31m❌ Error: Smoke test timed out after ${timeoutMs} ms.\x1b[0m`);
      cleanup(1);
    }, timeoutMs);

    const send = (method, params = {}) => {
      const request = {
        jsonrpc: "2.0",
        id: id++,
        method,
        params,
      };
      const json = JSON.stringify(request);
      log(`\x1b[34mC -> S [Request ${request.id}]: ${method}\x1b[0m`);
      server.stdin.write(json + "\n");
    };

    const notify = (method, params = {}) => {
      const notification = {
        jsonrpc: "2.0",
        method,
        params,
      };
      log(`\x1b[36mC -> S [Notify]: ${method}\x1b[0m`);
      server.stdin.write(JSON.stringify(notification) + "\n");
    };

    server.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;

        try {
          const response = JSON.parse(line);
          log(
            `\x1b[32mS -> C [Response ${response.id || "N/A"}]:\x1b[0m`,
            JSON.stringify(response, null, 2),
          );

          if (response.id === 1 && step === "initialize") {
            log("✅ Handshake Step 1: Initialize Success");
            notify("notifications/initialized");
            step = "list-tools";
            send("tools/list");
          } else if (response.id === 2 && step === "list-tools") {
            log("✅ Handshake Step 2: List Tools Success");
            const toolNames = response.result.tools.map((tool) => tool.name);
            log("🛠️  Available Tools:", toolNames.join(", "));

            step = "call-tool";
            const testMethod = env.MCP_SMOKE_METHOD || "documents-list";
            const testArguments = env.MCP_SMOKE_ARGUMENTS
              ? JSON.parse(env.MCP_SMOKE_ARGUMENTS)
              : {};

            log(`🧪 Testing tool: ${testMethod}...`);
            send("tools/call", {
              name: testMethod,
              arguments: testArguments,
            });
          } else if (response.id === 3 && step === "call-tool") {
            if (response.result && !response.isError) {
              log("✅ Smoke Test Passed: End-to-end tool call successful.");
            } else {
              warn(
                "⚠️  Tool call returned an error (likely expected if no credentials), but routing worked.",
              );
              log("Result:", JSON.stringify(response.result, null, 2));
            }
            cleanup(0);
          }
        } catch (e) {
          // Ignore non JSON-RPC lines.
        }
      }
    });

    server.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) log(`\x1b[90m[Server Log]: ${msg}\x1b[0m`);
    });

    server.on("error", (spawnError) => {
      error(`\x1b[31m❌ Failed to start server: ${spawnError.message}\x1b[0m`);
      cleanup(1);
    });

    server.on("exit", (code, signal) => {
      if (finished) return;
      error(
        `\x1b[31m❌ Server exited unexpectedly (code=${code}, signal=${signal || "none"}) before smoke test completed.\x1b[0m`,
      );
      cleanup(1);
    });

    server.stdin.on("error", (stdinError) => {
      if (finished) return;
      error(`\x1b[31m❌ Stdin error: ${stdinError.message}\x1b[0m`);
      cleanup(1);
    });

    send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test-client", version: "1.0.0" },
    });
  });
}

