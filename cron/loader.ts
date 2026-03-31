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
import { createLogger } from "../logger.ts";
import { parseCronExpression } from "./match.ts";
import type { CronJobDef } from "./types.ts";

const log = createLogger("cron-loader");

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
  const errors: string[] = [];

  // 必須 string フィールド
  if (typeof meta.schedule !== "string" || (meta.schedule as string) === "") {
    errors.push('"schedule" is required and must be a non-empty string');
  }

  // channelId はオプション。指定時は数値でも文字列でも許容
  if (
    meta.channelId !== undefined && meta.channelId !== null &&
    typeof meta.channelId !== "string" && typeof meta.channelId !== "number"
  ) {
    errors.push('"channelId" must be a string or number');
  }

  // オプション number
  if (meta.maxTurns !== undefined && typeof meta.maxTurns !== "number") {
    errors.push('"maxTurns" must be a number');
  }
  if (meta.timeout !== undefined && typeof meta.timeout !== "number") {
    errors.push('"timeout" must be a number');
  }
  if (
    meta.resumeSession !== undefined && typeof meta.resumeSession !== "boolean"
  ) {
    errors.push('"resumeSession" must be a boolean');
  }

  // プロンプト（本文）が空でないこと
  if (!body) {
    errors.push("prompt body is empty");
  }

  // cron 式のバリデーション
  if (typeof meta.schedule === "string" && meta.schedule !== "") {
    try {
      parseCronExpression(meta.schedule as string);
    } catch (e) {
      errors.push(
        `invalid cron expression: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`${filename}: ${errors.join("; ")}`);
  }

  return {
    name,
    schedule: meta.schedule as string,
    prompt: body,
    channelId: meta.channelId != null ? String(meta.channelId) : undefined,
    maxTurns: meta.maxTurns as number | undefined,
    timeout: meta.timeout as number | undefined,
    resumeSession: (meta.resumeSession as boolean | undefined) ?? false,
  };
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
