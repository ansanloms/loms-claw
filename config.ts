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
  /** 内部 API サーバーのポート（承認 + Discord API）。 */
  apiPort: number;
}

/**
 * ボイスチャンネル関連の設定。
 */
export interface VoiceConfig {
  /** VC 機能の有効/無効。 */
  enabled: boolean;
  /** whisper.cpp サーバーの URL。 */
  whisperUrl: string;
  /** TTS サーバーの URL（OpenAI 互換）。 */
  ttsUrl: string;
  /** TTS API キー。 */
  ttsApiKey?: string;
  /** TTS モデル名。 */
  ttsModel: string;
  /** TTS スピーカー/音声 ID。 */
  ttsSpeaker: string;
  /** TTS 再生速度。 */
  ttsSpeed: number;
  /** STT に送る最小発話時間（ミリ秒）。 */
  minSpeechMs: number;
  /** 発話とみなす最小 RMS 振幅。 */
  speechRms: number;
  /** AI 再生を中断する最小 RMS 振幅。 */
  interruptRms: number;
  /** 無人 VC からの自動退出タイムアウト（ミリ秒）。-1 で無効。 */
  autoLeaveMs: number;
  /** 発話デバウンス待機時間（ミリ秒）。 */
  speechDebounceMs: number;
  /** 通知トーン（処理中・エラー）の有効/無効。 */
  notificationTone: boolean;
  /** auto-join: false=無効, true=全VC, string[]=指定VC IDのみ。 */
  autoJoinVc: false | true | string[];
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
  /** ボイスチャンネル設定。 */
  voice: VoiceConfig;
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
 * AUTO_JOIN_VC 環境変数をパースする。
 * "false" → false, "true" → true, カンマ区切り → string[]。
 */
function parseAutoJoinVc(raw: string | undefined): false | true | string[] {
  if (!raw || raw === "false") {
    return false;
  }
  if (raw === "true") {
    return true;
  }
  return parseCsv(raw);
}

/**
 * 環境変数から設定を読み込む。
 * 必須変数が未設定の場合はエラーを投げる。
 */
export function loadConfig(): Config {
  const voiceEnabled = (Deno.env.get("VOICE_ENABLED") ?? "false") === "true";

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
      apiPort: Number(Deno.env.get("API_PORT") ?? "3000"),
    },
    voice: {
      enabled: voiceEnabled,
      whisperUrl: Deno.env.get("WHISPER_URL") ?? "http://localhost:8178",
      ttsUrl: Deno.env.get("OPENAI_TTS_URL") ?? "http://localhost:8000",
      ttsApiKey: Deno.env.get("OPENAI_TTS_API_KEY"),
      ttsModel: Deno.env.get("OPENAI_TTS_MODEL") ?? "voicevox",
      ttsSpeaker: Deno.env.get("OPENAI_TTS_SPEAKER") ?? "1",
      ttsSpeed: Number(Deno.env.get("OPENAI_TTS_SPEED") ?? "1"),
      minSpeechMs: Number(Deno.env.get("MIN_SPEECH_MS") ?? "500"),
      speechRms: Number(Deno.env.get("SPEECH_RMS") ?? "200"),
      interruptRms: Number(Deno.env.get("INTERRUPT_RMS") ?? "500"),
      autoLeaveMs: Number(Deno.env.get("AUTO_LEAVE_MS") ?? "600000"),
      speechDebounceMs: Number(Deno.env.get("SPEECH_DEBOUNCE_MS") ?? "500"),
      notificationTone:
        (Deno.env.get("NOTIFICATION_TONE") ?? "true") === "true",
      autoJoinVc: parseAutoJoinVc(Deno.env.get("AUTO_JOIN_VC")),
    },
  };
}
