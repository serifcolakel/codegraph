// Splits camelCase, PascalCase, snake_case and dotted names into lowercase
// search tokens. FTS5's unicode61 tokenizer already splits snake_case and
// punctuation, so the tokens column only needs to bridge camelCase.
export const splitIdentifier = (value: string): readonly string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase())

// Keeps the original compact identifier (so exact camelCase search still
// matches) and appends its split words (so `fund` and `sizes` match too).
export const tokenizeIdentifier = (value: string): string => {
  const original = value.trim().toLowerCase()
  const parts = Array.from(new Set(splitIdentifier(value)))
  return [original, ...parts].filter((part) => part.length > 0).join(" ")
}

const stripExtension = (filePath: string): string =>
  filePath.replace(/\\/g, "/").replace(/\.[^./]+$/, "")

// Module-qualified name, e.g. `src.domain.naming.tokenizeIdentifier`.
export const qualifyName = (filePath: string, name: string, containerName?: string): string => {
  const modulePath = stripExtension(filePath)
    .replace(/^\.?\//, "")
    .split("/")
    .filter(Boolean)
    .join(".")
  const qualified =
    containerName && !name.startsWith(`${containerName}.`) ? `${containerName}.${name}` : name
  return modulePath ? `${modulePath}.${qualified}` : qualified
}
