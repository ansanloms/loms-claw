/**
 * Google Health API の OAuth2 (認可コードフロー) 関連。
 * ネットワーク非依存にするため、fetch は呼び出し側から注入できる (テスト用)。
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** 既定スコープ (4 系統 (activity_and_fitness・health_metrics_and_measurements・sleep・nutrition) × readonly/writeonly の 8 種)。 */
export const DEFAULT_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.writeonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.writeonly",
  "https://www.googleapis.com/auth/googlehealth.nutrition.readonly",
  "https://www.googleapis.com/auth/googlehealth.nutrition.writeonly",
];

export type AuthUrlParams = {
  clientId: string;
  redirectUri: string;
  /** 取得スコープ。URL には空白区切りで載せる。 */
  scopes: readonly string[];
  /** CSRF 対策の state。auth コマンドではリダイレクト受信時にこの値との一致を検証する。 */
  state: string;
};

/** 認可 URL を組み立てる。ブラウザで開いてユーザが認可コードを取得するためのもの。 */
export function buildAuthUrl(params: AuthUrlParams): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  return url.toString();
}

/** CSRF 対策の state をランダムに生成する (32 バイトの hex 文字列)。 */
export function generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** authorization_code 交換のレスポンス。 */
export type ExchangeCodeResponse = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  scope: string;
  token_type: string;
};

/** refresh_token 更新のレスポンス。refresh_token・refresh_token_expires_in は返らないことがある。 */
export type RefreshResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

/** レスポンス本文を JSON として解釈する。失敗すれば API 構造変化の可能性として例外。 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "/token のレスポンスが JSON として解釈できない (API 構造変化の可能性)。値を捏造せず停止する。",
    );
  }
}

/** 非 2xx レスポンスを検査し、HTTP ステータスと生ボディを含む例外を投げる。 */
async function ensureOk(res: Response): Promise<string> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`/token 取得失敗 (HTTP ${res.status}): ${text}`);
  }
  return text;
}

/** /token へ POST し、JSON としてパースした本文を返す (grant の種類によらず共通)。 */
async function postToken(
  grantParams: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(grantParams),
  });
  const text = await ensureOk(res);
  return parseJson(text);
}

export type ExchangeCodeParams = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
};

/** 認可コードをアクセストークン・リフレッシュトークンに交換する。 */
export async function exchangeCode(
  params: ExchangeCodeParams,
  fetchFn: typeof fetch = fetch,
): Promise<ExchangeCodeResponse> {
  const body = await postToken({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code: params.code,
  }, fetchFn);
  const rec = typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : undefined;
  if (
    rec === undefined ||
    typeof rec.access_token !== "string" ||
    typeof rec.expires_in !== "number" ||
    typeof rec.refresh_token !== "string" ||
    typeof rec.refresh_token_expires_in !== "number" ||
    typeof rec.scope !== "string" ||
    typeof rec.token_type !== "string"
  ) {
    throw new Error(
      "/token のレスポンスに access_token・expires_in・refresh_token・refresh_token_expires_in・scope・token_type が揃っていない (API 構造変化の可能性)。値を捏造せず停止する。",
    );
  }
  return rec as unknown as ExchangeCodeResponse;
}

export type RefreshTokenParams = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

/**
 * リフレッシュトークンでアクセストークンを更新する。redirect_uri は refresh_token grant では不要。
 * レスポンスに refresh_token・refresh_token_expires_in が含まれない場合は、呼び出し側で直前の値を引き継ぐ。
 */
export async function refreshToken(
  params: RefreshTokenParams,
  fetchFn: typeof fetch = fetch,
): Promise<RefreshResponse> {
  const body = await postToken({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  }, fetchFn);
  const rec = typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : undefined;
  if (
    rec === undefined ||
    typeof rec.access_token !== "string" ||
    typeof rec.expires_in !== "number" ||
    (rec.refresh_token !== undefined &&
      typeof rec.refresh_token !== "string") ||
    (rec.refresh_token_expires_in !== undefined &&
      typeof rec.refresh_token_expires_in !== "number")
  ) {
    throw new Error(
      "/token のレスポンスに access_token・expires_in が揃っていない (API 構造変化の可能性)。値を捏造せず停止する。",
    );
  }
  return {
    access_token: rec.access_token as string,
    expires_in: rec.expires_in as number,
    refresh_token: rec.refresh_token as string | undefined,
    refresh_token_expires_in: rec.refresh_token_expires_in as
      | number
      | undefined,
  };
}
