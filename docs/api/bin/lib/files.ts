import { readdir } from "node:fs/promises";
import * as path from "node:path";

/** dir 配下の .yaml ファイル (symlink 含む) のフルパス一覧を再帰的に返す。 */
export const listYamlFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(
      (entry) => (entry.isFile() || entry.isSymbolicLink()) && path.extname(entry.name) === ".yaml",
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
};
