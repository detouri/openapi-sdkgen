#!/usr/bin/env node
import { generateSdk } from "./index.js";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (!part.startsWith("--")) {
      throw new Error(`Unexpected argument "${part}"`);
    }

    const key = part.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    options[key] = value;
    index += 1;
  }

  return { command, options };
}

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  openapi-sdkgen generate --input ./openapi.yaml --language typescript|golang --output ./generated [--output-mode single|split] [--package-name generated] [--config ./sdkgen.yaml]",
      "",
    ].join("\n"),
  );
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));

    if (command !== "generate") {
      printUsage();
      throw new Error(`Unsupported command "${command ?? ""}"`);
    }

    const result = await generateSdk({
      input: options.input,
      language: options.language,
      output: options.output,
      outputMode: options["output-mode"],
      packageName: options["package-name"],
      config: options.config,
    });

    if (result.diagnostics.length > 0) {
      for (const diagnostic of result.diagnostics) {
        process.stderr.write(`${diagnostic.level}: ${diagnostic.message}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
