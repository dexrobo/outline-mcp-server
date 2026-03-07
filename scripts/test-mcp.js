#!/usr/bin/env node
import { runMcpSmokeTest } from "./mcp-smoke-lib.js";

runMcpSmokeTest().then((code) => {
  process.exit(code);
});
