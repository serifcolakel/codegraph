import Parser from "tree-sitter"
import CSharp from "tree-sitter-c-sharp"
import type { ParsedEdge, ParsedSymbol } from "../domain/models.js"
import { computeTreeComplexity } from "./complexity.js"
import { headerOf, leadingComment, normalizeSignature, trimDoc } from "./doc.js"
import { withThrowsEdges } from "./throws.js"
import type { SourceParser } from "./types.js"

type Node = Parser.SyntaxNode

const lineOf = (node: Node): number => node.startPosition.row + 1
const endLineOf = (node: Node): number => node.endPosition.row + 1

const DOC_PATTERN = /^\s*\/\/\//
const ATTRIBUTE_PATTERN = /^\s*\[/

const nameOf = (node: Node): string | undefined =>
  node.childForFieldName("name")?.text ??
  node.namedChildren.find((child) => child.type === "identifier")?.text

const modifierOf = (node: Node): string =>
  node.namedChildren.find((child) => child.type === "modifier")?.text ?? ""

const visibilityOf = (
  node: Node,
  fallback: ParsedSymbol["visibility"]
): ParsedSymbol["visibility"] => {
  const modifier = modifierOf(node)
  if (/\bpublic\b/.test(modifier)) return "public"
  if (/\bprivate\b/.test(modifier)) return "private"
  if (/\bprotected\b/.test(modifier)) return "protected"
  if (/\binternal\b/.test(modifier)) return "internal"
  return fallback
}

const cleanCsharpDoc = (raw: string): string =>
  trimDoc(
    raw
      .replace(/<exception\s+cref="([^"]+)">([\s\S]*?)<\/exception>/gi, "@throws $1 $2")
      .replace(/<param\s+name="([^"]+)">([\s\S]*?)<\/param>/gi, "@param $1 $2")
      .replace(/<typeparam\s+name="([^"]+)">([\s\S]*?)<\/typeparam>/gi, "@typeparam $1 $2")
      .replace(/<returns>([\s\S]*?)<\/returns>/gi, "@returns $1")
      .replace(/<summary>([\s\S]*?)<\/summary>/gi, "$1")
      .replace(/<remarks>([\s\S]*?)<\/remarks>/gi, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
  )

export const parseCsharpFile: SourceParser["parse"] = (filePath, content) => {
  const parser = new Parser()
  parser.setLanguage(CSharp)
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

  const docAt = (row: number): string =>
    cleanCsharpDoc(leadingComment(lines, row, DOC_PATTERN, ATTRIBUTE_PATTERN))

  const addCallEdges = (body: Node | null, caller: string, className?: string) => {
    if (!body) return
    for (const invocation of body.descendantsOfType("invocation_expression")) {
      const callee = invocation.namedChildren[0]
      if (!callee) continue

      let calledName: string | undefined
      if (callee.type === "identifier") {
        calledName = callee.text
      } else if (callee.type === "member_access_expression") {
        const property =
          callee.childForFieldName("name")?.text ??
          callee.namedChildren.at(-1)?.descendantsOfType("identifier")[0]?.text
        const object = callee.childForFieldName("expression")?.text
        if (!property) continue
        calledName = object === "this" && className ? `${className}.${property}` : property
      }

      if (!calledName || calledName === caller) continue
      addEdge({ srcName: caller, dstName: calledName, kind: "call", srcLine: lineOf(invocation) })
    }
  }

  const addMethod = (node: Node, container?: string, forcePublic = false) => {
    const name = nameOf(node)
    if (!name) return
    const qualified = container ? `${container}.${name}` : name
    const visibility = forcePublic ? "public" : visibilityOf(node, "private")
    const body = node.childForFieldName("body") ?? null

    const params =
      node.namedChildren.find((child) => child.type === "parameter_list")?.namedChildren.length ?? 0
    symbols.push({
      name: qualified,
      kind: container ? "method" : "function",
      startLine: lineOf(node),
      endLine: endLineOf(node),
      signature: headerOf(node, ["block", "arrow_expression_clause"]),
      exported: visibility === "public" || visibility === "protected",
      visibility,
      doc: docAt(node.startPosition.row),
      ...computeTreeComplexity(body, name, params),
      ...(container ? { containerName: container } : {})
    })

    if (container) {
      addEdge({ srcName: container, dstName: qualified, kind: "contains", srcLine: lineOf(node) })
    }

    addCallEdges(body, qualified, container)
  }

  const addField = (node: Node, container: string) => {
    const visibility = visibilityOf(node, "private")
    for (const declarator of node.descendantsOfType("variable_declarator")) {
      const name = declarator.namedChildren.find((child) => child.type === "identifier")?.text
      if (!name) continue
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

  const addType = (node: Node, fallbackVisibility: ParsedSymbol["visibility"]) => {
    const name = nameOf(node)
    if (!name) return
    const visibility = visibilityOf(node, fallbackVisibility)
    const kind =
      node.type === "interface_declaration"
        ? "interface"
        : node.type === "enum_declaration"
          ? "enum"
          : node.type === "struct_declaration"
            ? "class"
            : "class"

    symbols.push({
      name,
      kind,
      startLine: lineOf(node),
      endLine: endLineOf(node),
      signature: headerOf(node, ["declaration_list"]),
      exported: visibility === "public" || visibility === "protected",
      visibility,
      doc: docAt(node.startPosition.row)
    })

    const baseList = node.namedChildren.find((child) => child.type === "base_list")
    for (const base of baseList?.descendantsOfType("identifier") ?? []) {
      addEdge({
        srcName: name,
        dstName: base.text,
        kind: /^I[A-Z]/.test(base.text) ? "implements" : "extends",
        srcLine: lineOf(node)
      })
    }

    const body = node.namedChildren.find((child) =>
      ["declaration_list", "enum_member_declaration_list"].includes(child.type)
    )
    if (!body) return

    for (const member of body.namedChildren) {
      if (member.type === "method_declaration" || member.type === "constructor_declaration") {
        addMethod(member, name, node.type === "interface_declaration")
      } else if (member.type === "field_declaration" || member.type === "property_declaration") {
        addField(member, name)
      } else if (member.type === "enum_member_declaration") {
        const memberName = member.namedChildren.find((child) => child.type === "identifier")?.text
        if (!memberName) continue
        symbols.push({
          name: `${name}.${memberName}`,
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
          dstName: `${name}.${memberName}`,
          kind: "contains",
          srcLine: lineOf(member)
        })
      } else if (
        member.type === "class_declaration" ||
        member.type === "interface_declaration" ||
        member.type === "struct_declaration" ||
        member.type === "enum_declaration"
      ) {
        addType(member, "private")
      }
    }
  }

  const visit = (node: Node, fallbackVisibility: ParsedSymbol["visibility"]) => {
    for (const child of node.namedChildren) {
      if (child.type === "using_directive") {
        const raw = child.text
          .replace(/^using\s+(?:static\s+)?/, "")
          .replace(/;$/, "")
          .trim()
        const specifier = raw.includes("=") ? (raw.split("=").pop() ?? raw).trim() : raw
        if (specifier && !specifier.includes("{")) {
          addEdge({
            srcName: specifier.split(".").pop() ?? specifier,
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
        child.type === "struct_declaration" ||
        child.type === "enum_declaration" ||
        child.type === "record_declaration"
      ) {
        addType(child, fallbackVisibility)
      } else if (
        child.type === "namespace_declaration" ||
        child.type === "file_scoped_namespace_declaration" ||
        child.type === "declaration_list"
      ) {
        visit(child, fallbackVisibility)
      }
    }
  }

  visit(root, "internal")

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
