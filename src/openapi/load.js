import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

export async function loadOpenApiDocument(inputPath) {
  try {
    if (inputPath.startsWith("https://") || inputPath.startsWith("http://")) {
      return loadFromUrl(inputPath);
    }

    return loadFromFile(inputPath);
  } catch (err) {
    throw err;
  }
}

async function loadFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch spec from "${url}": ${response.status} ${response.statusText}`);
  }

  const source = await response.text();
  const extension = path.extname(new URL(url).pathname).toLowerCase();

  if (extension === ".json") {
    return JSON.parse(source);
  }

  if (extension === ".yaml" || extension === ".yml") {
    return parseYaml(source);
  }

  return parseYaml(source);
}

async function loadFromFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".json") {
    return JSON.parse(source);
  }

  if (extension === ".yaml" || extension === ".yml") {
    return parseYaml(source);
  }

  throw new Error(`Unsupported OpenAPI file extension "${extension}"`);
}
