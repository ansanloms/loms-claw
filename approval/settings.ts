/**
 * Claude Code の .claude/settings.json への永続化。
 *
 * 「Allow Always」で承認されたツールを permissions.allow に追記し、
 * 次回の claude -p 起動時から PreToolUse フック自体をスキップさせる。
 */

import { dirname } from "@std/path/dirname";
import { createLogger } from "../logger.ts";

const log = createLogger("approval-settings");

/**
 * 指定ツールを .claude/settings.json の permissions.allow に追加する。
 *
 * - ファイルが存在しない場合は新規作成する。
 * - 既存フィールドは保持してマージする。
 * - 重複するツール名は追加しない。
 *
 * @param settingsPath - .claude/settings.json の絶対パス
 * @param toolName - 追加するツール名（例: "mcp__discord__discord_send_message"）
 */
export async function addToSettingsAllowList(
  settingsPath: string,
  toolName: string,
): Promise<void> {
  let settings: Record<string, unknown> = {};
  try {
    const raw = await Deno.readTextFile(settingsPath);
    try {
      settings = JSON.parse(raw);
    } catch {
      log.warn("settings.json is invalid JSON, overwriting:", settingsPath);
    }
  } catch (error: unknown) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  if (!settings.permissions || typeof settings.permissions !== "object") {
    settings.permissions = {};
  }
  const perms = settings.permissions as Record<string, unknown>;

  if (!Array.isArray(perms.allow)) {
    perms.allow = [];
  }
  const allowList = perms.allow as string[];

  if (allowList.includes(toolName)) {
    log.debug("already in allow list:", toolName);
    return;
  }

  allowList.push(toolName);

  await Deno.mkdir(dirname(settingsPath), { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );

  log.info("persisted to settings.json allow list:", toolName);
}
