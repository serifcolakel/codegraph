import Parser from "tree-sitter"
import Rust from "tree-sitter-rust"
import type { ParsedEdge, ParsedSymbol } from "../domain/models.js"
import { computeTreeComplexity } from "./complexity.js"
import { headerOf, leadingComment, normalizeSignature, trimDoc } from "./doc.js"
import type { SourceParser } from "./types.js"

type Node = Parser.SyntaxNode

const lineOf = (node: Node): number => node.startPosition.row + 1
const endLineOf = (node: Node): number => node.endPosition.row + 1

const DOC_PATTERN = /^\s*\/\/[/!]/
const ATTRIBUTE_PATTERN = /^\s*#\[/

const isPublic = (node: Node): boolean =>
  node.namedChildren.some((child) => child.type === "visibility_modifier")

const itemNameOf = (node: Node): string | undefined =>
  node.childForFieldName("name")?.text ??
  node.namedChildren.find(
    (child) => child.type === "type_identifier" || child.type === "identifier"
  )?.text

const header = (node: Node, bodyTypes: readonly string[]): string => {
  const directBody = node.namedChildren.find((child) => bodyTypes.includes(child.type))
  if (directBody) {
    return normalizeSignature(
      node.text.slice(0, Math.max(0, directBody.startIndex - node.startIndex))
    ).replace(/:\s*$/, "")
  }
  return headerOf(node, bodyTypes)
}

export const parseRustFile: SourceParser["parse"] = (filePath, content) => {
  const parser = new Parser()
  parser.setLanguage(Rust)
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

  const docAt = (row: number): string => leadingComment(lines, row, DOC_PATTERN, ATTRIBUTE_PATTERN)

  const visibilityOf = (node: Node): ParsedSymbol["visibility"] =>
    isPublic(node) ? "public" : "private"

  const addCallEdges = (body: Node | null, caller: string, selfType?: string) => {
    if (!body) return
    for (const call of body.descendantsOfType("call_expression")) {
      const fn = call.childForFieldName("function") ?? call.namedChildren[0]
      if (!fn) continue

      let calledName: string | undefined

      if (fn.type === "identifier") {
        calledName = fn.text
      } else if (fn.type === "field_expression") {
        const field = fn.childForFieldName("field")?.text
        const value = fn.childForFieldName("value")?.text
        if (!field) continue
        calledName = value === "self" && selfType ? `${selfType}.${field}` : field
      } else if (fn.type === "scoped_identifier") {
        calledName = fn.namedChildren.at(-1)?.text
      }

      if (!calledName || calledName === caller) continue
      addEdge({ srcName: caller, dstName: calledName, kind: "call", srcLine: lineOf(call) })
    }
  }

  const addFieldSymbols = (body: Node, container: string) => {
    for (const field of body.namedChildren) {
      if (field.type !== "field_declaration") continue
      const name = field.childForFieldName("name")?.text ?? field.namedChildren[0]?.text
      if (!name) continue
      const visibility = visibilityOf(field)
      symbols.push({
        name: `${container}.${name}`,
        kind: "property",
        startLine: lineOf(field),
        endLine: endLineOf(field),
        signature: normalizeSignature(field.text),
        exported: visibility === "public",
        visibility,
        doc: docAt(field.startPosition.row),
        containerName: container
      })
      addEdge({
        srcName: container,
        dstName: `${container}.${name}`,
        kind: "contains",
        srcLine: lineOf(field)
      })
    }
  }

  const addEnumVariants = (body: Node, container: string) => {
    for (const variant of body.namedChildren) {
      if (variant.type !== "enum_variant") continue
      const name = variant.childForFieldName("name")?.text ?? variant.namedChildren[0]?.text
      if (!name) continue
      const visibility = visibilityOf(variant)
      symbols.push({
        name: `${container}.${name}`,
        kind: "property",
        startLine: lineOf(variant),
        endLine: endLineOf(variant),
        signature: normalizeSignature(variant.text),
        exported: true,
        visibility,
        doc: docAt(variant.startPosition.row),
        containerName: container
      })
      addEdge({
        srcName: container,
        dstName: `${container}.${name}`,
        kind: "contains",
        srcLine: lineOf(variant)
      })
    }
  }

  const addFunction = (node: Node, container?: string, selfType?: string) => {
    const name = itemNameOf(node)
    if (!name) return
    const qualified = container ? `${container}.${name}` : name
    const visibility = visibilityOf(node)
    const body = node.childForFieldName("body") ?? null

    const params = node.childForFieldName("parameters")?.namedChildren.length ?? 0
    symbols.push({
      name: qualified,
      kind: container ? "method" : "function",
      startLine: lineOf(node),
      endLine: endLineOf(node),
      signature: header(node, ["block"]),
      exported: visibility === "public",
      visibility,
      doc: docAt(node.startPosition.row),
      ...computeTreeComplexity(body, name, params),
      ...(container ? { containerName: container } : {})
    })

    if (container) {
      addEdge({
        srcName: container,
        dstName: qualified,
        kind: "contains",
        srcLine: lineOf(node)
      })
    }

    addCallEdges(body, qualified, selfType ?? container)
  }

  const addImpl = (node: Node) => {
    const target = node.childForFieldName("type")?.text
    const trait = node.childForFieldName("trait")?.text
    if (!target) return
    if (trait) {
      addEdge({ srcName: target, dstName: trait, kind: "implements", srcLine: lineOf(node) })
    }
    const body = node.namedChildren.find((child) => child.type === "declaration_list")
    if (!body) return
    for (const member of body.namedChildren) {
      if (member.type === "function_item") addFunction(member, target, target)
    }
  }

  for (const child of root.namedChildren) {
    if (child.type === "use_declaration") {
      const raw = child.text
        .replace(/^use\s+/, "")
        .replace(/;$/, "")
        .trim()
      if (raw && !raw.includes("{")) {
        addEdge({
          srcName: raw.split("::").pop() ?? raw,
          dstName: raw,
          kind: "import",
          srcLine: lineOf(child),
          importPath: raw
        })
      }
      continue
    }
    switch (child.type) {
      case "function_item":
        addFunction(child)
        break
      case "impl_item":
        addImpl(child)
        break
      case "struct_item":
      case "union_item": {
        const name = itemNameOf(child)
        if (!name) break
        const visibility = visibilityOf(child)
        symbols.push({
          name,
          kind: "class",
          startLine: lineOf(child),
          endLine: endLineOf(child),
          signature: header(child, ["field_declaration_list"]),
          exported: visibility === "public",
          visibility,
          doc: docAt(child.startPosition.row)
        })
        const body = child.namedChildren.find((node) => node.type === "field_declaration_list")
        if (body) addFieldSymbols(body, name)
        break
      }
      case "enum_item": {
        const name = itemNameOf(child)
        if (!name) break
        const visibility = visibilityOf(child)
        symbols.push({
          name,
          kind: "enum",
          startLine: lineOf(child),
          endLine: endLineOf(child),
          signature: header(child, ["enum_variant_list"]),
          exported: visibility === "public",
          visibility,
          doc: docAt(child.startPosition.row)
        })
        const body = child.namedChildren.find((node) => node.type === "enum_variant_list")
        if (body) addEnumVariants(body, name)
        break
      }
      case "trait_item": {
        const name = itemNameOf(child)
        if (!name) break
        const visibility = visibilityOf(child)
        symbols.push({
          name,
          kind: "interface",
          startLine: lineOf(child),
          endLine: endLineOf(child),
          signature: header(child, ["declaration_list"]),
          exported: visibility === "public",
          visibility,
          doc: docAt(child.startPosition.row)
        })
        const body = child.namedChildren.find((node) => node.type === "declaration_list")
        if (body) {
          for (const member of body.namedChildren) {
            if (member.type === "function_signature_item" || member.type === "function_item") {
              addFunction(member, name, name)
            }
          }
        }
        break
      }
      case "const_item":
      case "static_item": {
        const name = itemNameOf(child)
        if (!name) break
        const visibility = visibilityOf(child)
        symbols.push({
          name,
          kind: "const",
          startLine: lineOf(child),
          endLine: endLineOf(child),
          signature: normalizeSignature(trimDoc(child.text).split("\n")[0] ?? name),
          exported: visibility === "public",
          visibility,
          doc: docAt(child.startPosition.row)
        })
        break
      }
      case "type_item": {
        const name = itemNameOf(child)
        if (!name) break
        const visibility = visibilityOf(child)
        symbols.push({
          name,
          kind: "type",
          startLine: lineOf(child),
          endLine: endLineOf(child),
          signature: normalizeSignature(trimDoc(child.text).split("\n")[0] ?? name),
          exported: visibility === "public",
          visibility,
          doc: docAt(child.startPosition.row)
        })
        break
      }
    }
  }

  symbols.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))

  return {
    path: filePath,
    symbols,
    edges,
    parseStatus: root.hasError ? "partial" : "parsed"
  }
}
