import { vi } from "vitest";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

describe("createServer", () => {
  it("instantiates MCP without writing to stdout", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = createServer(loadConfig({} as NodeJS.ProcessEnv));
    expect(server).toBeDefined();
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
  });
});
