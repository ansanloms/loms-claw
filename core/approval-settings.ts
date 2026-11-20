/**
 * Claude Code の .claude/settings.json への永続化。
 *
 * 「Allow Always」で承認されたツールを permissions.allow に追記し、
 * 次回の query() から SDK 側で事前許可させる（canUseTool の確認をスキップ）。
 */

import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "@std/path/dirname";
import { isNotFoundError } from "../errors.ts";
import { isRecord } from "../guards.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("approval-settings");

/**
 * 指定ツールが .claude/settings.json の permissions.allow に含まれるか確認する。
 *
 * ファイルが存在しない場合や JSON が不正な場合は false を返す。
 *
 * @param settingsPath - .claude/settings.json の絶対パス
 * @param toolName - 確認するツール名
 */
export async function isInAllowList(
  settingsPath: string,
  toolName: string,
): Promise<boolean> {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    const allow = settings?.permissions?.allow;
    return Array.isArray(allow) && allow.includes(toolName);
  } catch {
    return false;
  }
}

function isStringArray(value: unknown[]): value is string[] {
  return value.every((v) => typeof v === "string");
}

/** path ごとの書き込みチェーン。read-modify-write を 1 つずつ実行するために使う。 */
const writeChains = new Map<string, Promise<void>>();

/**
 * 指定ツールを .claude/settings.json の permissions.allow に追加する。
 *
 * - ファイルが存在しない場合は新規作成する。
 * - JSON が不正な場合、トップレベル・permissions がオブジェクトでない場合、
 *   permissions.allow が配列でない・文字列以外の要素を含む場合は throw し、
 *   ファイルには触れない。permissions・permissions.allow が無い・null の
 *   場合は作り直す。
 * - 既存フィールドは保持してマージする。
 * - 重複するツール名は追加しない。
 * - 同一 path への呼び出しは直列化し、一時ファイル + rename で置き換える。
 *
 * @param settingsPath - .claude/settings.json の絶対パス
 * @param toolName - 追加するツール名（例: "mcp__claude_ai_Gmail__search_threads"）
 */
export function addToSettingsAllowList(
  settingsPath: string,
  toolName: string,
): Promise<void> {
  const previous = writeChains.get(settingsPath) ?? Promise.resolve();
  const run = previous.then(() =>
    doAddToSettingsAllowList(settingsPath, toolName),
  );
  // 失敗しても後続が走るよう、チェーンには catch 済みの Promise を繋ぐ。
  const tail = run.catch(() => {});
  writeChains.set(settingsPath, tail);
  void tail.then(() => {
    if (writeChains.get(settingsPath) === tail) {
      writeChains.delete(settingsPath);
    }
  });
  return run;
}

async function doAddToSettingsAllowList(
  settingsPath: string,
  toolName: string,
): Promise<void> {
  let raw: string | undefined;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  let settings: Record<string, unknown> = {};
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      throw new Error(`settings.json is invalid JSON: ${settingsPath}`, {
        cause: error,
      });
    }
    if (!isRecord(parsed)) {
      throw new Error(`settings.json is not a JSON object: ${settingsPath}`);
    }
    settings = parsed;
  }

  // キーが無い・明示の null は、守るべき元の値が無いので作り直す。
  if (settings.permissions === undefined || settings.permissions === null) {
    settings.permissions = {};
  }
  const perms = settings.permissions;
  if (!isRecord(perms)) {
    throw new Error(
      `settings.json permissions is not a JSON object: ${settingsPath}`,
    );
  }

  if (perms.allow === undefined || perms.allow === null) {
    perms.allow = [];
  }
  const allowList = perms.allow;
  if (!Array.isArray(allowList)) {
    throw new Error(
      `settings.json permissions.allow is not an array: ${settingsPath}`,
    );
  }
  if (!isStringArray(allowList)) {
    throw new Error(
      `settings.json permissions.allow has a non-string entry: ${settingsPath}`,
    );
  }

  if (allowList.includes(toolName)) {
    log.debug("already in allow list:", toolName);
    return;
  }

  allowList.push(toolName);

  await mkdir(dirname(settingsPath), { recursive: true });
  // symlink は実体へ書く (rename で symlink 自体を置き換えない)。
  let targetPath = settingsPath;
  try {
    targetPath = await realpath(settingsPath);
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  let mode: number | undefined;
  try {
    mode = (await stat(targetPath)).mode & 0o7777;
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // 作成時から元の mode にする (umask で落ちる分は chmod で補う)。
    await writeFile(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, {
      mode,
    });
    if (mode !== undefined) {
      await chmod(tmpPath, mode);
    }
    await rename(tmpPath, targetPath);
  } catch (error: unknown) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  log.info("persisted to settings.json allow list:", toolName);
}
