/**
 * cron ジョブファイルの読み込みとバリデーション。
 *
 * `cron/` 配下の Markdown ファイルを走査し、
 * YAML フロントマターからメタデータ、本文からプロンプトを抽出する。
 *
 * @module
 */

import { join } from "jsr:@std/path@^1/join";
import { extract } from "@std/front-matter/yaml";
import Ajv from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { createLogger } from "../logger.ts";
import { parseCronExpression } from "./match.ts";
import type { CronJobDef } from "./types.ts";

const log = createLogger("cron-loader");

/**
 * フロントマター用 JSON Schema。
 *
 * ajv の `compile()` で型ガード関数を生成し、
 * バリデーション通過後は `as` キャスト不要で型安全にアクセスできる。
 */
interface CronFrontMatter {
  schedule: string;
  channelId?: string | number;
  maxTurns?: number;
  timeout?: number;
  resumeSession?: boolean;
  once?: boolean;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

// deno の npm 互換レイヤーでは CJS default export のコンストラクタ型が解決できない
// @ts-expect-error: Ajv CJS default export
const ajv = new Ajv({ allErrors: true });

const cronExpressionValidate = Object.assign(
  (_schema: boolean, data: string): boolean => {
    try {
      parseCronExpression(data);
      return true;
    } catch (e) {
      cronExpressionValidate.errors = [{
        keyword: "cronExpression",
        instancePath: "",
        schemaPath: "#/cronExpression",
        message: `invalid cron expression: ${
          e instanceof Error ? e.message : String(e)
        }`,
        params: { value: data },
      }];
      return false;
    }
  },
  { errors: [] as ErrorObject[] },
);

ajv.addKeyword({
  keyword: "cronExpression",
  type: "string",
  validate: cronExpressionValidate,
  errors: true,
});

const validateFrontMatter: ValidateFunction<CronFrontMatter> = ajv.compile<
  CronFrontMatter
>({
  type: "object",
  properties: {
    schedule: { type: "string", minLength: 1, cronExpression: true },
    channelId: { oneOf: [{ type: "string" }, { type: "number" }] },
    maxTurns: { type: "number" },
    timeout: { type: "number" },
    resumeSession: { type: "boolean" },
    once: { type: "boolean" },
    model: { type: "string" },
    effort: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh", "max"],
    },
  },
  required: ["schedule"],
  additionalProperties: true,
});

/**
 * パース済みのフロントマターと本文を CronJobDef にバリデーションする。
 *
 * @param meta - YAML フロントマターのオブジェクト。
 * @param body - Markdown 本文（プロンプト）。
 * @param filename - ジョブ名の決定とエラーメッセージに使うファイル名。
 * @throws バリデーションエラー時。
 */
export function validateCronJob(
  meta: Record<string, unknown>,
  body: string,
  filename: string,
): CronJobDef {
  const name = filename.replace(/\.md$/, "");

  if (validateFrontMatter(meta)) {
    // 型ガード通過: meta は CronFrontMatter に narrowing 済み
    if (!body) {
      throw new Error(`${filename}: prompt body is empty`);
    }

    return {
      name,
      schedule: meta.schedule,
      prompt: body,
      channelId: meta.channelId != null ? String(meta.channelId) : undefined,
      maxTurns: meta.maxTurns,
      timeout: meta.timeout,
      resumeSession: meta.resumeSession ?? false,
      once: meta.once ?? false,
      model: meta.model,
      effort: meta.effort,
    };
  }

  // バリデーション失敗: エラーメッセージを収集
  const errors: string[] = [];

  for (const err of validateFrontMatter.errors ?? []) {
    if (err.keyword === "cronExpression") {
      errors.push(err.message ?? "invalid cron expression");
    } else if (err.keyword === "required") {
      errors.push(
        `"${err.params.missingProperty}" is required and must be a non-empty string`,
      );
    } else if (
      err.keyword === "minLength" && err.instancePath === "/schedule"
    ) {
      errors.push('"schedule" is required and must be a non-empty string');
    } else if (err.keyword === "type") {
      const field = err.instancePath.slice(1);
      // oneOf 配下の type エラーは親の oneOf エラーで処理するためスキップ
      if (field === "channelId") {
        continue;
      }
      const expected = err.params.type;
      errors.push(`"${field}" must be a ${expected}`);
    } else if (err.keyword === "oneOf" && err.instancePath === "/channelId") {
      errors.push('"channelId" must be a string or number');
    } else {
      errors.push(err.message ?? "validation error");
    }
  }

  if (!body) {
    errors.push("prompt body is empty");
  }

  throw new Error(`${filename}: ${errors.join("; ")}`);
}

/**
 * `cron/` ディレクトリから全ジョブ定義を読み込む。
 *
 * ディレクトリが存在しない場合は空配列を返す。
 *
 * @param workspaceDir - ワークスペースのルートディレクトリ。
 * @returns バリデーション済みのジョブ定義配列。
 */
export async function loadCronJobsFromDir(
  workspaceDir: string,
): Promise<CronJobDef[]> {
  const cronDir = join(workspaceDir, "cron");

  const jobs: CronJobDef[] = [];

  try {
    for await (const entry of Deno.readDir(cronDir)) {
      if (!entry.isFile || !entry.name.endsWith(".md")) {
        continue;
      }

      const filePath = join(cronDir, entry.name);

      try {
        const raw = await Deno.readTextFile(filePath);
        const { attrs, body } = extract<Record<string, unknown>>(raw);
        const job = validateCronJob(attrs, body.trim(), entry.name);
        jobs.push(job);
      } catch (e) {
        log.error(
          `failed to load cron job ${entry.name}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      log.info("cron directory not found, skipping");
      return [];
    }
    throw e;
  }

  log.info(`loaded ${jobs.length} cron job(s) from ${cronDir}`);
  return jobs;
}
