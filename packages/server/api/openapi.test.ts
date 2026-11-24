import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { describe, mock, test } from "node:test";
import { Hono } from "hono";
import { errorWith } from "../test-helpers.ts";
import { createTokenRegistry, parseUserTokens } from "../auth/tokens.ts";
import {
  handleError,
  jsonBody,
  parseAllowedRoles,
  secured,
} from "./openapi.ts";
import type { AuthEnv } from "./openapi.ts";

const USER_TOKEN = "user-token";
const registry = createTokenRegistry(
  parseUserTokens(`cli=${hash("sha256", USER_TOKEN, "hex")}`),
);

function createTestApp(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.onError(handleError);
  app.get("/approvals", secured(registry, "getApprovals"), (c) =>
    c.json({ source: c.get("principal").source }, 200),
  );
  app.post("/reload", secured(registry, "postScheduledTasksReload"), (c) =>
    c.json({ ok: true }, 200),
  );
  app.get("/boom", () => {
    throw new Error("boom");
  });
  app.post("/turns", jsonBody("postThreadsThreadIdTurns"), (c) =>
    c.json(c.req.valid("json"), 200),
  );
  return app;
}

async function post(body: unknown): Promise<Response> {
  return await createTestApp().request("/turns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("jsonBody", () => {
  test("定義どおりの body は 200 になること", async () => {
    const res = await post({ prompt: "hi" });
    assert.deepStrictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { prompt: "hi" });
  });

  test("必須のキーが無い body は 400 になること", async () => {
    const res = await post({});
    assert.deepStrictEqual(res.status, 400);
  });

  test("定義に無いキーは 400 になること", async () => {
    const res = await post({ prompt: "hi", unknown: 1 });
    assert.deepStrictEqual(res.status, 400);
  });

  test("source を渡すと 400 になること", async () => {
    const res = await post({ prompt: "hi", source: "client:cli" });
    assert.deepStrictEqual(res.status, 400);
  });

  test("空白だけの prompt は 400 になること", async () => {
    const res = await post({ prompt: "   " });
    assert.deepStrictEqual(res.status, 400);
  });

  test("effort に語彙外の値を渡すと 400 になること", async () => {
    const res = await post({ prompt: "hi", effort: "invalid" });
    assert.deepStrictEqual(res.status, 400);
  });

  test("400 の応答が { error: string } の形であること", async () => {
    const res = await post({});
    const body: unknown = await res.json();
    assert.ok(typeof body === "object" && body !== null);
    assert.deepStrictEqual(Object.keys(body), ["error"]);
    assert.ok("error" in body && typeof body.error === "string");
  });

  test("JSON として読めない body は { error: string } の 400 になること", async () => {
    const res = await createTestApp().request("/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    assert.deepStrictEqual(res.status, 400);
    const body: unknown = await res.json();
    assert.ok(typeof body === "object" && body !== null);
    assert.deepStrictEqual(Object.keys(body), ["error"]);
    assert.ok("error" in body && typeof body.error === "string");
  });

  test('HTTPException 以外の例外は { error: "Internal Server Error" } の 500 になること', async () => {
    const spy = mock.method(console, "error", () => {});
    try {
      const res = await createTestApp().request("/boom");
      assert.deepStrictEqual(res.status, 500);
      assert.deepStrictEqual(await res.json(), {
        error: "Internal Server Error",
      });
    } finally {
      spy.mock.restore();
    }
  });

  test("存在しない operationId は例外を投げること", () => {
    assert.throws(
      () => jsonBody("noSuchOperation" as never),
      errorWith(Error, "operation が無い"),
    );
  });

  test("requestBody の無い operationId は例外を投げること", () => {
    assert.throws(
      () => jsonBody("getApprovals"),
      errorWith(Error, "JSON の requestBody が無い"),
    );
  });
});

async function get(
  path: string,
  authorization?: string,
  method = "GET",
): Promise<Response> {
  return await createTestApp().request(path, {
    method,
    headers: authorization === undefined ? {} : { authorization },
  });
}

async function assertErrorBody(res: Response): Promise<void> {
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body: unknown = await res.json();
  assert.ok(typeof body === "object" && body !== null);
  assert.deepStrictEqual(Object.keys(body), ["error"]);
  assert.ok("error" in body && typeof body.error === "string");
}

describe("secured", () => {
  test("Authorization ヘッダが無いと 401 と WWW-Authenticate を返すこと", async () => {
    const res = await get("/approvals");
    assert.deepStrictEqual(res.status, 401);
    assert.deepStrictEqual(
      res.headers.get("www-authenticate"),
      'Bearer realm="loms-claw"',
    );
    await assertErrorBody(res);
  });

  test("形式が不正な Authorization ヘッダは 400 と invalid_request を返すこと", async () => {
    const res = await get("/approvals", "Basic abc");
    assert.deepStrictEqual(res.status, 400);
    assert.deepStrictEqual(
      res.headers.get("www-authenticate"),
      'Bearer error="invalid_request"',
    );
    await assertErrorBody(res);
  });

  test("未知の token は 401 と invalid_token を返すこと", async () => {
    const res = await get("/approvals", "Bearer unknown");
    assert.deepStrictEqual(res.status, 401);
    assert.deepStrictEqual(
      res.headers.get("www-authenticate"),
      'Bearer error="invalid_token"',
    );
    await assertErrorBody(res);
  });

  test("user の token は通り、出所を c.get(principal) で読めること", async () => {
    const res = await get("/approvals", `Bearer ${USER_TOKEN}`);
    assert.deepStrictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { source: "client:cli" });
  });

  test("agent の一時 token は通ること", async () => {
    const token = registry.issueAgentToken("turn:t-0001");
    try {
      const res = await get("/approvals", `Bearer ${token}`);
      assert.deepStrictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), { source: "turn:t-0001" });
    } finally {
      registry.revokeAgentToken(token);
    }
  });

  test("失効した一時 token は 401 になること", async () => {
    const token = registry.issueAgentToken("turn:t-0001");
    registry.revokeAgentToken(token);
    const res = await get("/approvals", `Bearer ${token}`);
    assert.deepStrictEqual(res.status, 401);
  });

  test("user 限定の operation は user の token で通ること", async () => {
    const res = await get("/reload", `Bearer ${USER_TOKEN}`, "POST");
    assert.deepStrictEqual(res.status, 200);
  });

  test("user 限定の operation を agent の token で呼ぶと 403 と insufficient_scope を返すこと", async () => {
    const token = registry.issueAgentToken("turn:t-0001");
    try {
      const res = await get("/reload", `Bearer ${token}`, "POST");
      assert.deepStrictEqual(res.status, 403);
      assert.deepStrictEqual(
        res.headers.get("www-authenticate"),
        'Bearer error="insufficient_scope"',
      );
      await assertErrorBody(res);
    } finally {
      registry.revokeAgentToken(token);
    }
  });

  test("存在しない operationId は例外を投げること", () => {
    assert.throws(
      () => secured(registry, "noSuchOperation" as never),
      errorWith(Error, "operation が無い"),
    );
  });
});

describe("parseAllowedRoles", () => {
  test("空配列は認証なしとして undefined になること", () => {
    assert.deepStrictEqual(parseAllowedRoles("op", []), undefined);
  });

  test("1 ロールの要件はそのロールの集合になること", () => {
    assert.deepStrictEqual(
      parseAllowedRoles("op", [{ bearerAuth: ["user"] }]),
      new Set(["user"]),
    );
  });

  test("要件を分けた 2 ロールは両方の集合になること", () => {
    assert.deepStrictEqual(
      parseAllowedRoles("op", [
        { bearerAuth: ["user"] },
        { bearerAuth: ["agent"] },
      ]),
      new Set(["user", "agent"]),
    );
  });

  test("security が配列でないと例外を投げること", () => {
    assert.throws(
      () => parseAllowedRoles("op", undefined),
      errorWith(Error, "security が無い"),
    );
  });

  test("要素がオブジェクトでないと例外を投げること", () => {
    assert.throws(
      () => parseAllowedRoles("op", ["bearerAuth"]),
      errorWith(Error, "オブジェクトでない"),
    );
  });

  test("未知のロールは例外を投げること", () => {
    assert.throws(
      () => parseAllowedRoles("op", [{ bearerAuth: ["admin"] }]),
      errorWith(Error, "未知のロール"),
    );
  });

  test("空のロール配列は例外を投げること", () => {
    assert.throws(
      () => parseAllowedRoles("op", [{ bearerAuth: [] }]),
      errorWith(Error, "ロールが空"),
    );
  });

  test("bearerAuth 以外のスキームは例外を投げること", () => {
    assert.throws(
      () => parseAllowedRoles("op", [{ apiKey: [] }]),
      errorWith(Error, "未対応の security scheme"),
    );
  });

  test("空の要件 {} は例外を投げること", () => {
    assert.throws(
      () => parseAllowedRoles("op", [{}]),
      errorWith(Error, "要素が空"),
    );
  });

  test("1 つの要件に複数のロールを書くと例外を投げること", () => {
    assert.throws(
      () => parseAllowedRoles("op", [{ bearerAuth: ["user", "agent"] }]),
      errorWith(Error, "複数のロール"),
    );
  });
});
