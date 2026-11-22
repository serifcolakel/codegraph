import Parser from "tree-sitter"
import Python from "tree-sitter-python"
import type { ParsedEdge, ParsedSymbol } from "../domain/models.js"
import { computeTreeComplexity } from "./complexity.js"
import { leadingComment, normalizeSignature, trimDoc } from "./doc.js"
import { withThrowsEdges } from "./throws.js"
import type { SourceParser } from "./types.js"

type Node = Parser.SyntaxNode

const MAX_DOC_LENGTH = 2000

const lineOf = (node: Node): number => node.startPosition.row + 1
const endLineOf = (node: Node): number => node.endPosition.row + 1

const childText = (node: Node, fieldName: string): string | undefined =>
  node.childForFieldName(fieldName)?.text

const docstringOf = (body: Node | null): string => {
  const first = body?.namedChildren[0]
  if (first?.type !== "expression_statement") return ""
  const literal = first.namedChildren[0]
  if (literal?.type !== "string") return ""
  const content = literal.namedChildren.find((child) => child.type === "string_content")
  return trimDoc(content?.text ?? literal.text.replace(/^['"]+|['"]+$/g, "")).slice(
    0,
    MAX_DOC_LENGTH
  )
}

const nameOf = (node: Node): string | undefined =>
  node.childForFieldName("name")?.text ??
  node.namedChildren.find((child) => child.type === "identifier")?.text

const superclassNames = (node: Node): readonly string[] => {
  const args = node.namedChildren.find((child) => child.type === "argument_list")
  if (!args) return []
  return args.namedChildren
    .map((child) => (child.type === "identifier" ? child.text : child.namedChildren[0]?.text))
    .filter((name): name is string => Boolean(name))
    .map((name) => name.split(".").pop() ?? name)
}

const signatureOf = (node: Node): string => {
  const body = node.childForFieldName("body")
  const raw = body ? node.text.slice(0, Math.max(0, body.startIndex - node.startIndex)) : node.text
  return normalizeSignature(raw.replace(/:\s*$/, ""))
}

type ImportBinding = {
  readonly specifier: string
  readonly importedName: string
  readonly line: number
}

const collectImports = (root: Node): Map<string, ImportBinding> => {
  const bindings = new Map<string, ImportBinding>()

  for (const child of root.namedChildren) {
    if (child.type === "import_statement") {
      for (const item of child.namedChildren) {
        const imported = item.type === "aliased_import" ? childText(item, "name") : item.text
        const alias = item.type === "aliased_import" ? childText(item, "alias") : undefined
        if (!imported) continue
        const local = alias ?? imported.split(".").pop() ?? imported
        bindings.set(local, {
          specifier: imported,
          importedName: local,
          line: lineOf(child)
        })
      }
    } else if (child.type === "import_from_statement") {
      const specifier = childText(child, "module_name")
      if (!specifier) continue
      for (const item of child.namedChildren) {
        if (item === child.childForFieldName("module_name")) continue
        if (item.type !== "dotted_name" && item.type !== "aliased_import") continue
        const imported = item.type === "aliased_import" ? childText(item, "name") : item.text
        const alias = item.type === "aliased_import" ? childText(item, "alias") : undefined
        if (!imported) continue
        const local = alias ?? imported.split(".").pop() ?? imported
        bindings.set(local, {
          specifier,
          importedName: imported.split(".").pop() ?? imported,
          line: lineOf(child)
        })
      }
    }
  }

  return bindings
}

export const parsePythonFile: SourceParser["parse"] = (filePath, content) => {
  const parser = new Parser()
  parser.setLanguage(Python)
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

  const imports = collectImports(root)
  const routeNames = new Set<string>()
  const addRoute = (
    method: string,
    routePath: string,
    line: number,
    endLine: number,
    handler?: string
  ) => {
    const name = `${method} ${routePath}`
    if (routeNames.has(name)) return
    routeNames.add(name)
    symbols.push({
      name,
      kind: "route",
      startLine: line,
      endLine,
      signature: name,
      exported: true,
      visibility: "public"
    })
    if (handler) {
      addEdge({ srcName: name, dstName: handler, kind: "contains", srcLine: line })
    }
  }
  for (const [local, binding] of imports) {
    addEdge({
      srcName: local,
      dstName: binding.specifier,
      kind: "import",
      srcLine: binding.line,
      importPath: binding.specifier
    })
  }

  const docFor = (body: Node | null, commentStart: number): string => {
    const docstring = docstringOf(body)
    const comment = leadingComment(lines, commentStart, /^\s*#/)
    return trimDoc([comment, docstring].filter((part) => part.length > 0).join("\n"))
  }

  const addCallEdges = (body: Node | null, caller: string, className?: string) => {
    if (!body) return
    for (const call of body.descendantsOfType("call")) {
      const fn = call.childForFieldName("function") ?? call.namedChildren[0]
      if (!fn) continue

      let calledName: string | undefined
      let binding: ImportBinding | undefined

      if (fn.type === "identifier") {
        calledName = fn.text
        binding = imports.get(calledName)
      } else if (fn.type === "attribute") {
        const property = childText(fn, "attribute")
        const object = childText(fn, "object")
        if (!property) continue
        calledName = object === "self" && className ? `${className}.${property}` : property
      }

      if (!calledName || calledName === caller) continue

      addEdge({
        srcName: caller,
        dstName: binding?.importedName ?? calledName,
        kind: "call",
        srcLine: lineOf(call),
        ...(binding ? { importPath: binding.specifier } : {})
      })
    }
  }

  const addFunction = (declaration: Node, outer: Node, containerName?: string) => {
    const name = nameOf(declaration)
    if (!name) return
    const body = declaration.childForFieldName("body")
    const qualified = containerName ? `${containerName}.${name}` : name
    const exported = !name.startsWith("_")

    if (outer.type === "decorated_definition") {
      for (const decorator of outer.namedChildren) {
        if (decorator.type !== "decorator") continue
        const match = decorator.text.match(
          /@(?:[A-Za-z_]\w*)\.(get|post|put|patch|delete|options|head|route)\s*\(\s*["']([^"']+)["']/i
        )
        if (!match) continue
        const method = (match[1] ?? "").toUpperCase()
        const routePath = match[2] ?? "/"
        const methods =
          method === "ROUTE"
            ? Array.from(
                decorator.text.matchAll(/["'](get|post|put|patch|delete|options|head)["']/gi)
              ).map((item) => (item[1] ?? "").toUpperCase())
            : [method]
        const effective = methods.length > 0 ? methods : ["ALL"]
        for (const httpMethod of effective) {
          addRoute(httpMethod, routePath, lineOf(decorator), endLineOf(decorator), qualified)
        }
      }
    }

    const params = declaration.childForFieldName("parameters")?.namedChildren.length ?? 0
    symbols.push({
      name: qualified,
      kind: containerName ? "method" : "function",
      startLine: lineOf(outer),
      endLine: endLineOf(outer),
      signature: signatureOf(declaration),
      exported,
      visibility: exported ? "public" : "private",
      doc: docFor(body, outer.startPosition.row),
      ...computeTreeComplexity(body, name, params),
      ...(containerName ? { containerName } : {})
    })

    if (containerName) {
      addEdge({
        srcName: containerName,
        dstName: qualified,
        kind: "contains",
        srcLine: lineOf(outer)
      })
    }

    addCallEdges(body, qualified, containerName)
  }

  const addClass = (declaration: Node, outer: Node) => {
    const name = nameOf(declaration)
    if (!name) return
    const body = declaration.childForFieldName("body")
    const exported = !name.startsWith("_")

    symbols.push({
      name,
      kind: "class",
      startLine: lineOf(outer),
      endLine: endLineOf(outer),
      signature: signatureOf(declaration),
      exported,
      visibility: exported ? "public" : "private",
      doc: docFor(body, outer.startPosition.row)
    })

    for (const base of superclassNames(declaration)) {
      addEdge({ srcName: name, dstName: base, kind: "extends", srcLine: lineOf(outer) })
    }

    if (!body) return
    for (const member of body.namedChildren) {
      if (member.type === "function_definition") {
        addFunction(member, member, name)
      } else if (member.type === "class_definition") {
        addClass(member, member)
      } else if (member.type === "expression_statement") {
        const assignment = member.namedChildren.find((child) => child.type === "assignment")
        const left = assignment?.namedChildren[0]
        if (left?.type !== "identifier") continue
        const propertyName = left.text
        const propertyExported = !propertyName.startsWith("_")
        symbols.push({
          name: `${name}.${propertyName}`,
          kind: "property",
          startLine: lineOf(member),
          endLine: endLineOf(member),
          signature: normalizeSignature(member.text),
          exported: propertyExported,
          visibility: propertyExported ? "public" : "private",
          doc: leadingComment(lines, member.startPosition.row, /^\s*#/),
          containerName: name
        })
        addEdge({
          srcName: name,
          dstName: `${name}.${propertyName}`,
          kind: "contains",
          srcLine: lineOf(member)
        })
      }
    }
  }

  for (const child of root.namedChildren) {
    if (child.type === "function_definition") {
      addFunction(child, child)
    } else if (child.type === "class_definition") {
      addClass(child, child)
    } else if (child.type === "decorated_definition") {
      const declaration = child.namedChildren.find(
        (node) => node.type === "function_definition" || node.type === "class_definition"
      )
      if (declaration?.type === "function_definition") addFunction(declaration, child)
      else if (declaration?.type === "class_definition") addClass(declaration, child)
    } else if (child.type === "expression_statement") {
      const assignment = child.namedChildren.find((node) => node.type === "assignment")
      const left = assignment?.namedChildren[0]
      if (left?.type !== "identifier" || !/^[A-Z][A-Z0-9_]{2,}$/.test(left.text)) continue
      symbols.push({
        name: left.text,
        kind: "const",
        startLine: lineOf(child),
        endLine: endLineOf(child),
        signature: normalizeSignature(child.text),
        exported: true,
        visibility: "public",
        doc: leadingComment(lines, child.startPosition.row, /^\s*#/)
      })
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
    "raises"
  )
}
