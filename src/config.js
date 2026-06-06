import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

const VALID_OUTPUT_MODES = new Set(["single", "split"]);
const LANGUAGE_ALIASES = new Map([
  ["ts", "typescript"],
  ["typescript", "typescript"],
  ["go", "golang"],
  ["golang", "golang"],
]);

export const DEFAULT_TYPESCRIPT_LAYOUT = {
  models: "models.ts",
  requests: "requests.ts",
  responses: "responses.ts",
  operations: "operations.ts",
  client: "client.ts",
  metadata: "metadata.ts",
  barrel: "index.ts",
};

export const DEFAULT_GOLANG_LAYOUT = {
  single: "types.gen.go",
  models: "models.go",
  requests: "requests.go",
  responses: "responses.go",
  operations: "operations.go",
  client: "client.go",
  metadata: "metadata.go",
};

export const DEFAULT_LAYOUT = DEFAULT_TYPESCRIPT_LAYOUT;

export async function loadGeneratorConfig(filePath) {
  const source = await readFile(filePath, "utf8");
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".json") {
    return JSON.parse(source);
  }

  if (extension === ".yaml" || extension === ".yml") {
    return parseYaml(source) ?? {};
  }

  throw new Error(`Unsupported config file extension "${extension}"`);
}

export function resolveGenerateOptions(cliOptions, fileConfig = {}) {
  if (!cliOptions.input) {
    throw new Error("Missing required option --input");
  }

  if (!cliOptions.output) {
    throw new Error("Missing required option --output");
  }

  const language = normalizeLanguage(
    cliOptions.language ?? fileConfig.language ?? "typescript",
  );
  const outputMode = cliOptions.outputMode ?? fileConfig.outputMode ?? "split";

  if (!VALID_OUTPUT_MODES.has(outputMode)) {
    throw new Error(`Unsupported output mode "${outputMode}"`);
  }

  const layout = {
    ...getDefaultLayout(language),
    ...(fileConfig.layout ?? {}),
  };

  return {
    input: cliOptions.input,
    output: cliOptions.output,
    language,
    outputMode,
    layout,
    packageName:
      cliOptions.packageName ??
      fileConfig.packageName ??
      createDefaultPackageName(cliOptions.output),
  };
}

export function normalizeLanguage(language) {
  const normalized = LANGUAGE_ALIASES.get(String(language).toLowerCase());
  if (!normalized) {
    throw new Error(`Unsupported language "${language}"`);
  }

  return normalized;
}

export function getDefaultLayout(language) {
  switch (language) {
    case "typescript":
      return DEFAULT_TYPESCRIPT_LAYOUT;
    case "golang":
      return DEFAULT_GOLANG_LAYOUT;
    default:
      throw new Error(`Unsupported language "${language}"`);
  }
}

function createDefaultPackageName(outputPath) {
  const baseName = path.basename(outputPath || "generated");
  const sanitized = baseName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^[^a-z_]+/, "");

  return sanitized || "generated";
}
