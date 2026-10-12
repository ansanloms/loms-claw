import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadAuthUrlConfig,
  loadTokenConfig,
  loadTokenPathConfig,
} from "./config.ts";

const VARS = [
  "GOOGLE_HEALTH_CLIENT_ID",
  "GOOGLE_HEALTH_CLIENT_SECRET",
  "GOOGLE_HEALTH_TOKEN_PATH",
] as const;

/** 対象の環境変数を退避し、テスト後に元へ戻す。 */
function withEnv(
  vars: Partial<Record<(typeof VARS)[number], string>>,
  fn: () => void,
): void {
  const saved = new Map<string, string | undefined>();
  for (const name of VARS) {
    saved.set(name, process.env[name]);
  }
  try {
    for (const name of VARS) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(vars)) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
    fn();
  } finally {
    for (const name of VARS) {
      const v = saved.get(name);
      if (v === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = v;
      }
    }
  }
}

test("loadAuthUrlConfig: GOOGLE_HEALTH_CLIENT_ID 未設定は変数名を含む例外", () => {
  withEnv({}, () => {
    assert.throws(() => loadAuthUrlConfig(), /GOOGLE_HEALTH_CLIENT_ID/);
  });
});

test("loadAuthUrlConfig: CLIENT_ID が揃えば読める (redirectUri は既定 port から組み立て)", () => {
  withEnv({ GOOGLE_HEALTH_CLIENT_ID: "cid" }, () => {
    const config = loadAuthUrlConfig();
    assert.deepEqual(config.clientId, "cid");
    assert.deepEqual(config.redirectUri, "http://localhost:8765");
  });
});

test("loadAuthUrlConfig: port を渡すと redirectUri がその port になる", () => {
  withEnv({ GOOGLE_HEALTH_CLIENT_ID: "cid" }, () => {
    const config = loadAuthUrlConfig(9999);
    assert.deepEqual(config.redirectUri, "http://localhost:9999");
  });
});

test("loadTokenConfig: GOOGLE_HEALTH_CLIENT_ID 未設定は変数名を含む例外", () => {
  withEnv(
    {
      GOOGLE_HEALTH_CLIENT_SECRET: "secret",
      GOOGLE_HEALTH_TOKEN_PATH: "/tmp/t.json",
    },
    () => {
      assert.throws(() => loadTokenConfig(), /GOOGLE_HEALTH_CLIENT_ID/);
    },
  );
});

test("loadTokenConfig: GOOGLE_HEALTH_CLIENT_SECRET 未設定は変数名を含む例外", () => {
  withEnv(
    {
      GOOGLE_HEALTH_CLIENT_ID: "cid",
      GOOGLE_HEALTH_TOKEN_PATH: "/tmp/t.json",
    },
    () => {
      assert.throws(() => loadTokenConfig(), /GOOGLE_HEALTH_CLIENT_SECRET/);
    },
  );
});

test("loadTokenConfig: GOOGLE_HEALTH_TOKEN_PATH 未設定は変数名を含む例外", () => {
  withEnv(
    {
      GOOGLE_HEALTH_CLIENT_ID: "cid",
      GOOGLE_HEALTH_CLIENT_SECRET: "secret",
    },
    () => {
      assert.throws(() => loadTokenConfig(), /GOOGLE_HEALTH_TOKEN_PATH/);
    },
  );
});

test("loadTokenConfig: 必須が揃えば読める (redirectUri は既定 port から組み立て)", () => {
  withEnv(
    {
      GOOGLE_HEALTH_CLIENT_ID: "cid",
      GOOGLE_HEALTH_CLIENT_SECRET: "secret",
      GOOGLE_HEALTH_TOKEN_PATH: "/tmp/t.json",
    },
    () => {
      const config = loadTokenConfig();
      assert.deepEqual(config.clientId, "cid");
      assert.deepEqual(config.clientSecret, "secret");
      assert.deepEqual(config.tokenPath, "/tmp/t.json");
      assert.deepEqual(config.redirectUri, "http://localhost:8765");
    },
  );
});

test("loadTokenConfig: port を渡すと redirectUri がその port になる", () => {
  withEnv(
    {
      GOOGLE_HEALTH_CLIENT_ID: "cid",
      GOOGLE_HEALTH_CLIENT_SECRET: "secret",
      GOOGLE_HEALTH_TOKEN_PATH: "/tmp/t.json",
    },
    () => {
      const config = loadTokenConfig(9999);
      assert.deepEqual(config.redirectUri, "http://localhost:9999");
    },
  );
});

test("loadTokenPathConfig: GOOGLE_HEALTH_TOKEN_PATH 未設定は変数名を含む例外", () => {
  withEnv({}, () => {
    assert.throws(() => loadTokenPathConfig(), /GOOGLE_HEALTH_TOKEN_PATH/);
  });
});

test("loadTokenPathConfig: TOKEN_PATH が揃えば読める", () => {
  withEnv({ GOOGLE_HEALTH_TOKEN_PATH: "/tmp/t.json" }, () => {
    const config = loadTokenPathConfig();
    assert.deepEqual(config.tokenPath, "/tmp/t.json");
  });
});
