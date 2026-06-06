import { DEFAULT_TYPESCRIPT_LAYOUT } from "../config.js";
import { createNameRegistry } from "../generator/names.js";
import { collectTypeRefs, formatPropertyName, mapTypeRefs } from "../openapi/ir.js";
import { camelCase, sanitizeIdentifier } from "../openapi/naming.js";

export function generateTypescriptSdk(ir, options) {
  const { symbols, diagnostics } = buildSymbols(ir);
  const planner = createPlanner(symbols, options);

  return {
    files: planner.files,
    diagnostics: [...ir.diagnostics, ...diagnostics, ...planner.diagnostics],
  };
}

function buildSymbols(ir) {
  const diagnostics = [];
  const typeNames = createNameRegistry();
  const valueNames = createNameRegistry();
  const schemaNameMap = new Map();

  const builtinNames = {
    httpMethod: typeNames.allocate("HttpMethod"),
    endpointMetadata: typeNames.allocate("EndpointMetadata"),
    operationTypes: typeNames.allocate("OperationTypes"),
    generatedApiClient: typeNames.allocate("GeneratedApiClient"),
  };

  const schemaSymbols = ir.schemas.map((schema) => {
    const symbolName = typeNames.allocate(schema.name);
    schemaNameMap.set(schema.name, symbolName);
    return {
      schema,
      symbolName,
    };
  });

  const operationMemberNames = createNameRegistry();
  const operationSymbols = ir.operations.map((operation) => {
    const operationTypeBaseName = typeNames.allocate(operation.name);
    const paramsName = typeNames.allocate(`${operationTypeBaseName}Params`);
    const requestBodyName = operation.requestBody
      ? typeNames.allocate(`${operationTypeBaseName}RequestBody`)
      : null;
    const responseName = typeNames.allocate(`${operationTypeBaseName}Response`);
    const metadataName = valueNames.allocate(`${camelCase(operationTypeBaseName)}Metadata`);
    const memberName = operationMemberNames.allocate(
      sanitizeIdentifier(operation.operationId),
    );

    const responseBodyNames = operation.responses
      .filter((response) => response.type)
      .map((response) => ({
        statusCode: response.statusCode,
        name: typeNames.allocate(
          `${operationTypeBaseName}Response${normalizeStatusCode(response.statusCode)}`,
        ),
      }));

    return {
      operation,
      operationTypeBaseName,
      paramsName,
      requestBodyName,
      responseName,
      responseBodyNames,
      metadataName,
      memberName,
    };
  });

  const symbols = [];

  for (const { schema, symbolName } of schemaSymbols) {
    const mappedType = remapTypeRefs(schema.type, schemaNameMap);
    symbols.push({
      name: symbolName,
      category: "models",
      dependencies: collectDependencies(mappedType),
      declaration: renderNamedType(symbolName, mappedType, schema.description),
    });
  }

  symbols.push({
    name: builtinNames.httpMethod,
    category: "metadata",
    dependencies: [],
    declaration:
      `export type ${builtinNames.httpMethod} = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"`,
  });

  symbols.push({
    name: builtinNames.endpointMetadata,
    category: "metadata",
    dependencies: [
      {
        name: builtinNames.httpMethod,
        importKind: "type",
      },
    ],
    declaration: [
      `export interface ${builtinNames.endpointMetadata} {`,
      "  operationId: string",
      `  method: ${builtinNames.httpMethod}`,
      "  path: string",
      "}",
    ].join("\n"),
  });

  for (const operationSymbol of operationSymbols) {
    const { operation } = operationSymbol;
    const paramsType = {
      kind: "object",
      properties: operation.parameters.map((parameter) => ({
        name: parameter.name,
        required: parameter.required,
        description: parameter.description,
        type: remapTypeRefs(parameter.type, schemaNameMap),
      })),
      additionalProperties: false,
    };

    symbols.push({
      name: operationSymbol.paramsName,
      category: "requests",
      dependencies: collectDependencies(paramsType),
      declaration: renderNamedType(
        operationSymbol.paramsName,
        paramsType,
        operation.description,
      ),
    });

    if (operation.requestBody && operationSymbol.requestBodyName) {
      const mappedRequestBodyType = remapTypeRefs(operation.requestBody.type, schemaNameMap);
      symbols.push({
        name: operationSymbol.requestBodyName,
        category: "requests",
        dependencies: collectDependencies(mappedRequestBodyType),
        declaration: renderNamedType(
          operationSymbol.requestBodyName,
          mappedRequestBodyType,
          `Request body for ${operation.operationId}`,
        ),
      });
    }

    for (const responseBodyName of operationSymbol.responseBodyNames) {
      const response = operation.responses.find(
        (item) => item.statusCode === responseBodyName.statusCode,
      );
      const mappedResponseType = remapTypeRefs(response.type, schemaNameMap);

      symbols.push({
        name: responseBodyName.name,
        category: "responses",
        dependencies: collectDependencies(mappedResponseType),
        declaration: renderNamedType(
          responseBodyName.name,
          mappedResponseType,
          `Response body for ${operation.operationId} ${response.statusCode}`,
        ),
      });
    }

    symbols.push({
      name: operationSymbol.responseName,
      category: "responses",
      dependencies: operationSymbol.responseBodyNames.map((responseBody) => ({
        name: responseBody.name,
        importKind: "type",
      })),
      declaration: renderResponseUnion(
        operationSymbol.responseName,
        operation.responses,
        operationSymbol.responseBodyNames,
      ),
    });

    symbols.push({
      name: operationSymbol.metadataName,
      category: "metadata",
      dependencies: [
        {
          name: builtinNames.endpointMetadata,
          importKind: "type",
        },
      ],
      declaration: [
        `export const ${operationSymbol.metadataName}: ${builtinNames.endpointMetadata} = {`,
        `  operationId: ${JSON.stringify(operation.operationId)},`,
        `  method: ${JSON.stringify(operation.method)},`,
        `  path: ${JSON.stringify(operation.path)},`,
        "}",
      ].join("\n"),
    });
  }

  symbols.push({
    name: builtinNames.operationTypes,
    category: "operations",
    dependencies: operationSymbols.flatMap((operationSymbol) => [
      {
        name: operationSymbol.paramsName,
        importKind: "type",
      },
      {
        name: operationSymbol.responseName,
        importKind: "type",
      },
      ...(operationSymbol.requestBodyName
        ? [
            {
              name: operationSymbol.requestBodyName,
              importKind: "type",
            },
          ]
        : []),
    ]),
    declaration: renderOperationTypes(builtinNames.operationTypes, operationSymbols),
  });

  symbols.push({
    name: builtinNames.generatedApiClient,
    category: "client",
    dependencies: operationSymbols.flatMap((operationSymbol) => [
      {
        name: operationSymbol.paramsName,
        importKind: "type",
      },
      {
        name: operationSymbol.responseName,
        importKind: "type",
      },
      ...(operationSymbol.requestBodyName
        ? [
            {
              name: operationSymbol.requestBodyName,
              importKind: "type",
            },
          ]
        : []),
    ]),
    declaration: renderClientInterface(
      builtinNames.generatedApiClient,
      operationSymbols,
    ),
  });

  assertUniqueSymbolNames(symbols);

  return { symbols, diagnostics };
}

function createPlanner(symbols, options) {
  const diagnostics = [];
  const layout = {
    ...DEFAULT_TYPESCRIPT_LAYOUT,
    ...(options.layout ?? {}),
  };

  const orderedFiles =
    options.outputMode === "single"
      ? [layout.barrel]
      : [
          layout.models,
          layout.requests,
          layout.responses,
          layout.operations,
          layout.client,
          layout.metadata,
        ];

  const grouped = new Map();
  for (const filePath of orderedFiles) {
    grouped.set(filePath, []);
  }

  for (const symbol of symbols) {
    const filePath =
      options.outputMode === "single"
        ? layout.barrel
        : layout[symbol.category] ?? `${symbol.category}.ts`;
    grouped.get(filePath).push(symbol);
  }

  if (options.outputMode === "split") {
    resolveCircularDependencies(grouped, orderedFiles, diagnostics);
  }

  const symbolFile = buildSymbolFileIndex(grouped);
  const files = [];

  for (const filePath of orderedFiles) {
    const fileSymbols = grouped.get(filePath) ?? [];
    const imports =
      options.outputMode === "split"
        ? buildImportsForFile(fileSymbols, filePath, symbolFile)
        : new Map();

    files.push({
      path: filePath,
      contents: renderFile(fileSymbols, imports, filePath),
    });
  }

  if (options.outputMode === "split") {
    files.push({
      path: layout.barrel,
      contents: renderBarrel(orderedFiles, layout.barrel),
    });
  }

  return { files, diagnostics };
}

function resolveCircularDependencies(grouped, orderedFiles, diagnostics) {
  while (true) {
    const symbolFile = buildSymbolFileIndex(grouped);
    const graph = buildDependencyGraph(grouped, symbolFile);
    const cycles = findCycles(graph);

    if (cycles.length === 0) {
      return;
    }

    const cycleFiles = [...new Set(cycles[0].slice(0, -1))];
    const anchorFile = orderedFiles.find((filePath) => cycleFiles.includes(filePath));

    for (const filePath of cycleFiles) {
      if (filePath === anchorFile) {
        continue;
      }

      grouped.get(anchorFile).push(...grouped.get(filePath));
      grouped.set(filePath, []);
    }

    diagnostics.push({
      level: "warning",
      message: `Coalesced generated files into ${anchorFile} to break a circular dependency`,
    });
  }
}

function buildSymbolFileIndex(grouped) {
  const symbolFile = new Map();

  for (const [filePath, symbols] of grouped.entries()) {
    for (const symbol of symbols) {
      symbolFile.set(symbol.name, filePath);
    }
  }

  return symbolFile;
}

function buildDependencyGraph(grouped, symbolFile) {
  const graph = new Map();

  for (const [filePath, symbols] of grouped.entries()) {
    const dependencyTargets = new Set();

    for (const symbol of symbols) {
      for (const dependency of symbol.dependencies) {
        const targetFile = symbolFile.get(dependency.name);
        if (!targetFile || targetFile === filePath) {
          continue;
        }

        dependencyTargets.add(targetFile);
      }
    }

    graph.set(filePath, dependencyTargets);
  }

  return graph;
}

function buildImportsForFile(fileSymbols, filePath, symbolFile) {
  const imports = new Map();

  for (const symbol of fileSymbols) {
    for (const dependency of symbol.dependencies) {
      const targetFile = symbolFile.get(dependency.name);
      if (!targetFile || targetFile === filePath) {
        continue;
      }

      if (!imports.has(targetFile)) {
        imports.set(targetFile, {
          type: new Set(),
          value: new Set(),
        });
      }

      const importBucket =
        dependency.importKind === "value"
          ? imports.get(targetFile).value
          : imports.get(targetFile).type;
      importBucket.add(dependency.name);
    }
  }

  return imports;
}

function renderFile(symbols, imports, filePath) {
  const blocks = [];

  for (const [targetFile, groupedImports] of [...imports.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    const relativePath = toImportPath(filePath, targetFile);

    if (groupedImports.type.size > 0) {
      blocks.push(
        `import type { ${[...groupedImports.type].sort().join(", ")} } from ${JSON.stringify(relativePath)}`,
      );
    }

    if (groupedImports.value.size > 0) {
      blocks.push(
        `import { ${[...groupedImports.value].sort().join(", ")} } from ${JSON.stringify(relativePath)}`,
      );
    }
  }

  for (const symbol of symbols) {
    blocks.push(symbol.declaration);
  }

  return `${blocks.filter(Boolean).join("\n\n")}\n`;
}

function renderBarrel(files, barrelPath) {
  return `${files
    .map((filePath) => `export * from ${JSON.stringify(toImportPath(barrelPath, filePath))}`)
    .join("\n")}\n`;
}

function renderNamedType(name, typeRef, description) {
  const docComment = renderDocComment(description);
  if (typeRef.kind === "object" && typeRef.additionalProperties === false) {
    if (typeRef.properties.length === 0) {
      return joinBlocks(docComment, `export interface ${name} {\n}`);
    }

    return joinBlocks(
      docComment,
      [
        `export interface ${name} {`,
        renderObjectMembers(typeRef),
        "}",
      ].join("\n"),
    );
  }

  return joinBlocks(docComment, `export type ${name} = ${renderType(typeRef)}`);
}

function renderResponseUnion(name, responses, responseBodyNames) {
  const responseNameMap = new Map(
    responseBodyNames.map((responseBody) => [responseBody.statusCode, responseBody.name]),
  );

  const variants = responses.map((response) => {
    const responseBodyName = responseNameMap.get(response.statusCode);
    const payloadType = responseBodyName ?? "undefined";
    return `{ status: ${normalizeStatusLiteral(response.statusCode)}; data: ${payloadType} }`;
  });

  return `export type ${name} = ${variants.join(" | ")}`;
}

function renderOperationTypes(interfaceName, operations) {
  return [
    `export interface ${interfaceName} {`,
    ...operations.map((operation) => {
      const requestBodyType = operation.requestBodyName ?? "never";
      return [
        `  ${operation.memberName}: {`,
        `    params: ${operation.paramsName}`,
        `    requestBody: ${requestBodyType}`,
        `    response: ${operation.responseName}`,
        "  }",
      ].join("\n");
    }),
    "}",
  ].join("\n");
}

function renderClientInterface(interfaceName, operations) {
  return [
    `export interface ${interfaceName} {`,
    ...operations.map((operation) => {
      const args = [`params: ${operation.paramsName}`];
      if (operation.requestBodyName) {
        args.push(`body: ${operation.requestBodyName}`);
      }
      return `  ${operation.memberName}(${args.join(", ")}): Promise<${operation.responseName}>`;
    }),
    "}",
  ].join("\n");
}

function renderType(typeRef) {
  switch (typeRef.kind) {
    case "primitive":
      return typeRef.name;
    case "unknown":
      return "unknown";
    case "literal":
      return JSON.stringify(typeRef.value);
    case "ref":
      return typeRef.name;
    case "enum":
      return typeRef.values.map((value) => JSON.stringify(value)).join(" | ");
    case "array":
      return `Array<${renderType(typeRef.element)}>`;
    case "object":
      if (
        typeRef.properties.length === 0 &&
        (typeRef.additionalProperties === false || !typeRef.additionalProperties)
      ) {
        return "Record<string, never>";
      }

      if (typeRef.properties.length === 0 && typeRef.additionalProperties) {
        return `Record<string, ${renderType(typeRef.additionalProperties)}>`;
      }

      return `{\n${indent(renderObjectMembers(typeRef))}\n}`;
    case "union":
      return typeRef.variants.map((variant) => parenthesizeUnionMember(variant)).join(" | ");
    case "intersection":
      return typeRef.variants.map((variant) => parenthesizeIntersectionMember(variant)).join(" & ");
    default:
      return "unknown";
  }
}

function renderObjectMembers(typeRef) {
  const members = typeRef.properties.map((property) => {
    const optionalFlag = property.required ? "" : "?";
    const docComment = renderDocComment(property.description, "  ");
    const member = `  ${formatPropertyName(property.name)}${optionalFlag}: ${renderType(property.type)}`;
    return docComment ? `${docComment}\n${member}` : member;
  });

  if (typeRef.additionalProperties && typeRef.additionalProperties !== false) {
    members.push(`  [key: string]: ${renderType(typeRef.additionalProperties)}`);
  }

  return members.join("\n");
}

function renderDocComment(text, indentLevel = "") {
  if (!text) {
    return "";
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => `${indentLevel} * ${sanitizeBlockCommentText(line)}`.trimEnd());
  return [`${indentLevel}/**`, ...lines, `${indentLevel} */`].join("\n");
}

function sanitizeBlockCommentText(text) {
  return text.replaceAll("*/", "* /");
}

function remapTypeRefs(typeRef, schemaNameMap) {
  return mapTypeRefs(typeRef, (name) => schemaNameMap.get(name) ?? name);
}

function collectDependencies(typeRef) {
  return [...collectTypeRefs(typeRef)].map((name) => ({
    name,
    importKind: "type",
  }));
}

function normalizeStatusCode(statusCode) {
  return statusCode.replace(/[^A-Za-z0-9]/g, "_");
}

function normalizeStatusLiteral(statusCode) {
  return /^\d+$/.test(statusCode) ? statusCode : JSON.stringify(statusCode);
}

function joinBlocks(...blocks) {
  return blocks.filter(Boolean).join("\n");
}

function indent(value) {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function parenthesizeUnionMember(typeRef) {
  if (typeRef.kind === "intersection") {
    return `(${renderType(typeRef)})`;
  }

  return renderType(typeRef);
}

function parenthesizeIntersectionMember(typeRef) {
  if (typeRef.kind === "union") {
    return `(${renderType(typeRef)})`;
  }

  return renderType(typeRef);
}

function toImportPath(fromFile, toFile) {
  const fromParts = fromFile.split("/").slice(0, -1);
  const toParts = toFile.split("/");
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  const up = fromParts.map(() => "..");
  const relative = [...up, ...toParts].join("/");
  const normalized = relative.startsWith(".") ? relative : `./${relative}`;
  return normalized.replace(/\.ts$/, "");
}

function findCycles(graph) {
  const visited = new Set();
  const active = [];
  const activeSet = new Set();
  const cycles = [];

  function visit(node) {
    visited.add(node);
    active.push(node);
    activeSet.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!visited.has(dependency)) {
        visit(dependency);
        continue;
      }

      if (activeSet.has(dependency)) {
        const start = active.indexOf(dependency);
        cycles.push([...active.slice(start), dependency]);
      }
    }

    active.pop();
    activeSet.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      visit(node);
    }
  }

  return cycles;
}

function assertUniqueSymbolNames(symbols) {
  const seen = new Set();

  for (const symbol of symbols) {
    if (seen.has(symbol.name)) {
      throw new Error(`Duplicate generated symbol name "${symbol.name}"`);
    }

    seen.add(symbol.name);
  }
}
