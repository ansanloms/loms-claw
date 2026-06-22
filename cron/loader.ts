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
import { type Schema, Validator } from "@cfworker/json-schema";
import { createLogger } from "../logger.ts";
import { parseCronExpression } from "./match.ts";
import type { CronJobDef } from "./types.ts";
import { EFFORT_LEVELS, type EffortLevel } from "../claude/mod.ts";
import { getErrorMessage } from "../errors.ts";

const log = createLogger("cron-loader");

/**
 * フロントマター用 JSON Schema が表す型。
 *
 * {@link matchesFrontMatter} の型ガードを通過すると、`as` キャスト不要で
 * 型安全にアクセスできる。
 */
interface CronFrontMatter {
  schedule: string;
  channelId?: string | number;
  maxTurns?: number;
  timeout?: number;
  resumeSession?: boolean;
  once?: boolean;
  model?: string;
  effort?: EffortLevel;
}

// フロントマターの構造検証スキーマ。cron 式の妥当性は @cfworker の拡張点が無いため
// schema には含めず、構造検証通過後に parseCronExpression で別途チェックする。
const frontMatterSchema: Schema = {
  type: "object",
  properties: {
    schedule: { type: "string", minLength: 1 },
    channelId: { oneOf: [{ type: "string" }, { type: "number" }] },
    maxTurns: { type: "number" },
    timeout: { type: "number" },
    resumeSession: { type: "boolean" },
    once: { type: "boolean" },
    model: { type: "string" },
    effort: {
      type: "string",
      enum: [...EFFORT_LEVELS],
    },
  },
  required: ["schedule"],
  additionalProperties: true,
};

// shortCircuit を false にして全エラーを収集する（ajv の allErrors: true 相当）。
const frontMatterValidator = new Validator(frontMatterSchema, "2020-12", false);

/**
 * meta がフロントマタースキーマに構造適合するかの型ガード。
 */
function matchesFrontMatter(
  meta: Record<string, unknown>,
): meta is Record<string, unknown> & CronFrontMatter {
  return frontMatterValidator.validate(meta).valid;
}

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

  if (matchesFrontMatter(meta)) {
    // 型ガード通過: meta は CronFrontMatter に narrowing 済み。
    // 構造は妥当なので、cron 式の妥当性と本文を別途検証する。
    const errors: string[] = [];

    try {
      parseCronExpression(meta.schedule);
    } catch (e) {
      errors.push(`invalid cron expression: ${getErrorMessage(e)}`);
    }

    if (!body) {
      errors.push("prompt body is empty");
    }

    if (errors.length > 0) {
      throw new Error(`${filename}: ${errors.join("; ")}`);
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

  // 構造検証に失敗: @cfworker のエラーを人間向けメッセージへマッピングする。
  const errors: string[] = [];

  for (const err of frontMatterValidator.validate(meta).errors) {
    const field = err.instanceLocation.replace(/^#\/?/, "");

    if (err.keyword === "required") {
      const prop = /required property "([^"]+)"/.exec(err.error)?.[1] ??
        "schedule";
      errors.push(`"${prop}" is required and must be a non-empty string`);
    } else if (err.keyword === "minLength" && field === "schedule") {
      errors.push('"schedule" is required and must be a non-empty string');
    } else if (err.keyword === "type") {
      // oneOf 配下の type エラーは親の oneOf エラーで処理するためスキップ
      if (field === "channelId") {
        continue;
      }
      const expected = /Expected "([^"]+)"/.exec(err.error)?.[1] ?? "value";
      errors.push(`"${field}" must be a ${expected}`);
    } else if (err.keyword === "oneOf" && field === "channelId") {
      errors.push('"channelId" must be a string or number');
    } else if (err.keyword === "enum") {
      errors.push(`"${field}" must be one of the allowed values`);
    } else {
      errors.push(err.error);
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
          getErrorMessage(e),
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
