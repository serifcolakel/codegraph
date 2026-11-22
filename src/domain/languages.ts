export type Language =
  | "typescript"
  | "javascript"
  | "csharp"
  | "go"
  | "rust"
  | "python"
  | "java"
  | "kotlin"
  | "swift"
  | "cpp"
  | "ruby"
  | "php"
  | "scala"
  | "markdown"

const EXTENSION_LANGUAGE: Readonly<Record<string, Language>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".cs": "csharp",
  ".go": "go",
  ".rs": "rust",
  ".py": "python",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".c": "cpp",
  ".h": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".scala": "scala",
  ".sc": "scala",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown"
}

export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(EXTENSION_LANGUAGE))

export const languageForPath = (filePath: string): Language | undefined => {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf(".")
  if (dot === -1) return undefined
  return EXTENSION_LANGUAGE[lower.slice(dot)]
}

export const isTypeScriptLanguage = (language: Language): boolean =>
  language === "typescript" || language === "javascript"

export const languageLabel = (language: Language): string => {
  switch (language) {
    case "typescript":
      return "TypeScript"
    case "javascript":
      return "JavaScript"
    case "csharp":
      return "C#"
    case "go":
      return "Go"
    case "rust":
      return "Rust"
    case "python":
      return "Python"
    case "java":
      return "Java"
    case "kotlin":
      return "Kotlin"
    case "swift":
      return "Swift"
    case "cpp":
      return "C/C++"
    case "ruby":
      return "Ruby"
    case "php":
      return "PHP"
    case "scala":
      return "Scala"
    case "markdown":
      return "Markdown"
  }
}
