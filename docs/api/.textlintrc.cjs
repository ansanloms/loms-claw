// rules / plugins は node_modules のパッケージ名で解決する。
//   - "@ansanloms/preset-ansanloms"             -> @ansanloms/textlint-rule-preset-ansanloms (git 依存)
//   - "@ansanloms/textlint-plugin-yaml-keys"    -> @ansanloms/textlint-plugin-yaml-keys (git 依存)
// 両パッケージは GitHub のタグを git 依存 (package.json の github:ansanloms/<repo>#<tag>) で参照して
// いる。Dependabot は git 依存を更新しないため、バージョン更新は package.json のタグを手で書き換えて
// `npm install` で lockfile を更新する。redocly-plugin-inline-examples も同様。
//
// 個別 rule の options は preset 側 (ansanloms/textlint-rule-preset-ansanloms) が持ち、ここでは上書きしない。
module.exports = {
  plugins: {
    "@ansanloms/textlint-plugin-yaml-keys": {
      // 抽出対象とする yaml キー。`*` / `[]` / 階層パス対応。詳細は ansanloms/textlint-plugin-yaml-keys を参照。
      keys: ["description", "summary"],
    },
  },
  rules: {
    "@ansanloms/preset-ansanloms": true,
  },
};
