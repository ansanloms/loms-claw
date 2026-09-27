import { assertEquals, assertRejects } from "@std/assert";
import { getPaginated, HttpError, request } from "./api.ts";

/** globalThis.fetch を差し替えて fn を実行し、実行後に元へ戻す。 */
async function withMockedFetch<T>(
  mockFn: typeof fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("getPaginated: nextPageToken を辿って全ページの配列を結合する", async () => {
  let calls = 0;
  const mockFn: typeof fetch = (input) => {
    calls++;
    const u = new URL(input instanceof URL ? input : String(input));
    if (u.searchParams.get("pageToken") === null) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ dataPoints: [{ id: 1 }], nextPageToken: "p2" }),
          { status: 200 },
        ),
      );
    }
    assertEquals(u.searchParams.get("pageToken"), "p2");
    return Promise.resolve(
      new Response(
        JSON.stringify({ dataPoints: [{ id: 2 }], nextPageToken: "" }),
        { status: 200 },
      ),
    );
  };

  const items = await withMockedFetch(
    mockFn,
    () =>
      getPaginated("https://health.googleapis.com/v4/x", "token", "dataPoints"),
  );
  assertEquals(items, [{ id: 1 }, { id: 2 }]);
  assertEquals(calls, 2);
});

Deno.test("getPaginated: 呼び出し元が付けた pageSize クエリを全ページで維持する", async () => {
  let calls = 0;
  const mockFn: typeof fetch = (input) => {
    calls++;
    const u = new URL(input instanceof URL ? input : String(input));
    assertEquals(u.searchParams.get("pageSize"), "10000");
    if (u.searchParams.get("pageToken") === null) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ dataPoints: [{ id: 1 }], nextPageToken: "p2" }),
          { status: 200 },
        ),
      );
    }
    assertEquals(u.searchParams.get("pageToken"), "p2");
    return Promise.resolve(
      new Response(
        JSON.stringify({ dataPoints: [{ id: 2 }], nextPageToken: "" }),
        { status: 200 },
      ),
    );
  };

  const items = await withMockedFetch(
    mockFn,
    () =>
      getPaginated(
        "https://health.googleapis.com/v4/x?pageSize=10000",
        "token",
        "dataPoints",
      ),
  );
  assertEquals(items, [{ id: 1 }, { id: 2 }]);
  assertEquals(calls, 2);
});

Deno.test("getPaginated: 非 2xx は HTTP ステータスとボディを含む HttpError", async () => {
  const mockFn: typeof fetch = () =>
    Promise.resolve(new Response("bad request body", { status: 400 }));

  await assertRejects(
    () =>
      withMockedFetch(
        mockFn,
        () =>
          getPaginated(
            "https://health.googleapis.com/v4/x",
            "token",
            "dataPoints",
          ),
      ),
    HttpError,
    "HTTP 400",
  );
});

Deno.test("getPaginated: 配列キーが欠落している場合は proto3 の空配列省略として正常終端扱い (items は空)", async () => {
  // ページネーションの最終ページで dataPoints・nextPageToken の両方が省略された `{}` を模する
  // (2026-09-26 実測、steps 6 ページ目)。
  const mockFn: typeof fetch = () =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));

  const items = await withMockedFetch(
    mockFn,
    () =>
      getPaginated("https://health.googleapis.com/v4/x", "token", "dataPoints"),
  );
  assertEquals(items, []);
});

Deno.test("getPaginated: 配列キーが存在するが配列でない場合は例外", async () => {
  const mockFn: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ dataPoints: "not-an-array" }), {
        status: 200,
      }),
    );

  await assertRejects(
    () =>
      withMockedFetch(
        mockFn,
        () =>
          getPaginated(
            "https://health.googleapis.com/v4/x",
            "token",
            "dataPoints",
          ),
      ),
    Error,
    "配列でない",
  );
});

Deno.test("getPaginated: レスポンスがオブジェクトでない場合は例外", async () => {
  const mockFn: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify("just a string"), { status: 200 }),
    );

  await assertRejects(
    () =>
      withMockedFetch(
        mockFn,
        () =>
          getPaginated(
            "https://health.googleapis.com/v4/x",
            "token",
            "dataPoints",
          ),
      ),
    Error,
    "オブジェクトでない",
  );
});

Deno.test("request: GET は body・Content-Type 無しで Authorization のみ付けて送り、本文を返す", async () => {
  let calls = 0;
  const mockFn: typeof fetch = (input, init) => {
    calls++;
    assertEquals(String(input), "https://health.googleapis.com/v4/x");
    assertEquals(init?.method, "GET");
    assertEquals(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer token",
    );
    assertEquals(
      (init?.headers as Record<string, string>)["Content-Type"],
      undefined,
    );
    assertEquals(init?.body, undefined);
    return Promise.resolve(new Response('{"name":"x"}', { status: 200 }));
  };
  const text = await request(
    "https://health.googleapis.com/v4/x",
    "token",
    "GET",
    undefined,
    mockFn,
  );
  assertEquals(text, '{"name":"x"}');
  assertEquals(calls, 1);
});

Deno.test("request: body を渡すと method・Content-Type・JSON 本文で送る", async () => {
  const mockFn: typeof fetch = (_input, init) => {
    assertEquals(init?.method, "POST");
    assertEquals(
      (init?.headers as Record<string, string>)["Content-Type"],
      "application/json",
    );
    assertEquals(init?.body, JSON.stringify({ foo: "bar" }));
    return Promise.resolve(new Response('{"done":true}', { status: 200 }));
  };
  const text = await request(
    "https://health.googleapis.com/v4/x",
    "token",
    "POST",
    { foo: "bar" },
    mockFn,
  );
  assertEquals(text, '{"done":true}');
});

Deno.test("request: 非 2xx は HTTP ステータスとボディを含む HttpError", async () => {
  const mockFn: typeof fetch = () =>
    Promise.resolve(new Response("bad request body", { status: 400 }));
  await assertRejects(
    () =>
      request(
        "https://health.googleapis.com/v4/x",
        "token",
        "PATCH",
        { foo: "bar" },
        mockFn,
      ),
    HttpError,
    "HTTP 400",
  );
});

Deno.test("getPaginated: JSON として解釈できないレスポンスは生の SyntaxError ではなく本文付きの例外", async () => {
  const mockFn: typeof fetch = () =>
    Promise.resolve(new Response("not json", { status: 200 }));

  await assertRejects(
    () =>
      withMockedFetch(
        mockFn,
        () =>
          getPaginated(
            "https://health.googleapis.com/v4/x",
            "token",
            "dataPoints",
          ),
      ),
    Error,
    "not json",
  );
});
