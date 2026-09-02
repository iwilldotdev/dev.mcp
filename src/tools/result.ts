import { errorMessage } from "../errors.js";

export function jsonResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: stringify(data) }],
  };
}

export function errorResult(err: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: errorMessage(err) }],
  };
}

export function wrapTool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return jsonResult(await fn(args));
    } catch (err) {
      return errorResult(err);
    }
  };
}

function stringify(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}
