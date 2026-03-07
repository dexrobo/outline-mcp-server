import { jest } from "@jest/globals";
import { EventEmitter } from "events";
import { runMcpSmokeTest } from "./mcp-smoke-lib.js";

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = jest.fn();
  child.kill = jest.fn();
  return child;
}

describe("runMcpSmokeTest", () => {
  test("returns non-zero when server exits before completing handshake", async () => {
    const child = createFakeChild();
    const spawnFn = jest.fn(() => child);
    const error = jest.fn();

    const resultPromise = runMcpSmokeTest({
      spawnFn,
      timeoutMs: 5000,
      log: jest.fn(),
      warn: jest.fn(),
      error,
    });

    child.emit("exit", 1, null);

    await expect(resultPromise).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Server exited unexpectedly"),
    );
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

