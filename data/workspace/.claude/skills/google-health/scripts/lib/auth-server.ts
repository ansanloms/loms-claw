/**
 * OAuth2 のリダイレクトを localhost で受け取る一時 HTTP サーバ (`auth` コマンドから使う)。
 * 認可コードの交換 (ネットワークアクセスを伴う) は呼び出し側から注入し、このモジュール自体はネットワーク非依存にする。
 */
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** 認可コード受信後の結果。ok: false のときは reason に失敗理由 (人が読める文言) を持つ。 */
export type AuthServerOutcome = { ok: true } | { ok: false; reason: string };

export type RunAuthServerParams = {
  /** listen する port。0 を渡すと OS が空き port を選ぶ (テスト用)。 */
  port: number;
  /** listen する hostname。既定 "127.0.0.1"。 */
  hostname?: string;
  /** 受信した code を交換・保存する処理 (呼び出し側から注入)。例外を投げれば失敗として扱う。 */
  exchangeCode: (code: string) => Promise<void>;
  /** code・error のどちらも来ないまま経過したら失敗とみなす猶予 (ms)。既定 5 分。 */
  timeoutMs?: number;
  /** 実際に bind した port が確定した時点で呼ばれる (port: 0 指定時に実際の port を知るためのもの)。 */
  onListen?: (info: { port: number }) => void;
  /**
   * 認可 URL に付けた state。`/?code=`・`/?error=` を受けたとき、リクエストの state パラメータが
   * これと一致しない場合は 400 を返して listen を継続する (任意ページからの /?code= 注入対策)。
   */
  state: string;
};

export type RunAuthServerResult = AuthServerOutcome & {
  /** 実際に listen していた port。 */
  port: number;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}

function textResponse(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain;charset=UTF-8" });
  res.end(text);
}

function htmlResponse(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Google Health 認可</title><p>${escapeHtml(
      message,
    )}</p>`,
  );
}

/**
 * `127.0.0.1:<port>` で HTTP を listen し、`/?code=` を受けたら注入された exchangeCode で交換・保存して終了する。
 * `/?error=` を受けたら失敗として終了する。他パスは 404 を返して listen を継続する。
 * `/?code=`・`/?error=` はどちらも state が params.state と一致した場合のみ終了扱いにする。一致しない場合は
 * 400 を返して listen を継続する (任意ページから /?code= を注入されても待ち続ける)。
 * どちらも来ないまま timeoutMs を過ぎればタイムアウト失敗として終了する。
 */
export async function runAuthServer(
  params: RunAuthServerParams,
): Promise<RunAuthServerResult> {
  const hostname = params.hostname ?? "127.0.0.1";
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let settle: (outcome: AuthServerOutcome) => void;
  const outcome = new Promise<AuthServerOutcome>((resolve) => {
    settle = resolve;
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") {
        textResponse(res, 404, "not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error !== null) {
        if (url.searchParams.get("state") !== params.state) {
          textResponse(res, 400, "bad request (invalid or missing state)");
          return;
        }
        settle({
          ok: false,
          reason: `認可がエラーで終わった (error=${error})`,
        });
        htmlResponse(res, 400, "認可に失敗した。このタブは閉じてよい。");
        return;
      }

      const code = url.searchParams.get("code");
      if (code !== null) {
        if (url.searchParams.get("state") !== params.state) {
          textResponse(res, 400, "bad request (invalid or missing state)");
          return;
        }
        try {
          await params.exchangeCode(code);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          settle({ ok: false, reason });
          htmlResponse(
            res,
            400,
            "認可コードの交換に失敗した。このタブは閉じてよい。",
          );
          return;
        }
        settle({ ok: true });
        htmlResponse(res, 200, "認可完了。このタブは閉じてよい。");
        return;
      }

      textResponse(res, 404, "not found");
    } catch {
      // 想定外の例外でプロセスを落とさず、500 を返して listen を継続する (settle は呼ばない)。
      textResponse(res, 500, "internal error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port, hostname, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  const timer = setTimeout(() => {
    settle({
      ok: false,
      reason: `${timeoutMs}ms 以内に認可コードを受信できなかった (タイムアウト)`,
    });
  }, timeoutMs);

  params.onListen?.({ port });

  const result = await outcome;
  clearTimeout(timer);
  // keep-alive の待機接続だけを切って close を即時に完了させる。処理中の要求は切らず完了まで待つ。
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { port, ...result };
}
