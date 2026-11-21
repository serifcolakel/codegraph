import { Context, Effect, Layer } from "effect"
import { Project, SyntaxKind, Node } from "ts-morph"
import { ParseError } from "../domain/errors.js"
import type { ParsedFile, ParsedSymbol, ParsedEdge, SymbolKind } from "../domain/models.js"

export interface Parser {
  readonly parse: (filePath: string, content: string) => Effect.Effect<ParsedFile, ParseError>
}

export const Parser = Context.GenericTag<Parser>("@codegraph/Parser")

const getHeaderSignature = (text: string): string => {
  const firstLine = text.split("\n")[0] ?? text
  const braceIdx = firstLine.indexOf("{")
  if (braceIdx !== -1) {
    return firstLine.slice(0, braceIdx).trim()
  }
  return firstLine.trim()
}

export const ParserLive = Layer.succeed(Parser, {
  parse: (filePath: string, content: string) =>
    Effect.try({
      try: () => {
        const project = new Project({
          useInMemoryFileSystem: true,
          compilerOptions: { allowJs: true }
        })

        const sourceFile = project.createSourceFile(filePath, content, { overwrite: true })
        const symbols: ParsedSymbol[] = []
        const edges: ParsedEdge[] = []

        // 1. Functions
        for (const fn of sourceFile.getFunctions()) {
          const name = fn.getName()
          if (!name) continue
          const signature = getHeaderSignature(fn.getText())
          symbols.push({
            name,
            kind: "function",
            startLine: fn.getStartLineNumber(),
            endLine: fn.getEndLineNumber(),
            signature,
            exported: fn.isExported()
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
            exported: cls.isExported()
          })

          // Extends
          const baseClass = cls.getBaseClass()
          if (baseClass?.getName()) {
            edges.push({
              srcName: name,
              dstName: baseClass.getName()!,
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
            const methodSig = getHeaderSignature(method.getText())
            symbols.push({
              name: `${name}.${methodName}`,
              kind: "method",
              startLine: method.getStartLineNumber(),
              endLine: method.getEndLineNumber(),
              signature: methodSig,
              exported: cls.isExported(),
              containerName: name
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
            exported: iface.isExported()
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
          const signature = getHeaderSignature(typeAlias.getText())
          symbols.push({
            name,
            kind: "type",
            startLine: typeAlias.getStartLineNumber(),
            endLine: typeAlias.getEndLineNumber(),
            signature,
            exported: typeAlias.isExported()
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
            exported: en.isExported()
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
            if (initializer && Node.isArrowFunction(initializer)) {
              kind = "function"
            }

            const rawSig = decl.getText().split("=")[0]?.trim() ?? name
            const signature = `${varStmt.getDeclarationKind()} ${rawSig}`
            symbols.push({
              name,
              kind,
              startLine: decl.getStartLineNumber(),
              endLine: decl.getEndLineNumber(),
              signature,
              exported: isExported
            })
          }
        }

        // 7. Imports
        for (const imp of sourceFile.getImportDeclarations()) {
          const moduleSpecifier = imp.getModuleSpecifierValue()
          const defaultImport = imp.getDefaultImport()
          if (defaultImport) {
            edges.push({
              srcName: defaultImport.getText(),
              dstName: moduleSpecifier,
              kind: "import",
              srcLine: imp.getStartLineNumber(),
              importPath: moduleSpecifier
            })
          }

          for (const named of imp.getNamedImports()) {
            edges.push({
              srcName: named.getName(),
              dstName: moduleSpecifier,
              kind: "import",
              srcLine: imp.getStartLineNumber(),
              importPath: moduleSpecifier
            })
          }
        }

        // Helper: find enclosing symbol for an AST node
        const findEnclosingSymbol = (node: Node): string | undefined => {
          let current: Node | undefined = node.getParent()
          while (current && !Node.isSourceFile(current)) {
            if (Node.isMethodDeclaration(current)) {
              const cls = current.getParent()
              if (Node.isClassDeclaration(cls) && cls.getName()) {
                return `${cls.getName()}.${current.getName()}`
              }
              return current.getName()
            }
            if (Node.isFunctionDeclaration(current)) {
              return current.getName()
            }
            if (Node.isVariableDeclaration(current)) {
              return current.getName()
            }
            if (Node.isClassDeclaration(current)) {
              return current.getName()
            }
            current = current.getParent()
          }
          return undefined
        }

        // 8. Call expressions
        for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const expr = callExpr.getExpression()
          let calledName: string | undefined
          if (Node.isIdentifier(expr)) {
            calledName = expr.getText()
          } else if (Node.isPropertyAccessExpression(expr)) {
            calledName = expr.getName()
          }

          if (calledName) {
            const enclosing = findEnclosingSymbol(callExpr)
            if (enclosing && enclosing !== calledName) {
              edges.push({
                srcName: enclosing,
                dstName: calledName,
                kind: "call",
                srcLine: callExpr.getStartLineNumber()
              })
            }
          }
        }

        return {
          path: filePath,
          symbols,
          edges
        }
      },
      catch: e =>
        new ParseError({
          path: filePath,
          message: e instanceof Error ? e.message : String(e),
          cause: e
        })
    })
})
