import {
  camelCase,
  createOperationName,
  pascalCase,
  sanitizeIdentifier,
} from "./naming.js";

const METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
];

export function buildIr(document) {
  const diagnostics = [];
  const context = {
    document,
    diagnostics,
  };

  const schemas = Object.entries(document.components?.schemas ?? {}).map(
    ([name, schema]) => ({
      name: pascalCase(name),
      originalName: name,
      description: schema?.description,
      type: toTypeRef(schema, context),
    }),
  );

  const operations = [];

  for (const [pathName, pathItem] of Object.entries(document.paths ?? {})) {
    const sharedParameters = resolveParameterList(pathItem?.parameters ?? [], context);

    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (!operation) {
        continue;
      }

      const operationName = createOperationName(
        method,
        pathName,
        operation.operationId,
      );
      const parameterMap = new Map();
      for (const parameter of [
        ...sharedParameters,
        ...resolveParameterList(operation.parameters ?? [], context),
      ]) {
        parameterMap.set(`${parameter.location}:${parameter.name}`, parameter);
      }

      const parameters = [...parameterMap.values()];
      const requestBody = resolveRequestBody(operation.requestBody, context);
      const responses = resolveResponses(operation.responses ?? {}, context);

      operations.push({
        name: operationName,
        method: method.toUpperCase(),
        path: pathName,
        operationId: operation.operationId ?? camelCase(operationName),
        description: operation.description ?? operation.summary,
        parameters,
        requestBody,
        responses,
      });
    }
  }

  return {
    schemas,
    operations,
    diagnostics,
  };
}

export function mapTypeRefs(typeRef, mapper) {
  if (!typeRef || typeof typeRef !== "object") {
    return typeRef;
  }

  switch (typeRef.kind) {
    case "ref":
      return {
        ...typeRef,
        name: mapper(typeRef.name),
      };
    case "array":
      return {
        ...typeRef,
        element: mapTypeRefs(typeRef.element, mapper),
      };
    case "object":
      return {
        ...typeRef,
        properties: typeRef.properties.map((property) => ({
          ...property,
          type: mapTypeRefs(property.type, mapper),
        })),
        additionalProperties:
          typeRef.additionalProperties && typeRef.additionalProperties !== false
            ? mapTypeRefs(typeRef.additionalProperties, mapper)
            : typeRef.additionalProperties,
      };
    case "union":
    case "intersection":
      return {
        ...typeRef,
        variants: typeRef.variants.map((variant) => mapTypeRefs(variant, mapper)),
      };
    default:
      return typeRef;
  }
}

export function formatPropertyName(name) {
  return sanitizeIdentifier(name) === name ? name : JSON.stringify(name);
}

function resolveMaybeRef(value, context) {
  if (value && typeof value === "object" && "$ref" in value) {
    return resolveRef(value.$ref, context.document);
  }

  return value;
}

function resolveParameterList(parameters, context) {
  return parameters.map((parameter) => {
    const resolved = resolveMaybeRef(parameter, context);
    return {
      name: resolved.name,
      location: resolved.in,
      required: Boolean(resolved.required),
      description: resolved.description,
      type: toTypeRef(resolved.schema ?? {}, context),
    };
  });
}

function resolveRequestBody(requestBody, context) {
  if (!requestBody) {
    return null;
  }

  const resolved = resolveMaybeRef(requestBody, context);
  const content = pickPreferredContent(resolved.content ?? {});
  if (!content) {
    return null;
  }

  return {
    required: Boolean(resolved.required),
    contentType: content.contentType,
    type: toTypeRef(content.schema ?? {}, context),
  };
}

function resolveResponses(responses, context) {
  return Object.entries(responses).map(([statusCode, response]) => {
    const resolved = resolveMaybeRef(response, context);
    const content = pickPreferredContent(resolved.content ?? {});
    return {
      statusCode,
      description: resolved.description,
      contentType: content?.contentType ?? null,
      type: content ? toTypeRef(content.schema ?? {}, context) : null,
    };
  });
}

function pickPreferredContent(contentMap) {
  if (!contentMap || typeof contentMap !== "object") {
    return null;
  }

  const contentTypes = Object.keys(contentMap);
  if (contentTypes.length === 0) {
    return null;
  }

  const preferredType =
    contentTypes.find((contentType) => contentType === "application/json") ??
    contentTypes[0];

  return {
    contentType: preferredType,
    schema: contentMap[preferredType]?.schema ?? null,
  };
}



export function collectTypeRefs(typeRef, refs = new Set()) {
  if (!typeRef || typeof typeRef !== "object") {
    return refs;
  }

  switch (typeRef.kind) {
    case "ref":
      refs.add(typeRef.name);
      break;
    case "array":
      collectTypeRefs(typeRef.element, refs);
      break;
    case "object":
      for (const property of typeRef.properties) {
        collectTypeRefs(property.type, refs);
      }
      if (typeRef.additionalProperties && typeRef.additionalProperties !== false) {
        collectTypeRefs(typeRef.additionalProperties, refs);
      }
      break;
    case "union":
    case "intersection":
      for (const variant of typeRef.variants) {
        collectTypeRefs(variant, refs);
      }
      break;
    default:
      break;
  }

  return refs;
}

function toTypeRef(schema, context) {
  if (!schema || typeof schema !== "object") {
    return { kind: "unknown" };
  }

  if ("$ref" in schema) {
    return { kind: "ref", name: refToName(schema.$ref) };
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return applyNullable(
      {
        kind: "enum",
        valueType: typeof schema.enum[0] === "number" ? "number" : "string",
        values: schema.enum,
      },
      schema,
    );
  }

  if (schema.oneOf) {
    return applyNullable(
      {
        kind: "union",
        variants: schema.oneOf.map((member) => toTypeRef(member, context)),
      },
      schema,
    );
  }

  if (schema.anyOf) {
    return applyNullable(
      {
        kind: "union",
        variants: schema.anyOf.map((member) => toTypeRef(member, context)),
      },
      schema,
    );
  }

  if (schema.allOf) {
    return applyNullable(
      {
        kind: "intersection",
        variants: schema.allOf.map((member) => toTypeRef(member, context)),
      },
      schema,
    );
  }

  if (schema.type === "array") {
    return applyNullable(
      {
        kind: "array",
        element: toTypeRef(schema.items ?? {}, context),
      },
      schema,
    );
  }

  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {}).map(([name, value]) => ({
      name,
      required: required.has(name),
      description: value?.description,
      type: toTypeRef(value, context),
    }));

    let additionalProperties = false;
    if (schema.additionalProperties === true) {
      additionalProperties = { kind: "unknown" };
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      additionalProperties = toTypeRef(
        schema.additionalProperties,
        context,
      );
    }

    return applyNullable(
      {
        kind: "object",
        properties,
        additionalProperties,
      },
      schema,
    );
  }

  if (schema.type === "integer" || schema.type === "number") {
    return applyNullable({ kind: "primitive", name: "number" }, schema);
  }

  if (schema.type === "boolean") {
    return applyNullable({ kind: "primitive", name: "boolean" }, schema);
  }

  if (schema.type === "null") {
    return { kind: "primitive", name: "null" };
  }

  if (schema.type === "string") {
    return applyNullable({ kind: "primitive", name: "string" }, schema);
  }

  if ("const" in schema) {
    return { kind: "literal", value: schema.const };
  }

  return { kind: "unknown" };
}

function applyNullable(typeRef, schema) {
  if (schema.nullable === true) {
    return {
      kind: "union",
      variants: [typeRef, { kind: "primitive", name: "null" }],
    };
  }

  return typeRef;
}

function resolveRef(ref, document) {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported $ref "${ref}"`);
  }

  const pointer = ref.slice(2).split("/").map(unescapeJsonPointer);
  let current = document;

  for (const segment of pointer) {
    current = current?.[segment];
  }

  if (current === undefined) {
    throw new Error(`Unable to resolve $ref "${ref}"`);
  }

  return current;
}

function refToName(ref) {
  const parts = ref.split("/");
  return pascalCase(parts[parts.length - 1]);
}

function unescapeJsonPointer(value) {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}