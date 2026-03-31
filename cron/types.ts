/**
 * cron ジョブの型定義。
 *
 * @module
 */

/**
 * cron ジョブの定義。
 *
 * `.claude/cron/` 配下の Markdown ファイルから読み込まれる。
 * YAML フロントマターがメタデータ、本文がプロンプトとなる。
 */
export interface CronJobDef {
  /** ジョブ名（一意）。ファイル名（拡張子除く）と一致させる。 */
  name: string;
  /** 人間向けのジョブ説明。 */
  description?: string;
  /** cron 式（5フィールド、TZ 環境変数依存）。 */
  schedule: string;
  /** Claude に送るプロンプト（Markdown 本文）。 */
  prompt: string;
  /** 承認ボタン送信先の Discord チャンネル ID（省略可）。 */
  channelId?: string;
  /** ClaudeConfig.maxTurns のオーバーライド。 */
  maxTurns?: number;
  /** ClaudeConfig.timeout のオーバーライド（ミリ秒）。 */
  timeout?: number;
  /** 前回のセッションを引き継ぐか（デフォルト: false）。 */
  resumeSession?: boolean;
}
