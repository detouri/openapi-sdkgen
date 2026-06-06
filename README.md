# openapi-sdkgen

`openapi-sdkgen` generates SDK-oriented output from OpenAPI 3.x documents.

Current generators:

- [✅] TypeScript
- [✅] Go
- [❌] Rust
- [❌] Java
- [❌] Kotlin

## Install

```bash
npm install openapi-sdkgen
```

## CLI

```bash
openapi-sdkgen generate \
  --input ./openapi.yaml \
  --language typescript \
  --output ./generated \
  --output-mode split
```

Run it without installing:

```bash
npx openapi-sdkgen generate \
  --input ./openapi.yaml \
  --language typescript \
  --output ./generated \
  --output-mode split
```

Go output is also supported:

```bash
openapi-sdkgen generate \
  --input ./openapi.yaml \
  --language golang \
  --output ./generated \
  --output-mode split
```

With `npx`:

```bash
npx openapi-sdkgen generate \
  --input ./openapi.yaml \
  --language golang \
  --output ./generated \
  --output-mode split
```

## Library

```js
import { generateSdk } from "openapi-sdkgen";

await generateSdk({
  input: "./openapi.yaml",
  language: "typescript",
  output: "./generated",
  outputMode: "single",
});
```

## Development

```bash
npm ci
npm test
```

## Publishing

This repository includes GitHub Actions workflows for CI and npm publishing.

- CI runs on pushes and pull requests.
- npm publishing runs on GitHub release publication and manual dispatch.

The publish workflow expects a repository secret named `NPM_TOKEN`.
