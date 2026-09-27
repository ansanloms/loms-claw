import { assertEquals, assertThrows } from "@std/assert";
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
    saved.set(name, Deno.env.get(name));
  }
  try {
    for (const name of VARS) {
      Deno.env.delete(name);
    }
    for (const [name, value] of Object.entries(vars)) {
      if (value !== undefined) {
        Deno.env.set(name, value);
      }
    }
    fn();
  } finally {
    for (const name of VARS) {
      const v = saved.get(name);
      if (v === undefined) {
        Deno.env.delete(name);
      } else Deno.env.set(name, v);
    }
  }
}

Deno.test("loadAuthUrlConfig: GOOGLE_HEALTH_CLIENT_ID 未設定は変数名を含む例外", () => {
  withEnv({}, () => {
    assertThrows(
      () => loadAuthUrlConfig(),
      Error,
      "GOOGLE_HEALTH_CLIENT_ID",
    );
  });
});

Deno.test("loadAuthUrlConfig: CLIENT_ID が揃えば読める (redirectUri は既定 port から組み立て)", () => {
  withEnv({ GOOGLE_HEALTH_CLIENT_ID: "cid" }, () => {
    const config = loadAuthUrlConfig();
    assertEquals(config.clientId, "cid");
    assertEquals(config.redirectUri, "http://localhost:8765");
  });
});

Deno.test("loadAuthUrlConfig: port を渡すと redirectUri がその port になる", () => {
  withEnv({ GOOGLE_HEALTH_CLIENT_ID: "cid" }, () => {
    const config = loadAuthUrlConfig(9999);
    assertEquals(config.redirectUri, "http://localhost:9999");
  });
});

Deno.test("loadTokenConfig: GOOGLE_HEALTH_CLIENT_ID 未設定は変数名を含む例外", () => {
  withEnv({
    GOOGLE_HEALTH_CLIENT_SECRET: "secret",
    GOOGLE_HEALTH_TOKEN_PATH: "/tmp/t.json",
  }, () => {
    assertThrows(
      () => loadTokenConfig(),
      Error,
      "GOOGLE_HEALTH_CLIENT_ID",
    );
  });
});

Deno.test("loadTokenConfig: GOOGLE_HEALTH_CLIENT_SECRET 未設定は変数名を含む例外", () => {
  withEnv({
    GOOGLE_HEALTH_CLIENT_ID: "cid",
    GOOGLE_HEALTH_TOKEN_PATH: "/tmp/t.json",
  }, () => {
    assertThrows(
      () => loadTokenConfig(),
      Error,
      "GOOGLE_HEALTH_CLIENT_SECRET",
    );
  });
});

Deno.test("loadTokenConfig: GOOGLE_HEALTH_TOKEN_PATH 未設定は変数名を含む例外", () => {
  withEnv({
    GOOGLE_HEALTH_CLIENT_ID: "cid",
    GOOGLE_HEALTH_CLIENT_SECRET: "secret",
  }, () => {
    assertThrows(
      () => loadTokenConfig(),
      Error,
      "GOOGLE_HEALTH_TOKEN_PATH",
    );
  });
});

Deno.test("loadTokenConfig: 必須が揃えば読める (redirectUri は既定 port から組み立て)", () => {
  withEnv(
    {
      GOOGLE_HEALTH_CLIENT_ID: "cid",
      GOOGLE_HEALTH_CLIENT_SECRET: "secret",
      GOOGLE_HEALTH_TOKEN_PATH: "/tmp/t.json",
    },
    () => {
      const config = loadTokenConfig();
      assertEquals(config.clientId, "cid");
      assertEquals(config.clientSecret, "secret");
      assertEquals(config.tokenPath, "/tmp/t.json");
      assertEquals(config.redirectUri, "http://localhost:8765");
    },
  );
});

Deno.test("loadTokenConfig: port を渡すと redirectUri がその port になる", () => {
  withEnv(
    {
      GOOGLE_HEALTH_CLIENT_ID: "cid",
      GOOGLE_HEALTH_CLIENT_SECRET: "secret",
      GOOGLE_HEALTH_TOKEN_PATH: "/tmp/t.json",
    },
    () => {
      const config = loadTokenConfig(9999);
      assertEquals(config.redirectUri, "http://localhost:9999");
    },
  );
});

Deno.test("loadTokenPathConfig: GOOGLE_HEALTH_TOKEN_PATH 未設定は変数名を含む例外", () => {
  withEnv({}, () => {
    assertThrows(
      () => loadTokenPathConfig(),
      Error,
      "GOOGLE_HEALTH_TOKEN_PATH",
    );
  });
});

Deno.test("loadTokenPathConfig: TOKEN_PATH が揃えば読める", () => {
  withEnv({ GOOGLE_HEALTH_TOKEN_PATH: "/tmp/t.json" }, () => {
    const config = loadTokenPathConfig();
    assertEquals(config.tokenPath, "/tmp/t.json");
  });
});
