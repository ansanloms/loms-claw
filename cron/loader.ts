/**
 * cron ジョブファイルの読み込みとバリデーション。
 *
 * `cron/` 配下の Markdown ファイル（prompt ジョブ）と YAML ファイル（command ジョブ）を走査する。
 * Markdown は YAML フロントマターからメタデータ、本文からプロンプトを抽出する。
 * YAML は全体をメタデータとして扱う。
 *
 * @module
 */

import { join } from "@std/path/join";
import { extract } from "@std/front-matter/yaml";
import { parse as parseYaml } from "@std/yaml";
import { type OutputUnit, type Schema, Validator } from "@cfworker/json-schema";
import { createLogger } from "../logger.ts";
import { parseCronExpression } from "./match.ts";
import type { CronCommandJob, CronJobDef, CronPromptJob } from "./types.ts";
import { EFFORT_LEVELS, type EffortLevel } from "../claude/mod.ts";
import { getErrorMessage } from "../errors.ts";
import { isRecord } from "../guards.ts";

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
    timeout: { type: "number", exclusiveMinimum: 0 },
    resumeSession: { type: "boolean" },
    once: { type: "boolean" },
    model: { type: "string" },
    effort: {
      type: "string",
      enum: [...EFFORT_LEVELS],
    },
  },
  required: ["schedule"],
  additionalProperties: false,
};

// frontMatterSchema.properties に宣言済みのフィールド名。additionalProperties エラーが
// 本当に未知キーによるものかどうかの判定に使う（既知フィールドの型違いとの区別）。
const KNOWN_FRONT_MATTER_FIELDS = new Set(
  Object.keys(frontMatterSchema.properties ?? {}),
);

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
 * command ジョブ用 JSON Schema が表す型。
 *
 * {@link matchesCommandSchema} の型ガードを通過すると、`as` キャスト不要で
 * 型安全にアクセスできる。
 */
interface CronCommandFrontMatter {
  schedule: string;
  command: string;
  channelId?: string | number;
  timeout?: number;
  once?: boolean;
}

// command ジョブ (`cron/*.yaml`) の構造検証スキーマ。
const commandSchema: Schema = {
  type: "object",
  properties: {
    schedule: { type: "string", minLength: 1 },
    command: { type: "string", minLength: 1 },
    channelId: { oneOf: [{ type: "string" }, { type: "number" }] },
    timeout: { type: "number", exclusiveMinimum: 0 },
    once: { type: "boolean" },
  },
  required: ["schedule", "command"],
  additionalProperties: false,
};

// commandSchema.properties に宣言済みのフィールド名。frontMatterSchema と同じ判定に使う。
const KNOWN_COMMAND_FIELDS = new Set(
  Object.keys(commandSchema.properties ?? {}),
);

const commandValidator = new Validator(commandSchema, "2020-12", false);

/**
 * meta が command スキーマに構造適合するかの型ガード。
 */
function matchesCommandSchema(
  meta: Record<string, unknown>,
): meta is Record<string, unknown> & CronCommandFrontMatter {
  return commandValidator.validate(meta).valid;
}

/**
 * @cfworker のバリデーションエラーを人間向けメッセージへ変換する。
 *
 * frontMatterSchema / commandSchema の両方で共通に使う。
 *
 * @param errors - `Validator.validate()` が返す `errors`。
 * @param knownFields - 対象スキーマの `properties` に宣言済みのフィールド名。
 *   additionalProperties エラーが本当に未知キーによるものかどうかの判定に使う
 *   （既知フィールドの型違いとの区別）。
 */
function formatSchemaErrors(
  errors: OutputUnit[],
  knownFields: Set<string>,
): string[] {
  const messages: string[] = [];

  for (const err of errors) {
    const field = err.instanceLocation.replace(/^#\/?/, "");

    if (err.keyword === "required") {
      const prop = /required property "([^"]+)"/.exec(err.error)?.[1] ??
        "schedule";
      messages.push(`"${prop}" is required and must be a non-empty string`);
    } else if (err.keyword === "minLength") {
      messages.push(`"${field}" is required and must be a non-empty string`);
    } else if (err.keyword === "type") {
      // oneOf 配下の type エラーは親の oneOf エラーで処理するためスキップ
      if (field === "channelId") {
        continue;
      }
      const expected = /Expected "([^"]+)"/.exec(err.error)?.[1] ?? "value";
      messages.push(`"${field}" must be a ${expected}`);
    } else if (err.keyword === "oneOf" && field === "channelId") {
      messages.push('"channelId" must be a string or number');
    } else if (err.keyword === "exclusiveMinimum") {
      messages.push(`"${field}" must be a positive number`);
    } else if (err.keyword === "enum") {
      messages.push(`"${field}" must be one of the allowed values`);
    } else if (err.keyword === "additionalProperties") {
      // "false" keyword エラー (instanceLocation がキー名を指す) が同じキーについて
      // 別途出るため、こちらは重複を避けてスキップする。
      continue;
    } else if (err.keyword === "false") {
      // @cfworker は properties に宣言済みのフィールドがその subschema に失敗した
      // 場合にも additionalProperties + false のエラーを instanceLocation "#/<field>"
      // で出す。真に未知のキー (knownFields に無い) の場合だけ
      // 「許可されていないプロパティ」として報告し、既知フィールドの型違いは
      // 上の type/oneOf/enum 分岐で既に報告済みなのでスキップする。
      if (!knownFields.has(field)) {
        messages.push(`"${field}" is not an allowed property`);
      }
    } else {
      messages.push(err.error);
    }
  }

  return messages;
}

/**
 * `channelId` が number の場合に安全な整数かどうかを検証する。
 *
 * YAML で引用符なしに書いた大きな数値は `2^53` を超えると精度が落ちる
 * (末尾が丸められる) ため、安全な整数でなければエラーメッセージを返す。
 * string の場合や安全な整数の場合は undefined を返す。
 */
function channelIdPrecisionError(
  channelId: string | number | undefined,
): string | undefined {
  if (typeof channelId === "number" && !Number.isSafeInteger(channelId)) {
    return '"channelId" must be quoted as a string (numeric value is not a safe integer)';
  }
  return undefined;
}

/**
 * パース済みのフロントマターと本文を CronPromptJob にバリデーションする。
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
): CronPromptJob {
  const name = filename;

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

    const channelIdError = channelIdPrecisionError(meta.channelId);
    if (channelIdError) {
      errors.push(channelIdError);
    }

    if (errors.length > 0) {
      throw new Error(`${filename}: ${errors.join("; ")}`);
    }

    return {
      kind: "prompt",
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
  const errors = formatSchemaErrors(
    frontMatterValidator.validate(meta).errors,
    KNOWN_FRONT_MATTER_FIELDS,
  );

  if (!body) {
    errors.push("prompt body is empty");
  }

  throw new Error(`${filename}: ${errors.join("; ")}`);
}

/**
 * パース済みの YAML を CronCommandJob にバリデーションする。
 *
 * @param attrs - `parse()` (`@std/yaml`) が返した値。
 * @param filename - ジョブ名の決定とエラーメッセージに使うファイル名。
 * @throws バリデーションエラー時。
 */
export function validateCommandJob(
  attrs: unknown,
  filename: string,
): CronCommandJob {
  if (!isRecord(attrs)) {
    throw new Error(`${filename}: yaml must be an object`);
  }

  const meta = attrs;

  if (matchesCommandSchema(meta)) {
    // 型ガード通過: meta は CronCommandFrontMatter に narrowing 済み。
    // 構造は妥当なので、cron 式の妥当性を別途検証する。
    try {
      parseCronExpression(meta.schedule);
    } catch (e) {
      throw new Error(
        `${filename}: invalid cron expression: ${getErrorMessage(e)}`,
      );
    }

    const channelIdError = channelIdPrecisionError(meta.channelId);
    if (channelIdError) {
      throw new Error(`${filename}: ${channelIdError}`);
    }

    return {
      kind: "command",
      name: filename,
      schedule: meta.schedule,
      command: meta.command,
      channelId: meta.channelId != null ? String(meta.channelId) : undefined,
      timeout: meta.timeout,
      once: meta.once ?? false,
    };
  }

  // 構造検証に失敗: @cfworker のエラーを人間向けメッセージへマッピングする。
  const errors = formatSchemaErrors(
    commandValidator.validate(meta).errors,
    KNOWN_COMMAND_FIELDS,
  );

  throw new Error(`${filename}: ${errors.join("; ")}`);
}

/**
 * `cron/` ディレクトリから全ジョブ定義を読み込む。
 *
 * `.md` (prompt ジョブ) と `.yaml` (command ジョブ) を対象にする (`.yml` は対象外)。
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
      if (!entry.isFile) {
        continue;
      }

      const filePath = join(cronDir, entry.name);

      try {
        if (entry.name.endsWith(".md")) {
          const raw = await Deno.readTextFile(filePath);
          const { attrs, body } = extract<Record<string, unknown>>(raw);
          jobs.push(validateCronJob(attrs, body.trim(), entry.name));
        } else if (entry.name.endsWith(".yaml")) {
          const raw = await Deno.readTextFile(filePath);
          const parsed = parseYaml(raw);
          jobs.push(validateCommandJob(parsed, entry.name));
        }
        // .md / .yaml 以外は無視する
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
