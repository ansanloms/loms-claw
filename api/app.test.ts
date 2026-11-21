import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp } from "./app.ts";

describe("createApp", () => {
  test("GET /health が 200 と { status: ok } を返すこと", async () => {
    const res = await createApp().request("/health");
    assert.deepStrictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { status: "ok" });
  });
});
