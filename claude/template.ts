/**
 * システムプロンプトのテンプレート変数置換。
 *
 * `{{key}}` 形式のプレースホルダーを実際の値で置換する。
 * ドット記法（`{{discord.channel.id}}`）に対応。
 */

/**
 * テンプレート文字列中の `{{key}}` を `vars` の値で置換する。
 *
 * - キーはワード文字とドットで構成される（`[\w.]+`）。
 * - `vars` に存在しないキーはそのまま残る。
 *
 * @param template - テンプレート文字列。
 * @param vars - 置換変数のマップ。
 * @returns 置換後の文字列。
 */
export function replaceTemplateVariables(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });
}
