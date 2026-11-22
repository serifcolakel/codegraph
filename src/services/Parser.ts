import { Context, Effect, Layer } from "effect"
import { type ArrowFunction, type FunctionExpression, Node, Project, SyntaxKind } from "ts-morph"
import { ParseError } from "../domain/errors.js"
import { isTypeScriptLanguage, languageForPath } from "../domain/languages.js"
import type {
  ParsedEdge,
  ParsedFile,
  ParsedSymbol,
  SymbolKind,
  SymbolVisibility
} from "../domain/models.js"
import { parseDockerfile } from "../parsers/config.js"
import { astParserFor } from "../parsers/index.js"
import { withThrowsEdges } from "../parsers/throws.js"
import { parseGenericFile } from "./GenericParser.js"

export interface Parser {
  readonly parse: (filePath: string, content: string) => Effect.Effect<ParsedFile, ParseError>
}

export const Parser = Context.GenericTag<Parser>("@codegraph/Parser")

const MAX_SIGNATURE_LENGTH = 400

const normalizeSignature = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > MAX_SIGNATURE_LENGTH
    ? `${normalized.slice(0, MAX_SIGNATURE_LENGTH - 3)}...`
    : normalized
}

// Returns the declaration text up to the real body node. Splitting on the
// first "{" would cut inside parameter object types such as
// `params: { fundType: FundType }`.
const getSignatureBeforeBody = (node: Node, body: Node | undefined): string => {
  const start = node.getStart()
  const end = body ? body.getStart() : node.getEnd()
  return normalizeSignature(node.getText().slice(0, Math.max(0, end - start)))
}

const getHeaderSignature = (text: string): string => {
  const braceIdx = text.indexOf("{")
  const header = braceIdx === -1 ? text : text.slice(0, braceIdx)
  return normalizeSignature(header)
}

const visibilityForScope = (scope: string | undefined): SymbolVisibility | undefined =>
  scope === "public" || scope === "private" || scope === "protected" ? scope : undefined

// Top-level declarations are public when exported and module-private otherwise.
const visibilityForDeclaration = (exported: boolean): SymbolVisibility =>
  exported ? "public" : "private"

type ComplexityFields = Pick<
  ParsedSymbol,
  | "cyclomatic"
  | "cognitive"
  | "loopDepth"
  | "loopCount"
  | "linearScanInLoop"
  | "allocInLoop"
  | "recursive"
  | "paramCount"
>

const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "ALL"])

const EXPRESS_ROUTE_RECEIVERS = new Set(["app", "router", "server", "fastify", "api"])

const SCAN_CALLS = new Set([
  "find",
  "findIndex",
  "includes",
  "indexOf",
  "some",
  "every",
  "filter",
  "contains"
])
const ALLOC_CALLS = new Set(["push", "unshift", "splice", "concat", "append", "add"])

const isFunctionLike = (node: Node): boolean =>
  Node.isFunctionDeclaration(node) ||
  Node.isFunctionExpression(node) ||
  Node.isArrowFunction(node) ||
  Node.isMethodDeclaration(node) ||
  Node.isGetAccessorDeclaration(node) ||
  Node.isSetAccessorDeclaration(node) ||
  Node.isConstructorDeclaration(node)

const isLoop = (node: Node): boolean =>
  Node.isForStatement(node) ||
  Node.isForInStatement(node) ||
  Node.isForOfStatement(node) ||
  Node.isWhileStatement(node) ||
  Node.isDoStatement(node)

const complexityFor = (
  body: Node | undefined,
  name: string,
  paramCount: number
): ComplexityFields => {
  if (!body) {
    return { cyclomatic: 1, cognitive: 1, paramCount }
  }

  let cyclomatic = 1
  let cognitive = 1
  let loopCount = 0
  let maxLoopDepth = 0
  let linearScanInLoop = 0
  let allocInLoop = 0
  let recursive = false

  const visit = (node: Node, loopDepth: number, controlDepth: number): void => {
    if (node !== body && isFunctionLike(node)) return

    let nextLoop = loopDepth
    let nextControl = controlDepth

    if (isLoop(node)) {
      cyclomatic += 1
      cognitive += 1 + controlDepth
      loopCount += 1
      nextLoop = loopDepth + 1
      maxLoopDepth = Math.max(maxLoopDepth, nextLoop)
      nextControl = controlDepth + 1
    } else if (
      Node.isIfStatement(node) ||
      Node.isConditionalExpression(node) ||
      Node.isCatchClause(node)
    ) {
      cyclomatic += 1
      cognitive += 1 + controlDepth
      nextControl = controlDepth + 1
    } else if (Node.isCaseClause(node)) {
      cyclomatic += 1
      cognitive += 1 + controlDepth
    } else if (Node.isBinaryExpression(node)) {
      const operator = node.getOperatorToken().getText()
      if (operator === "&&" || operator === "||" || operator === "??") {
        cyclomatic += 1
        cognitive += 1
      }
    }

    if (Node.isCallExpression(node)) {
      const expressionText = node.getExpression().getText()
      if (expressionText === name || expressionText === `this.${name}`) {
        recursive = true
      }
      if (loopDepth > 0) {
        const callName = expressionText.split(".").pop() ?? expressionText
        if (SCAN_CALLS.has(callName)) linearScanInLoop += 1
        if (ALLOC_CALLS.has(callName)) allocInLoop += 1
      }
    }

    if (loopDepth > 0) {
      if (
        Node.isNewExpression(node) ||
        Node.isArrayLiteralExpression(node) ||
        Node.isObjectLiteralExpression(node)
      ) {
        allocInLoop += 1
      }
    }

    for (const child of node.getChildren()) {
      visit(child, nextLoop, nextControl)
    }
  }

  visit(body, 0, 0)

  return {
    cyclomatic,
    cognitive,
    loopDepth: maxLoopDepth,
    loopCount,
    linearScanInLoop,
    allocInLoop,
    recursive,
    paramCount
  }
}

type DocComment = {
  getCommentText(): string | undefined
  getTags(): ReadonlyArray<{ getText(): string }>
}

type DocNode = {
  getJsDocs(): ReadonlyArray<DocComment>
}

const getDocText = (node: DocNode): string =>
  node
    .getJsDocs()
    .map((doc) => {
      const parts: string[] = []
      const description = doc.getCommentText()?.trim()
      if (description) parts.push(description)
      for (const tag of doc.getTags()) {
        const tagText = tag.getText().trim().replace(/\s+/g, " ")
        if (tagText) parts.push(tagText)
      }
      return parts.join("\n")
    })
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .slice(0, 2000)

const unwrapFunctionInitializer = (node: Node): ArrowFunction | FunctionExpression | undefined => {
  let current: Node = node
  for (;;) {
    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) return current
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression()
      continue
    }
    if (Node.isAsExpression(current) || Node.isSatisfiesExpression(current)) {
      current = current.getExpression()
      continue
    }
    return undefined
  }
}

const isFunctionInitializer = (node: Node): boolean => unwrapFunctionInitializer(node) !== undefined

export const ParserLive = Layer.succeed(Parser, {
  parse: (filePath: string, content: string) =>
    Effect.try({
      try: () => {
        const baseName = filePath.split("/").pop() ?? filePath
        if (/^Dockerfile(\.|$)/i.test(baseName)) {
          return parseDockerfile(filePath, content)
        }

        const language = languageForPath(filePath)
        if (!language) {
          return { path: filePath, symbols: [], edges: [], parseStatus: "unsupported" }
        }

        const astParser = astParserFor(language)
        if (astParser) {
          try {
            return astParser.parse(filePath, content)
          } catch {
            // Keep the regex fallback when a grammar is unavailable or fails.
            return { ...parseGenericFile(language, filePath, content), parseStatus: "partial" }
          }
        }

        if (!isTypeScriptLanguage(language)) {
          return parseGenericFile(language, filePath, content)
        }

        const project = new Project({
          useInMemoryFileSystem: true,
          skipAddingFilesFromTsConfig: true,
          skipFileDependencyResolution: true,
          skipLoadingLibFiles: true,
          compilerOptions: { allowJs: true, noLib: true }
        })

        const sourceFile = project.createSourceFile(filePath, content, { overwrite: true })
        const symbols: ParsedSymbol[] = []
        const edges: ParsedEdge[] = []

        // 1. Functions
        for (const fn of sourceFile.getFunctions()) {
          const name = fn.getName()
          if (!name) continue
          const signature = getSignatureBeforeBody(fn, fn.getBody())
          symbols.push({
            name,
            kind: "function",
            startLine: fn.getStartLineNumber(),
            endLine: fn.getEndLineNumber(),
            signature,
            exported: fn.isExported(),
            visibility: visibilityForDeclaration(fn.isExported()),
            doc: getDocText(fn),
            ...complexityFor(fn.getBody(), name, fn.getParameters().length)
          })
        }

        // 2. Classes
        for (const cls of sourceFile.getClasses()) {
          const name = cls.getName()
          if (!name) continue
          const signature = getHeaderSignature(cls.getText())
          symbols.push({
            name,
            kind: "class",
            startLine: cls.getStartLineNumber(),
            endLine: cls.getEndLineNumber(),
            signature,
            exported: cls.isExported(),
            visibility: visibilityForDeclaration(cls.isExported()),
            doc: getDocText(cls)
          })

          // Extends
          const baseClass = cls.getBaseClass()
          if (baseClass?.getName()) {
            edges.push({
              srcName: name,
              dstName: baseClass.getName() ?? "",
              kind: "extends",
              srcLine: cls.getStartLineNumber()
            })
          } else {
            const extNodes = cls.getExtends()
            if (extNodes) {
              edges.push({
                srcName: name,
                dstName: extNodes.getExpression().getText(),
                kind: "extends",
                srcLine: cls.getStartLineNumber()
              })
            }
          }

          // Implements
          for (const impl of cls.getImplements()) {
            const implName = impl.getExpression().getText()
            edges.push({
              srcName: name,
              dstName: implName,
              kind: "implements",
              srcLine: cls.getStartLineNumber()
            })
          }

          // Methods
          for (const method of cls.getMethods()) {
            const methodName = method.getName()
            const methodSig = getSignatureBeforeBody(method, method.getBody())
            symbols.push({
              name: `${name}.${methodName}`,
              kind: "method",
              startLine: method.getStartLineNumber(),
              endLine: method.getEndLineNumber(),
              signature: methodSig,
              exported: cls.isExported(),
              visibility:
                visibilityForScope(method.getScope()) ?? visibilityForDeclaration(cls.isExported()),
              doc: getDocText(method),
              containerName: name,
              ...complexityFor(method.getBody(), methodName, method.getParameters().length)
            })

            edges.push({
              srcName: name,
              dstName: `${name}.${methodName}`,
              kind: "contains",
              srcLine: method.getStartLineNumber()
            })
          }

          // Properties
          for (const prop of cls.getProperties()) {
            const propName = prop.getName()
            symbols.push({
              name: `${name}.${propName}`,
              kind: "property",
              startLine: prop.getStartLineNumber(),
              endLine: prop.getEndLineNumber(),
              signature: prop.getText().split(";")[0]?.trim() ?? propName,
              exported: cls.isExported(),
              visibility:
                visibilityForScope(prop.getScope()) ?? visibilityForDeclaration(cls.isExported()),
              doc: getDocText(prop),
              containerName: name
            })

            edges.push({
              srcName: name,
              dstName: `${name}.${propName}`,
              kind: "contains",
              srcLine: prop.getStartLineNumber()
            })
          }
        }

        // 3. Interfaces
        for (const iface of sourceFile.getInterfaces()) {
          const name = iface.getName()
          const signature = getHeaderSignature(iface.getText())
          symbols.push({
            name,
            kind: "interface",
            startLine: iface.getStartLineNumber(),
            endLine: iface.getEndLineNumber(),
            signature,
            exported: iface.isExported(),
            visibility: visibilityForDeclaration(iface.isExported()),
            doc: getDocText(iface)
          })

          // Extends
          for (const ext of iface.getExtends()) {
            edges.push({
              srcName: name,
              dstName: ext.getExpression().getText(),
              kind: "extends",
              srcLine: iface.getStartLineNumber()
            })
          }

          // Methods & Properties
          for (const method of iface.getMethods()) {
            const methodName = method.getName()
            symbols.push({
              name: `${name}.${methodName}`,
              kind: "method",
              startLine: method.getStartLineNumber(),
              endLine: method.getEndLineNumber(),
              signature: method.getText().trim(),
              exported: iface.isExported(),
              visibility: "public",
              doc: getDocText(method),
              containerName: name
            })

            edges.push({
              srcName: name,
              dstName: `${name}.${methodName}`,
              kind: "contains",
              srcLine: method.getStartLineNumber()
            })
          }

          for (const prop of iface.getProperties()) {
            const propName = prop.getName()
            symbols.push({
              name: `${name}.${propName}`,
              kind: "property",
              startLine: prop.getStartLineNumber(),
              endLine: prop.getEndLineNumber(),
              signature: prop.getText().trim(),
              exported: iface.isExported(),
              visibility: "public",
              doc: getDocText(prop),
              containerName: name
            })

            edges.push({
              srcName: name,
              dstName: `${name}.${propName}`,
              kind: "contains",
              srcLine: prop.getStartLineNumber()
            })
          }
        }

        // 4. Type Aliases
        for (const typeAlias of sourceFile.getTypeAliases()) {
          const name = typeAlias.getName()
          const signature = normalizeSignature(typeAlias.getText())
          symbols.push({
            name,
            kind: "type",
            startLine: typeAlias.getStartLineNumber(),
            endLine: typeAlias.getEndLineNumber(),
            signature,
            exported: typeAlias.isExported(),
            visibility: visibilityForDeclaration(typeAlias.isExported()),
            doc: getDocText(typeAlias)
          })
        }

        // 5. Enums
        for (const en of sourceFile.getEnums()) {
          const name = en.getName()
          const signature = getHeaderSignature(en.getText())
          symbols.push({
            name,
            kind: "enum",
            startLine: en.getStartLineNumber(),
            endLine: en.getEndLineNumber(),
            signature,
            exported: en.isExported(),
            visibility: visibilityForDeclaration(en.isExported()),
            doc: getDocText(en)
          })

          for (const member of en.getMembers()) {
            const memberName = member.getName()
            symbols.push({
              name: `${name}.${memberName}`,
              kind: "property",
              startLine: member.getStartLineNumber(),
              endLine: member.getEndLineNumber(),
              signature: member.getText().trim(),
              exported: en.isExported(),
              visibility: visibilityForDeclaration(en.isExported()),
              doc: getDocText(member),
              containerName: name
            })

            edges.push({
              srcName: name,
              dstName: `${name}.${memberName}`,
              kind: "contains",
              srcLine: member.getStartLineNumber()
            })
          }
        }

        // 6. Variable Declarations (const, let, functions assigned to const)
        for (const varStmt of sourceFile.getVariableStatements()) {
          const isExported = varStmt.isExported()
          for (const decl of varStmt.getDeclarations()) {
            const name = decl.getName()
            const initializer = decl.getInitializer()
            let kind: SymbolKind = "const"
            if (initializer && isFunctionInitializer(initializer)) {
              kind = "function"
            }

            const declarationKind = varStmt.getDeclarationKind()
            const functionInitializer =
              initializer && isFunctionInitializer(initializer)
                ? unwrapFunctionInitializer(initializer)
                : undefined
            const typeNode = decl.getTypeNode()?.getText()

            let signature: string
            if (functionInitializer) {
              const params = functionInitializer
                .getParameters()
                .map((param) => param.getText())
                .join(", ")
              const returnType = Node.isArrowFunction(functionInitializer)
                ? functionInitializer.getReturnTypeNode()?.getText()
                : undefined
              signature = `${declarationKind} ${name}${typeNode ? `: ${typeNode}` : ""} = (${params})${
                returnType ? `: ${returnType}` : ""
              } =>`
            } else {
              const rawSig = decl.getText().split("=")[0]?.trim() ?? name
              signature = `${declarationKind} ${rawSig}`
            }
            if (signature.length > MAX_SIGNATURE_LENGTH) {
              signature = `${signature.slice(0, MAX_SIGNATURE_LENGTH - 3)}...`
            }
            symbols.push({
              name,
              kind,
              startLine: decl.getStartLineNumber(),
              endLine: decl.getEndLineNumber(),
              signature,
              exported: isExported,
              visibility: visibilityForDeclaration(isExported),
              doc: getDocText(varStmt),
              ...(functionInitializer
                ? complexityFor(
                    functionInitializer.getBody(),
                    name,
                    functionInitializer.getParameters().length
                  )
                : {})
            })
          }
        }

        // 6.5 Routes (file-based conventions and explicit declarations)
        const routeNames = new Set<string>()
        const addRoute = (
          method: string,
          routePath: string,
          line: number,
          endLine: number,
          handler?: string,
          doc?: string
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
            visibility: "public",
            ...(doc ? { doc } : {})
          })
          if (handler) {
            edges.push({
              srcName: name,
              dstName: handler,
              kind: "contains",
              srcLine: line
            })
          }
        }

        const normalizeRouteSegments = (segments: readonly string[]): string => {
          const cleaned = segments
            .filter((segment) => segment.length > 0 && !/^\(.*\)$/.test(segment))
            .map((segment) => {
              if (/^\[\.\.\..+\]$/.test(segment)) return `:${segment.slice(4, -1)}*`
              if (/^\[.+\]$/.test(segment)) return `:${segment.slice(1, -1)}`
              return segment
            })
          return cleaned.length === 0 ? "/" : `/${cleaned.join("/")}`
        }

        const appRouteMatch = filePath.match(/(?:^|\/)app\/(.+)?route\.[cm]?[jt]sx?$/)
        if (appRouteMatch) {
          const raw = appRouteMatch[1] ?? ""
          const routePath = normalizeRouteSegments(raw.split("/"))
          for (const fn of sourceFile.getFunctions()) {
            const fnName = fn.getName()
            if (!fnName || !fn.isExported()) continue
            const method = fnName.toUpperCase()
            if (!ROUTE_METHODS.has(method)) continue
            addRoute(
              method,
              routePath,
              fn.getStartLineNumber(),
              fn.getEndLineNumber(),
              fnName,
              getDocText(fn)
            )
          }
        }

        const pagesApiMatch = filePath.match(/(?:^|\/)pages\/api\/(.+)\.[cm]?[jt]sx?$/)
        if (pagesApiMatch) {
          let raw = pagesApiMatch[1] ?? ""
          if (raw === "index") raw = ""
          raw = raw.replace(/\/index$/, "")
          const routePath = `/api${raw ? `/${raw}` : ""}`
          const normalized = normalizeRouteSegments(routePath.split("/"))
          const handler = sourceFile.getDefaultExportSymbol()?.getName()
          addRoute("ALL", normalized, 1, sourceFile.getEndLineNumber(), handler)
        }

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const callee = call.getExpression()
          if (!Node.isPropertyAccessExpression(callee)) continue
          const receiver = callee.getExpression().getText()
          if (!EXPRESS_ROUTE_RECEIVERS.has(receiver)) continue
          const method = callee.getName().toUpperCase()
          if (!ROUTE_METHODS.has(method)) continue
          const [pathArg, handlerArg] = call.getArguments()
          if (!pathArg) continue
          if (!Node.isStringLiteral(pathArg) && !Node.isNoSubstitutionTemplateLiteral(pathArg)) {
            continue
          }
          const routePath = pathArg.getLiteralText()
          const handler = handlerArg
            ? handlerArg
                .getText()
                .replace(/\([\s\S]*$/, "")
                .split(".")
                .pop()
            : undefined
          addRoute(
            method,
            routePath.startsWith("/") ? routePath : `/${routePath}`,
            call.getStartLineNumber(),
            call.getEndLineNumber(),
            handler
          )
        }

        // 7. Imports
        // Maps the local identifier introduced by an import to the module it
        // came from, so cross-file calls/extends can be resolved by path.
        const importedBindings = new Map<string, { specifier: string; importedName: string }>()

        for (const imp of sourceFile.getImportDeclarations()) {
          const moduleSpecifier = imp.getModuleSpecifierValue()
          const defaultImport = imp.getDefaultImport()
          if (defaultImport) {
            const localName = defaultImport.getText()
            importedBindings.set(localName, {
              specifier: moduleSpecifier,
              importedName: localName
            })
            edges.push({
              srcName: localName,
              dstName: moduleSpecifier,
              kind: "import",
              srcLine: imp.getStartLineNumber(),
              importPath: moduleSpecifier
            })
          }

          for (const named of imp.getNamedImports()) {
            const importedName = named.getName()
            const localName = named.getAliasNode()?.getText() ?? importedName
            importedBindings.set(localName, {
              specifier: moduleSpecifier,
              importedName
            })
            edges.push({
              srcName: localName,
              dstName: moduleSpecifier,
              kind: "import",
              srcLine: imp.getStartLineNumber(),
              importPath: moduleSpecifier
            })
          }
        }

        // Resolve the caller by position instead of walking AST parents. This
        // correctly attributes calls inside arrow functions passed to
        // `Effect.gen`, `Layer.effect`, object literals, etc. to the nearest
        // named function, then to the nearest containing const/class.
        const callableSymbols = symbols.filter(
          (symbol) => symbol.kind === "function" || symbol.kind === "method"
        )
        const containerSymbols = symbols.filter(
          (symbol) => symbol.kind === "const" || symbol.kind === "class"
        )

        const smallestContaining = (
          candidates: readonly ParsedSymbol[],
          line: number
        ): ParsedSymbol | undefined => {
          let best: ParsedSymbol | undefined
          for (const candidate of candidates) {
            if (line < candidate.startLine || line > candidate.endLine) continue
            if (!best || candidate.endLine - candidate.startLine < best.endLine - best.startLine) {
              best = candidate
            }
          }
          return best
        }

        const findEnclosingSymbol = (node: Node): string | undefined => {
          const line = node.getStartLineNumber()
          return (
            smallestContaining(callableSymbols, line) ?? smallestContaining(containerSymbols, line)
          )?.name
        }

        // 8. Call expressions (both `foo()` and `new Foo()`)
        const pushCallEdge = (callNode: Node, expr: Node) => {
          let calledName: string | undefined
          let importedBinding: { specifier: string; importedName: string } | undefined

          if (Node.isIdentifier(expr)) {
            calledName = expr.getText()
            importedBinding = importedBindings.get(calledName)
          } else if (Node.isPropertyAccessExpression(expr)) {
            const target = expr.getExpression()
            const property = expr.getName()
            // `this.foo()` resolves to the method declared on the same class.
            if (Node.isThisExpression(target)) {
              const className = findEnclosingSymbol(callNode)?.split(".")[0]
              calledName = className ? `${className}.${property}` : property
            } else {
              calledName = property
            }
          }

          if (!calledName) return

          const enclosing = findEnclosingSymbol(callNode)
          if (!enclosing || enclosing === calledName) return

          edges.push({
            srcName: enclosing,
            dstName: importedBinding?.importedName ?? calledName,
            kind: "call",
            srcLine: callNode.getStartLineNumber(),
            ...(importedBinding ? { importPath: importedBinding.specifier } : {})
          })
        }

        for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          pushCallEdge(callExpr, callExpr.getExpression())
        }
        for (const newExpr of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
          pushCallEdge(newExpr, newExpr.getExpression())
        }

        // 9. Reference edges: callbacks passed without invocation and non-call
        // usages of local declarations. Only identifiers whose text matches a
        // symbol declared in this file are considered, and the resolved
        // declaration must be the same node, which keeps shadowed names and
        // property keys out.
        const localByName = new Map<string, ParsedSymbol[]>()
        for (const symbol of symbols) {
          const baseName = symbol.name.split(".").pop()
          if (!baseName) continue
          const list = localByName.get(baseName) ?? []
          list.push(symbol)
          localByName.set(baseName, list)
        }

        const referenceKeys = new Set(
          edges.map((edge) => `${edge.srcName}->${edge.dstName}:${edge.kind}`)
        )

        const isDeclarationName = (identifier: Node, parent: Node | undefined): boolean => {
          if (!parent) return false
          if (Node.isCallExpression(parent) && parent.getExpression() === identifier) return true
          if (Node.isNewExpression(parent) && parent.getExpression() === identifier) return true
          if (Node.isImportDeclaration(parent)) return true
          if (Node.isImportSpecifier(parent)) return true
          if (Node.isImportClause(parent)) return true
          if (Node.isNamespaceImport(parent)) return true
          if (
            Node.isPropertyAccessExpression(parent) ||
            Node.isPropertyAssignment(parent) ||
            Node.isPropertyDeclaration(parent) ||
            Node.isMethodDeclaration(parent) ||
            Node.isFunctionDeclaration(parent) ||
            Node.isClassDeclaration(parent) ||
            Node.isInterfaceDeclaration(parent) ||
            Node.isTypeAliasDeclaration(parent) ||
            Node.isEnumDeclaration(parent) ||
            Node.isEnumMember(parent) ||
            Node.isVariableDeclaration(parent)
          ) {
            return parent.getNameNode() === identifier
          }
          return false
        }

        for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
          const candidates = localByName.get(identifier.getText())
          if (!candidates) continue
          if (isDeclarationName(identifier, identifier.getParent())) continue

          const declaration = identifier.getSymbol()?.getDeclarations()[0]
          if (!declaration || declaration.getSourceFile() !== sourceFile) continue

          const declarationLine = declaration.getStartLineNumber()
          const target = candidates.find((symbol) => symbol.startLine === declarationLine)
          if (!target) continue

          const enclosing = findEnclosingSymbol(identifier)
          if (!enclosing || enclosing === target.name) continue

          const kind: "call_reference" | "usage" =
            target.kind === "function" || target.kind === "method" ? "call_reference" : "usage"
          const key = `${enclosing}->${target.name}:${kind}`
          if (referenceKeys.has(key)) continue
          referenceKeys.add(key)
          edges.push({
            srcName: enclosing,
            dstName: target.name,
            kind,
            srcLine: identifier.getStartLineNumber()
          })
        }

        return withThrowsEdges(
          {
            path: filePath,
            symbols,
            edges,
            parseStatus: "parsed"
          },
          "throws"
        )
      },
      catch: (e) =>
        new ParseError({
          path: filePath,
          message: e instanceof Error ? e.message : String(e),
          cause: e
        })
    })
})
