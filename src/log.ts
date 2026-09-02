/** Logs only on stderr so stdout stays JSON-RPC. */
import { PACKAGE_NAME } from "./config.js";

export function log(...args: unknown[]): void {
  console.error(`[${PACKAGE_NAME}]`, ...args);
}
