/**
 * cron ジョブ管理 API ハンドラ。
 *
 * `.claude/cron/` 配下の Markdown ファイルの CRUD 操作と
 * ジョブのリロードを HTTP エンドポイントとして提供する。
 */

import { join } from "jsr:@std/path@^1/join";
import { createLogger } from "../logger.ts";
import {
  loadCronJobsFromDir,
  parseFrontmatter,
  validateCronJob,
} from "../cron/loader.ts";

const log = createLogger("api-cron");

/**
 * cron API のコンテキスト。
 */
export interface CronApiContext {
  /** .claude/cron/ ディレクトリのパス。 */
  cronDir: string;
  /** ワークスペースのルートディレクトリ。 */
  workspaceDir: string;
  /** ジョブリロードのコールバック。 */
  reloadJobs: () => Promise<void>;
}

/**
 * JSON 成功レスポンスを生成する。
 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * JSON エラーレスポンスを生成する。
 */
function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /cron/jobs — 全ジョブ一覧（メタデータのみ）。
 */
export async function listCronJobs(
  _req: Request,
  ctx: CronApiContext,
): Promise<Response> {
  const jobs = await loadCronJobsFromDir(ctx.workspaceDir);
  const list = jobs.map((j) => ({
    name: j.name,
    description: j.description,
    schedule: j.schedule,
    channelId: j.channelId,
    maxTurns: j.maxTurns,
    timeout: j.timeout,
  }));
  return jsonResponse(list);
}

/**
 * GET /cron/jobs/:name — 特定ジョブの詳細（全文含む）。
 */
export async function getCronJob(
  _req: Request,
  ctx: CronApiContext,
  params: Record<string, string>,
): Promise<Response> {
  const filePath = join(ctx.cronDir, `${params.name}.md`);

  try {
    const raw = await Deno.readTextFile(filePath);
    const { meta, body } = parseFrontmatter(raw);
    return jsonResponse({
      ...meta,
      prompt: body,
      _raw: raw,
    });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return errorResponse(`cron job "${params.name}" not found`, 404);
    }
    throw e;
  }
}

/**
 * PUT /cron/jobs/:name — ジョブの作成/更新。
 *
 * リクエストボディは raw Markdown（Content-Type: text/markdown）。
 * フロントマターの name と URL パラメータの :name が一致する必要がある。
 */
export async function putCronJob(
  req: Request,
  ctx: CronApiContext,
  params: Record<string, string>,
): Promise<Response> {
  const rawBody = await req.text();
  if (!rawBody.trim()) {
    return errorResponse("request body is empty", 400);
  }

  // バリデーション
  let meta: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(rawBody);
    meta = parsed.meta;
    body = parsed.body;
  } catch (e) {
    return errorResponse(
      `invalid frontmatter: ${e instanceof Error ? e.message : String(e)}`,
      400,
    );
  }

  try {
    validateCronJob(meta, body, `${params.name}.md`);
  } catch (e) {
    return errorResponse(
      e instanceof Error ? e.message : String(e),
      400,
    );
  }

  // name の一致チェック
  if (meta.name !== params.name) {
    return errorResponse(
      `frontmatter name "${meta.name}" does not match URL parameter "${params.name}"`,
      400,
    );
  }

  // ファイル書き込み
  await Deno.mkdir(ctx.cronDir, { recursive: true });
  const filePath = join(ctx.cronDir, `${params.name}.md`);
  await Deno.writeTextFile(filePath, rawBody);

  log.info(`cron job "${params.name}" saved`);

  // リロード
  await ctx.reloadJobs();

  return jsonResponse({
    name: meta.name,
    description: meta.description,
    schedule: meta.schedule,
    channelId: String(meta.channelId),
  });
}

/**
 * DELETE /cron/jobs/:name — ジョブの削除。
 */
export async function deleteCronJob(
  _req: Request,
  ctx: CronApiContext,
  params: Record<string, string>,
): Promise<Response> {
  const filePath = join(ctx.cronDir, `${params.name}.md`);

  try {
    await Deno.remove(filePath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return errorResponse(`cron job "${params.name}" not found`, 404);
    }
    throw e;
  }

  log.info(`cron job "${params.name}" deleted`);

  // リロード
  await ctx.reloadJobs();

  return jsonResponse({ deleted: params.name });
}

/**
 * POST /cron/reload — 全ジョブをディスクからリロード。
 */
export async function reloadCronJobs(
  _req: Request,
  ctx: CronApiContext,
): Promise<Response> {
  await ctx.reloadJobs();

  const jobs = await loadCronJobsFromDir(ctx.workspaceDir);
  const list = jobs.map((j) => ({
    name: j.name,
    description: j.description,
    schedule: j.schedule,
    channelId: j.channelId,
  }));

  return jsonResponse({ reloaded: list.length, jobs: list });
}

/**
 * cron API のルート定義。
 */
export const cronRoutes: {
  pattern: URLPattern;
  method: string;
  handler: (
    req: Request,
    ctx: CronApiContext,
    params: Record<string, string>,
  ) => Promise<Response>;
}[] = [
  {
    pattern: new URLPattern({ pathname: "/cron/jobs" }),
    method: "GET",
    handler: (req, ctx) => listCronJobs(req, ctx),
  },
  {
    pattern: new URLPattern({ pathname: "/cron/jobs/:name" }),
    method: "GET",
    handler: (req, ctx, params) => getCronJob(req, ctx, params),
  },
  {
    pattern: new URLPattern({ pathname: "/cron/jobs/:name" }),
    method: "PUT",
    handler: (req, ctx, params) => putCronJob(req, ctx, params),
  },
  {
    pattern: new URLPattern({ pathname: "/cron/jobs/:name" }),
    method: "DELETE",
    handler: (req, ctx, params) => deleteCronJob(req, ctx, params),
  },
  {
    pattern: new URLPattern({ pathname: "/cron/reload" }),
    method: "POST",
    handler: (req, ctx) => reloadCronJobs(req, ctx),
  },
];
