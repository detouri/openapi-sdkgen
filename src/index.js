import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_LAYOUT,
  DEFAULT_GOLANG_LAYOUT,
  DEFAULT_TYPESCRIPT_LAYOUT,
  loadGeneratorConfig,
  resolveGenerateOptions,
} from "./config.js";
import { generateGolangSdk } from "./golang/generate.js";
import { buildIr } from "./openapi/ir.js";
import { loadOpenApiDocument } from "./openapi/load.js";
import { generateTypescriptSdk } from "./typescript/generate.js";

const LANGUAGE_GENERATORS = {
  typescript: generateTypescriptSdk,
  golang: generateGolangSdk,
};

export {
  DEFAULT_LAYOUT,
  DEFAULT_GOLANG_LAYOUT,
  DEFAULT_TYPESCRIPT_LAYOUT,
  loadGeneratorConfig,
  resolveGenerateOptions,
};

export async function generateSdk(options) {
  const document = await loadOpenApiDocument(options.input);
  const config = options.config ? await loadGeneratorConfig(options.config) : {};
  const resolved = resolveGenerateOptions(options, config);
  const ir = buildIr(document);
  const generator = LANGUAGE_GENERATORS[resolved.language];
  const result = generator(ir, resolved);

  await mkdir(resolved.output, { recursive: true });
  await Promise.all(
    result.files.map(async (file) => {
      const targetPath = path.join(resolved.output, file.path);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.contents, "utf8");
    }),
  );

  return {
    ...result,
    ir,
    options: resolved,
  };
}
