/**
 * cron ジョブの型定義。
 *
 * @module
 */

/**
 * cron ジョブに共通するフィールド。
 */
interface CronJobBase {
  /** ジョブ名（一意）。ファイル名そのもの（例: "news-tech.md", "token-check.yaml"）。 */
  name: string;
  /** cron 式（5フィールド、TZ 環境変数依存）。 */
  schedule: string;
  /** 結果の自動投稿先と承認ボタン送信先のチャンネル ID（省略可）。 */
  channelId?: string;
  /** ClaudeConfig.timeout のオーバーライド（ミリ秒）。 */
  timeout?: number;
  /** true の場合、1回実行後にジョブファイルを削除する（デフォルト: false）。 */
  once?: boolean;
}

/**
 * prompt ジョブの定義。
 *
 * `cron/*.md` から読み込まれる。YAML フロントマターがメタデータ、本文がプロンプトとなる。
 */
export interface CronPromptJob extends CronJobBase {
  kind: "prompt";
  /** Claude に送るプロンプト（Markdown 本文）。 */
  prompt: string;
  /** ClaudeConfig.maxTurns のオーバーライド。 */
  maxTurns?: number;
  /** 前回のセッションを引き継ぐか（デフォルト: false）。 */
  resumeSession?: boolean;
  /** モデル alias または full name のオーバーライド。 */
  model?: string;
  /** effort level (low / medium / high / xhigh / max) のオーバーライド。 */
  effort?: string;
}

/**
 * command ジョブの定義。
 *
 * `cron/*.yaml` から読み込まれる。`sh -c` でコマンドを実行し、標準出力を結果として扱う。
 */
export interface CronCommandJob extends CronJobBase {
  kind: "command";
  /** `sh -c` で実行するコマンド。 */
  command: string;
}

/**
 * cron ジョブの定義。
 *
 * `kind` で prompt ジョブ (`cron/*.md`) と command ジョブ (`cron/*.yaml`) を判別する。
 */
export type CronJobDef = CronPromptJob | CronCommandJob;
