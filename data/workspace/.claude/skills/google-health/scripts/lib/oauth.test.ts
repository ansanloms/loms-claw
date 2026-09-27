import { assertEquals, assertRejects } from "@std/assert";
import {
  buildAuthUrl,
  DEFAULT_SCOPES,
  exchangeCode,
  generateState,
  refreshToken,
} from "./oauth.ts";

Deno.test("buildAuthUrl: client_id・redirect_uri・response_type・access_type・prompt・scope・state を含む", () => {
  const url = new URL(
    buildAuthUrl({
      clientId: "cid",
      redirectUri: "https://www.google.com",
      scopes: DEFAULT_SCOPES,
      state: "state-value",
    }),
  );
  assertEquals(
    url.origin + url.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  assertEquals(url.searchParams.get("client_id"), "cid");
  assertEquals(url.searchParams.get("redirect_uri"), "https://www.google.com");
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("access_type"), "offline");
  assertEquals(url.searchParams.get("prompt"), "consent");
  assertEquals(url.searchParams.get("scope"), DEFAULT_SCOPES.join(" "));
  assertEquals(url.searchParams.get("state"), "state-value");
});

Deno.test("DEFAULT_SCOPES: 既定スコープは 3 つ", () => {
  assertEquals(DEFAULT_SCOPES.length, 3);
});

Deno.test("generateState: 64 文字の hex 文字列で、呼ぶたびに異なる値になる", () => {
  const a = generateState();
  const b = generateState();
  assertEquals(/^[0-9a-f]{64}$/.test(a), true);
  assertEquals(/^[0-9a-f]{64}$/.test(b), true);
  assertEquals(a === b, false);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

Deno.test("exchangeCode: 正常系は access_token 等の全フィールドを返す", async () => {
  const fetchFn = (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(init?.body as string);
    assertEquals(body.get("grant_type"), "authorization_code");
    assertEquals(body.get("client_id"), "cid");
    assertEquals(body.get("client_secret"), "secret");
    assertEquals(body.get("redirect_uri"), "https://www.google.com");
    assertEquals(body.get("code"), "auth-code");
    return Promise.resolve(
      jsonResponse({
        access_token: "at",
        expires_in: 3600,
        refresh_token: "rt",
        refresh_token_expires_in: 604800,
        scope: "scope-a",
        token_type: "Bearer",
      }),
    );
  };
  const token = await exchangeCode(
    {
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "https://www.google.com",
      code: "auth-code",
    },
    fetchFn as typeof fetch,
  );
  assertEquals(token, {
    access_token: "at",
    expires_in: 3600,
    refresh_token: "rt",
    refresh_token_expires_in: 604800,
    scope: "scope-a",
    token_type: "Bearer",
  });
});

Deno.test("exchangeCode: 非 2xx は HTTP ステータスとボディを含む例外", async () => {
  const fetchFn = () =>
    Promise.resolve(new Response("bad request body", { status: 400 }));
  await assertRejects(
    () =>
      exchangeCode(
        {
          clientId: "cid",
          clientSecret: "secret",
          redirectUri: "https://www.google.com",
          code: "auth-code",
        },
        fetchFn as typeof fetch,
      ),
    Error,
    "HTTP 400",
  );
});

Deno.test("exchangeCode: フィールド欠落は例外", async () => {
  const fetchFn = () => Promise.resolve(jsonResponse({ access_token: "at" }));
  await assertRejects(
    () =>
      exchangeCode(
        {
          clientId: "cid",
          clientSecret: "secret",
          redirectUri: "https://www.google.com",
          code: "auth-code",
        },
        fetchFn as typeof fetch,
      ),
    Error,
    "揃っていない",
  );
});

Deno.test("refreshToken: 正常系は grant_type=refresh_token で交換する (redirect_uri は送らない)", async () => {
  const fetchFn = (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(init?.body as string);
    assertEquals(body.get("grant_type"), "refresh_token");
    assertEquals(body.get("client_id"), "cid");
    assertEquals(body.get("client_secret"), "secret");
    assertEquals(body.get("refresh_token"), "rt-old");
    assertEquals(body.get("redirect_uri"), null);
    return Promise.resolve(
      jsonResponse({
        access_token: "at2",
        expires_in: 3600,
        refresh_token: "rt2",
        refresh_token_expires_in: 604800,
      }),
    );
  };
  const token = await refreshToken(
    {
      clientId: "cid",
      clientSecret: "secret",
      refreshToken: "rt-old",
    },
    fetchFn as typeof fetch,
  );
  assertEquals(token.access_token, "at2");
});

Deno.test("refreshToken: レスポンスに refresh_token・refresh_token_expires_in が無ければ省略される", async () => {
  const fetchFn = () =>
    Promise.resolve(
      jsonResponse({
        access_token: "at2",
        expires_in: 3600,
        // refresh_token・refresh_token_expires_in を含めない。
      }),
    );
  const token = await refreshToken(
    {
      clientId: "cid",
      clientSecret: "secret",
      refreshToken: "rt-old",
    },
    fetchFn as typeof fetch,
  );
  assertEquals(token, {
    access_token: "at2",
    expires_in: 3600,
    refresh_token: undefined,
    refresh_token_expires_in: undefined,
  });
});

Deno.test("refreshToken: access_token・expires_in が欠けていれば例外", async () => {
  const fetchFn = () => Promise.resolve(jsonResponse({ expires_in: 100 }));
  await assertRejects(
    () =>
      refreshToken(
        {
          clientId: "cid",
          clientSecret: "secret",
          refreshToken: "rt-old",
        },
        fetchFn as typeof fetch,
      ),
    Error,
    "揃っていない",
  );
});

Deno.test("refreshToken: 非 2xx は HTTP ステータスとボディを含む例外", async () => {
  const fetchFn = () =>
    Promise.resolve(new Response("unauthorized", { status: 401 }));
  await assertRejects(
    () =>
      refreshToken(
        {
          clientId: "cid",
          clientSecret: "secret",
          refreshToken: "rt-old",
        },
        fetchFn as typeof fetch,
      ),
    Error,
    "HTTP 401",
  );
});
