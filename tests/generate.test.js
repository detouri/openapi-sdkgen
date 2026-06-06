import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { generateSdk } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "users.yaml");
const collisionFixturePath = path.join(__dirname, "fixtures", "name-collisions.yaml");
const commentEscapeFixturePath = path.join(__dirname, "fixtures", "comment-escape.yaml");
const goRecursiveFixturePath = path.join(__dirname, "fixtures", "go-recursive.yaml");
const snapshotsDir = path.join(__dirname, "snapshots");

function serializeFiles(files) {
  return files
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `=== ${file.path} ===\n${file.contents.trimEnd()}`)
    .join("\n\n");
}

async function readSnapshot(name) {
  return readFile(path.join(snapshotsDir, name), "utf8");
}

function hasGoToolchain() {
  try {
    execFileSync("go", ["version"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

test("generates a single-file TypeScript SDK snapshot", async () => {
  const outputDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-single-"));
  const result = await generateSdk({
    input: fixturePath,
    language: "typescript",
    output: outputDir,
    outputMode: "single",
  });

  assert.equal(result.diagnostics.length, 0);
  assert.equal(serializeFiles(result.files), (await readSnapshot("single.txt")).trimEnd());
});

test("generates split TypeScript SDK files with correct imports and barrel exports", async () => {
  const outputDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-split-"));
  const result = await generateSdk({
    input: fixturePath,
    language: "typescript",
    output: outputDir,
    outputMode: "split",
  });

  assert.equal(result.diagnostics.length, 0);
  assert.equal(serializeFiles(result.files), (await readSnapshot("split.txt")).trimEnd());
});

test("split output compiles with tsc --noEmit and supports root/direct imports", async () => {
  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-compile-"));
  const generatedDir = path.join(tempDir, "generated");

  const result = await generateSdk({
    input: fixturePath,
    language: "typescript",
    output: generatedDir,
    outputMode: "split",
  });

  assert.equal(result.diagnostics.length, 0);

  await writeFile(
    path.join(tempDir, "root-import.ts"),
    [
      'import type { User, GetUserParams, GetUserResponse } from "./generated"',
      "",
      "declare const user: User",
      "declare const params: GetUserParams",
      "declare const response: GetUserResponse",
      "",
      "export { user, params, response }",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(tempDir, "direct-import.ts"),
    [
      'import type { User } from "./generated/models"',
      'import type { GetUserResponse } from "./generated/responses"',
      "",
      "declare const user: User",
      "declare const response: GetUserResponse",
      "",
      "export { user, response }",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
        },
        include: ["./generated/**/*.ts", "./root-import.ts", "./direct-import.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );

  execFileSync(
    path.resolve(process.cwd(), "node_modules", ".bin", "tsc"),
    ["-p", path.join(tempDir, "tsconfig.json"), "--noEmit"],
    {
      cwd: process.cwd(),
      stdio: "pipe",
    },
  );
});

test("reads output mode and layout overrides from a config file", async () => {
  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-config-"));
  const generatedDir = path.join(tempDir, "generated");
  const configPath = path.join(tempDir, "sdkgen.yaml");

  await writeFile(
    configPath,
    [
      "outputMode: split",
      "layout:",
      "  models: domain-models.ts",
      "  requests: transport-requests.ts",
      "  responses: transport-responses.ts",
      "  operations: operation-types.ts",
      "  client: sdk-client.ts",
      "  metadata: endpoint-metadata.ts",
      "  barrel: index.ts",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await generateSdk({
    input: fixturePath,
    language: "typescript",
    output: generatedDir,
    config: configPath,
  });

  assert.deepEqual(
    result.files.map((file) => file.path).sort(),
    [
      "domain-models.ts",
      "endpoint-metadata.ts",
      "index.ts",
      "operation-types.ts",
      "sdk-client.ts",
      "transport-requests.ts",
      "transport-responses.ts",
    ],
  );
});

test("generates a single-file Go SDK snapshot", async () => {
  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-go-single-"));
  const outputDir = path.join(tempDir, "generated");
  const result = await generateSdk({
    input: fixturePath,
    language: "golang",
    output: outputDir,
    outputMode: "single",
  });

  assert.equal(result.diagnostics.length, 0);
  assert.equal(serializeFiles(result.files), (await readSnapshot("go-single.txt")).trimEnd());
});

test("generates split Go SDK files", async () => {
  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-go-split-"));
  const outputDir = path.join(tempDir, "generated");
  const result = await generateSdk({
    input: fixturePath,
    language: "golang",
    output: outputDir,
    outputMode: "split",
  });

  assert.equal(result.diagnostics.length, 0);
  assert.equal(serializeFiles(result.files), (await readSnapshot("go-split.txt")).trimEnd());
});

test("split Go output compiles with go test", async (context) => {
  if (!hasGoToolchain()) {
    context.skip("go toolchain is not available");
    return;
  }

  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-go-compile-"));
  const generatedDir = path.join(tempDir, "generated");

  const result = await generateSdk({
    input: fixturePath,
    language: "golang",
    output: generatedDir,
    outputMode: "split",
  });

  assert.equal(result.diagnostics.length, 0);

  await writeFile(
    path.join(tempDir, "go.mod"),
    [
      "module example.com/sdkgentest",
      "",
      "go 1.26",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(tempDir, "compile_test.go"),
    [
      "package sdkgentest",
      "",
      'import generated "example.com/sdkgentest/generated"',
      "",
      "func useClient(c generated.Client) generated.Client {",
      "\treturn c",
      "}",
      "",
      "func useTypes() {",
      '\t_ = generated.User{ID: "123"}',
      "\t_ = generated.GetUserParams{}",
      "\t_ = generated.GetUserResponse{}",
      "\t_ = generated.CreateUserRequestBody{}",
      "\t_ = generated.GetUserMetadata",
      "\t_ = useClient",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  execFileSync("go", ["test", "./..."], {
    cwd: tempDir,
    stdio: "pipe",
  });
});

test("resolves generated TypeScript name collisions without duplicate declarations or cycle warnings", async () => {
  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-ts-collisions-"));
  const generatedDir = path.join(tempDir, "generated");

  const result = await generateSdk({
    input: collisionFixturePath,
    language: "typescript",
    output: generatedDir,
    outputMode: "split",
  });

  assert.equal(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("circular dependency"),
    ),
    false,
  );

  const allOutput = result.files.map((file) => file.contents).join("\n");
  assert.match(allOutput, /export interface GetUserParams2/);
  assert.match(allOutput, /export type HttpMethod2 = "custom"/);
  assert.match(allOutput, /export interface EndpointMetadata2/);
  assert.match(allOutput, /export interface GeneratedApiClient2/);

  await writeFile(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
        },
        include: ["./generated/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );

  execFileSync(
    path.resolve(process.cwd(), "node_modules", ".bin", "tsc"),
    ["-p", path.join(tempDir, "tsconfig.json"), "--noEmit"],
    {
      cwd: process.cwd(),
      stdio: "pipe",
    },
  );
});

test("resolves generated Go name collisions without duplicate declarations", async (context) => {
  if (!hasGoToolchain()) {
    context.skip("go toolchain is not available");
    return;
  }

  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-go-collisions-"));
  const generatedDir = path.join(tempDir, "generated");

  const result = await generateSdk({
    input: collisionFixturePath,
    language: "golang",
    output: generatedDir,
    outputMode: "split",
  });

  const allOutput = result.files.map((file) => file.contents).join("\n");
  assert.match(allOutput, /type Client2 struct/);
  assert.match(allOutput, /type HttpMethod2 string/);
  assert.match(allOutput, /type EndpointMetadata2 struct/);

  await writeFile(
    path.join(tempDir, "go.mod"),
    [
      "module example.com/sdkgencollisions",
      "",
      "go 1.26",
      "",
    ].join("\n"),
    "utf8",
  );

  execFileSync("go", ["test", "./..."], {
    cwd: tempDir,
    stdio: "pipe",
  });
});

test("sanitizes TypeScript doc comments that contain */ so output stays valid", async () => {
  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-ts-comments-"));
  const generatedDir = path.join(tempDir, "generated");

  const result = await generateSdk({
    input: commentEscapeFixturePath,
    language: "typescript",
    output: generatedDir,
    outputMode: "split",
  });

  const allOutput = result.files.map((file) => file.contents).join("\n");
  assert.match(allOutput, /Fetch note with \* \/ inside summary/);
  assert.match(allOutput, /Identifier has \* \/ marker/);

  await writeFile(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
        },
        include: ["./generated/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );

  execFileSync(
    path.resolve(process.cwd(), "node_modules", ".bin", "tsc"),
    ["-p", path.join(tempDir, "tsconfig.json"), "--noEmit"],
    {
      cwd: process.cwd(),
      stdio: "pipe",
    },
  );
});

test("keeps Go comment output valid when descriptions contain */", async (context) => {
  if (!hasGoToolchain()) {
    context.skip("go toolchain is not available");
    return;
  }

  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-go-comments-"));
  const generatedDir = path.join(tempDir, "generated");

  const result = await generateSdk({
    input: commentEscapeFixturePath,
    language: "golang",
    output: generatedDir,
    outputMode: "split",
  });

  const allOutput = result.files.map((file) => file.contents).join("\n");
  assert.match(allOutput, /Fetch note with \*\/ inside summary/);
  assert.match(allOutput, /Identifier has \*\/ marker/);

  await writeFile(
    path.join(tempDir, "go.mod"),
    [
      "module example.com/sdkgencomments",
      "",
      "go 1.26",
      "",
    ].join("\n"),
    "utf8",
  );

  execFileSync("go", ["test", "./..."], {
    cwd: tempDir,
    stdio: "pipe",
  });
});

test("emits Go named types that compile for recursive non-object schemas", async (context) => {
  if (!hasGoToolchain()) {
    context.skip("go toolchain is not available");
    return;
  }

  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-go-recursive-"));
  const generatedDir = path.join(tempDir, "generated");

  const result = await generateSdk({
    input: goRecursiveFixturePath,
    language: "golang",
    output: generatedDir,
    outputMode: "split",
  });

  const allOutput = result.files.map((file) => file.contents).join("\n");
  assert.match(allOutput, /type NodeList \[\]NodeList/);
  assert.doesNotMatch(allOutput, /type NodeList = \[\]NodeList/);

  await writeFile(
    path.join(tempDir, "go.mod"),
    [
      "module example.com/sdkgenrecursive",
      "",
      "go 1.26",
      "",
    ].join("\n"),
    "utf8",
  );

  execFileSync("go", ["test", "./..."], {
    cwd: tempDir,
    stdio: "pipe",
  });
});

test("packed npm tarball exposes an npx-runnable CLI bin", async () => {
  const tempDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sdkgen-pack-"));
  const tarballName = execFileSync(
    "npm",
    ["pack", "--cache", path.join(tempDir, ".npm-cache")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    },
  ).trim();
  const tarballPath = path.join(process.cwd(), tarballName);

  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    }),
  );

  const packedListing = execFileSync("tar", ["-tvf", tarballPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });

  assert.equal(packedManifest.bin?.["openapi-sdkgen"], "./src/cli.js");
  assert.match(packedListing, /-rwxr-xr-x\s+.*package\/src\/cli\.js/);
});
