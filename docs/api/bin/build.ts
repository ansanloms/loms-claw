import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = ["web-components.min.js", "web-components.min.js.LICENSE.txt", "styles.min.css"];

const __dirname = import.meta.dirname;
const INDEX_HTML_PATH = path.join(__dirname, "./../index.html");

const entryUrl = import.meta.resolve("@stoplight/elements/web-components.min.js");
const baseDir = path.dirname(fileURLToPath(entryUrl));

const to = process.argv.slice(2)[0] ?? "./dist";
await mkdir(to, { recursive: true });

for (const asset of ASSETS) {
  const src = path.join(baseDir, asset);
  const dest = path.join(to, asset);
  await copyFile(src, dest);
  console.log(`copied: ${asset} -> ${dest}`);
}

const indexHtml = await readFile(INDEX_HTML_PATH, "utf8");
const rewritten = indexHtml
  .replaceAll(
    /https:\/\/unpkg\.com\/@stoplight\/elements(?:@[^/]+)?\/web-components\.min\.js/g,
    "./web-components.min.js",
  )
  .replaceAll(
    /https:\/\/unpkg\.com\/@stoplight\/elements(?:@[^/]+)?\/styles\.min\.css/g,
    "./styles.min.css",
  );
const indexDest = path.join(to, "index.html");
await writeFile(indexDest, rewritten);
console.log(`written: index.html -> ${indexDest}`);
