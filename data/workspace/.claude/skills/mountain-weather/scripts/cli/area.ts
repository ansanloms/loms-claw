/**
 * 気象庁 area.json の正規化・検索。
 * ネットワーク非依存 (テスト可能)。取得・キャッシュ管理は cli/find-area.ts が行う。
 */

type ChildNode = { name: string; parent: string };

/** area.json のうち区域解決に必要な部分だけを正規化した形 (offices の parent は空)。 */
export type AreaData = {
  offices: Record<string, ChildNode>;
  class10s: Record<string, ChildNode>;
  class15s: Record<string, ChildNode>;
  class20s: Record<string, ChildNode>;
};

export type AreaMatch = {
  class20: { code: string; name: string };
  class10: { code: string; name: string };
  office: { code: string; name: string };
};

function pick(
  section: unknown,
  withParent: boolean,
  label: string,
): Record<string, ChildNode> {
  if (typeof section !== "object" || section === null) {
    throw new Error(
      `area.json に ${label} が無い (構造変化の可能性)。値を捏造せず停止する。`,
    );
  }
  const out: Record<string, ChildNode> = {};
  for (const [code, node] of Object.entries(section)) {
    const name = (node as { name?: unknown }).name;
    const parent = (node as { parent?: unknown }).parent;
    if (
      typeof name !== "string" || (withParent && typeof parent !== "string")
    ) {
      throw new Error(
        `area.json の ${label}.${code} に name/parent が無い (構造変化の可能性)。値を捏造せず停止する。`,
      );
    }
    out[code] = { name, parent: withParent ? (parent as string) : "" };
  }
  return out;
}

/** 生の area.json から必要フィールドのみ抜き出し、構造を検証する。 */
export function stripAreaJson(raw: unknown): AreaData {
  const r = raw as Record<string, unknown>;
  return {
    offices: pick(r.offices, false, "offices"),
    class10s: pick(r.class10s, true, "class10s"),
    class15s: pick(r.class15s, true, "class15s"),
    class20s: pick(r.class20s, true, "class20s"),
  };
}

/**
 * 市町村・地区名 (部分一致) から class20s → class15s → class10 → office を
 * 決定的に辿る。親の欠けたエントリは候補から除く (捏造しない)。
 */
export function resolveMunicipality(
  data: AreaData,
  query: string,
): AreaMatch[] {
  const matches: AreaMatch[] = [];
  for (const [c20code, c20] of Object.entries(data.class20s)) {
    if (!c20.name.includes(query)) {
      continue;
    }
    const c15 = data.class15s[c20.parent];
    const c10code = c15?.parent ?? "";
    const c10 = data.class10s[c10code];
    const office = c10 === undefined ? undefined : data.offices[c10.parent];
    if (c10 === undefined || office === undefined) {
      continue;
    }
    matches.push({
      class20: { code: c20code, name: c20.name },
      class10: { code: c10code, name: c10.name },
      office: { code: c10.parent, name: office.name },
    });
  }
  return matches;
}
