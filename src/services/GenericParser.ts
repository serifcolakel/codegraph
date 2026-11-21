import type { Language } from "../domain/languages.js"
import type { ParsedEdge, ParsedFile, ParsedSymbol, SymbolKind } from "../domain/models.js"

type MutableSymbol = { -readonly [K in keyof ParsedSymbol]: ParsedSymbol[K] }

const MAX_SIGNATURE_LENGTH = 200
const MAX_DOC_LENGTH = 2000
const MAX_CALL_EDGES = 3000

const CALL_KEYWORDS = new Set([
  "if",
  "for",
  "foreach",
  "while",
  "switch",
  "catch",
  "return",
  "new",
  "delete",
  "sizeof",
  "typeof",
  "nameof",
  "throw",
  "else",
  "do",
  "case",
  "when",
  "match",
  "yield",
  "await",
  "using",
  "lock",
  "fixed",
  "unsafe",
  "checked",
  "unchecked",
  "assert",
  "print",
  "println",
  "printf",
  "fmt",
  "super",
  "this",
  "self",
  "init",
  "constructor",
  "function",
  "func",
  "fn",
  "def"
])

const MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "final",
  "abstract",
  "sealed",
  "partial",
  "readonly",
  "virtual",
  "override",
  "async",
  "synchronized",
  "native",
  "default",
  "open",
  "suspend",
  "inline",
  "operator",
  "infix",
  "tailrec",
  "external",
  "unsafe",
  "new",
  "constexpr",
  "explicit",
  "friend",
  "const",
  "volatile",
  "data",
  "enum",
  "annotation",
  "value",
  "inner",
  "fileprivate",
  "mutating",
  "nonmutating",
  "indirect",
  "required",
  "convenience",
  "final",
  "open"
])

const normalize = (text: string): string =>
  text.trim().replace(/\s+/g, " ").slice(0, MAX_SIGNATURE_LENGTH)

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trim()
  return (
    trimmed === "" ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    (trimmed.startsWith("#") && !trimmed.startsWith("#[") && !trimmed.startsWith("#include"))
  )
}

const stripStringsAndComments = (line: string): string => {
  let text = line
  text = text.replace(/\/\*[\s\S]*?\*\//g, " ")
  text = text.replace(/\/\/.*$/, "")
  text = text.replace(/"(?:\\.|[^"\\])*"/g, '""')
  text = text.replace(/'(?:\\.|[^'\\])*'/g, "''")
  text = text.replace(/`(?:\\.|[^`\\])*`/g, "``")
  return text
}

const braceCounts = (line: string): { open: number; close: number } => {
  const text = stripStringsAndComments(line)
  let open = 0
  let close = 0
  for (const char of text) {
    if (char === "{") open += 1
    else if (char === "}") close += 1
  }
  return { open, close }
}

const cleanDoc = (text: string, language: Language): string => {
  let cleaned = text
  if (language === "csharp") {
    cleaned = cleaned
      .replace(/<param\s+name="([^"]+)">([\s\S]*?)<\/param>/gi, "@param $1 $2")
      .replace(/<typeparam\s+name="([^"]+)">([\s\S]*?)<\/typeparam>/gi, "@typeparam $1 $2")
      .replace(/<exception\s+cref="([^"]+)">([\s\S]*?)<\/exception>/gi, "@throws $1 $2")
      .replace(/<returns>([\s\S]*?)<\/returns>/gi, "@returns $1")
      .replace(/<summary>([\s\S]*?)<\/summary>/gi, "$1")
      .replace(/<remarks>([\s\S]*?)<\/remarks>/gi, "$1")
      .replace(/<[^>]+>/g, " ")
  } else if (language === "java" || language === "kotlin") {
    cleaned = cleaned.replace(/<[^>]+>/g, " ")
  }

  if (language === "csharp" || language === "java" || language === "kotlin") {
    cleaned = cleaned
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
  }
  return cleaned
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, MAX_DOC_LENGTH)
}

const extractDoc = (lines: readonly string[], index: number, language: Language): string => {
  let cursor = index - 1

  // Attributes/annotations often sit between the doc comment and the item.
  while (cursor >= 0) {
    const line = lines[cursor] ?? ""
    if (/^\s*(#\[|@[A-Za-z_]|\[[A-Za-z_][^\]]*\]\s*$)/.test(line)) {
      cursor -= 1
      continue
    }
    break
  }

  if (cursor < 0) return ""

  const current = (lines[cursor] ?? "").trim()
  if (current.endsWith("*/")) {
    const collected: string[] = []
    while (cursor >= 0) {
      const line = lines[cursor] ?? ""
      collected.unshift(line)
      if (line.includes("/*")) break
      cursor -= 1
    }
    const text = collected
      .join("\n")
      .replace(/^\s*\/\*\*?/, "")
      .replace(/\*\/\s*$/, "")
    return cleanDoc(text, language)
  }

  const prefix =
    language === "python" || language === "ruby" ? /^\s*#\s?/ : /^\s*(?:\/\/\/|\/\/!|\/\/|#|--)\s?/

  const collected: string[] = []
  while (cursor >= 0) {
    const line = lines[cursor] ?? ""
    if (!prefix.test(line)) break
    collected.unshift(line.replace(prefix, ""))
    cursor -= 1
  }

  return cleanDoc(collected.join("\n"), language)
}

const docstringAfter = (lines: readonly string[], index: number): string => {
  let cursor = index + 1
  while (cursor < lines.length && (lines[cursor] ?? "").trim() === "") cursor += 1
  const first = (lines[cursor] ?? "").trim()
  const match = first.match(/^("""|''')/)
  if (!match) return ""

  const delimiter = match[1] ?? '"""'
  const after = first.slice(delimiter.length)
  if (after.includes(delimiter)) {
    return cleanDoc(after.split(delimiter)[0] ?? "", "python")
  }

  const collected: string[] = []
  if (after) collected.push(after)
  cursor += 1
  while (cursor < lines.length) {
    const line = lines[cursor] ?? ""
    if (line.includes(delimiter)) {
      collected.push(line.split(delimiter)[0] ?? "")
      break
    }
    collected.push(line)
    cursor += 1
  }
  return cleanDoc(collected.join("\n"), "python")
}

const isExported = (language: Language, line: string, name: string): boolean => {
  const trimmed = line.trim()
  switch (language) {
    case "go":
      return /^[A-Z]/.test(name)
    case "rust":
      return /\bpub\b/.test(trimmed)
    case "csharp":
    case "java":
    case "kotlin":
    case "swift":
    case "cpp":
    case "php":
    case "scala":
      if (/\bprivate\b/.test(trimmed) || /\bfileprivate\b/.test(trimmed)) return false
      if (/\binternal\b/.test(trimmed) && language !== "java") return false
      if (/\bprotected\b/.test(trimmed) && language === "php") return false
      return true
    case "python":
    case "ruby":
      return !name.startsWith("_")
    default:
      return true
  }
}

const visibilityFor = (
  language: Language,
  line: string,
  exported: boolean
): ParsedSymbol["visibility"] => {
  const explicit = line.match(/\b(public|private|protected|internal)\b/)
  const keyword = explicit?.[1]
  if (keyword === "public" || keyword === "private" || keyword === "protected") {
    return keyword
  }
  if (keyword === "internal") return "internal"
  if (language === "go") return exported ? "public" : "package"
  if (language === "rust" || language === "python" || language === "ruby") {
    return exported ? "public" : "private"
  }
  return exported ? "public" : undefined
}

const kindForContainer = (keyword: string): SymbolKind => {
  if (keyword === "interface" || keyword === "protocol" || keyword === "trait") return "interface"
  if (keyword === "enum") return "enum"
  if (keyword === "type") return "type"
  return "class"
}

type ContainerMatch = {
  readonly name: string
  readonly keyword: string
  readonly kind?: SymbolKind
  readonly extendsNames: readonly string[]
  readonly implementsNames: readonly string[]
}

const splitNames = (text: string): string[] =>
  text
    .split(",")
    .map((part) => part.trim().replace(/\(.*$/, "").replace(/<.*$/, ""))
    .map((part) => part.split(/\s+/).pop() ?? "")
    .filter((part) => /^[A-Za-z_][\w.]*$/.test(part))

const matchContainer = (language: Language, line: string): ContainerMatch | undefined => {
  if (isCommentLine(line)) return undefined
  const text = line.trim()

  if (language === "go") {
    const struct = text.match(/^type\s+([A-Za-z_]\w*)\s+struct\b/)
    if (struct?.[1]) {
      return {
        name: struct[1],
        keyword: "struct",
        kind: "class",
        extendsNames: [],
        implementsNames: []
      }
    }
    const iface = text.match(/^type\s+([A-Za-z_]\w*)\s+interface\b/)
    if (iface?.[1]) {
      return {
        name: iface[1],
        keyword: "interface",
        kind: "interface",
        extendsNames: [],
        implementsNames: []
      }
    }
    const alias = text.match(/^type\s+([A-Za-z_]\w*)\s+/)
    if (alias?.[1]) {
      return {
        name: alias[1],
        keyword: "type",
        kind: "type",
        extendsNames: [],
        implementsNames: []
      }
    }
    return undefined
  }

  if (language === "rust") {
    const impl = text.match(/^impl(?:<[^>]*>)?\s+(?:([A-Za-z_][\w:]*)\s+for\s+)?([A-Za-z_][\w:]*)/)
    if (impl?.[2]) {
      const target = (impl[2].split("::").pop() ?? impl[2]) as string
      const trait = impl[1]?.split("::").pop()
      return {
        name: target,
        keyword: "impl",
        extendsNames: [],
        implementsNames: trait ? [trait] : []
      }
    }
    const decl = text.match(/^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union)\s+([A-Za-z_]\w*)/)
    if (decl?.[1] && decl[2]) {
      return {
        name: decl[2],
        keyword: decl[1],
        kind: kindForContainer(decl[1]),
        extendsNames: [],
        implementsNames: []
      }
    }
    const alias = text.match(/^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)\s*=/)
    if (alias?.[1]) {
      return {
        name: alias[1],
        keyword: "type",
        kind: "type",
        extendsNames: [],
        implementsNames: []
      }
    }
    return undefined
  }

  const patterns: Partial<Record<Language, { re: RegExp; kind?: SymbolKind }[]>> = {
    csharp: [
      {
        re: /^(?:(?:public|private|protected|internal|sealed|abstract|static|partial|readonly|unsafe)\s+)*(class|interface|struct|record|enum)\s+([A-Za-z_]\w*)/
      }
    ],
    java: [
      {
        re: /^(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)/
      }
    ],
    kotlin: [
      {
        re: /^(?:(?:public|private|protected|internal|open|abstract|sealed|data|enum|annotation|value|inner)\s+)*(class|interface|object)\s+([A-Za-z_]\w*)/
      }
    ],
    swift: [
      {
        re: /^(?:(?:public|private|fileprivate|internal|open|final|indirect)\s+)*(class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/
      }
    ],
    cpp: [
      {
        re: /^(?:template\s*<[^>]*>\s*)?(class|struct|union|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/
      }
    ],
    php: [
      {
        re: /^(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/
      }
    ],
    scala: [
      {
        re: /^(?:(?:sealed|abstract|final|case|implicit|private|protected|override)\s+)*(class|trait|object|enum)\s+([A-Za-z_]\w*)/
      }
    ]
  }

  const entries = patterns[language] ?? []
  for (const entry of entries) {
    const match = text.match(entry.re)
    if (!match?.[1] || !match[2]) continue

    let keyword = match[1]
    if (language === "kotlin" && text.includes("enum class")) keyword = "enum"
    if (language === "cpp" && keyword.startsWith("enum")) keyword = "enum"

    const kind = entry.kind ?? kindForContainer(keyword)
    const rest = text.slice((match.index ?? 0) + match[0].length)
    const basesPart = rest.includes(":") ? rest.slice(rest.indexOf(":") + 1) : ""
    const bases = splitNames(basesPart.replace(/\{.*/, "").replace(/\bwith\b/g, ","))
    const extendsNames: string[] = []
    const implementsNames: string[] = []

    if (language === "java") {
      const ext = text.match(/\bextends\s+([A-Za-z_][\w.]*)/)
      if (ext?.[1]) extendsNames.push(ext[1])
      const impl = text.match(/\bimplements\s+([^{]+)/)
      if (impl?.[1]) implementsNames.push(...splitNames(impl[1]))
    } else if (language === "php") {
      const ext = text.match(/\bextends\s+([A-Za-z_][\w.]*)/)
      if (ext?.[1]) extendsNames.push(ext[1])
      const impl = text.match(/\bimplements\s+([^{]+)/)
      if (impl?.[1]) implementsNames.push(...splitNames(impl[1]))
    } else if (language === "scala") {
      const ext = text.match(/\bextends\s+([A-Za-z_][\w.]*)/)
      if (ext?.[1]) extendsNames.push(ext[1])
      const withs = text.match(/\bwith\s+([A-Za-z_][\w.]*)/g) ?? []
      for (const withPart of withs) {
        const namePart = withPart.replace(/^with\s+/, "")
        if (namePart) implementsNames.push(namePart)
      }
    } else if (bases.length > 0) {
      if (language === "csharp") {
        for (const base of bases) {
          if (/^I[A-Z]/.test(base)) implementsNames.push(base)
          else if (extendsNames.length === 0) extendsNames.push(base)
          else implementsNames.push(base)
        }
      } else {
        extendsNames.push(bases[0] as string)
        implementsNames.push(...bases.slice(1))
      }
    }

    return { name: match[2], keyword, kind, extendsNames, implementsNames }
  }

  return undefined
}

type FunctionMatch = {
  readonly name: string
  readonly containerName: string | undefined
}

const matchFunction = (
  language: Language,
  line: string,
  containerName: string | undefined
): FunctionMatch | undefined => {
  if (isCommentLine(line)) return undefined
  const text = line.trim()

  if (language === "go") {
    const go = text.match(/^func\s+(?:\([^)]*?\b([A-Za-z_]\w*)\)\s*)?([A-Za-z_]\w*)\s*\(/)
    if (!go?.[2]) return undefined
    const receiver = go[1]
    return receiver
      ? { name: `${receiver}.${go[2]}`, containerName: receiver }
      : { name: go[2], containerName: undefined }
  }

  if (language === "rust") {
    const rust = text.match(
      /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/
    )
    if (!rust?.[1]) return undefined
    return {
      name: containerName ? `${containerName}.${rust[1]}` : rust[1],
      containerName
    }
  }

  if (language === "kotlin") {
    const kotlin = text.match(
      /^(?:(?:public|private|protected|internal|open|override|abstract|final|inline|suspend|operator|infix|tailrec|external|suspend)\s+)*fun\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)/
    )
    if (kotlin?.[1]) {
      return {
        name: containerName ? `${containerName}.${kotlin[1]}` : kotlin[1],
        containerName
      }
    }
  }

  if (language === "swift") {
    const swift = text.match(
      /^(?:(?:public|private|fileprivate|internal|open|final|static|class|override|mutating|nonmutating|required|convenience|indirect)\s+)*func\s+([A-Za-z_]\w*)/
    )
    if (swift?.[1]) {
      return {
        name: containerName ? `${containerName}.${swift[1]}` : swift[1],
        containerName
      }
    }
  }

  if (language === "php") {
    const php = text.match(
      /^(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/
    )
    if (php?.[1]) {
      return {
        name: containerName ? `${containerName}.${php[1]}` : php[1],
        containerName
      }
    }
  }

  // C# / Java / C / C++ / Scala style: optional modifiers + return type + name.
  const generic = text.match(
    /^(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|readonly|virtual|override|async|synchronized|native|default|extern|constexpr|explicit|friend|unsafe|inline|operator)\s+)*(?:<[^>]+>\s*)?([A-Za-z_][\w<>.,? [\]]*?)\s+([A-Za-z_]\w*)\s*\(/
  )
  if (generic?.[2]) {
    const returnType = (generic[1] ?? "").trim()
    const firstToken = returnType.split(/\s+/)[0] ?? ""
    if (
      MODIFIERS.has(firstToken) ||
      CALL_KEYWORDS.has(returnType) ||
      CALL_KEYWORDS.has(generic[2]) ||
      returnType === ""
    ) {
      // fall through to constructor check
    } else {
      return {
        name: containerName ? `${containerName}.${generic[2]}` : generic[2],
        containerName
      }
    }
  }

  // Constructors: `public Foo(...)`
  if (language === "csharp" || language === "java" || language === "cpp" || language === "scala") {
    const ctor = text.match(
      /^(?:(?:public|private|protected|internal|static|final|abstract|sealed|explicit)\s+)*([A-Z][A-Za-z_]\w*)\s*\(/
    )
    if (ctor?.[1] && ctor[1] === containerName) {
      return { name: `${ctor[1]}.constructor`, containerName }
    }
  }

  return undefined
}

const matchConstant = (language: Language, line: string): string | undefined => {
  if (isCommentLine(line)) return undefined
  const text = line.trim()
  if (language === "rust") {
    return text.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)/)?.[1]
  }
  if (language === "go") {
    return text.match(/^(?:const|var)\s+([A-Za-z_]\w*)/)?.[1]
  }
  if (language === "cpp") {
    return text.match(/^(?:static\s+)?(?:const|constexpr)\s+[\w:<>]+\s+([A-Za-z_]\w*)/)?.[1]
  }
  return undefined
}

type Block = {
  readonly name: string
  readonly kind: "container" | "function"
  readonly openDepth: number
  readonly symbol?: MutableSymbol
}

const parseBraceLanguage = (language: Language, lines: readonly string[]): ParsedFile => {
  const symbols: MutableSymbol[] = []
  const edges: ParsedEdge[] = []
  const edgeKeys = new Set<string>()
  const blocks: Block[] = []
  let depth = 0

  const addEdge = (edge: ParsedEdge) => {
    const key = `${edge.srcName}->${edge.dstName}:${edge.kind}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(edge)
  }

  const lastContainer = (): string | undefined => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block?.kind === "container") return block.name
    }
    return undefined
  }

  const lastFunction = (): string | undefined => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block?.kind === "function") return block.name
    }
    return undefined
  }

  const closeBlocks = (lineNumber: number) => {
    while (blocks.length > 0) {
      const top = blocks[blocks.length - 1]
      if (!top || depth >= top.openDepth) break
      blocks.pop()
      if (top.symbol && lineNumber > top.symbol.endLine) {
        top.symbol.endLine = lineNumber
      }
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const lineNumber = index + 1
    closeBlocks(lineNumber)

    const container = matchContainer(language, line)
    const currentContainer = container?.name ?? lastContainer()
    let matchedDefinition = false

    if (container) {
      matchedDefinition = true
      const symbol: MutableSymbol | undefined =
        container.kind === undefined
          ? undefined
          : {
              name: container.name,
              kind: container.kind,
              startLine: lineNumber,
              endLine: lineNumber,
              signature: normalize(line),
              exported: isExported(language, line, container.name),
              visibility: visibilityFor(language, line, isExported(language, line, container.name)),
              doc: extractDoc(lines, index, language)
            }

      if (symbol) {
        symbols.push(symbol)
      }

      for (const base of container.extendsNames) {
        addEdge({
          srcName: container.name,
          dstName: base,
          kind: "extends",
          srcLine: lineNumber
        })
      }
      for (const iface of container.implementsNames) {
        addEdge({
          srcName: container.name,
          dstName: iface,
          kind: "implements",
          srcLine: lineNumber
        })
      }

      blocks.push({
        name: container.name,
        kind: "container",
        openDepth: depth + 1,
        ...(symbol ? { symbol } : {})
      })
    } else {
      const fn = matchFunction(language, line, currentContainer)
      if (fn) {
        matchedDefinition = true
        const isMethod = Boolean(fn.containerName)
        const symbol: MutableSymbol = {
          name: fn.name,
          kind: isMethod ? "method" : "function",
          startLine: lineNumber,
          endLine: lineNumber,
          signature: normalize(line),
          exported: isExported(language, line, fn.name),
          visibility: visibilityFor(language, line, isExported(language, line, fn.name)),
          doc: extractDoc(lines, index, language),
          ...(fn.containerName ? { containerName: fn.containerName } : {})
        }
        symbols.push(symbol)

        if (fn.containerName) {
          addEdge({
            srcName: fn.containerName,
            dstName: fn.name,
            kind: "contains",
            srcLine: lineNumber
          })
        }

        blocks.push({
          name: fn.name,
          kind: "function",
          openDepth: depth + 1,
          symbol
        })
      } else {
        const constant = matchConstant(language, line)
        if (constant) {
          matchedDefinition = true
          symbols.push({
            name: currentContainer ? `${currentContainer}.${constant}` : constant,
            kind: "const",
            startLine: lineNumber,
            endLine: lineNumber,
            signature: normalize(line),
            exported: isExported(language, line, constant),
            visibility: visibilityFor(language, line, isExported(language, line, constant)),
            doc: extractDoc(lines, index, language),
            ...(currentContainer ? { containerName: currentContainer } : {})
          })
        }
      }
    }

    const caller = lastFunction()
    if (!matchedDefinition && caller && edges.length < MAX_CALL_EDGES) {
      const callText = stripStringsAndComments(line)
      const pattern = /\b([A-Za-z_]\w*)\s*\(/g
      let match: RegExpExecArray | null = pattern.exec(callText)
      while (match) {
        const callee = match[1]
        if (
          callee &&
          !CALL_KEYWORDS.has(callee) &&
          callee !== caller &&
          callee !== caller.split(".").pop()
        ) {
          addEdge({
            srcName: caller,
            dstName: callee,
            kind: "call",
            srcLine: lineNumber
          })
        }
        match = pattern.exec(callText)
      }
    }

    const braces = braceCounts(line)
    depth += braces.open - braces.close
    closeBlocks(lineNumber)
  }

  while (blocks.length > 0) {
    const top = blocks.pop()
    if (top?.symbol && top.symbol.endLine < lines.length) {
      top.symbol.endLine = lines.length
    }
  }

  symbols.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))
  return { path: "", symbols, edges }
}

const indentOf = (line: string): number => line.length - line.trimStart().length

const blockEndByIndent = (lines: readonly string[], start: number, indent: number): number => {
  let end = start
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (line.trim() === "") continue
    if (indentOf(line) <= indent) break
    end = index
  }
  return end + 1
}

const parsePython = (lines: readonly string[]): ParsedFile => {
  const symbols: ParsedSymbol[] = []
  const edges: ParsedEdge[] = []
  const edgeKeys = new Set<string>()
  const classStack: { name: string; indent: number; end: number }[] = []

  const addEdge = (edge: ParsedEdge) => {
    const key = `${edge.srcName}->${edge.dstName}:${edge.kind}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(edge)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const indent = indentOf(line)

    while (classStack.length > 0) {
      const top = classStack[classStack.length - 1]
      if (!top || indent > top.indent) break
      classStack.pop()
    }

    const cls = trimmed.match(/^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/)
    if (cls?.[1]) {
      const name = cls[1]
      const end = blockEndByIndent(lines, index, indent)
      const doc = docstringAfter(lines, index) || extractDoc(lines, index, "python")
      symbols.push({
        name,
        kind: "class",
        startLine: index + 1,
        endLine: end,
        signature: normalize(line),
        exported: !name.startsWith("_"),
        visibility: visibilityFor("python", line, !name.startsWith("_")),
        doc
      })

      for (const base of splitNames(cls[2] ?? "")) {
        addEdge({ srcName: name, dstName: base, kind: "extends", srcLine: index + 1 })
      }

      classStack.push({ name, indent, end })
      continue
    }

    const fn = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
    if (fn?.[1]) {
      const container = classStack[classStack.length - 1]
      const name = container ? `${container.name}.${fn[1]}` : fn[1]
      const end = blockEndByIndent(lines, index, indent)
      const doc = docstringAfter(lines, index) || extractDoc(lines, index, "python")
      symbols.push({
        name,
        kind: container ? "method" : "function",
        startLine: index + 1,
        endLine: end,
        signature: normalize(line),
        exported: !fn[1].startsWith("_"),
        visibility: visibilityFor("python", line, !fn[1].startsWith("_")),
        doc,
        ...(container ? { containerName: container.name } : {})
      })
      if (container) {
        addEdge({
          srcName: container.name,
          dstName: name,
          kind: "contains",
          srcLine: index + 1
        })
      }

      // Calls inside the function body.
      for (let callLine = index + 1; callLine < end; callLine += 1) {
        const text = stripStringsAndComments(lines[callLine] ?? "")
        const pattern = /\b([A-Za-z_]\w*)\s*\(/g
        let match: RegExpExecArray | null = pattern.exec(text)
        while (match) {
          const callee = match[1]
          if (callee && !CALL_KEYWORDS.has(callee) && callee !== fn[1]) {
            addEdge({
              srcName: name,
              dstName: callee,
              kind: "call",
              srcLine: callLine + 1
            })
          }
          match = pattern.exec(text)
        }
      }
      continue
    }

    const constant = trimmed.match(/^([A-Z][A-Z0-9_]{2,})\s*=/)
    if (constant?.[1]) {
      symbols.push({
        name: constant[1],
        kind: "const",
        startLine: index + 1,
        endLine: index + 1,
        signature: normalize(line),
        exported: true,
        visibility: "public",
        doc: extractDoc(lines, index, "python")
      })
    }
  }

  symbols.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))
  return { path: "", symbols, edges }
}

const rubyEnd = (lines: readonly string[], start: number): number => {
  let depth = 1
  const openers = /^\s*(?:class|module|def|do|if|unless|case|while|until|for|begin)\b/
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (openers.test(line) && !/\bend\b/.test(line)) depth += 1
    if (/^\s*end\b/.test(line)) {
      depth -= 1
      if (depth <= 0) return index + 1
    }
  }
  return lines.length
}

const parseRuby = (lines: readonly string[]): ParsedFile => {
  const symbols: ParsedSymbol[] = []
  const edges: ParsedEdge[] = []
  const edgeKeys = new Set<string>()
  const containers: { name: string; end: number }[] = []

  const addEdge = (edge: ParsedEdge) => {
    const key = `${edge.srcName}->${edge.dstName}:${edge.kind}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(edge)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue

    while (containers.length > 0) {
      const top = containers[containers.length - 1]
      if (!top || index + 1 <= top.end) break
      containers.pop()
    }

    const cls = trimmed.match(/^(class|module)\s+([A-Za-z_][\w:]*)/)
    if (cls?.[2]) {
      const name = cls[2].split("::").pop() ?? cls[2]
      const end = rubyEnd(lines, index)
      symbols.push({
        name,
        kind: "class",
        startLine: index + 1,
        endLine: end,
        signature: normalize(line),
        exported: true,
        visibility: "public",
        doc: extractDoc(lines, index, "ruby")
      })
      containers.push({ name, end })
      continue
    }

    const fn = trimmed.match(/^def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/)
    if (fn?.[1]) {
      const container = containers[containers.length - 1]
      const name = container ? `${container.name}.${fn[1]}` : fn[1]
      const end = rubyEnd(lines, index)
      symbols.push({
        name,
        kind: container ? "method" : "function",
        startLine: index + 1,
        endLine: end,
        signature: normalize(line),
        exported: !fn[1].startsWith("_"),
        visibility: visibilityFor("ruby", line, !fn[1].startsWith("_")),
        doc: extractDoc(lines, index, "ruby"),
        ...(container ? { containerName: container.name } : {})
      })
      if (container) {
        addEdge({
          srcName: container.name,
          dstName: name,
          kind: "contains",
          srcLine: index + 1
        })
      }
    }
  }

  symbols.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))
  return { path: "", symbols, edges }
}

export const parseGenericFile = (
  language: Language,
  filePath: string,
  content: string
): ParsedFile => {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const parsed =
    language === "python"
      ? parsePython(lines)
      : language === "ruby"
        ? parseRuby(lines)
        : parseBraceLanguage(language, lines)

  return { ...parsed, path: filePath, parseStatus: "partial" }
}
