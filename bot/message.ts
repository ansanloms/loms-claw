/**
 * Discord メッセージ送信ユーティリティ。
 *
 * 2000 文字制限の分割送信、typing インジケーター維持、
 * 画像添付ファイルのダウンロードを提供する。
 */

import type { Attachment, GuildTextBasedChannel } from "discord.js";
import { dirname } from "@std/path/dirname";
import { join } from "@std/path/join";
import { createLogger } from "../logger.ts";

const log = createLogger("message");

/** 画像の content type プレフィックス。 */
const IMAGE_CONTENT_TYPE_PREFIX = "image/";

/** Claude Vision の推奨最大長辺（px）。 */
const MAX_IMAGE_DIMENSION = 1568;

/**
 * ダウンロード済み画像の情報。
 */
export interface DownloadedImage {
  /** 一時ファイルの絶対パス。 */
  path: string;
  /** 元のファイル名。 */
  originalName: string;
}

/**
 * ffprobe で画像の幅と高さを取得する。
 */
async function getImageDimensions(
  buffer: Uint8Array,
): Promise<{ width: number; height: number }> {
  const cmd = new Deno.Command("ffprobe", {
    args: [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-select_streams",
      "v:0",
      "pipe:0",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(buffer);
  await writer.close();

  const output = await child.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`ffprobe failed: ${stderr}`);
  }
  const json = JSON.parse(new TextDecoder().decode(output.stdout));
  const stream = json.streams?.[0];

  return {
    width: Number(stream?.width ?? 0),
    height: Number(stream?.height ?? 0),
  };
}

/**
 * 画像バッファを最大サイズ以内にリサイズする。
 *
 * 長辺が MAX_IMAGE_DIMENSION を超える場合のみ縮小し、JPEG で再エンコードする。
 * 超えない場合は元のバッファをそのまま返す。
 *
 * @returns [リサイズ後バッファ, 拡張子]
 */
export async function resizeImageIfNeeded(
  buffer: Uint8Array,
  maxDimension: number = MAX_IMAGE_DIMENSION,
): Promise<[Uint8Array, string]> {
  const { width, height } = await getImageDimensions(buffer);
  const longer = Math.max(width, height);

  if (longer <= maxDimension) {
    return [buffer, ""];
  }

  const cmd = new Deno.Command("ffmpeg", {
    args: [
      "-i",
      "pipe:0",
      "-vf",
      `scale='min(${maxDimension},iw)':'min(${maxDimension},ih)':force_original_aspect_ratio=decrease`,
      "-f",
      "mjpeg",
      "-q:v",
      // ffmpeg の JPEG 品質は 2-31（低いほど高品質）。JPEG_QUALITY 80 ≒ q:v 4 程度。
      "4",
      "pipe:1",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(buffer);
  await writer.close();

  const output = await child.output();

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`ffmpeg resize failed: ${stderr}`);
  }

  const resized = new Uint8Array(output.stdout);

  // scale フィルタの force_original_aspect_ratio=decrease と同じ計算
  const scale = Math.min(maxDimension / width, maxDimension / height);
  const newW = Math.round(width * scale);
  const newH = Math.round(height * scale);
  log.info(`resized image: ${width}x${height} -> ${newW}x${newH}`);

  return [resized, ".jpg"];
}

/**
 * Discord メッセージの添付ファイルから画像をダウンロードし、一時ファイルに保存する。
 *
 * 長辺が 1568px を超える画像は自動的にリサイズされる。
 *
 * @param attachments - Discord メッセージの添付ファイルコレクション。
 * @returns ダウンロード済み画像情報の配列。呼び出し側で一時ファイルの削除を行うこと。
 */
export async function downloadImageAttachments(
  attachments: Iterable<Attachment>,
): Promise<DownloadedImage[]> {
  const images: Attachment[] = [];
  for (const att of attachments) {
    if (att.contentType?.startsWith(IMAGE_CONTENT_TYPE_PREFIX)) {
      images.push(att);
    }
  }

  if (images.length === 0) {
    return [];
  }

  let dir: string | null = null;
  const results: DownloadedImage[] = [];

  for (const att of images) {
    try {
      const response = await fetch(att.url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        log.warn(
          `failed to download attachment: ${att.name} (${response.status})`,
        );
        continue;
      }

      const original = new Uint8Array(await response.arrayBuffer());
      const [data, resizedExt] = await resizeImageIfNeeded(original);

      // 最初の成功時にディレクトリを作成。
      if (!dir) {
        dir = await Deno.makeTempDir({ prefix: "loms-claw-img-" });
      }

      // リサイズされた場合は .jpg、されなかった場合は元の拡張子を維持。
      const ext = resizedExt ||
        (att.name.lastIndexOf(".") !== -1
          ? att.name.substring(att.name.lastIndexOf("."))
          : ".bin");
      const filename = `${crypto.randomUUID()}${ext}`;
      const filepath = join(dir, filename);

      await Deno.writeFile(filepath, data);
      results.push({ path: filepath, originalName: att.name });
      log.debug(`downloaded image: ${att.name} -> ${filepath}`);
    } catch (e) {
      log.warn(`failed to process attachment: ${att.name}`, e);
    }
  }

  return results;
}

/**
 * 一時画像ファイルを削除する。
 *
 * ダウンロード先ディレクトリごと削除する。
 * 異なるディレクトリに分散している場合はファイル単位で削除する。
 */
export async function cleanupImageFiles(
  images: DownloadedImage[],
): Promise<void> {
  const dirs = new Set<string>();
  for (const img of images) {
    dirs.add(dirname(img.path));
  }
  for (const dir of dirs) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * プロンプトに画像ファイル参照を付加する。
 *
 * claude -p の @ 構文で画像を参照できる形式にする。
 */
export function appendImageReferences(
  prompt: string,
  images: DownloadedImage[],
): string {
  if (images.length === 0) {
    return prompt;
  }
  const refs = images.map((img) => `@${img.path}`).join(" ");
  return `${prompt}\n\n${refs}`;
}

/**
 * Discord のメッセージ文字数上限。
 */
const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * テキストを Discord の文字数制限に収まるように分割する。
 *
 * 分割の優先順:
 * 1. 改行位置（後半に存在する場合）
 * 2. 強制分割（制限文字数で切る）
 */
export function splitMessage(
  text: string,
  limit: number = DISCORD_MESSAGE_LIMIT,
): string[] {
  if (!text) {
    return [];
  }

  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    // 後半の改行位置を探す
    const newline = rest.lastIndexOf("\n", limit);
    const cut = newline > limit / 2 ? newline : limit;

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }

  if (rest) {
    chunks.push(rest);
  }

  return chunks;
}

/**
 * typing インジケーターを維持する。
 *
 * Discord の typing インジケーターは約 10 秒で消えるため、
 * 10 秒ごとに `sendTyping()` を呼び続ける。
 * AbortSignal で停止する。
 *
 * @param channel - typing を送信するチャンネル
 * @param signal - 停止用 AbortSignal
 */
export function keepTyping(
  channel: GuildTextBasedChannel,
  signal: AbortSignal,
): void {
  if (signal.aborted) {
    return;
  }

  // 初回の typing 送信
  channel.sendTyping().catch(() => {});

  const id = setInterval(() => {
    if (signal.aborted) {
      clearInterval(id);
      return;
    }
    channel.sendTyping().catch(() => {});
  }, 10_000);

  signal.addEventListener("abort", () => clearInterval(id), { once: true });
}

/** スロットル間隔（ミリ秒）。Discord の message.edit() レート制限（5回/5秒）を考慮。 */
const PROGRESS_THROTTLE_MS = 3000;

/**
 * ツール実行の進捗を Discord メッセージで表示する。
 *
 * Discord の message.edit() レート制限を考慮し、最短 3 秒間隔でスロットルする。
 * 返り値の `report` で進捗を更新し、`cleanup` で進捗メッセージを削除する。
 */
export function createProgressReporter(
  channel: GuildTextBasedChannel,
  nowMs: () => number = () => Temporal.Now.instant().epochMilliseconds,
): {
  report: (toolName: string, elapsedSeconds: number) => Promise<void>;
  cleanup: () => Promise<void>;
} {
  let message: Awaited<ReturnType<GuildTextBasedChannel["send"]>> | null = null;
  let lastUpdate = 0;

  return {
    async report(toolName, elapsedSeconds) {
      const now = nowMs();
      if (now - lastUpdate < PROGRESS_THROTTLE_MS) {
        return;
      }

      // 並行呼び出し時の二重 send を防ぐため、await 前に更新
      lastUpdate = now;

      const text = `\`${toolName}\` 実行中... (${Math.round(elapsedSeconds)}s)`;

      if (!message) {
        message = await channel.send(text);
      } else {
        await message.edit(text).catch(() => {});
      }
    },

    async cleanup() {
      if (message) {
        await message.delete().catch(() => {});
        message = null;
      }
    },
  };
}
