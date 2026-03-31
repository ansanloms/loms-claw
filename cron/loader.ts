/**
 * cron ジョブファイルの読み込みとバリデーション。
 *
 * `.claude/cron/` 配下の Markdown ファイルを走査し、
 * YAML フロントマターからメタデータ、本文からプロンプトを抽出する。
 *
 * @module
 */

import { join } from "jsr:@std/path@^1/join";
import { parse as parseYaml } from "@std/yaml";
import { createLogger } from "../logger.ts";
import { parseCronExpression } from "./match.ts";
import type { CronJobDef } from "./types.ts";

const log = createLogger("cron-loader");

/**
 * フロントマターのパース結果。
 */
export interface FrontmatterResult {
  /** YAML パース済みのメタデータ。 */
  meta: Record<string, unknown>;
  /** フロントマター後の本文。 */
  body: string;
}

/**
 * Markdown 文字列から YAML フロントマターと本文を分離する。
 *
 * フォーマット:
 * ```
 * ---
 * key: value
 * ---
 * 本文
 * ```
 *
 * @throws フロントマターの区切りが見つからない場合。
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    throw new Error("frontmatter opening delimiter '---' not found");
  }

  // 閉じ区切り: "\n---\n" または "\n---" + EOF
  const closingPattern = /\n---(?:\n|$)/;
  const match = closingPattern.exec(trimmed.slice(3));
  if (!match) {
    throw new Error("frontmatter closing delimiter '---' not found");
  }
  const endIdx = 3 + match.index;

  const yamlStr = trimmed.slice(3, endIdx).trim();
  const meta = parseYaml(yamlStr);

  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new Error("frontmatter must be a YAML mapping");
  }

  const bodyStart = endIdx + match[0].length;
  const body = trimmed.slice(bodyStart).trim();

  return { meta: meta as Record<string, unknown>, body };
}

/**
 * パース済みのフロントマターと本文を CronJobDef にバリデーションする。
 *
 * @param meta - YAML フロントマターのオブジェクト。
 * @param body - Markdown 本文（プロンプト）。
 * @param filename - エラーメッセージ用のファイル名。
 * @throws バリデーションエラー時。
 */
export function validateCronJob(
  meta: Record<string, unknown>,
  body: string,
  filename: string,
): CronJobDef {
  const errors: string[] = [];

  // 必須 string フィールド
  for (const field of ["name", "schedule"] as const) {
    if (typeof meta[field] !== "string" || (meta[field] as string) === "") {
      errors.push(`"${field}" is required and must be a non-empty string`);
    }
  }

  // channelId は数値でも文字列でも許容（YAML で引用符なしだと number になる）
  if (
    meta.channelId === undefined || meta.channelId === null ||
    String(meta.channelId) === ""
  ) {
    errors.push('"channelId" is required');
  }

  // オプション string
  if (
    meta.description !== undefined && typeof meta.description !== "string"
  ) {
    errors.push('"description" must be a string');
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
    name: meta.name as string,
    description: meta.description as string | undefined,
    schedule: meta.schedule as string,
    prompt: body,
    channelId: String(meta.channelId),
    maxTurns: meta.maxTurns as number | undefined,
    timeout: meta.timeout as number | undefined,
    resumeSession: (meta.resumeSession as boolean | undefined) ?? false,
  };
}

/**
 * `.claude/cron/` ディレクトリから全ジョブ定義を読み込む。
 *
 * ディレクトリが存在しない場合は空配列を返す。
 *
 * @param workspaceDir - ワークスペースのルートディレクトリ。
 * @returns バリデーション済みのジョブ定義配列。
 */
export async function loadCronJobsFromDir(
  workspaceDir: string,
): Promise<CronJobDef[]> {
  const cronDir = join(workspaceDir, ".claude", "cron");

  const jobs: CronJobDef[] = [];
  const names = new Set<string>();

  try {
    for await (const entry of Deno.readDir(cronDir)) {
      if (!entry.isFile || !entry.name.endsWith(".md")) {
        continue;
      }

      const filePath = join(cronDir, entry.name);

      try {
        const raw = await Deno.readTextFile(filePath);
        const { meta, body } = parseFrontmatter(raw);
        const job = validateCronJob(meta, body, entry.name);

        if (names.has(job.name)) {
          log.warn(`duplicate cron job name "${job.name}" in ${entry.name}`);
          continue;
        }

        names.add(job.name);
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
