/**
 * ボイスチャンネルの接続管理と STT → Claude CLI → TTS パイプライン。
 *
 * DiscordBot からボイス関連のロジックを分離し、
 * join/leave/auto-join/auto-leave/音声受信/パイプライン制御を担う。
 */

import { Buffer } from "node:buffer";
import { ChannelType } from "discord.js";
import type { Client, VoiceState } from "discord.js";
import {
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import type { ClaudeConfig, VoiceConfig } from "../config.ts";
import type { Store } from "../store/mod.ts";
import type { ApprovalManager } from "../approval/manager.ts";
import { createLogger } from "../logger.ts";
import type { SystemPromptStore } from "../claude/system-prompt.ts";
import { calcRms, concatBytes, createOpusDecoder } from "./codec.ts";
import type { SpeechToText } from "./stt.ts";
import type { VoicePlayer } from "./player.ts";
import { streamClaudeForVoice } from "./adapter.ts";

const log = createLogger("voice");

/**
 * ミリ秒を PCM バイト数に変換する。
 * 48 kHz モノラル 16 ビット = 96 bytes/ms。
 */
function msToBytes(ms: number): number {
  return Math.floor(48000 * 2 * ms / 1000);
}

/**
 * ボイスチャンネルの接続・パイプライン・auto-join/leave を管理する。
 */
export class VoiceManager {
  private currentConnection: VoiceConnection | null = null;
  private currentChannelId: string | null = null;
  private autoLeaveTimer: ReturnType<typeof setTimeout> | null = null;
  private isAutoJoining = false;
  private readonly minPcmBytes: number;
  private readonly speechDebounce = new Map<string, {
    texts: string[];
    displayName: string;
    timer: ReturnType<typeof setTimeout>;
    timerActive: boolean;
  }>();
  private readonly processingUsers = new Set<string>();

  constructor(
    private readonly voiceConfig: VoiceConfig,
    private readonly claudeConfig: ClaudeConfig,
    private readonly guildId: string,
    private readonly authorizedUserId: string,
    private readonly client: Client,
    private readonly stt: SpeechToText,
    private readonly voicePlayer: VoicePlayer,
    private readonly store: Store,
    private readonly approvalManager: ApprovalManager,
    private readonly systemPrompts: SystemPromptStore,
  ) {
    this.minPcmBytes = msToBytes(voiceConfig.minSpeechMs);
  }

  /**
   * 指定されたボイスチャンネルに参加する。
   * 既に別の VC に参加中の場合は切断してから参加する。
   */
  async join(channelId: string): Promise<void> {
    if (this.currentConnection) {
      this.currentConnection.destroy();
      this.currentConnection = null;
      this.currentChannelId = null;
    }

    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) {
      throw new Error(`guild ${this.guildId} not found in cache`);
    }

    const connection = joinVoiceChannel({
      channelId,
      guildId: this.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    connection.on("stateChange", (_old, newState) => {
      log.debug(`voice state: ${newState.status}`);
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (e) {
      // Ready にならなかった場合はコネクションを破棄する。
      try {
        connection.destroy();
      } catch {
        // 既に destroyed の場合は無視する。
      }
      throw e;
    }

    this.currentConnection = connection;
    this.currentChannelId = channelId;
    log.info(`voice connection ready (channel: ${channelId})`);
    connection.subscribe(this.voicePlayer.discordPlayer);
    this.setupVoiceReceiver(connection);

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.handleDisconnect(connection);
    });

    connection.on("error", (err) => {
      log.error("voice connection error:", err);
    });
  }

  /**
   * 現在の VC から離脱する。
   */
  leave(): void {
    if (this.autoLeaveTimer) {
      clearTimeout(this.autoLeaveTimer);
      this.autoLeaveTimer = null;
    }
    const conn = getVoiceConnection(this.guildId);
    if (conn) {
      conn.destroy();
    }
    this.currentConnection = null;
    this.currentChannelId = null;
  }

  /**
   * VC に接続中かどうかを返す。
   */
  isConnected(): boolean {
    return this.currentConnection !== null;
  }

  /**
   * 現在参加中のチャンネル ID を返す。
   */
  getCurrentChannelId(): string | null {
    return this.currentChannelId;
  }

  /**
   * 全リソースを解放する。
   */
  shutdown(): void {
    if (this.autoLeaveTimer) {
      clearTimeout(this.autoLeaveTimer);
      this.autoLeaveTimer = null;
    }
    for (const entry of this.speechDebounce.values()) {
      clearTimeout(entry.timer);
    }
    this.speechDebounce.clear();
    this.processingUsers.clear();
    if (this.currentConnection) {
      try {
        this.currentConnection.destroy();
      } catch {
        // 既に destroyed の場合は無視する。
      }
      this.currentConnection = null;
      this.currentChannelId = null;
    }
  }

  /**
   * voiceStateUpdate イベントのハンドラ。
   * DiscordBot から委譲される。
   */
  onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    // ボット未接続時: auto-join 判定。
    if (!this.currentChannelId) {
      this.tryAutoJoin(newState);
      return;
    }
    // ボット接続中: auto-leave 判定。
    if (
      newState.channelId !== this.currentChannelId &&
      oldState.channelId !== this.currentChannelId
    ) {
      return;
    }
    this.tryAutoLeave();
  }

  /**
   * ギルド内の VC をスキャンし、auto-join 条件を満たすチャンネルがあれば参加する。
   * 起動時や auto-leave / disconnect 後に呼ばれる。
   */
  scanAndAutoJoin(): void {
    const autoJoin = this.voiceConfig.autoJoinVc;
    if (autoJoin === false || this.currentChannelId || this.isAutoJoining) {
      return;
    }

    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) {
      return;
    }

    const voiceChannels = guild.channels.cache
      .filter((ch) => ch.type === ChannelType.GuildVoice)
      .sort((a, b) => a.position - b.position);

    for (const [, channel] of voiceChannels) {
      if (Array.isArray(autoJoin) && !autoJoin.includes(channel.id)) {
        continue;
      }

      // 指定ユーザーがいる VC のみ参加する。
      const hasAuthorizedUser = channel.members.has(this.authorizedUserId);
      if (hasAuthorizedUser) {
        log.info(
          `auto-joining VC ${channel.id} (authorized user found by scan)`,
        );
        this.isAutoJoining = true;
        this.join(channel.id)
          .catch((e) => log.error("auto-join (scan) failed:", e))
          .finally(() => {
            this.isAutoJoining = false;
          });
        return;
      }
    }
  }

  // ── private ──────────────────────────────────────────────

  /**
   * ボイスコネクション切断時の再接続ハンドラ。
   */
  private async handleDisconnect(connection: VoiceConnection): Promise<void> {
    log.warn("voice connection disconnected, attempting rejoin...");
    try {
      connection.rejoin();
      await entersState(connection, VoiceConnectionStatus.Ready, 5_000);
      log.info("voice connection rejoined");
    } catch {
      log.error("rejoin failed, destroying connection");
      try {
        connection.destroy();
      } catch {
        // 既に destroyed の場合は無視する。
      }
      this.currentConnection = null;
      this.currentChannelId = null;
      this.scanAndAutoJoin();
    }
  }

  /**
   * ボイスレシーバーに発話リスナーを設定する。
   */
  private setupVoiceReceiver(connection: VoiceConnection): void {
    const receiver = connection.receiver;
    const activeUsers = new Set<string>();

    receiver.speaking.on("start", (userId) => {
      // 指定ユーザー以外の発話は無視する。
      if (userId !== this.authorizedUserId) {
        return;
      }
      if (activeUsers.has(userId)) {
        return;
      }
      activeUsers.add(userId);
      log.info(`recording user ${userId}`);

      // ユーザーごとにデコーダを生成する。
      // opusscript はストリームごとに状態を持つため、共有するとアーティファクトが生じる。
      const decoder = createOpusDecoder();

      const opusStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1500,
        },
      });

      const pcmChunks: Buffer[] = [];

      opusStream.on("data", (chunk: Buffer) => {
        try {
          const pcm = decoder.decode(chunk);
          pcmChunks.push(pcm);

          // AI 再生中ならフレーム単位で RMS を判定し、即中断する。
          if (this.voicePlayer.isSpeaking) {
            const rms = calcRms(pcm);
            if (rms >= this.voiceConfig.interruptRms) {
              log.info(
                `interrupting AI speech in real-time (RMS: ${rms.toFixed(0)})`,
              );
              this.voicePlayer.interrupt();
            }
          }
        } catch {
          // 不正な Opus フレームはスキップする。
        }
      });

      opusStream.on("end", () => {
        decoder.delete();
        this.onSpeechEnd(userId, pcmChunks, activeUsers);
      });

      opusStream.on("error", (err: Error) => {
        decoder.delete();
        activeUsers.delete(userId);
        log.error(`stream error for user ${userId}:`, err.message);
      });
    });
  }

  /**
   * 発話完了後の STT → Claude CLI → TTS パイプラインを実行する。
   */
  private async onSpeechEnd(
    userId: string,
    pcmChunks: Buffer[],
    activeUsers: Set<string>,
  ): Promise<void> {
    activeUsers.delete(userId);

    try {
      if (pcmChunks.length === 0) {
        return;
      }

      const pcm = concatBytes(...pcmChunks);

      if (pcm.length < this.minPcmBytes) {
        log.debug("audio too short, skipping");
        return;
      }

      const rms = calcRms(pcm);

      if (this.voicePlayer.isSpeaking) {
        if (rms < this.voiceConfig.interruptRms) {
          log.debug(
            `audio during AI speech too quiet to interrupt (RMS: ${
              rms.toFixed(0)
            }), skipping`,
          );
          return;
        }
        log.info(`interrupting AI speech (RMS: ${rms.toFixed(0)})`);
        this.voicePlayer.interrupt();
      } else {
        if (rms < this.voiceConfig.speechRms) {
          log.debug(`audio too quiet (RMS: ${rms.toFixed(0)}), skipping`);
          return;
        }
      }

      log.info(
        `processing ${pcmChunks.length} frame(s), ${
          (pcm.length / 1024).toFixed(1)
        } KB PCM, RMS: ${rms.toFixed(0)}`,
      );

      this.voicePlayer.startThinking();

      const text = await this.stt.transcribe(pcm);
      if (!text) {
        log.info("no transcription result");
        this.voicePlayer.stopThinking();
        return;
      }

      const guild = this.client.guilds.cache.get(this.guildId);
      const member = guild?.members.cache.get(userId);
      const displayName = member?.displayName ?? userId;

      log.info(`transcript from ${displayName} (${userId}): ${text}`);

      this.enqueueSpeech(userId, displayName, text);
    } catch (e: unknown) {
      log.error(`pipeline error for user ${userId}:`, e);
      this.voicePlayer.playErrorTone();
    }
  }

  /**
   * 発話テキストをデバウンスバッファに追加する。
   */
  private enqueueSpeech(
    userId: string,
    displayName: string,
    text: string,
  ): void {
    const existing = this.speechDebounce.get(userId);
    const scheduleFlush = () =>
      setTimeout(
        () => {
          const entry = this.speechDebounce.get(userId);
          if (entry) {
            entry.timerActive = false;
          }
          this.flushSpeech(userId).catch((e) =>
            log.error(`flush error for user ${userId}:`, e)
          );
        },
        this.voiceConfig.speechDebounceMs,
      );

    if (existing) {
      clearTimeout(existing.timer);
      existing.texts.push(text);
      existing.timer = scheduleFlush();
      existing.timerActive = true;
    } else {
      const timer = scheduleFlush();
      this.speechDebounce.set(userId, {
        texts: [text],
        displayName,
        timer,
        timerActive: true,
      });
    }
  }

  /**
   * デバウンスバッファをフラッシュし、Claude CLI → TTS パイプラインを実行する。
   * 同一ユーザーの並行実行を防ぐ排他制御付き。
   */
  private async flushSpeech(userId: string): Promise<void> {
    if (this.processingUsers.has(userId)) {
      // 前の実行が完了するまでバッファに残しておく。
      // 完了後に再フラッシュされる。
      log.debug(`skipping flush for ${userId} (already processing)`);
      return;
    }

    const entry = this.speechDebounce.get(userId);
    this.speechDebounce.delete(userId);
    if (!entry || entry.texts.length === 0) {
      return;
    }

    const mergedText = entry.texts.join(" ");
    const channelId = this.currentChannelId;
    if (!channelId) {
      return;
    }

    this.processingUsers.add(userId);
    try {
      log.info(
        `sending to Claude (${entry.texts.length} segment(s)): ${mergedText}`,
      );

      // 承認ボタンの送信先チャンネルを設定。
      this.approvalManager.setChannel(channelId);

      this.voicePlayer.startThinking();

      // VC はスレッドを持たないので channel スコープのみ。
      const scope = { channelId };
      const [sessionId, model, effort] = await Promise.all([
        this.store.getSession(scope),
        this.store.getModel(scope),
        this.store.getEffort(scope),
      ]);
      const vcChannel = this.client.channels.cache.get(channelId);
      const templateVars: Record<string, string> = {
        "discord.guild.id": this.guildId,
        "discord.guild.name":
          this.client.guilds.cache.get(this.guildId)?.name ?? "",
        "discord.channel.id": channelId,
        "discord.channel.name":
          (vcChannel && "name" in vcChannel ? vcChannel.name : "") ?? "",
        "discord.channel.type": "voice",
        "discord.user.id": userId,
        "discord.user.name": entry.displayName,
      };
      const appendSystemPrompt = this.systemPrompts.resolve(
        "vc",
        scope,
        templateVars,
      );

      // ストリーミングで Claude CLI を呼び出し、文単位で逐次 TTS → 再生する。
      const voiceStream = streamClaudeForVoice(mergedText, {
        sessionId,
        config: this.claudeConfig,
        signal: AbortSignal.timeout(this.claudeConfig.timeout),
        appendSystemPrompt,
        model,
        effort,
      });

      const player = this.voicePlayer;
      let newSessionId = "";

      // テキストチャンクだけを抽出する AsyncGenerator。
      // 最初のチャンク到着時に thinking tone を停止する。
      const textChunks = async function* () {
        let thinkingStopped = false;
        for await (const event of voiceStream) {
          if (event.type === "text") {
            if (!thinkingStopped) {
              player.stopThinking();
              thinkingStopped = true;
            }
            log.info(`reply chunk: ${event.text.slice(0, 200)}`);
            yield event.text;
          } else if (event.type === "end") {
            newSessionId = event.sessionId;
          }
        }
        if (!thinkingStopped) {
          player.stopThinking();
        }
      };

      await player.speakStreaming(textChunks());

      // セッション ID を保存。
      if (newSessionId) {
        await this.store.setSession(scope, newSessionId);
      }
    } catch (e: unknown) {
      log.error(`pipeline error for user ${userId}:`, e);
      this.voicePlayer.stopThinking();
      this.voicePlayer.playErrorTone();
    } finally {
      this.processingUsers.delete(userId);
      // 処理中に溜まった発話があれば再フラッシュする。
      // ただしデバウンスタイマーがまだ動いている場合はタイマーに任せる
      // （ユーザーがまだ話し続けている可能性がある）。
      const pending = this.speechDebounce.get(userId);
      if (pending && !pending.timerActive) {
        log.info(`flushing queued speech for ${userId}`);
        this.flushSpeech(userId).catch((e) =>
          log.error(`flush error for user ${userId}:`, e)
        );
      }
    }
  }

  /**
   * ボットが未接続のとき、non-bot メンバーの VC 参加を検知して自動参加する。
   */
  private tryAutoJoin(newState: VoiceState): void {
    const autoJoin = this.voiceConfig.autoJoinVc;
    if (autoJoin === false || this.isAutoJoining) {
      return;
    }

    const channelId = newState.channelId;
    if (!channelId) {
      return;
    }

    // 指定ユーザー以外の入室は無視する。
    if (newState.member?.user.id !== this.authorizedUserId) {
      return;
    }

    if (Array.isArray(autoJoin) && !autoJoin.includes(channelId)) {
      return;
    }

    const channel = this.client.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      return;
    }

    log.info(`auto-joining VC ${channelId}`);
    this.isAutoJoining = true;
    this.join(channelId)
      .catch((e) => log.error("auto-join failed:", e))
      .finally(() => {
        this.isAutoJoining = false;
      });
  }

  /**
   * 現在の VC にボット以外のメンバーがいるか確認し、
   * いなければ自動退出タイマーを開始する。
   */
  private tryAutoLeave(): void {
    if (!this.currentChannelId || this.voiceConfig.autoLeaveMs < 0) {
      return;
    }

    const channel = this.client.channels.cache.get(this.currentChannelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      return;
    }

    // 指定ユーザーがいるかで判定する。
    const hasAuthorizedUser = channel.members.has(this.authorizedUserId);

    if (!hasAuthorizedUser) {
      if (this.autoLeaveTimer) {
        return;
      }

      log.info(
        `no members in VC, auto-leave in ${
          this.voiceConfig.autoLeaveMs / 1000
        }s`,
      );
      this.autoLeaveTimer = setTimeout(() => {
        this.autoLeaveTimer = null;
        const ch = this.client.channels.cache.get(this.currentChannelId!);
        if (
          ch && ch.type === ChannelType.GuildVoice &&
          !ch.members.has(this.authorizedUserId)
        ) {
          log.info("auto-leaving VC (no members)");
          this.leave();
          this.scanAndAutoJoin();
        }
      }, this.voiceConfig.autoLeaveMs);
    } else {
      if (this.autoLeaveTimer) {
        clearTimeout(this.autoLeaveTimer);
        this.autoLeaveTimer = null;
        log.info("auto-leave cancelled (member joined)");
      }
    }
  }
}
