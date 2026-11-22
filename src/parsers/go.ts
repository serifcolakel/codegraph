import Parser from "tree-sitter"
import Go from "tree-sitter-go"
import type { ParsedEdge, ParsedSymbol } from "../domain/models.js"
import { computeTreeComplexity } from "./complexity.js"
import { headerOf, leadingComment, trimDoc } from "./doc.js"
import type { SourceParser } from "./types.js"

type Node = Parser.SyntaxNode

const lineOf = (node: Node): number => node.startPosition.row + 1
const endLineOf = (node: Node): number => node.endPosition.row + 1

const isExported = (name: string): boolean => /^[A-Z]/.test(name)

const typeNameOf = (node: Node): string | undefined =>
  node.childForFieldName("name")?.text ??
  node.namedChildren.find((child) => child.type === "type_identifier")?.text

const functionNameOf = (node: Node): string | undefined =>
  node.childForFieldName("name")?.text ??
  node.namedChildren.find(
    (child) => child.type === "identifier" || child.type === "field_identifier"
  )?.text

const receiverInfo = (
  node: Node
): { readonly typeName: string; readonly variable?: string } | undefined => {
  const receiver = node.childForFieldName("receiver")
  const declaration = receiver?.namedChildren.find(
    (child) => child.type === "parameter_declaration"
  )
  if (!declaration) return undefined
  const typeName = declaration.descendantsOfType("type_identifier")[0]?.text
  if (!typeName) return undefined
  const variable = declaration.namedChildren.find((child) => child.type === "identifier")?.text
  return variable ? { typeName, variable } : { typeName }
}

type ImportBinding = { readonly specifier: string; readonly line: number }

const collectImports = (root: Node): Map<string, ImportBinding> => {
  const bindings = new Map<string, ImportBinding>()
  for (const spec of root.descendantsOfType("import_spec")) {
    const literal = spec.namedChildren.find(
      (child) => child.type === "interpreted_string_literal" || child.type === "raw_string_literal"
    )
    if (!literal) continue
    const specifier = literal.text.replace(/^["`]|["`]$/g, "")
    const alias = spec.namedChildren.find((child) => child.type === "package_identifier")?.text
    const local = alias ?? specifier.split("/").pop() ?? specifier
    bindings.set(local, { specifier, line: lineOf(spec) })
  }
  return bindings
}

export const parseGoFile: SourceParser["parse"] = (filePath, content) => {
  const parser = new Parser()
  parser.setLanguage(Go)
  const tree = parser.parse(content)
  const root = tree.rootNode
  const lines = content.split("\n")

  const symbols: ParsedSymbol[] = []
  const edges: ParsedEdge[] = []
  const edgeKeys = new Set<string>()
  const imports = collectImports(root)

  const addEdge = (edge: ParsedEdge) => {
    const key = `${edge.srcName}->${edge.dstName}:${edge.kind}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(edge)
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

  const docAt = (row: number): string => leadingComment(lines, row, /^\s*\/\//)

  const addCallEdges = (
    body: Node | null,
    caller: string,
    receiver?: { readonly typeName: string; readonly variable?: string }
  ) => {
    if (!body) return
    for (const call of body.descendantsOfType("call_expression")) {
      const fn = call.childForFieldName("function") ?? call.namedChildren[0]
      if (!fn) continue

      let calledName: string | undefined
      let importPath: string | undefined

      if (fn.type === "identifier") {
        calledName = fn.text
      } else if (fn.type === "selector_expression") {
        const field = fn.childForFieldName("field")?.text
        const operand = fn.childForFieldName("operand")?.text
        if (!field) continue
        if (receiver?.variable && operand === receiver.variable) {
          calledName = `${receiver.typeName}.${field}`
        } else if (operand && imports.has(operand)) {
          calledName = field
          importPath = imports.get(operand)?.specifier
        } else {
          calledName = field
        }
      }

      if (!calledName || calledName === caller) continue
      addEdge({
        srcName: caller,
        dstName: calledName,
        kind: "call",
        srcLine: lineOf(call),
        ...(importPath ? { importPath } : {})
      })
    }
  }

  const addStructMembers = (structType: Node, container: string) => {
    for (const field of structType.descendantsOfType("field_declaration")) {
      const name = field.childForFieldName("name")?.text ?? field.namedChildren[0]?.text
      if (!name || field.namedChildren.length === 1) {
        // Embedded type: treat it as an extends edge.
        const embedded = field.descendantsOfType("type_identifier")[0]?.text
        if (embedded) {
          addEdge({
            srcName: container,
            dstName: embedded,
            kind: "extends",
            srcLine: lineOf(field)
          })
        }
        continue
      }
      const exported = isExported(name)
      symbols.push({
        name: `${container}.${name}`,
        kind: "property",
        startLine: lineOf(field),
        endLine: endLineOf(field),
        signature: trimDoc(field.text).split("\n")[0] ?? name,
        exported,
        visibility: exported ? "public" : "package",
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

  const addInterfaceMethods = (interfaceType: Node, container: string) => {
    for (const method of interfaceType.descendantsOfType("method_elem")) {
      const name = method.childForFieldName("name")?.text ?? method.namedChildren[0]?.text
      if (!name) continue
      const exported = isExported(name)
      symbols.push({
        name: `${container}.${name}`,
        kind: "method",
        startLine: lineOf(method),
        endLine: endLineOf(method),
        signature: trimDoc(method.text).split("\n")[0] ?? name,
        exported,
        visibility: exported ? "public" : "package",
        doc: docAt(method.startPosition.row),
        containerName: container
      })
      addEdge({
        srcName: container,
        dstName: `${container}.${name}`,
        kind: "contains",
        srcLine: lineOf(method)
      })
    }
  }

  const addFunction = (node: Node) => {
    const name = functionNameOf(node)
    if (!name) return
    const body = node.childForFieldName("body")
    const receiver = node.type === "method_declaration" ? receiverInfo(node) : undefined
    const containerName = receiver?.typeName
    const qualified = containerName ? `${containerName}.${name}` : name
    const exported = isExported(name)

    const params = node.childForFieldName("parameters")?.namedChildren.length ?? 0
    symbols.push({
      name: qualified,
      kind: receiver ? "method" : "function",
      startLine: lineOf(node),
      endLine: endLineOf(node),
      signature: headerOf(node, ["block"]),
      exported,
      visibility: exported ? "public" : "package",
      doc: docAt(node.startPosition.row),
      ...computeTreeComplexity(body, name, params),
      ...(containerName ? { containerName } : {})
    })

    if (containerName) {
      addEdge({
        srcName: containerName,
        dstName: qualified,
        kind: "contains",
        srcLine: lineOf(node)
      })
    }

    addCallEdges(body, qualified, receiver)
  }

  for (const child of root.namedChildren) {
    switch (child.type) {
      case "function_declaration":
        addFunction(child)
        break
      case "method_declaration":
        addFunction(child)
        break
      case "type_declaration": {
        for (const typeSpec of child.namedChildren) {
          if (typeSpec.type !== "type_spec") continue
          const name = typeNameOf(typeSpec)
          if (!name) continue
          const underlying =
            typeSpec.namedChildren.find(
              (node) => node.type === "struct_type" || node.type === "interface_type"
            ) ??
            typeSpec.namedChildren.find((node) =>
              ["type_identifier", "slice_type", "map_type"].includes(node.type)
            )
          const kind =
            underlying?.type === "struct_type"
              ? "class"
              : underlying?.type === "interface_type"
                ? "interface"
                : "type"
          const exported = isExported(name)
          symbols.push({
            name,
            kind,
            startLine: lineOf(typeSpec),
            endLine: endLineOf(typeSpec),
            signature: headerOf(typeSpec, ["struct_type", "interface_type"]),
            exported,
            visibility: exported ? "public" : "package",
            doc: docAt(child.startPosition.row)
          })

          if (underlying?.type === "struct_type") {
            addStructMembers(underlying, name)
          } else if (underlying?.type === "interface_type") {
            addInterfaceMethods(underlying, name)
          }
        }
        break
      }
      case "const_declaration":
      case "var_declaration": {
        for (const spec of child.descendantsOfType(["const_spec", "var_spec"])) {
          const name = spec.namedChildren.find((node) => node.type === "identifier")?.text
          if (!name) continue
          const exported = isExported(name)
          symbols.push({
            name,
            kind: "const",
            startLine: lineOf(spec),
            endLine: endLineOf(spec),
            signature: trimDoc(spec.text).split("\n")[0] ?? name,
            exported,
            visibility: exported ? "public" : "package",
            doc: docAt(child.startPosition.row)
          })
        }
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
