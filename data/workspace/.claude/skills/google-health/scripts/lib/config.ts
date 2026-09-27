/**
 * 環境変数から Google Health API の設定を読み込む。
 * 用途 (auth-url / token-status / token・datapoints・daily-rollup) ごとに必須項目が違うため、関数を分けてある。
 * redirect_uri は環境変数にせず、localhost リスナー (`auth` コマンド) の port から組み立てる
 * (`http://localhost:<port>`)。port は呼び出し側 (CLI の `--port`) から渡し、省略時は DEFAULT_PORT を使う。
 */

/** redirect_uri・`auth` コマンドの既定 listen port。Cloud Console にはこの port の URI を登録する。 */
export const DEFAULT_PORT = 8765;

/** port から redirect_uri を組み立てる。 */
export function redirectUriForPort(port: number): string {
  return `http://localhost:${port}`;
}

/** 必須環境変数を読む。無ければ変数名を含むエラーを投げる。 */
function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") {
    throw new Error(`環境変数 ${name} が未設定`);
  }
  return value;
}

/** auth-url コマンド向けの設定。client_secret は不要。 */
export type AuthUrlConfig = {
  clientId: string;
  redirectUri: string;
};

export function loadAuthUrlConfig(port: number = DEFAULT_PORT): AuthUrlConfig {
  return {
    clientId: requireEnv("GOOGLE_HEALTH_CLIENT_ID"),
    redirectUri: redirectUriForPort(port),
  };
}

/** token・datapoints・daily-rollup コマンド向けの設定。トークンファイルの読み書きに使う。 */
export type TokenConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath: string;
};

export function loadTokenConfig(port: number = DEFAULT_PORT): TokenConfig {
  return {
    clientId: requireEnv("GOOGLE_HEALTH_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_HEALTH_CLIENT_SECRET"),
    redirectUri: redirectUriForPort(port),
    tokenPath: requireEnv("GOOGLE_HEALTH_TOKEN_PATH"),
  };
}

/** token-status コマンド向けの設定。refresh を行わないため client_id・client_secret は不要。 */
export type TokenPathConfig = {
  tokenPath: string;
};

export function loadTokenPathConfig(): TokenPathConfig {
  return {
    tokenPath: requireEnv("GOOGLE_HEALTH_TOKEN_PATH"),
  };
}
