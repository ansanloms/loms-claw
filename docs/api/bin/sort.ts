import { readFile, writeFile } from "node:fs/promises";
import * as yaml from "yaml";
import * as path from "node:path";
import type { OpenAPIV3_1 } from "openapi-types";

const __dirname = import.meta.dirname;

const API_DOC_PATH = path.join(__dirname, "./../api.yaml");

const sortKeys = <T>(
  source: Record<string, T>,
  comparator?: (a: string, b: string) => number,
): Record<string, T> =>
  (comparator ? Object.keys(source).sort(comparator) : Object.keys(source).sort()).reduce<
    Record<string, T>
  >((acc, key) => {
    acc[key] = source[key];
    return acc;
  }, {});

const schemasComparator = (a: string, b: string): number => {
  const weight = (name: string): string => {
    if (name.startsWith("Enum")) {
      return `1${name}`;
    }
    if (name.startsWith("Request")) {
      return `2${name}`;
    }
    if (name.startsWith("Response")) {
      return `3${name}`;
    }
    return `0${name}`;
  };
  return weight(a).localeCompare(weight(b));
};

const main = async () => {
  const apiDoc = yaml.parse(await readFile(API_DOC_PATH, "utf8")) as OpenAPIV3_1.Document;

  if (apiDoc.paths) {
    apiDoc.paths = sortKeys(apiDoc.paths);
  }
  if (apiDoc.components?.schemas) {
    apiDoc.components.schemas = sortKeys(apiDoc.components.schemas, schemasComparator);
  }
  if (apiDoc.components?.securitySchemes) {
    apiDoc.components.securitySchemes = sortKeys(apiDoc.components.securitySchemes);
  }

  await writeFile(API_DOC_PATH, yaml.stringify(apiDoc, { lineWidth: -1 }));
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
