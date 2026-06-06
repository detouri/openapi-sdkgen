const RESERVED_WORDS = new Set([
  "class",
  "default",
  "export",
  "extends",
  "function",
  "import",
  "interface",
  "new",
  "null",
  "return",
  "string",
  "type",
  "var",
  "func",
  "struct",
]);

export function pascalCase(value) {
  const parts = splitWords(value);
  const result = parts.map((part) => capitalize(part.toLowerCase())).join("");
  return sanitizeTypeName(result || "GeneratedType");
}

export function camelCase(value) {
  const typeName = pascalCase(value);
  const result = typeName.charAt(0).toLowerCase() + typeName.slice(1);
  return sanitizeIdentifier(result || "generatedValue");
}

export function sanitizeTypeName(value) {
  const stripped = value.replace(/[^a-zA-Z0-9_$]/g, "");
  const safe = stripped.length > 0 ? stripped : "GeneratedType";
  return /^[A-Za-z_$]/.test(safe) ? safe : `T${safe}`;
}

export function sanitizeIdentifier(value) {
  const stripped = value.replace(/[^a-zA-Z0-9_$]/g, "");
  const safe = stripped.length > 0 ? stripped : "generatedValue";
  const prefixed = /^[A-Za-z_$]/.test(safe) ? safe : `v${safe}`;
  return RESERVED_WORDS.has(prefixed) ? `${prefixed}Value` : prefixed;
}

export function createOperationName(method, path, operationId) {
  if (operationId) {
    return pascalCase(operationId);
  }

  const normalizedPath = normalisePath(path);

  return pascalCase(`${method} ${normalizedPath}`);
}

function splitWords(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalisePath(path) {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, "By "))
    .join(" ");
}
