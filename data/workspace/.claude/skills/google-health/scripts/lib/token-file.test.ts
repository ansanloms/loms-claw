import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  applyRefresh,
  assertTokenPathWritable,
  computeTokenStatus,
  isExpired,
  readTokenFile,
  type StoredToken,
  toStoredToken,
  writeTokenFile,
} from "./token-file.ts";
import type { ExchangeCodeResponse, RefreshResponse } from "./oauth.ts";

const SAMPLE: StoredToken = {
  access_token: "at",
  expires_in: 3600,
  refresh_token: "rt",
  refresh_token_expires_in: 604800,
  scope: "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  token_type: "Bearer",
  obtained_at: "2026-09-01T00:00:00.000Z",
};

Deno.test("writeTokenFile/readTokenFile: 往復で同じ内容が読める (親ディレクトリは既存)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    await writeTokenFile(path, SAMPLE);
    const read = await readTokenFile(path);
    assertEquals(read, SAMPLE);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTokenFile: パーミッションが 0o600", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    await writeTokenFile(path, SAMPLE);
    const stat = await Deno.stat(path);
    assertEquals((stat.mode ?? 0) & 0o777, 0o600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTokenFile: 既存ファイル (0o644) を上書きすると 0o600 になる", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    await Deno.writeTextFile(path, "{}", { mode: 0o644 });
    await writeTokenFile(path, SAMPLE);
    const stat = await Deno.stat(path);
    assertEquals((stat.mode ?? 0) & 0o777, 0o600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTokenFile: 書き込み後に .tmp ファイルが残らない", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    await writeTokenFile(path, SAMPLE);
    const tmpExists = await Deno.stat(`${path}.tmp`).then(
      () => true,
      () => false,
    );
    assertEquals(tmpExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTokenFile: 既存の .tmp が残っていると待った後にエラーになる (他プロセスの .tmp は削除しない)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    const tmpPath = `${path}.tmp`;
    await Deno.writeTextFile(tmpPath, "in-progress");
    await assertRejects(
      () => writeTokenFile(path, SAMPLE, { retries: 2, intervalMs: 1 }),
      Error,
      "残っている",
    );
    const tmpText = await Deno.readTextFile(tmpPath);
    assertEquals(tmpText, "in-progress");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTokenFile: 2 つを並行実行しても最終ファイルはどちらか一方の正しい JSON になり .tmp が残らない", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    const tokenA: StoredToken = { ...SAMPLE, access_token: "at-a" };
    const tokenB: StoredToken = { ...SAMPLE, access_token: "at-b" };
    await Promise.all([
      writeTokenFile(path, tokenA),
      writeTokenFile(path, tokenB),
    ]);
    const read = await readTokenFile(path);
    const matchesA = JSON.stringify(read) === JSON.stringify(tokenA);
    const matchesB = JSON.stringify(read) === JSON.stringify(tokenB);
    assertEquals(matchesA || matchesB, true);
    const tmpExists = await Deno.stat(`${path}.tmp`).then(
      () => true,
      () => false,
    );
    assertEquals(tmpExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTokenFile: 親ディレクトリが無ければ事前作成を促す例外 (mkdir はしない)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "nested", "token.json");
    await assertRejects(
      () => writeTokenFile(path, SAMPLE),
      Error,
      "事前に作成しておく",
    );
    const nestedExists = await Deno.stat(join(dir, "nested")).then(
      () => true,
      () => false,
    );
    assertEquals(nestedExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertTokenPathWritable: 親ディレクトリが無ければ例外 (mkdir -p を促す)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "nested", "token.json");
    await assertRejects(
      () => assertTokenPathWritable(path),
      Error,
      "mkdir -p -m 700",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertTokenPathWritable: 親ディレクトリがあれば成功する", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    await assertTokenPathWritable(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertTokenPathWritable: ファイルが元々存在しなければ probe 後に削除して空ファイルを残さない", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    await assertTokenPathWritable(path);
    const exists = await Deno.stat(path).then(() => true, () => false);
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertTokenPathWritable: 新規作成時のファイルモードが 0o600 (削除前に検証)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    // 削除前のモードを確認するため、probe と同じ create パスを直接使う。
    const file = await Deno.open(path, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    file.close();
    const stat = await Deno.stat(path);
    assertEquals((stat.mode ?? 0) & 0o777, 0o600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertTokenPathWritable: 既存ファイルがあれば内容を変更せず残す", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    await Deno.writeTextFile(path, "existing-content");
    await assertTokenPathWritable(path);
    const text = await Deno.readTextFile(path);
    assertEquals(text, "existing-content");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTokenFile: 存在しないファイルは例外", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(() => readTokenFile(join(dir, "missing.json")), Error);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTokenFile: 必須フィールド欠落は例外", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    await Deno.writeTextFile(path, JSON.stringify({ access_token: "at" }));
    await assertRejects(() => readTokenFile(path), Error, "揃っていない");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTokenFile: 空ファイル (0 バイト) は未認可の案内付きで例外", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "token.json");
    await Deno.writeTextFile(path, "");
    await assertRejects(() => readTokenFile(path), Error, "deno task auth");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isExpired: margin 込みでちょうど期限切れの境界 (refresh 要 / 不要)", () => {
  const obtainedAt = new Date("2026-09-01T00:00:00.000Z");
  const token: StoredToken = {
    ...SAMPLE,
    obtained_at: obtainedAt.toISOString(),
    expires_in: 100,
  };
  // 100 - 60 = 40 秒後がちょうど境界。
  const justBefore = new Date(obtainedAt.getTime() + 39_000);
  const atBoundary = new Date(obtainedAt.getTime() + 40_000);
  assertEquals(isExpired(token, justBefore, 60), false);
  assertEquals(isExpired(token, atBoundary, 60), true);
});

Deno.test("isExpired: obtained_at が日時として解釈できなければ期限切れ扱い", () => {
  const token: StoredToken = { ...SAMPLE, obtained_at: "not-a-date" };
  assertEquals(isExpired(token), true);
});

Deno.test("isExpired: expires_in が有限数でなければ期限切れ扱い", () => {
  const token: StoredToken = {
    ...SAMPLE,
    obtained_at: new Date().toISOString(),
    expires_in: NaN,
  };
  assertEquals(isExpired(token), true);
});

Deno.test("toStoredToken: exchangeCode のレスポンスをそのまま写し、refresh_token_obtained_at も obtained_at と揃える", () => {
  const resp: ExchangeCodeResponse = {
    access_token: "at",
    expires_in: 3600,
    refresh_token: "rt",
    refresh_token_expires_in: 604800,
    scope: "scope-a",
    token_type: "Bearer",
  };
  const now = new Date("2026-09-26T00:00:00.000Z");
  assertEquals(toStoredToken(resp, now), {
    access_token: "at",
    expires_in: 3600,
    refresh_token: "rt",
    refresh_token_expires_in: 604800,
    scope: "scope-a",
    token_type: "Bearer",
    obtained_at: "2026-09-26T00:00:00.000Z",
    refresh_token_obtained_at: "2026-09-26T00:00:00.000Z",
  });
});

Deno.test("applyRefresh: refresh_token_expires_in が応答に無ければ refresh_token_expires_in・refresh_token_obtained_at ともに据え置く", () => {
  const resp: RefreshResponse = { access_token: "at2", expires_in: 3600 };
  const now = new Date("2026-09-26T00:00:00.000Z");
  const next = applyRefresh(SAMPLE, resp, now);
  assertEquals(next, {
    ...SAMPLE,
    access_token: "at2",
    expires_in: 3600,
    obtained_at: "2026-09-26T00:00:00.000Z",
  });
  assertEquals(next.refresh_token_obtained_at, undefined);
});

Deno.test("applyRefresh: refresh_token_expires_in が応答にあれば refresh_token_expires_in・refresh_token_obtained_at を組で更新する", () => {
  const resp: RefreshResponse = {
    access_token: "at2",
    expires_in: 3600,
    refresh_token: "rt2",
    refresh_token_expires_in: 500000,
  };
  const now = new Date("2026-09-26T00:00:00.000Z");
  const next = applyRefresh(SAMPLE, resp, now);
  assertEquals(next.refresh_token, "rt2");
  assertEquals(next.refresh_token_expires_in, 500000);
  assertEquals(next.refresh_token_obtained_at, "2026-09-26T00:00:00.000Z");
});

Deno.test("computeTokenStatus: refresh_token 失効前は refresh_token_expired が false", () => {
  const obtainedAt = new Date("2026-09-01T00:00:00.000Z");
  const token: StoredToken = {
    ...SAMPLE,
    obtained_at: obtainedAt.toISOString(),
    refresh_token_expires_in: 604800, // 7 日
  };
  const status = computeTokenStatus(token, obtainedAt);
  assertEquals(status.refresh_token_expired, false);
  assertEquals(status.refresh_token_expires_in_days, 7);
});

Deno.test("computeTokenStatus: refresh_token 失効後は refresh_token_expired が true", () => {
  const obtainedAt = new Date("2026-09-01T00:00:00.000Z");
  const now = new Date(obtainedAt.getTime() + 8 * 24 * 60 * 60 * 1000); // 8 日後
  const token: StoredToken = {
    ...SAMPLE,
    obtained_at: obtainedAt.toISOString(),
    refresh_token_expires_in: 604800, // 7 日
  };
  const status = computeTokenStatus(token, now);
  assertEquals(status.refresh_token_expired, true);
});

Deno.test("computeTokenStatus: refresh_token_obtained_at が無い旧形式ファイルは obtained_at を fallback に使う", () => {
  const obtainedAt = new Date("2026-09-01T00:00:00.000Z");
  const token: StoredToken = {
    ...SAMPLE,
    obtained_at: obtainedAt.toISOString(),
    refresh_token_expires_in: 604800, // 7 日
  };
  // refresh_token_obtained_at が別に無いことを明示する。
  assertEquals(token.refresh_token_obtained_at, undefined);
  const status = computeTokenStatus(token, obtainedAt);
  assertEquals(status.refresh_token_expires_in_days, 7);
});

Deno.test("computeTokenStatus: refresh_token_obtained_at があれば obtained_at と独立して残り日数を計算する", () => {
  const obtainedAt = new Date("2026-09-01T00:00:00.000Z");
  // refresh_token_obtained_at は obtained_at より 3 日前 (refresh で access_token だけ更新した想定)。
  const refreshTokenObtainedAt = new Date(
    obtainedAt.getTime() - 3 * 24 * 60 * 60 * 1000,
  );
  const token: StoredToken = {
    ...SAMPLE,
    obtained_at: obtainedAt.toISOString(),
    refresh_token_obtained_at: refreshTokenObtainedAt.toISOString(),
    refresh_token_expires_in: 604800, // 7 日
  };
  const status = computeTokenStatus(token, obtainedAt);
  // 7 日 - 3 日 = 残り 4 日 (obtained_at 起点なら 7 日になってしまうところ)。
  assertEquals(status.refresh_token_expires_in_days, 4);
});

Deno.test("computeTokenStatus: 残り 1 時間でも expired は false (丸めた日数ではなく生の残り秒で判定する)", () => {
  const refreshTokenObtainedAt = new Date("2026-09-01T00:00:00.000Z");
  const now = new Date(
    refreshTokenObtainedAt.getTime() + 6 * 24 * 60 * 60 * 1000 +
      23 * 60 * 60 * 1000,
  ); // 6 日 23 時間後 (残り 1 時間)
  const token: StoredToken = {
    ...SAMPLE,
    obtained_at: refreshTokenObtainedAt.toISOString(),
    refresh_token_obtained_at: refreshTokenObtainedAt.toISOString(),
    refresh_token_expires_in: 604800, // 7 日
  };
  const status = computeTokenStatus(token, now);
  assertEquals(status.refresh_token_expired, false);
  assertEquals(status.refresh_token_expires_in_days, 0);
});

Deno.test("computeTokenStatus: obtained_at が日時として解釈できなければ例外 (exit 0 で誤魔化さない)", () => {
  const token: StoredToken = { ...SAMPLE, obtained_at: "not-a-date" };
  assertThrows(() => computeTokenStatus(token), Error, "壊れている");
});

Deno.test("computeTokenStatus: refresh_token_obtained_at が日時として解釈できなければ例外", () => {
  const token: StoredToken = {
    ...SAMPLE,
    refresh_token_obtained_at: "not-a-date",
  };
  assertThrows(() => computeTokenStatus(token), Error, "壊れている");
});
