import { cacheKey, type MemoryCache } from "../cache.js";
import type { FigmaConfig } from "../config.js";
import { inspectImage, type ImageInspection } from "../figma/image.js";
import type { HttpClient } from "../http.js";
import { withQuery } from "../http.js";

export type FigmaFileResponse = {
  name: string;
  lastModified?: string;
  version?: string;
  document?: unknown;
  components?: Record<string, { key?: string; name?: string; componentSetId?: string }>;
  componentSets?: Record<string, { key?: string; name?: string }>;
  styles?: Record<string, { key?: string; name?: string; styleType?: string }>;
  [key: string]: unknown;
};

export type FigmaNodesResponse = {
  name?: string;
  lastModified?: string;
  nodes: Record<
    string,
    {
      document?: unknown;
      components?: Record<string, { key?: string; name?: string; componentSetId?: string }>;
      componentSets?: Record<string, { key?: string; name?: string }>;
      styles?: Record<string, { key?: string; name?: string; styleType?: string }>;
      err?: string;
    } | null
  >;
  [key: string]: unknown;
};

export type FigmaImagesResponse = {
  err?: string | null;
  images: Record<string, string | null>;
  [key: string]: unknown;
};

export class FigmaClient {
  constructor(
    private readonly config: FigmaConfig,
    private readonly http: HttpClient,
    private readonly cache: MemoryCache,
  ) {}

  private headers(): HeadersInit {
    return {
      "X-Figma-Token": this.config.accessToken,
      Accept: "application/json",
    };
  }

  private cached<T>(key: string, factory: () => Promise<T>): Promise<T> {
    return this.cache.getOrSet(key, this.config.cacheTtlMs, factory);
  }

  async me(): Promise<unknown> {
    return this.http.json(`${this.config.apiBase}/v1/me`, {
      headers: this.headers(),
    });
  }

  async getFile(
    fileKey: string,
    params: {
      depth?: number;
      ids?: string[];
      geometry?: string;
      plugin_data?: string;
    } = {},
  ): Promise<FigmaFileResponse> {
    const url = withQuery(`${this.config.apiBase}/v1/files/${fileKey}`, {
      depth: params.depth,
      ids: params.ids?.join(","),
      geometry: params.geometry,
      plugin_data: params.plugin_data,
    });
    return this.cached(cacheKey(["figma", "file", url]), () =>
      this.http.json<FigmaFileResponse>(url, { headers: this.headers() }),
    );
  }

  async getNodes(
    fileKey: string,
    ids: string[],
    params: { depth?: number; geometry?: string } = {},
  ): Promise<FigmaNodesResponse> {
    const url = withQuery(`${this.config.apiBase}/v1/files/${fileKey}/nodes`, {
      ids: ids.join(","),
      depth: params.depth,
      geometry: params.geometry,
    });
    return this.cached(cacheKey(["figma", "nodes", url]), () =>
      this.http.json<FigmaNodesResponse>(url, { headers: this.headers() }),
    );
  }

  async getImages(
    fileKey: string,
    ids: string[],
    params: {
      format?: "jpg" | "png" | "svg" | "pdf";
      scale?: number;
      svg_outline_text?: boolean;
      svg_include_id?: boolean;
      svg_simplify_stroke?: boolean;
    } = {},
  ): Promise<FigmaImagesResponse> {
    const url = withQuery(`${this.config.apiBase}/v1/images/${fileKey}`, {
      ids: ids.join(","),
      format: params.format ?? "png",
      scale: params.scale,
      svg_outline_text: params.svg_outline_text,
      svg_include_id: params.svg_include_id,
      svg_simplify_stroke: params.svg_simplify_stroke,
    });
    return this.cached(cacheKey(["figma", "images", url]), () =>
      this.http.json<FigmaImagesResponse>(url, { headers: this.headers() }),
    );
  }

  async fetchImage(url: string): Promise<ImageInspection & { data: Buffer }> {
    const downloaded = await this.http.bytes(url);
    return { ...inspectImage(downloaded.data, downloaded.mime), data: downloaded.data };
  }

  async getImageFills(fileKey: string): Promise<unknown> {
    const url = `${this.config.apiBase}/v1/files/${fileKey}/images`;
    return this.cached(cacheKey(["figma", "image-fills", url]), () =>
      this.http.json(url, { headers: this.headers() }),
    );
  }

  async getLocalVariables(fileKey: string): Promise<unknown> {
    const url = `${this.config.apiBase}/v1/files/${fileKey}/variables/local`;
    return this.cached(cacheKey(["figma", "variables-local", url]), () =>
      this.http.json(url, { headers: this.headers() }),
    );
  }

  async getPublishedVariables(fileKey: string): Promise<unknown> {
    const url = `${this.config.apiBase}/v1/files/${fileKey}/variables/published`;
    return this.cached(cacheKey(["figma", "variables-published", url]), () =>
      this.http.json(url, { headers: this.headers() }),
    );
  }

  async getComments(fileKey: string): Promise<unknown> {
    return this.http.json(`${this.config.apiBase}/v1/files/${fileKey}/comments`, {
      headers: this.headers(),
    });
  }
}
