import { z } from "zod";
import { saveToShape } from "./result.js";
import { sumJob, sumJobs, sumPipeline } from "./summaries.js";
import {
  type A,
  type Ctx,
  PAGE,
  PROJ_ID,
  aliasRead,
  dual,
  need,
  pageDesc,
  pageQuery,
  pageResult,
  pick,
  posInt,
  proj,
  readTool,
  sumList,
  writeTool,
  parityWriteTool,
} from "./gitlab-common.js";

const PIPELINE_INCLUDES = ["jobs", "downstream_pipelines", "bridge_jobs", "artifacts"] as const;

function sliceBytes(text: string, offset = 0, limit?: number) {
  const buf = Buffer.from(text, "utf8");
  const start = offset < 0 ? Math.max(0, buf.length + offset) : Math.min(offset, buf.length);
  const end = limit === undefined ? buf.length : Math.min(buf.length, start + limit);
  return { content: buf.subarray(start, end).toString("utf8"), offset: start, bytes: end - start, total_bytes: buf.length, truncated: end < buf.length };
}

export function registerGitLabCi(c: Ctx): void {
  const { gl } = c;

  readTool(
    c,
    "gitlab_list_pipelines",
    pageDesc("Lists pipelines (GET /projects/:id/pipelines). Without first/after it returns a plain array (legacy)."),
    dual({
      ...PROJ_ID,
      ref: z.string().optional(),
      status: z.string().optional(),
      sha: z.string().optional(),
      source: z.string().optional(),
      username: z.string().optional(),
      order_by: z.enum(["id", "status", "ref", "updated_at", "user_id"]).optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      ...PAGE,
      per_page: z.number().int().min(1).max(100).optional().describe("Deprecated: use first."),
      page: z.number().int().min(1).optional().describe("Deprecated: use after."),
    }),
    sumList(["id", "status", "ref", "web_url"]),
    async (a) =>
      pageResult(
        a,
        await gl.request(`projects/${proj(a)}/pipelines`, {
          query: {
            ref: a.ref,
            status: a.status,
            sha: a.sha,
            source: a.source,
            username: a.username,
            order_by: a.order_by,
            sort: a.sort,
            ...pageQuery(a),
          },
        }),
        true,
      ),
  );

  const getPipeline = async (a: A): Promise<unknown> => {
    const base = `projects/${proj(a)}/pipelines/${need(a.pipeline_id, "pipeline_id (legacy: pipelineId)")}`;
    const pipeline = await gl.request(base);
    const inc = new Set<string>(a.include ?? []);
    if (!inc.size) return pipeline;
    const out: Record<string, unknown> = { pipeline };
    const needJobs = inc.has("jobs") || inc.has("artifacts");
    const needBridges = inc.has("bridge_jobs") || inc.has("downstream_pipelines");
    const [jobs, bridges] = await Promise.all([
      needJobs ? gl.request<any[]>(`${base}/jobs`) : undefined,
      needBridges ? gl.request<any[]>(`${base}/bridges`) : undefined,
    ]);
    if (inc.has("jobs")) out.jobs = jobs;
    if (inc.has("bridge_jobs")) out.bridge_jobs = bridges;
    if (inc.has("downstream_pipelines")) {
      out.downstream_pipelines = (bridges ?? []).map((b) => b?.downstream_pipeline).filter(Boolean);
    }
    if (inc.has("artifacts")) {
      out.artifacts = (jobs ?? [])
        .filter((j) => Array.isArray(j?.artifacts) && j.artifacts.length > 0)
        .map((j) => ({ job_id: j.id, job_name: j.name, artifacts_expire_at: j.artifacts_expire_at, artifacts: j.artifacts }));
    }
    return out;
  };
  readTool(
    c,
    "gitlab_get_pipeline",
    "Gets a pipeline (GET /projects/:id/pipelines/:pipeline_id). include adds extra keys next to pipeline: jobs (GET …/jobs), bridge_jobs (GET …/bridges), downstream_pipelines (the downstream pipeline of each bridge job) and artifacts (artifact files of the jobs).",
    dual({ ...PROJ_ID, pipeline_id: posInt.optional(), include: z.array(z.enum(PIPELINE_INCLUDES)).optional() }),
    (p) => ({
      ...sumPipeline(p?.pipeline ?? p),
      ...(Array.isArray(p?.jobs) ? { jobs_count: p.jobs.length } : {}),
      ...(Array.isArray(p?.bridge_jobs) ? { bridge_jobs_count: p.bridge_jobs.length } : {}),
      ...(Array.isArray(p?.downstream_pipelines) ? { downstream_pipelines_count: p.downstream_pipelines.length } : {}),
    }),
    getPipeline,
  );
  aliasRead(
    c,
    "gitlab_get_pipeline with include: [\"jobs\"]",
    "gitlab_get_pipeline_jobs",
    { ...saveToShape, projectId: z.string().describe("Numeric ID or path with namespace, e.g. group/project."), pipelineId: posInt },
    sumJobs,
    async (a) => gl.request(`projects/${proj(a)}/pipelines/${a.pipeline_id}/jobs`),
  );

  readTool(
    c,
    "gitlab_get_job",
    "Gets a job (GET /projects/:id/jobs/:job_id). include: log adds the job log (GET …/trace), sliced by bytes with offset (negative = from the end) and limit; artifacts adds the job's artifact list. With include the result is {job, log?, artifacts?}; without it, the job object.",
    dual({
      ...PROJ_ID,
      job_id: posInt.optional(),
      include: z.array(z.enum(["log", "artifacts"])).optional(),
      offset: z.number().int().optional().describe("Log byte offset; negative counts from the end (tail)."),
      limit: z.number().int().min(1).optional().describe("Max log bytes to return."),
    }),
    (p) => ({
      ...sumJob(p?.job ?? p),
      ...(p?.log ? { log_bytes: p.log.bytes, log_total_bytes: p.log.total_bytes, log_truncated: p.log.truncated } : {}),
    }),
    async (a) => {
      const base = `projects/${proj(a)}/jobs/${need(a.job_id, "job_id (legacy: jobId)")}`;
      const job = await gl.request<A>(base);
      const inc: string[] = a.include ?? [];
      if (!inc.length) return job;
      const out: Record<string, unknown> = { job };
      if (inc.includes("log")) {
        const raw = await gl.request<unknown>(`${base}/trace`);
        out.log = sliceBytes(typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw), a.offset, a.limit);
      }
      if (inc.includes("artifacts")) {
        out.artifacts = { file: job.artifacts_file ?? null, expire_at: job.artifacts_expire_at ?? null, files: job.artifacts ?? [] };
      }
      return out;
    },
  );

  readTool(
    c,
    "gitlab_get_artifact_file",
    "Reads one file from a job's artifacts (GET /projects/:id/jobs/:job_id/artifacts/*artifact_path). Returns {job_id, artifact_path, content} as text; binary files are not supported.",
    { ...PROJ_ID, job_id: posInt, artifact_path: z.string().describe("Path inside the artifacts archive.") },
    (p) => pick(p, ["job_id", "artifact_path"]),
    async (a) => {
      const path = need(a.artifact_path, "artifact_path").split("/").map(encodeURIComponent).join("/");
      const content = await gl.request<unknown>(`projects/${proj(a)}/jobs/${need(a.job_id, "job_id")}/artifacts/${path}`);
      return {
        job_id: a.job_id,
        artifact_path: a.artifact_path,
        content: typeof content === "string" ? content : JSON.stringify(content),
      };
    },
  );

  parityWriteTool(
    c,
    "gitlab_save_pipeline",
    "Pipeline actions, chosen by action: create (POST /projects/:id/pipeline with ref and optional variables; starts a pipeline), retry (POST …/pipelines/:id/retry; reruns failed jobs), cancel (POST …/pipelines/:id/cancel; cancels running jobs), update (PUT …/pipelines/:id/metadata; renames it with name), mr_pipeline (POST …/merge_requests/:iid/pipelines; creates a merge request pipeline).",
    {
      ...PROJ_ID,
      action: z.enum(["create", "retry", "cancel", "update", "mr_pipeline"]),
      ref: z.string().optional().describe("create: branch or tag."),
      variables: z
        .array(z.object({ key: z.string(), value: z.string(), variable_type: z.enum(["env_var", "file"]).optional() }))
        .optional()
        .describe("create: pipeline variables."),
      pipeline_id: posInt.optional().describe("retry, cancel, update."),
      name: z.string().optional().describe("update: new pipeline name."),
      merge_request_iid: posInt.optional().describe("mr_pipeline."),
    },
    async (a) => {
      const p = proj(a);
      switch (a.action) {
        case "create":
          return gl.request(`projects/${p}/pipeline`, {
            method: "POST",
            body: { ref: need(a.ref, "ref"), variables: a.variables },
          });
        case "retry":
        case "cancel":
          return gl.request(`projects/${p}/pipelines/${need(a.pipeline_id, "pipeline_id")}/${a.action}`, { method: "POST" });
        case "update":
          return gl.request(`projects/${p}/pipelines/${need(a.pipeline_id, "pipeline_id")}/metadata`, {
            method: "PUT",
            body: { name: need(a.name, "name") },
          });
        case "mr_pipeline":
          return gl.request(`projects/${p}/merge_requests/${need(a.merge_request_iid, "merge_request_iid")}/pipelines`, {
            method: "POST",
          });
        default:
          throw new Error(`Unsupported action: ${a.action}`);
      }
    },
  );

  parityWriteTool(
    c,
    "gitlab_save_pipeline_job",
    "Job action (action: play): starts a manual job (POST /projects/:id/jobs/:job_id/play) with optional job_variables_attributes. It runs the job.",
    {
      ...PROJ_ID,
      job_id: posInt,
      action: z.enum(["play"]).optional().describe("Default and only value: play."),
      job_variables_attributes: z
        .array(z.object({ key: z.string(), value: z.string() }))
        .optional()
        .describe("Variables for this run."),
    },
    async (a) =>
      gl.request(`projects/${proj(a)}/jobs/${a.job_id}/play`, {
        method: "POST",
        body: a.job_variables_attributes ? { job_variables_attributes: a.job_variables_attributes } : undefined,
      }),
  );

  readTool(
    c,
    "gitlab_list_pipeline_schedules",
    pageDesc("Lists pipeline schedules (GET /projects/:id/pipeline_schedules)."),
    { ...PROJ_ID, scope: z.enum(["active", "inactive"]).optional(), ...PAGE },
    sumList(["id", "description", "ref", "cron", "active"]),
    async (a) =>
      pageResult(a, await gl.request(`projects/${proj(a)}/pipeline_schedules`, { query: { scope: a.scope, ...pageQuery(a) } })),
  );
}
