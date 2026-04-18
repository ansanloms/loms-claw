/**
 * `config.json` の JSON Schema と ajv バリデータ。
 *
 * {@link ConfigFile} 型に対応する schema を定義し、`ajv.compile()` で
 * 型ガード関数 {@link validateConfigFile} を生成する。
 *
 * `useDefaults: true` により、省略されたフィールドは schema の `default` で
 * 自動補完される。`additionalProperties: false` で未知キーを拒否する
 * （typo の早期検出）。
 *
 * `claude.cwd` はプロセス由来のため schema には含めず、
 * {@link loadConfig} が検証後に `Deno.cwd()` を注入する。
 */

import Ajv from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { ConfigFile } from "./config.ts";

// deno の npm 互換レイヤーでは CJS default export のコンストラクタ型が解決できない
// @ts-expect-error: Ajv CJS default export
const ajv = new Ajv({ allErrors: true, useDefaults: true });

/**
 * `config.json` の JSON Schema。
 *
 * `claude.cwd` はプロセス実行時に注入されるため含めていない。
 */
export const validateConfigFile: ValidateFunction<ConfigFile> = ajv.compile<
  ConfigFile
>({
  type: "object",
  additionalProperties: false,
  required: [
    "discordToken",
    "guildId",
    "authorizedUserId",
    "activeChannelIds",
    "storePath",
    "defaults",
    "claude",
    "voice",
    "log",
  ],
  properties: {
    discordToken: { type: "string", minLength: 1 },
    guildId: { type: "string", minLength: 1 },
    authorizedUserId: { type: "string", minLength: 1 },
    activeChannelIds: {
      type: "array",
      items: { type: "string" },
      default: [],
    },
    storePath: { type: "string", default: ".claude/loms-claw.kv" },
    defaults: {
      type: "object",
      default: {},
      additionalProperties: false,
      properties: {
        model: { type: "string", nullable: true },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          nullable: true,
        },
      },
    },
    claude: {
      type: "object",
      default: {},
      additionalProperties: false,
      required: ["maxTurns", "verbose", "timeout", "apiPort"],
      properties: {
        maxTurns: { type: "number", default: 10 },
        verbose: { type: "boolean", default: true },
        timeout: { type: "number", default: 300000 },
        apiPort: { type: "number", default: 3000 },
      },
    },
    voice: {
      type: "object",
      default: {},
      additionalProperties: false,
      required: [
        "enabled",
        "whisperUrl",
        "ttsUrl",
        "ttsModel",
        "ttsSpeaker",
        "ttsSpeed",
        "minSpeechMs",
        "speechRms",
        "interruptRms",
        "autoLeaveMs",
        "speechDebounceMs",
        "noSpeechProbThreshold",
        "notificationTone",
        "autoJoinVc",
      ],
      properties: {
        enabled: { type: "boolean", default: false },
        whisperUrl: { type: "string", default: "http://localhost:8178" },
        ttsUrl: { type: "string", default: "http://localhost:8000" },
        ttsApiKey: { type: "string", nullable: true },
        ttsModel: { type: "string", default: "voicevox" },
        ttsSpeaker: { type: "string", default: "1" },
        ttsSpeed: { type: "number", default: 1 },
        minSpeechMs: { type: "number", default: 500 },
        speechRms: { type: "number", default: 200 },
        interruptRms: { type: "number", default: 500 },
        autoLeaveMs: { type: "number", default: 600000 },
        speechDebounceMs: { type: "number", default: 500 },
        noSpeechProbThreshold: { type: "number", default: 0.6 },
        notificationTone: { type: "boolean", default: true },
        autoJoinVc: {
          anyOf: [
            { type: "boolean" },
            { type: "array", items: { type: "string" } },
          ],
          default: false,
        },
      },
    },
    log: {
      type: "object",
      default: {},
      additionalProperties: false,
      required: ["level", "bufferSize"],
      properties: {
        level: {
          type: "string",
          enum: ["DEBUG", "INFO", "WARN", "ERROR"],
          default: "INFO",
        },
        bufferSize: {
          type: "number",
          default: 1000,
          minimum: 1,
          maximum: 10000,
        },
      },
    },
  },
});

/**
 * ajv のエラー配列を人間が読みやすいメッセージに整形する。
 */
export function formatConfigErrors(
  errors: ErrorObject[] | null | undefined,
): string {
  if (!errors || errors.length === 0) {
    return "(no error details)";
  }

  return errors
    .map((err) => {
      const path = err.instancePath || "(root)";
      if (err.keyword === "required") {
        return `  - ${path}: missing required property "${err.params.missingProperty}"`;
      }
      if (err.keyword === "additionalProperties") {
        return `  - ${path}: unexpected property "${err.params.additionalProperty}"`;
      }
      if (err.keyword === "type") {
        return `  - ${path}: expected ${err.params.type}`;
      }
      if (err.keyword === "enum") {
        const allowed = (err.params.allowedValues as unknown[]).join(" | ");
        return `  - ${path}: must be one of ${allowed}`;
      }
      if (err.keyword === "minLength") {
        return `  - ${path}: must not be empty`;
      }
      if (err.keyword === "anyOf") {
        return `  - ${path}: does not match any allowed shape`;
      }
      return `  - ${path}: ${err.message ?? "validation error"}`;
    })
    .join("\n");
}
