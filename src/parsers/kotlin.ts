import Parser from "tree-sitter"
import Kotlin from "tree-sitter-kotlin"
import type { ParsedEdge, ParsedSymbol } from "../domain/models.js"
import { headerOf, leadingComment, normalizeSignature, trimDoc } from "./doc.js"
import { withThrowsEdges } from "./throws.js"
import type { SourceParser } from "./types.js"

type Node = Parser.SyntaxNode

const lineOf = (node: Node): number => node.startPosition.row + 1
const endLineOf = (node: Node): number => node.endPosition.row + 1

const DOC_PATTERN = /^\s*(?:\/\/|\/\*|\*)/
const ANNOTATION_PATTERN = /^\s*@/

const nameOf = (node: Node): string | undefined =>
  node.namedChildren.find((child) => child.type === "type_identifier")?.text ??
  node.namedChildren.find((child) => child.type === "simple_identifier")?.text

const modifiersOf = (node: Node): string =>
  node.namedChildren.find((child) => child.type === "modifiers")?.text ?? ""

const visibilityOf = (node: Node): ParsedSymbol["visibility"] => {
  const modifiers = modifiersOf(node)
  if (/\bprivate\b/.test(modifiers)) return "private"
  if (/\bprotected\b/.test(modifiers)) return "protected"
  if (/\binternal\b/.test(modifiers)) return "internal"
  return "public"
}

export const parseKotlinFile: SourceParser["parse"] = (filePath, content) => {
  const parser = new Parser()
  parser.setLanguage(Kotlin)
  const tree = parser.parse(content)
  const root = tree.rootNode
  const lines = content.split("\n")

  const symbols: ParsedSymbol[] = []
  const edges: ParsedEdge[] = []
  const edgeKeys = new Set<string>()

  const addEdge = (edge: ParsedEdge) => {
    const key = `${edge.srcName}->${edge.dstName}:${edge.kind}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(edge)
  }

  const docAt = (row: number): string => leadingComment(lines, row, DOC_PATTERN, ANNOTATION_PATTERN)

  const addCallEdges = (body: Node | null, caller: string, className?: string) => {
    if (!body) return
    for (const call of body.descendantsOfType("call_expression")) {
      const callee = call.namedChildren[0]
      if (!callee) continue

      let calledName: string | undefined
      if (callee.type === "simple_identifier") {
        calledName = callee.text
      } else if (callee.type === "navigation_expression") {
        const parts = callee.namedChildren
        const property = parts.at(-1)?.descendantsOfType("simple_identifier")[0]?.text
        const object = parts[0]?.text
        if (!property) continue
        calledName = object === "this" && className ? `${className}.${property}` : property
      }

      if (!calledName || calledName === caller) continue
      addEdge({ srcName: caller, dstName: calledName, kind: "call", srcLine: lineOf(call) })
    }
  }

  const addFunction = (node: Node, container?: string) => {
    const name = nameOf(node)
    if (!name) return
    const qualified = container ? `${container}.${name}` : name
    const visibility = visibilityOf(node)
    const body = node.namedChildren.find((child) => child.type === "function_body") ?? null

    symbols.push({
      name: qualified,
      kind: container ? "method" : "function",
      startLine: lineOf(node),
      endLine: endLineOf(node),
      signature: headerOf(node, ["function_body"]),
      exported: visibility === "public" || visibility === "protected",
      visibility,
      doc: docAt(node.startPosition.row),
      ...(container ? { containerName: container } : {})
    })

    if (container) {
      addEdge({ srcName: container, dstName: qualified, kind: "contains", srcLine: lineOf(node) })
    }

    addCallEdges(body, qualified, container)
  }

  const addProperty = (node: Node, container: string) => {
    const declaration = node.namedChildren.find((child) => child.type === "variable_declaration")
    const name =
      declaration?.descendantsOfType("simple_identifier")[0]?.text ??
      node.descendantsOfType("simple_identifier")[0]?.text
    if (!name) return
    const visibility = visibilityOf(node)
    symbols.push({
      name: `${container}.${name}`,
      kind: "property",
      startLine: lineOf(node),
      endLine: endLineOf(node),
      signature: normalizeSignature(trimDoc(node.text).split("\n")[0] ?? name),
      exported: visibility === "public" || visibility === "protected",
      visibility,
      doc: docAt(node.startPosition.row),
      containerName: container
    })
    addEdge({
      srcName: container,
      dstName: `${container}.${name}`,
      kind: "contains",
      srcLine: lineOf(node)
    })
  }

  const addType = (node: Node) => {
    const name = nameOf(node)
    if (!name) return

    const body = node.namedChildren.find((child) =>
      ["class_body", "enum_class_body"].includes(child.type)
    )
    const isEnum = body?.type === "enum_class_body" || /^\s*enum\s+class\b/.test(node.text)
    const isInterface = /^\s*(?:public\s+|internal\s+|private\s+)?interface\b/.test(node.text)
    const kind = isEnum ? "enum" : isInterface ? "interface" : "class"
    const visibility = visibilityOf(node)

    symbols.push({
      name,
      kind,
      startLine: lineOf(node),
      endLine: endLineOf(node),
      signature: headerOf(node, ["class_body", "enum_class_body"]),
      exported: visibility === "public" || visibility === "protected",
      visibility,
      doc: docAt(node.startPosition.row)
    })

    for (const specifier of node.namedChildren.filter(
      (child) => child.type === "delegation_specifier"
    )) {
      const base = specifier.descendantsOfType("type_identifier")[0]?.text
      if (!base) continue
      const isConstructor = specifier.descendantsOfType("constructor_invocation").length > 0
      addEdge({
        srcName: name,
        dstName: base,
        kind: isConstructor ? "extends" : "implements",
        srcLine: lineOf(node)
      })
    }

    if (!body) return
    for (const member of body.namedChildren) {
      if (member.type === "function_declaration") {
        addFunction(member, name)
      } else if (member.type === "property_declaration") {
        addProperty(member, name)
      } else if (member.type === "enum_entry") {
        const entryName = member.descendantsOfType("simple_identifier")[0]?.text
        if (!entryName) continue
        symbols.push({
          name: `${name}.${entryName}`,
          kind: "property",
          startLine: lineOf(member),
          endLine: endLineOf(member),
          signature: normalizeSignature(member.text),
          exported: true,
          visibility: "public",
          containerName: name
        })
        addEdge({
          srcName: name,
          dstName: `${name}.${entryName}`,
          kind: "contains",
          srcLine: lineOf(member)
        })
      } else if (member.type === "class_declaration" || member.type === "object_declaration") {
        addType(member)
      }
    }
  }

  for (const child of root.namedChildren) {
    if (child.type === "import_header") {
      const raw = child.text.replace(/^import\s+/, "").trim()
      const specifier = raw.split(/\s+as\s+/)[0] ?? raw
      addEdge({
        srcName: specifier.split(".").pop() ?? specifier,
        dstName: specifier,
        kind: "import",
        srcLine: lineOf(child),
        importPath: specifier
      })
      continue
    }
    if (child.type === "class_declaration" || child.type === "object_declaration") {
      addType(child)
    } else if (child.type === "function_declaration") {
      addFunction(child)
    }
  }

  symbols.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))

  return withThrowsEdges(
    {
      path: filePath,
      symbols,
      edges,
      parseStatus: root.hasError ? "partial" : "parsed"
    },
    "throws"
  )
}
