/**
 * 環境変数からアプリケーション設定を読み込む。
 *
 * 必須変数: DISCORD_TOKEN, GUILD_ID, AUTHORIZED_USER_ID, CLAUDE_WORKSPACE。
 * その他はデフォルト値が設定されている。
 */

/**
 * Claude Code CLI 設定。
 */
export interface ClaudeConfig {
  /** `--max-turns` に渡す最大ターン数。 */
  maxTurns: number;
  /** `--verbose` フラグ。 */
  verbose: boolean;
  /** プロセスタイムアウト（ミリ秒）。 */
  timeout: number;
  /** `claude` プロセスの作業ディレクトリ。 */
  cwd: string;
  /** 承認 HTTP サーバーのポート。 */
  approvalPort: number;
}

/**
 * バリデーション済みのアプリケーション設定。
 */
export interface Config {
  /** Discord bot トークン。 */
  discordToken: string;
  /** 対象 Discord ギルド ID。 */
  guildId: string;
  /** 操作を許可する唯一のユーザー ID。 */
  authorizedUserId: string;
  /** mention 不要で全メッセージに反応するチャンネル ID の配列。 */
  activeChannelIds: string[];
  /** Claude Code CLI 設定。 */
  claude: ClaudeConfig;
  /** セッション永続化ファイルのパス。 */
  sessionFile: string;
}

/**
 * カンマ区切り文字列を配列にパースする。空文字列は除外。
 */
function parseCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * 必須環境変数を取得する。未設定の場合はエラーを投げる。
 */
function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Required environment variable not set: ${name}`);
  }
  return value;
}

/**
 * 環境変数から設定を読み込む。
 * 必須変数が未設定の場合はエラーを投げる。
 */
export function loadConfig(): Config {
  return {
    discordToken: requireEnv("DISCORD_TOKEN"),
    guildId: requireEnv("GUILD_ID"),
    authorizedUserId: requireEnv("AUTHORIZED_USER_ID"),
    activeChannelIds: parseCsv(Deno.env.get("ACTIVE_CHANNEL_IDS")),
    claude: {
      maxTurns: Number(Deno.env.get("CLAUDE_MAX_TURNS") ?? "10"),
      verbose: (Deno.env.get("CLAUDE_VERBOSE") ?? "true") === "true",
      timeout: Number(Deno.env.get("CLAUDE_TIMEOUT") ?? "300000"),
      cwd: Deno.cwd(),
      approvalPort: Number(Deno.env.get("APPROVAL_PORT") ?? "3000"),
    },
    sessionFile: Deno.env.get("SESSION_FILE") ?? "./data/sessions.json",
  };
}
