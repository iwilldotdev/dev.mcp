#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, PACKAGE_NAME } from "./config.js";
import { log } from "./log.js";
import { createServer } from "./server.js";

loadDotenv();

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("stdio server started");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[${PACKAGE_NAME}] failed to start:`, message);
  process.exit(1);
});
