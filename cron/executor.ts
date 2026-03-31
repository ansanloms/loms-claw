/**
 * cron ジョブの実行エンジン。
 *
 * Deno.cron でジョブを登録し、各ティックで askClaude() を呼び出して
 * 結果を指定の Discord チャンネルに送信する。
 *
 * @module
 */

import type { Client, GuildTextBasedChannel } from "discord.js";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { askClaude } from "../claude/mod.ts";
import type { ClaudeConfig } from "../config.ts";
import type { SessionStore } from "../session/mod.ts";
import type { ApprovalManager } from "../approval/manager.ts";
import type { SystemPromptStore } from "../claude/system-prompt.ts";
import { splitMessage } from "../bot/message.ts";
import { createLogger } from "../logger.ts";
import type { CronJobDef } from "./types.ts";

const log = createLogger("cron");

/**
 * cron ジョブの登録・実行を管理するクラス。
 */
export class CronExecutor {
  /** 実行中のジョブ名を追跡し、同一ジョブの並行実行を防止する。 */
  private running = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly config: ClaudeConfig,
    private readonly guildId: string,
    private readonly sessions: SessionStore,
    private readonly approvalManager: ApprovalManager,
    private readonly systemPrompts: SystemPromptStore,
  ) {}

  /**
   * 全ジョブを Deno.cron に登録する。
   */
  registerAll(jobs: CronJobDef[]): void {
    for (const job of jobs) {
      Deno.cron(job.name, job.schedule, () => this.runJob(job));
      log.info(`registered cron job: ${job.name} (${job.schedule})`);
    }
  }

  /**
   * 単一の cron ジョブを実行する。
   *
   * 重複実行防止のため、同名ジョブが既に実行中の場合はスキップする。
   * askClaude() の結果を指定チャンネルに送信し、セッション ID を保存する。
   */
  async runJob(job: CronJobDef): Promise<void> {
    if (this.running.has(job.name)) {
      log.warn(`cron job "${job.name}" is already running, skipping`);
      return;
    }

    this.running.add(job.name);
    log.info(`cron job "${job.name}" started`);

    try {
      const channel = await this.client.channels.fetch(job.channelId);
      if (!channel || !("send" in channel)) {
        throw new Error(
          `channel ${job.channelId} not found or not a text channel`,
        );
      }
      const textChannel = channel as GuildTextBasedChannel;

      const sessionKey = `cron:${job.name}`;
      const sessionId = this.sessions.get(sessionKey);

      // テンプレート変数はギルドレベルのみ（cron にはユーザー/チャンネルコンテキストが無い）
      const guild = this.client.guilds.cache.get(this.guildId);
      const templateVars: Record<string, string> = {
        "discord.guild.id": this.guildId,
        "discord.guild.name": guild?.name ?? "",
      };

      const appendSystemPrompt = this.systemPrompts.resolve(
        "cron",
        job.channelId,
        templateVars,
      );

      // 承認ボタンの送信先を設定
      this.approvalManager.setChannel(job.channelId);

      const jobConfig: ClaudeConfig = {
        ...this.config,
        ...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
      };
      const timeout = job.timeout ?? this.config.timeout;

      const stream = askClaude(job.prompt, {
        sessionId,
        config: jobConfig,
        signal: AbortSignal.timeout(timeout),
        appendSystemPrompt,
      });

      let resultEvent: SDKResultMessage | undefined;

      for await (const event of stream) {
        if (event.type === "result") {
          resultEvent = event;
          // 非ゼロ終了でもセッションが残るよう即座に保存
          this.sessions.set(sessionKey, event.session_id);
        }
      }

      if (!resultEvent) {
        throw new Error("claude stream ended without result event");
      }

      if ("result" in resultEvent && typeof resultEvent.result === "string") {
        const chunks = splitMessage(resultEvent.result);
        for (const chunk of chunks) {
          await textChannel.send(chunk);
        }
      } else {
        const errors = "errors" in resultEvent
          ? String(resultEvent.errors)
          : resultEvent.subtype;
        throw new Error(`claude returned error: ${errors}`);
      }

      log.info(`cron job "${job.name}" completed`);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error(`cron job "${job.name}" failed:`, errMsg);

      // エラーをチャンネルに通知（チャンネル取得自体の失敗時は無視）
      try {
        const ch = await this.client.channels.fetch(job.channelId);
        if (ch && "send" in ch) {
          await (ch as GuildTextBasedChannel).send(
            `[cron: ${job.name}] Error: ${errMsg}`,
          );
        }
      } catch {
        // チャンネルへの通知も失敗した場合はログのみ
      }
    } finally {
      this.running.delete(job.name);
    }
  }
}
