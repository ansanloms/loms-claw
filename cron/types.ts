/**
 * cron ジョブの型定義と設定ファイルのロード。
 *
 * ワークスペースの .claude/cron.json から定期実行ジョブの定義を読み込む。
 *
 * @module
 */

import { join } from "jsr:@std/path@^1/join";
import { createLogger } from "../logger.ts";

const log = createLogger("cron");

/**
 * cron ジョブの定義。
 */
export interface CronJobDef {
  /** ジョブ名（一意）。Deno.cron の名前およびセッションキーに使用。 */
  name: string;
  /** cron 式（5フィールド、UTC）。 */
  schedule: string;
  /** Claude に送るプロンプト。 */
  prompt: string;
  /** 結果送信先の Discord チャンネル ID。 */
  channelId: string;
  /** ClaudeConfig.maxTurns のオーバーライド。 */
  maxTurns?: number;
  /** ClaudeConfig.timeout のオーバーライド（ミリ秒）。 */
  timeout?: number;
}

/**
 * 必須フィールドの一覧。
 */
const REQUIRED_FIELDS: (keyof CronJobDef)[] = [
  "name",
  "schedule",
  "prompt",
  "channelId",
];

/**
 * 単一のジョブ定義をバリデーションする。
 *
 * @param entry - パース済みの JSON オブジェクト。
 * @param index - 配列内のインデックス（エラーメッセージ用）。
 * @throws 必須フィールドの欠損や型不正の場合。
 */
function validateEntry(
  entry: Record<string, unknown>,
  index: number,
): CronJobDef {
  for (const field of REQUIRED_FIELDS) {
    if (typeof entry[field] !== "string" || (entry[field] as string) === "") {
      throw new Error(
        `cron job [${index}]: "${field}" is required and must be a non-empty string`,
      );
    }
  }

  if (entry.maxTurns !== undefined && typeof entry.maxTurns !== "number") {
    throw new Error(`cron job [${index}]: "maxTurns" must be a number`);
  }
  if (entry.timeout !== undefined && typeof entry.timeout !== "number") {
    throw new Error(`cron job [${index}]: "timeout" must be a number`);
  }

  return {
    name: entry.name as string,
    schedule: entry.schedule as string,
    prompt: entry.prompt as string,
    channelId: entry.channelId as string,
    maxTurns: entry.maxTurns as number | undefined,
    timeout: entry.timeout as number | undefined,
  };
}

/**
 * .claude/cron.json からジョブ定義を読み込む。
 *
 * ファイルが存在しない場合は空配列を返す。
 * バリデーションに失敗した場合はエラーを投げる。
 *
 * @param dir - ワークスペースディレクトリ（.claude/ の親）。
 * @returns バリデーション済みのジョブ定義配列。
 */
export async function loadCronJobs(dir: string): Promise<CronJobDef[]> {
  const path = join(dir, ".claude", "cron.json");

  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      log.info("cron.json not found, skipping");
      return [];
    }
    throw e;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("cron.json must be a JSON array");
  }

  const jobs: CronJobDef[] = [];
  const names = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`cron job [${i}]: must be an object`);
    }
    const job = validateEntry(entry as Record<string, unknown>, i);

    if (names.has(job.name)) {
      throw new Error(`cron job [${i}]: duplicate name "${job.name}"`);
    }
    names.add(job.name);
    jobs.push(job);
  }

  log.info(`loaded ${jobs.length} cron job(s) from ${path}`);
  return jobs;
}
