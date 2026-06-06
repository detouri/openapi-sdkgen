import { DEFAULT_GOLANG_LAYOUT } from "../config.js";
import { createNameRegistry } from "../generator/names.js";
import { mapTypeRefs } from "../openapi/ir.js";
import { pascalCase } from "../openapi/naming.js";

export function generateGolangSdk(ir, options) {
  const diagnostics = [];
  const packageName = options.packageName || "generated";
  const layout = {
    ...DEFAULT_GOLANG_LAYOUT,
    ...(options.layout ?? {}),
  };

  const symbols = buildSymbols(ir, diagnostics);
  const orderedCategories = [
    "models",
    "requests",
    "responses",
    "operations",
    "client",
    "metadata",
  ];

  if (options.outputMode === "single") {
    return {
      files: [
        {
          path: layout.single,
          contents: renderGoFile(
            packageName,
            collectImports(symbols),
            symbols.map((symbol) => symbol.declaration),
          ),
        },
      ],
      diagnostics: [...ir.diagnostics, ...diagnostics],
    };
  }

  const files = orderedCategories.map((category) => {
    const categorySymbols = symbols.filter((symbol) => symbol.category === category);
    return {
      path: layout[category],
      contents: renderGoFile(
        packageName,
        collectImports(categorySymbols),
        categorySymbols.map((symbol) => symbol.declaration),
      ),
    };
  });

  return {
    files,
    diagnostics: [...ir.diagnostics, ...diagnostics],
  };
}

function buildSymbols(ir, diagnostics) {
  const symbols = [];
  const names = createNameRegistry();
  const schemaNameMap = new Map();
  const reservedNames = {
    client: names.allocate("Client"),
    httpMethod: names.allocate("HttpMethod"),
    endpointMetadata: names.allocate("EndpointMetadata"),
    methodGet: names.allocate("MethodGet"),
    methodPost: names.allocate("MethodPost"),
    methodPut: names.allocate("MethodPut"),
    methodPatch: names.allocate("MethodPatch"),
    methodDelete: names.allocate("MethodDelete"),
    methodHead: names.allocate("MethodHead"),
    methodOptions: names.allocate("MethodOptions"),
  };

  const schemaSymbols = ir.schemas.map((schema) => {
    const symbolName = names.allocate(schema.name);
    schemaNameMap.set(schema.name, symbolName);
    return {
      schema,
      symbolName,
    };
  });

  for (const { schema, symbolName } of schemaSymbols) {
    const mappedType = remapTypeRefs(schema.type, schemaNameMap);
    symbols.push({
      name: symbolName,
      category: "models",
      imports: [],
      declaration: renderNamedType(symbolName, mappedType, schema.description, diagnostics),
    });
  }

  symbols.push({
    name: reservedNames.httpMethod,
    category: "metadata",
    imports: [],
    declaration: renderMetadataTypes(reservedNames),
  });

  const operationMethodNames = createNameRegistry();
  for (const operation of ir.operations) {
    const operationTypeBaseName = names.allocate(operation.name);
    const methodName = operationMethodNames.allocate(operationTypeBaseName);
    const paramsName = names.allocate(`${operationTypeBaseName}Params`);
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
      name: paramsName,
      category: "requests",
      imports: [],
      declaration: renderNamedType(paramsName, paramsType, operation.description, diagnostics),
    });

    let requestBodyName = null;
    if (operation.requestBody) {
      requestBodyName = names.allocate(`${operationTypeBaseName}RequestBody`);
      const mappedRequestBodyType = remapTypeRefs(operation.requestBody.type, schemaNameMap);
      symbols.push({
        name: requestBodyName,
        category: "requests",
        imports: [],
        declaration: renderNamedType(
          requestBodyName,
          mappedRequestBodyType,
          `Request body for ${operation.operationId}`,
          diagnostics,
        ),
      });
    }

    const responseTypeNames = [];
    for (const response of operation.responses) {
      if (!response.type) {
        continue;
      }

      const responseTypeName = names.allocate(
        `${operationTypeBaseName}Response${normalizeStatusCode(response.statusCode)}`,
      );
      responseTypeNames.push({
        statusCode: response.statusCode,
        name: responseTypeName,
      });
      const mappedResponseType = remapTypeRefs(response.type, schemaNameMap);
      symbols.push({
        name: responseTypeName,
        category: "responses",
        imports: [],
        declaration: renderNamedType(
          responseTypeName,
          mappedResponseType,
          `Response body for ${operation.operationId} ${response.statusCode}`,
          diagnostics,
        ),
      });
    }

    const responseName = names.allocate(`${operationTypeBaseName}Response`);
    symbols.push({
      name: responseName,
      category: "responses",
      imports: [],
      declaration: renderResponseEnvelope(responseName, responseTypeNames),
    });

    const operationStructName = names.allocate(`${operationTypeBaseName}Operation`);
    symbols.push({
      name: operationStructName,
      category: "operations",
      imports: [],
      declaration: renderOperationType(
        operationStructName,
        paramsName,
        requestBodyName,
        responseName,
        reservedNames.httpMethod,
      ),
    });

    const metadataName = names.allocate(`${operationTypeBaseName}Metadata`);
    symbols.push({
      name: metadataName,
      category: "metadata",
      imports: [],
      declaration: renderOperationMetadata(operation, metadataName, reservedNames),
    });

    operation.paramsName = paramsName;
    operation.requestBodyName = requestBodyName;
    operation.responseName = responseName;
    operation.methodName = methodName;
  }

  symbols.push({
    name: reservedNames.client,
    category: "client",
    imports: ["context"],
    declaration: renderClientInterface(reservedNames.client, ir.operations),
  });

  assertUniqueSymbolNames(symbols);

  return symbols;
}

function renderNamedType(name, typeRef, description, diagnostics) {
  const docComment = renderDocComment(description);

  if (typeRef.kind === "object") {
    if (
      typeRef.properties.length === 0 &&
      (typeRef.additionalProperties === false || !typeRef.additionalProperties)
    ) {
      return joinBlocks(docComment, `type ${name} struct{}`);
    }

    return joinBlocks(docComment, `type ${name} struct {\n${renderStructFields(typeRef, diagnostics)}\n}`);
  }

  return joinBlocks(docComment, `type ${name} ${renderType(typeRef, diagnostics)}`);
}

function renderResponseEnvelope(name, responseTypeNames) {
  const fields = [
    "StatusCode int",
    "Data any",
    ...responseTypeNames.map(
      (responseType) => `${statusCodeFieldName(responseType.statusCode)} *${responseType.name}`,
    ),
  ];

  return `type ${name} struct {\n${fields.map((field) => `\t${field}`).join("\n")}\n}`;
}

function renderOperationType(name, paramsName, requestBodyName, responseName, httpMethodType) {
  const fields = [
    `Method ${httpMethodType}`,
    "Path string",
    `Params ${paramsName}`,
  ];

  if (requestBodyName) {
    fields.push(`RequestBody *${requestBodyName}`);
  }

  fields.push(`Response *${responseName}`);

  return [
    `type ${name} struct {`,
    ...fields.map((field) => `\t${field}`),
    "}",
  ].join("\n");
}

function renderOperationMetadata(operation, metadataName, reservedNames) {
  return [
    `var ${metadataName} = ${reservedNames.endpointMetadata}{`,
    `\tOperationID: ${JSON.stringify(operation.operationId)},`,
    `\tMethod: ${httpMethodConstName(operation.method, reservedNames)},`,
    `\tPath: ${JSON.stringify(operation.path)},`,
    "}",
  ].join("\n");
}

function renderClientInterface(name, operations) {
  return [
    `type ${name} interface {`,
    ...operations.map((operation) => {
      const args = [
        "ctx context.Context",
        `params ${operation.paramsName}`,
      ];
      if (operation.requestBodyName) {
        args.push(`body ${operation.requestBodyName}`);
      }

      return `\t${operation.methodName}(${args.join(", ")}) (*${operation.responseName}, error)`;
    }),
    "}",
  ].join("\n");
}

function renderMetadataTypes(reservedNames) {
  return [
    `type ${reservedNames.httpMethod} string`,
    "",
    "const (",
    `\t${reservedNames.methodGet} ${reservedNames.httpMethod} = "GET"`,
    `\t${reservedNames.methodPost} ${reservedNames.httpMethod} = "POST"`,
    `\t${reservedNames.methodPut} ${reservedNames.httpMethod} = "PUT"`,
    `\t${reservedNames.methodPatch} ${reservedNames.httpMethod} = "PATCH"`,
    `\t${reservedNames.methodDelete} ${reservedNames.httpMethod} = "DELETE"`,
    `\t${reservedNames.methodHead} ${reservedNames.httpMethod} = "HEAD"`,
    `\t${reservedNames.methodOptions} ${reservedNames.httpMethod} = "OPTIONS"`,
    ")",
    "",
    `type ${reservedNames.endpointMetadata} struct {`,
    "\tOperationID string",
    `\tMethod      ${reservedNames.httpMethod}`,
    "\tPath        string",
    "}",
  ].join("\n");
}

function renderType(typeRef, diagnostics) {
  const nullableInner = unwrapNullable(typeRef);
  if (nullableInner) {
    return `*${renderNonNullableType(nullableInner, diagnostics)}`;
  }

  return renderNonNullableType(typeRef, diagnostics);
}

function renderNonNullableType(typeRef, diagnostics) {
  switch (typeRef.kind) {
    case "primitive":
      return renderPrimitive(typeRef.name);
    case "unknown":
      return "any";
    case "literal":
      return renderPrimitive(typeof typeRef.value === "number" ? "number" : "string");
    case "ref":
      return typeRef.name;
    case "enum":
      return typeRef.valueType === "number" ? "float64" : "string";
    case "array":
      return `[]${renderNonNullableType(typeRef.element, diagnostics)}`;
    case "object":
      return renderInlineStruct(typeRef, diagnostics);
    case "union":
      diagnostics.push({
        level: "warning",
        message: "Go generator downgraded a union schema to any",
      });
      return "any";
    case "intersection":
      diagnostics.push({
        level: "warning",
        message: "Go generator downgraded an intersection schema to any",
      });
      return "any";
    default:
      return "any";
  }
}

function renderPrimitive(name) {
  switch (name) {
    case "string":
      return "string";
    case "number":
      return "float64";
    case "boolean":
      return "bool";
    case "null":
      return "any";
    default:
      return "any";
  }
}

function renderInlineStruct(typeRef, diagnostics) {
  if (typeRef.properties.length === 0 && typeRef.additionalProperties) {
    return `map[string]${renderNonNullableType(typeRef.additionalProperties, diagnostics)}`;
  }

  if (typeRef.properties.length === 0) {
    return "struct{}";
  }

  return `struct {\n${renderStructFields(typeRef, diagnostics)}\n}`;
}

function renderStructFields(typeRef, diagnostics) {
  const fields = typeRef.properties.map((property) => {
    const fieldType = renderStructFieldType(property, diagnostics);
    const tagSuffix = property.required ? "" : ",omitempty";
    const comment = renderDocComment(property.description, "\t");
    const field = `\t${toGoExportedName(property.name)} ${fieldType} \`json:"${property.name}${tagSuffix}"\``;
    return comment ? `${comment}\n${field}` : field;
  });

  if (typeRef.additionalProperties && typeRef.additionalProperties !== false) {
    fields.push(
      `\tAdditionalProperties map[string]${renderNonNullableType(typeRef.additionalProperties, diagnostics)} \`json:"-"\``,
    );
  }

  return fields.join("\n");
}

function renderStructFieldType(property, diagnostics) {
  const nullableInner = unwrapNullable(property.type);
  if (nullableInner) {
    return `*${renderNonNullableType(nullableInner, diagnostics)}`;
  }

  if (!property.required && shouldUseOptionalPointer(property.type)) {
    return `*${renderNonNullableType(property.type, diagnostics)}`;
  }

  return renderNonNullableType(property.type, diagnostics);
}

function unwrapNullable(typeRef) {
  if (typeRef.kind !== "union" || typeRef.variants.length !== 2) {
    return null;
  }

  const nonNull = typeRef.variants.find(
    (variant) => !(variant.kind === "primitive" && variant.name === "null"),
  );
  const hasNull = typeRef.variants.some(
    (variant) => variant.kind === "primitive" && variant.name === "null",
  );

  return hasNull ? nonNull : null;
}

function remapTypeRefs(typeRef, schemaNameMap) {
  return mapTypeRefs(typeRef, (name) => schemaNameMap.get(name) ?? name);
}

function shouldUseOptionalPointer(typeRef) {
  switch (typeRef.kind) {
    case "ref":
    case "object":
      return true;
    default:
      return false;
  }
}

function collectImports(symbols) {
  return [...new Set(symbols.flatMap((symbol) => symbol.imports))].sort();
}

function renderGoFile(packageName, imports, declarations) {
  const blocks = [
    "// Code generated by openapi-sdkgen. DO NOT EDIT.",
    "",
    `package ${packageName}`,
  ];

  if (imports.length === 1) {
    blocks.push("", `import ${JSON.stringify(imports[0])}`);
  } else if (imports.length > 1) {
    blocks.push(
      "",
      "import (",
      ...imports.map((packageImport) => `\t${JSON.stringify(packageImport)}`),
      ")",
    );
  }

  if (declarations.length > 0) {
    blocks.push("", declarations.join("\n\n"));
  }

  return `${blocks.join("\n")}\n`;
}

function renderDocComment(text, indent = "") {
  if (!text) {
    return "";
  }

  return text
    .split(/\r?\n/)
    .map((line, index) => `${indent}//${index === 0 ? " " : ""}${line}`.trimEnd())
    .join("\n");
}

function joinBlocks(...blocks) {
  return blocks.filter(Boolean).join("\n");
}

function normalizeStatusCode(statusCode) {
  return statusCode.replace(/[^A-Za-z0-9]/g, "_");
}

function statusCodeFieldName(statusCode) {
  return `HTTP${normalizeStatusCode(statusCode)}`;
}

function httpMethodConstName(method, reservedNames) {
  switch (method) {
    case "GET":
      return reservedNames.methodGet;
    case "POST":
      return reservedNames.methodPost;
    case "PUT":
      return reservedNames.methodPut;
    case "PATCH":
      return reservedNames.methodPatch;
    case "DELETE":
      return reservedNames.methodDelete;
    case "HEAD":
      return reservedNames.methodHead;
    case "OPTIONS":
      return reservedNames.methodOptions;
    default:
      return reservedNames.methodGet;
  }
}

function toGoExportedName(value) {
  let name = pascalCase(value);
  const replacements = new Map([
    ["Api", "API"],
    ["Http", "HTTP"],
    ["Https", "HTTPS"],
    ["Id", "ID"],
    ["Json", "JSON"],
    ["Url", "URL"],
    ["Uuid", "UUID"],
  ]);

  for (const [search, replacement] of replacements.entries()) {
    name = name.replaceAll(search, replacement);
  }

  return name;
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
