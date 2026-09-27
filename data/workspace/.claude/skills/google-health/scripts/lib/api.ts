/**
 * Google Health API (health.googleapis.com) への疎通。
 * Bearer 認証・ページネーション・非 2xx レスポンスの整形を担う。ネットワーク非依存にするため fetch は注入できる。
 */

export const API_BASE = "https://health.googleapis.com/v4";

/** 非 2xx レスポンスを表す例外。HTTP ステータスと生ボディを保持する。 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** 非 2xx レスポンスを検査し、HTTP ステータスと生ボディを含む例外を投げる。 */
async function ensureOk(res: Response, label: string): Promise<string> {
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(
      res.status,
      text,
      `${label} 取得失敗 (HTTP ${res.status}): ${text}`,
    );
  }
  return text;
}

/**
 * レスポンス本文 (生テキスト) を JSON として解釈し、配列部分 (arrayKey) と nextPageToken を取り出す。
 * JSON として解釈できない、レスポンスがオブジェクトでない、または arrayKey が配列として存在するのに
 * 配列でない場合は API 構造変化の可能性として例外にする (エラーメッセージに応答本文の先頭 200 文字を添える)。
 * arrayKey 自体が無い場合は、proto3 の JSON マッピングで空の repeated field がまるごと省略される
 * (ページネーションの最終ページが `{}` になる。2026-09-26 実測、steps 6 ページ目) ため、
 * 正常終端 (items: [], nextPageToken なし) として扱い、黙って握り潰さない範囲でエラーにしない。
 */
function extractPage(
  text: string,
  arrayKey: string,
): { items: unknown[]; nextPageToken?: string } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `レスポンスが JSON として解釈できない (API 構造変化の可能性)。応答本文 (先頭 200 文字): ${
        text.slice(0, 200)
      }`,
    );
  }
  if (typeof body !== "object" || body === null) {
    throw new Error(
      `レスポンスがオブジェクトでない (API 構造変化の可能性)。応答本文 (先頭 200 文字): ${
        text.slice(0, 200)
      }`,
    );
  }
  const rec = body as Record<string, unknown>;
  const page = rec[arrayKey];
  if (page !== undefined && !Array.isArray(page)) {
    throw new Error(
      `レスポンスの ${arrayKey} が配列でない (API 構造変化の可能性)。応答本文 (先頭 200 文字): ${
        text.slice(0, 200)
      }`,
    );
  }
  const next = rec.nextPageToken;
  return {
    items: Array.isArray(page) ? page : [],
    nextPageToken: typeof next === "string" && next !== "" ? next : undefined,
  };
}

/** GET でページネーション (query の pageToken) を辿り、指定のキー配下の配列を全ページ結合して返す。 */
export async function getPaginated(
  url: string,
  accessToken: string,
  arrayKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const u = new URL(url);
    if (pageToken !== undefined) {
      u.searchParams.set("pageToken", pageToken);
    }
    const res = await fetchFn(u, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await ensureOk(res, u.toString());
    const page = extractPage(text, arrayKey);
    items.push(...page.items);
    if (page.nextPageToken === undefined) {
      break;
    }
    pageToken = page.nextPageToken;
  }
  return items;
}

/** POST でページネーション (body の pageToken) を辿り、指定のキー配下の配列を全ページ結合して返す。 */
export async function postPaginated(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  arrayKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const reqBody = pageToken !== undefined ? { ...body, pageToken } : body;
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });
    const text = await ensureOk(res, url);
    const page = extractPage(text, arrayKey);
    items.push(...page.items);
    if (page.nextPageToken === undefined) {
      break;
    }
    pageToken = page.nextPageToken;
  }
  return items;
}
