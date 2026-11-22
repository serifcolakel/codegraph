import Parser from "tree-sitter"
import Java from "tree-sitter-java"
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
  node.childForFieldName("name")?.text ??
  node.namedChildren.find((child) => child.type === "identifier")?.text

const modifiersOf = (node: Node): string =>
  node.namedChildren.find((child) => child.type === "modifiers")?.text ?? ""

const visibilityOf = (
  node: Node,
  fallback: ParsedSymbol["visibility"]
): ParsedSymbol["visibility"] => {
  const modifiers = modifiersOf(node)
  if (/\bpublic\b/.test(modifiers)) return "public"
  if (/\bprivate\b/.test(modifiers)) return "private"
  if (/\bprotected\b/.test(modifiers)) return "protected"
  return fallback
}

const header = (node: Node, bodyTypes: readonly string[]): string => headerOf(node, bodyTypes)

export const parseJavaFile: SourceParser["parse"] = (filePath, content) => {
  const parser = new Parser()
  parser.setLanguage(Java)
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
    for (const invocation of body.descendantsOfType("method_invocation")) {
      const name = invocation.childForFieldName("name")?.text
      const object = invocation.childForFieldName("object")?.text
      if (!name) continue
      const calledName = object === "this" && className ? `${className}.${name}` : name
      if (calledName === caller) continue
      addEdge({ srcName: caller, dstName: calledName, kind: "call", srcLine: lineOf(invocation) })
    }
  }

  const addMethod = (node: Node, container?: string, forcePublic = false) => {
    const name = nameOf(node)
    if (!name) return
    const qualified = container ? `${container}.${name}` : name
    const visibility = forcePublic ? "public" : visibilityOf(node, "package")
    const body = node.childForFieldName("body") ?? null

    symbols.push({
      name: qualified,
      kind: container ? "method" : "function",
      startLine: lineOf(node),
      endLine: endLineOf(node),
      signature: header(node, ["block"]),
      exported: visibility === "public" || visibility === "protected",
      visibility,
      doc: docAt(node.startPosition.row),
      ...(container ? { containerName: container } : {})
    })

    if (container) {
      addEdge({ srcName: container, dstName: qualified, kind: "contains", srcLine: lineOf(node) })
    }

    addCallEdges(body, qualified, container)

    const throwsClause = node.namedChildren.find((child) => child.type === "throws")
    for (const thrown of throwsClause?.descendantsOfType("type_identifier") ?? []) {
      addEdge({
        srcName: qualified,
        dstName: thrown.text,
        kind: "throws",
        srcLine: lineOf(node)
      })
    }
  }

  const addField = (node: Node, container: string) => {
    for (const declarator of node.descendantsOfType("variable_declarator")) {
      const name = declarator.childForFieldName("name")?.text ?? declarator.namedChildren[0]?.text
      if (!name) continue
      const visibility = visibilityOf(node, "private")
      symbols.push({
        name: `${container}.${name}`,
        kind: "property",
        startLine: lineOf(declarator),
        endLine: endLineOf(declarator),
        signature: normalizeSignature(trimDoc(declarator.text).split("\n")[0] ?? name),
        exported: visibility === "public" || visibility === "protected",
        visibility,
        doc: docAt(node.startPosition.row),
        containerName: container
      })
      addEdge({
        srcName: container,
        dstName: `${container}.${name}`,
        kind: "contains",
        srcLine: lineOf(declarator)
      })
    }
  }

  const addEnumMembers = (body: Node, container: string) => {
    for (const member of body.namedChildren) {
      if (member.type !== "enum_constant") continue
      const name = member.childForFieldName("name")?.text ?? member.namedChildren[0]?.text
      if (!name) continue
      symbols.push({
        name: `${container}.${name}`,
        kind: "property",
        startLine: lineOf(member),
        endLine: endLineOf(member),
        signature: normalizeSignature(member.text),
        exported: true,
        visibility: "public",
        containerName: container
      })
      addEdge({
        srcName: container,
        dstName: `${container}.${name}`,
        kind: "contains",
        srcLine: lineOf(member)
      })
    }
  }

  const addTypeDeclaration = (node: Node) => {
    const name = nameOf(node)
    if (!name) return
    const visibility = visibilityOf(node, "package")
    const kind =
      node.type === "interface_declaration"
        ? "interface"
        : node.type === "enum_declaration"
          ? "enum"
          : "class"
    const bodyTypes =
      node.type === "class_declaration" || node.type === "record_declaration"
        ? ["class_body"]
        : node.type === "interface_declaration"
          ? ["interface_body"]
          : node.type === "enum_declaration"
            ? ["enum_body"]
            : ["class_body"]

    symbols.push({
      name,
      kind,
      startLine: lineOf(node),
      endLine: endLineOf(node),
      signature: header(node, bodyTypes),
      exported: visibility === "public" || visibility === "protected",
      visibility,
      doc: docAt(node.startPosition.row)
    })

    const superclass = node.namedChildren.find((child) => child.type === "superclass")
    const base = superclass?.descendantsOfType("type_identifier")[0]?.text
    if (base) addEdge({ srcName: name, dstName: base, kind: "extends", srcLine: lineOf(node) })

    const interfaces = node.namedChildren.find((child) => child.type === "super_interfaces")
    for (const iface of interfaces?.descendantsOfType("type_identifier") ?? []) {
      addEdge({ srcName: name, dstName: iface.text, kind: "implements", srcLine: lineOf(node) })
    }

    const body = node.namedChildren.find((child) =>
      ["class_body", "interface_body", "enum_body"].includes(child.type)
    )
    if (!body) return
    for (const member of body.namedChildren) {
      if (member.type === "method_declaration" || member.type === "constructor_declaration") {
        addMethod(member, name, node.type === "interface_declaration")
      } else if (member.type === "field_declaration") {
        addField(member, name)
      } else if (member.type === "enum_constant") {
        // handled by addEnumMembers via the body loop below
      } else if (
        member.type === "class_declaration" ||
        member.type === "interface_declaration" ||
        member.type === "enum_declaration"
      ) {
        addTypeDeclaration(member)
      }
    }
    if (node.type === "enum_declaration") addEnumMembers(body, name)
  }

  for (const child of root.namedChildren) {
    if (child.type === "import_declaration") {
      const specifier = child.namedChildren.find((node) => node.type === "scoped_identifier")?.text
      if (specifier) {
        const local = specifier.split(".").pop() ?? specifier
        addEdge({
          srcName: local,
          dstName: specifier,
          kind: "import",
          srcLine: lineOf(child),
          importPath: specifier
        })
      }
      continue
    }
    if (
      child.type === "class_declaration" ||
      child.type === "interface_declaration" ||
      child.type === "enum_declaration" ||
      child.type === "record_declaration"
    ) {
      addTypeDeclaration(child)
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
