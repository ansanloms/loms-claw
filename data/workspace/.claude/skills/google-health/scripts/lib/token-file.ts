/**
 * トークンファイル (access_token・refresh_token・expires_in 等) の読み書きと期限判定・更新。
 */
import { open, readFile, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TokenConfig } from "./config.ts";
import type { ExchangeCodeResponse, RefreshResponse } from "./oauth.ts";
import { refreshToken as requestRefreshToken } from "./oauth.ts";

/** この package の scripts ディレクトリ (エラー文のコマンド案内用)。 */
const SCRIPTS_DIR = resolve(import.meta.dirname, "..");

export type StoredToken = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  scope: string;
  token_type: string;
  /** トークンを取得・更新した時刻 (RFC3339, UTC)。 */
  obtained_at: string;
  /**
   * refresh_token を取得・更新した時刻 (RFC3339, UTC)。refresh 応答に refresh_token_expires_in が
   * 含まれるときだけ obtained_at とともに更新する。旧形式のファイル (このフィールドが無い) を読んだ場合は
   * obtained_at を fallback として使う。
   */
  refresh_token_obtained_at?: string;
};

const REQUIRED_STRING_FIELDS = [
  "access_token",
  "refresh_token",
  "scope",
  "token_type",
  "obtained_at",
] as const;
const REQUIRED_NUMBER_FIELDS = [
  "expires_in",
  "refresh_token_expires_in",
] as const;

/** トークンファイルを読む。無い・壊れている場合は例外。 */
export async function readTokenFile(path: string): Promise<StoredToken> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (e) {
    throw new Error(
      `トークンファイル (${path}) が読めない。先に token コマンドで取得する (親ディレクトリ ${dirname(
        path,
      )} が無い場合は事前に作成しておく): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (text.length === 0) {
    throw new Error(
      `トークンファイル (${path}) が空。未認可の可能性がある。\`npx --no --prefix "${SCRIPTS_DIR}" -- auth\` を実行する (localhost に届かない端末では auth-url と token <code> の組み合わせ)。`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`トークンファイル (${path}) が JSON として解釈できない`);
  }
  const rec =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : undefined;
  const ok =
    rec !== undefined &&
    REQUIRED_STRING_FIELDS.every((k) => typeof rec[k] === "string") &&
    REQUIRED_NUMBER_FIELDS.every((k) => typeof rec[k] === "number");
  if (!ok) {
    throw new Error(
      `トークンファイル (${path}) に必要なフィールドが揃っていない`,
    );
  }
  return rec as unknown as StoredToken;
}

/**
 * トークンファイルの親ディレクトリが存在し書き込めるかを、ネットワークに出る前に検査する。
 * ファイルのパスだけを扱い、親ディレクトリの mkdir はしない。ファイルパス自身への試し書き
 * (open。既存ファイルの内容は変更せず、位置を進めずに閉じる) で判定する。
 * ファイルが元から存在しなかった場合は排他作成 (`wx`) で存在確認と作成を兼ねて
 * probe し、probe 後に unlink で削除して空ファイルを残さない (既存ファイルがある場合は上書き可否だけを見る)。
 */
export async function assertTokenPathWritable(path: string): Promise<void> {
  let file: FileHandle;
  let created: boolean;
  try {
    try {
      file = await open(path, "wx", 0o600);
      created = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw e;
      }
      // 書き込み専用・切り詰め無し。ディレクトリなら EISDIR で止まる。
      file = await open(path, "a");
      created = false;
    }
  } catch (e) {
    const dir = dirname(path);
    throw new Error(
      `トークンファイル (${path}) の親ディレクトリ (${dir}) が無いか書き込めない。先に mkdir -p -m 700 ${dir} で作成しておく: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  await file.close();
  if (created) {
    await unlink(path);
  }
}

/**
 * トークンファイルを書く (パーミッション 0o600)。
 * 親ディレクトリは事前に存在している必要がある (作成はしない。ファイルのパスだけを扱う)。
 * 並列実行中の読み取りが truncate 中の内容を掴んだり、書き込み中断で refresh_token を失ったりしないよう、
 * `<path>.tmp` へ書いてから rename で置き換える (rename は同一ファイルシステム内ではアトミック)。
 * `.tmp` は 排他作成 (`wx`。O_EXCL 相当)する。datapoints と daily-rollup が同時に refresh すると
 * どちらも同じ `.tmp` へ書こうとし得るため、先着以外は EEXIST になり、先着の rename でパスが空くのを
 * 待って再試行する (intervalMs 間隔、最大 retries 回)。再試行しても空かない場合は他プロセスが書き込み中の
 * 可能性があるとして例外を投げる (他プロセスの `.tmp` を無断で削除はしない)。
 */
export async function writeTokenFile(
  path: string,
  token: StoredToken,
  retry: { retries?: number; intervalMs?: number } = {},
): Promise<void> {
  const { retries = 40, intervalMs = 50 } = retry;
  const tmpPath = `${path}.tmp`;
  let file: FileHandle;
  for (let attempt = 0; ; attempt++) {
    try {
      file = await open(tmpPath, "wx", 0o600);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        if (attempt >= retries) {
          throw new Error(
            `${tmpPath} が残っている。他のプロセスが書き込み中でなければ削除して再実行する。`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      throw new Error(
        `トークンファイル (${path}) が書けない。親ディレクトリ (${dirname(
          path,
        )}) が無い場合は事前に作成しておく: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  try {
    await file.writeFile(JSON.stringify(token, null, 2) + "\n");
    await file.close();
    await rename(tmpPath, path);
  } catch (e) {
    // 上の writeFile/close が成功済みなら二重 close になるだけなので無視する。
    await file.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw new Error(
      `トークンファイル (${path}) が書けない。親ディレクトリ (${dirname(
        path,
      )}) が無い場合は事前に作成しておく: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/**
 * obtained_at + expires_in (秒) - marginSeconds を過ぎていれば期限切れ (refresh 要) とみなす。
 * obtained_at が日時として解釈できない、または expires_in が有限数でない場合も期限切れとみなす。
 */
export function isExpired(
  token: StoredToken,
  now: Date = new Date(),
  marginSeconds = 60,
): boolean {
  const obtainedAt = new Date(token.obtained_at).getTime();
  if (!Number.isFinite(obtainedAt) || !Number.isFinite(token.expires_in)) {
    return true;
  }
  const expiresAt = obtainedAt + token.expires_in * 1000 - marginSeconds * 1000;
  return now.getTime() >= expiresAt;
}

/** /token (authorization_code) のレスポンスから StoredToken を組み立てる。 */
export function toStoredToken(
  resp: ExchangeCodeResponse,
  now: Date,
): StoredToken {
  return {
    access_token: resp.access_token,
    expires_in: resp.expires_in,
    refresh_token: resp.refresh_token,
    refresh_token_expires_in: resp.refresh_token_expires_in,
    scope: resp.scope,
    token_type: resp.token_type,
    obtained_at: now.toISOString(),
    refresh_token_obtained_at: now.toISOString(),
  };
}

/**
 * refresh 成功時に StoredToken を更新する。access_token・expires_in・obtained_at は必ず更新する。
 * refresh_token はレスポンスに含まれていればそれで差し替え (無ければ前回の値を維持)、
 * refresh_token_expires_in・refresh_token_obtained_at はレスポンスに refresh_token_expires_in が
 * 含まれているときだけ組で更新する (含まれていなければ両方とも据え置く。obtained_at だけ更新すると
 * token-status の残り日数が refresh のたびに延びてしまう)。
 */
export function applyRefresh(
  prev: StoredToken,
  resp: RefreshResponse,
  now: Date,
): StoredToken {
  return {
    ...prev,
    access_token: resp.access_token,
    expires_in: resp.expires_in,
    obtained_at: now.toISOString(),
    refresh_token: resp.refresh_token ?? prev.refresh_token,
    ...(resp.refresh_token_expires_in !== undefined
      ? {
          refresh_token_expires_in: resp.refresh_token_expires_in,
          refresh_token_obtained_at: now.toISOString(),
        }
      : {}),
  };
}

export type TokenStatus = {
  access_token_expires_in_sec: number;
  refresh_token_expires_in_days: number;
  refresh_token_expired: boolean;
};

/**
 * token-status コマンド向けの残り時間計算。refresh_token_expires_in_days は小数第 1 位に丸める。
 * refresh_token の残り日数は refresh_token_obtained_at (旧形式ファイルで無ければ obtained_at を
 * fallback) + refresh_token_expires_in で計算する。expired の判定は表示用に丸めた日数ではなく、
 * 生の残り秒数 (<= 0) で行う (丸めた日数で判定すると、残り 1 時間でも 0.0 日に丸まって失効扱いになる)。
 * obtained_at・refresh_token_obtained_at (fallback 込み) が日時として解釈できない場合はトークンファイルが
 * 壊れているとみなして例外を投げる。
 */
export function computeTokenStatus(
  token: StoredToken,
  now: Date = new Date(),
): TokenStatus {
  const obtainedAt = new Date(token.obtained_at).getTime();
  const refreshTokenObtainedAt = new Date(
    token.refresh_token_obtained_at ?? token.obtained_at,
  ).getTime();
  if (
    !Number.isFinite(obtainedAt) ||
    !Number.isFinite(refreshTokenObtainedAt)
  ) {
    throw new Error(
      `トークンファイルが壊れている (obtained_at を解釈できない)。\`npx --no --prefix "${SCRIPTS_DIR}" -- auth\` で再認可すること (localhost に届かない端末では auth-url と token <code> の組み合わせ)。`,
    );
  }
  const accessTokenExpiresInSec = Math.round(
    (obtainedAt + token.expires_in * 1000 - now.getTime()) / 1000,
  );
  const refreshTokenExpiresInRawSec =
    (refreshTokenObtainedAt +
      token.refresh_token_expires_in * 1000 -
      now.getTime()) /
    1000;
  const refreshTokenExpiresInDays =
    Math.round((refreshTokenExpiresInRawSec / (60 * 60 * 24)) * 10) / 10;
  return {
    access_token_expires_in_sec: accessTokenExpiresInSec,
    refresh_token_expires_in_days: refreshTokenExpiresInDays,
    refresh_token_expired: refreshTokenExpiresInRawSec <= 0,
  };
}

/**
 * 有効なアクセストークンを返す。期限切れなら refresh_token で更新し、トークンファイルへ書き戻す。
 * refresh に失敗した場合は auth コマンド (SKILL.md 参照) での再認可が必要な旨を添えた例外を投げる。
 */
export async function getValidToken(
  config: TokenConfig,
  fetchFn: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<StoredToken> {
  const token = await readTokenFile(config.tokenPath);
  if (!isExpired(token, now)) {
    return token;
  }
  let resp: RefreshResponse;
  try {
    resp = await requestRefreshToken(
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: token.refresh_token,
      },
      fetchFn,
    );
  } catch (e) {
    throw new Error(
      `アクセストークンの更新に失敗した (${
        e instanceof Error ? e.message : String(e)
      })。refresh_token が失効している可能性がある。\`npx --no --prefix "${SCRIPTS_DIR}" -- auth\` で再認可すること (localhost に届かない端末では auth-url と token <code> の組み合わせ)。`,
    );
  }
  const next = applyRefresh(token, resp, now);
  await writeTokenFile(config.tokenPath, next);
  return next;
}
