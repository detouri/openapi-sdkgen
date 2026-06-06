export function createNameRegistry() {
  const used = new Set();

  return {
    allocate(baseName) {
      let candidate = baseName;
      let suffix = 2;
      while (used.has(candidate)) {
        candidate = `${baseName}${suffix}`;
        suffix += 1;
      }

      used.add(candidate);
      return candidate;
    },
    has(name) {
      return used.has(name);
    },
  };
}
