import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "token-status.ts");

/** 親プロセスの GOOGLE_HEALTH_* を持ち込まないよう、子の環境変数を明示的に組み立てて実行する。 */
function runTokenStatus(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [CLI], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** 一時ディレクトリにトークンファイルを作り、fn に絶対パスを渡す。終了後に削除する。 */
async function withTokenFile(
  obtainedAt: Date,
  fn: (path: string) => void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "token-status-test-"));
  try {
    const path = join(dir, "token.json");
    await writeFile(
      path,
      JSON.stringify({
        access_token: "dummy-access",
        expires_in: 3600,
        refresh_token: "dummy-refresh",
        refresh_token_expires_in: 7 * 24 * 60 * 60,
        scope: "dummy",
        token_type: "Bearer",
        obtained_at: obtainedAt.toISOString(),
      }),
    );
    fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("token-status: refresh_token が失効していれば exit 2 で stdout は空", async () => {
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await withTokenFile(old, (path) => {
    const r = runTokenStatus({ GOOGLE_HEALTH_TOKEN_PATH: path });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /失効/);
  });
});

test("token-status: GOOGLE_HEALTH_TOKEN_PATH が未設定なら exit 1", () => {
  const r = runTokenStatus({});
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /GOOGLE_HEALTH_TOKEN_PATH/);
});

test("token-status: トークンファイルが読めなければ exit 1", () => {
  const r = runTokenStatus({
    GOOGLE_HEALTH_TOKEN_PATH: join(
      tmpdir(),
      "token-status-test-missing",
      "x.json",
    ),
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
});

test("token-status: 有効なトークンなら exit 0 で JSON を出す", async () => {
  await withTokenFile(new Date(), (path) => {
    const r = runTokenStatus({ GOOGLE_HEALTH_TOKEN_PATH: path });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.refresh_token_expired, false);
  });
});
