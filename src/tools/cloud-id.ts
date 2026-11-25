import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Runtime } from "../runtime.js";
import { errorResult } from "./result.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Tenant id per site, cached for the life of the process (only successes are cached). */
const tenantIds = new Map<string, string>();

/** Test hook. */
export function resetTenantIdCache(): void {
  tenantIds.clear();
}

async function tenantId(runtime: Runtime, site: string): Promise<string | undefined> {
  const known = tenantIds.get(site);
  if (known) return known;
  try {
    const info = await runtime.http.json<{ cloudId?: unknown }>(`https://${site}/_edge/tenant_info`, {
      headers: { Accept: "application/json" },
      maxRetries: 0,
    });
    if (typeof info?.cloudId === "string" && UUID.test(info.cloudId)) {
      const id = info.cloudId.toLowerCase();
      tenantIds.set(site, id);
      return id;
    }
  } catch {
    /* unknown tenant: handled by the caller */
  }
  return undefined;
}

/**
 * Validates an optional cloudId against the configured Atlassian site. dev.mcp serves exactly one site, so a
 * cloudId naming another one must not silently act on this one.
 * Returns a warning to attach to a read result, or throws.
 */
export async function checkCloudId(runtime: Runtime, cloudId: unknown, write: boolean): Promise<string | undefined> {
  if (cloudId === undefined || cloudId === null || cloudId === "") return undefined;
  const atlassian = runtime.config.atlassian;
  if (!atlassian) return undefined; // the tool itself reports the missing credentials
  const raw = String(cloudId).trim();
  const site = atlassian.site.toLowerCase();
  if (UUID.test(raw)) {
    const tenant = await tenantId(runtime, site);
    if (!tenant) {
      if (write) {
        throw new Error(
          `cloudId mismatch-unknown: could not read the tenant id of ${site} (GET /_edge/tenant_info failed), so cloudId ${raw} cannot be verified; the write was not sent. Omit cloudId to act on the configured site.`,
        );
      }
      return `cloudId ${raw} could not be verified against ${site} (tenant_info unavailable); the configured site was used.`;
    }
    if (tenant !== raw.toLowerCase()) {
      throw new Error(`cloudId mismatch: ${raw} is not the tenant of the configured site ${site} (${tenant}). dev.mcp serves only that site.`);
    }
    return undefined;
  }
  const host = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  if (HOSTNAME.test(host)) {
    if (host !== site) {
      throw new Error(`cloudId mismatch: ${raw} is not the configured site ${site}. dev.mcp serves only that site.`);
    }
    return undefined;
  }
  throw new Error(`cloudId "${raw}" is neither a site hostname nor a tenant UUID; omit it to use ${site}.`);
}

/**
 * Wraps `server.tool` so every tool that declares a `cloudId` argument validates it first. A tool counts as a write
 * when its description starts with "WRITE".
 */
export function withCloudIdCheck(server: McpServer, runtime: Runtime): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "tool") {
        return (...args: any[]) => {
          const cb = args[args.length - 1];
          const shape = args.find((a) => a && typeof a === "object" && !Array.isArray(a));
          const desc = typeof args[1] === "string" ? args[1] : "";
          if (typeof cb === "function" && shape && "cloudId" in shape) {
            const write = /^WRITE/.test(desc);
            args[args.length - 1] = async (a: any, ...rest: any[]) => {
              let warning: string | undefined;
              try {
                warning = await checkCloudId(runtime, a?.cloudId, write);
              } catch (err) {
                return errorResult(err);
              }
              const result = await cb(a, ...rest);
              if (warning && result && Array.isArray(result.content)) {
                result.content.push({ type: "text", text: `warning: ${warning}` });
              }
              return result;
            };
          }
          return (target.tool as any)(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
