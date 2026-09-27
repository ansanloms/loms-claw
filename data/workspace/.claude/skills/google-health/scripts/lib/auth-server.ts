/**
 * OAuth2 のリダイレクトを localhost で受け取る一時 HTTP サーバ (`auth` コマンドから使う)。
 * 認可コードの交換 (ネットワークアクセスを伴う) は呼び出し側から注入し、このモジュール自体はネットワーク非依存にする。
 */

/** 認可コード受信後の結果。ok: false のときは reason に失敗理由 (人が読める文言) を持つ。 */
export type AuthServerOutcome =
  | { ok: true }
  | { ok: false; reason: string };

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

function htmlResponse(status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Google Health 認可</title><p>${
      escapeHtml(message)
    }</p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
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

  const server = Deno.serve({
    hostname,
    port: params.port,
    onListen: () => {}, // 既定の "Listening on ..." ログを抑止する (案内は呼び出し側が出す)
  }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/") {
      return new Response("not found", { status: 404 });
    }

    const error = url.searchParams.get("error");
    if (error !== null) {
      if (url.searchParams.get("state") !== params.state) {
        return new Response("bad request (invalid or missing state)", {
          status: 400,
        });
      }
      settle({ ok: false, reason: `認可がエラーで終わった (error=${error})` });
      return htmlResponse(400, "認可に失敗した。このタブは閉じてよい。");
    }

    const code = url.searchParams.get("code");
    if (code !== null) {
      if (url.searchParams.get("state") !== params.state) {
        return new Response("bad request (invalid or missing state)", {
          status: 400,
        });
      }
      try {
        await params.exchangeCode(code);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        settle({ ok: false, reason });
        return htmlResponse(
          400,
          "認可コードの交換に失敗した。このタブは閉じてよい。",
        );
      }
      settle({ ok: true });
      return htmlResponse(200, "認可完了。このタブは閉じてよい。");
    }

    return new Response("not found", { status: 404 });
  });

  const timer = setTimeout(() => {
    settle({
      ok: false,
      reason:
        `${timeoutMs}ms 以内に認可コードを受信できなかった (タイムアウト)`,
    });
  }, timeoutMs);

  params.onListen?.({ port: server.addr.port });

  const result = await outcome;
  clearTimeout(timer);
  await server.shutdown();
  return { port: server.addr.port, ...result };
}
