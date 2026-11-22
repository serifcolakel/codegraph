import * as SqlClient from "@effect/sql/SqlClient"
import type { Fragment } from "@effect/sql/Statement"
import { Context, Effect, Layer } from "effect"
import { QueryLanguageError, StoreError } from "../domain/errors.js"

type Label = "symbol" | "file" | "repository"
type Direction = "out" | "in"

interface NodePattern {
  readonly variable: string
  readonly label: Label
}

interface EdgePattern {
  readonly variable: string
  readonly label: string
  readonly direction: Direction
}

type Value = string | number | boolean | null | readonly (string | number | boolean)[]

interface Predicate {
  readonly type: "predicate"
  readonly variable: string
  readonly property: string
  readonly operator:
    | "="
    | "!="
    | ">"
    | "<"
    | ">="
    | "<="
    | "CONTAINS"
    | "STARTS_WITH"
    | "ENDS_WITH"
    | "IN"
  readonly value: Value
}

interface WhereGroup {
  readonly type: "and" | "or"
  readonly items: readonly WhereNode[]
}

type WhereNode = Predicate | WhereGroup

interface Projection {
  readonly variable: string
  readonly property: string
  readonly alias: string
}

interface ParsedQuery {
  readonly start: NodePattern
  readonly edge?: EdgePattern
  readonly end?: NodePattern
  readonly where?: WhereNode
  readonly returns: readonly Projection[]
  readonly orderBy?: {
    readonly variable: string
    readonly property: string
    readonly direction: "ASC" | "DESC"
  }
  readonly limit?: number
  readonly skip?: number
}

export interface ExecuteQueryOptions {
  readonly repoId?: string
  readonly limit?: number
}

export interface QueryResult {
  readonly columns: readonly string[]
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly total: number
  readonly returned: number
  readonly truncated: boolean
}

export interface QueryLanguage {
  readonly execute: (
    query: string,
    options?: ExecuteQueryOptions
  ) => Effect.Effect<QueryResult, QueryLanguageError | StoreError>
}

export const QueryLanguage = Context.GenericTag<QueryLanguage>("@codegraph/QueryLanguage")

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = "ident" | "string" | "number" | "punct" | "eof"

interface Token {
  readonly type: TokenType
  readonly value: string
  readonly position: number
}

const KEYWORDS = new Set([
  "MATCH",
  "WHERE",
  "RETURN",
  "ORDER",
  "BY",
  "ASC",
  "DESC",
  "LIMIT",
  "SKIP",
  "AND",
  "OR",
  "CONTAINS",
  "STARTS",
  "WITH",
  "ENDS",
  "IN",
  "TRUE",
  "FALSE",
  "NULL"
])

const TWO_CHAR_PUNCT = ["->", "<-", "<=", ">=", "!=", "<>"]
const ONE_CHAR_PUNCT = "()[]{}:.,*+-=<>"

const fail = (message: string, position: number): never => {
  throw new QueryLanguageError({ message, position })
}

const tokenize = (input: string): readonly Token[] => {
  const tokens: Token[] = []
  let index = 0

  while (index < input.length) {
    const character = input[index] ?? ""
    if (/\s/.test(character)) {
      index++
      continue
    }

    if (character === "'" || character === '"') {
      const quote = character
      const start = index
      index++
      let value = ""
      while (index < input.length && input[index] !== quote) {
        const current = input[index] ?? ""
        if (current === "\\") {
          const next = input[index + 1] ?? ""
          value += next === "n" ? "\n" : next === "t" ? "\t" : next
          index += 2
          continue
        }
        value += current
        index++
      }
      if (index >= input.length) fail("Unterminated string literal", start)
      index++
      tokens.push({ type: "string", value, position: start })
      continue
    }

    if (/[0-9]/.test(character)) {
      const start = index
      while (index < input.length && /[0-9]/.test(input[index] ?? "")) index++
      if (input[index] === "." && /[0-9]/.test(input[index + 1] ?? "")) {
        index++
        while (index < input.length && /[0-9]/.test(input[index] ?? "")) index++
      }
      tokens.push({ type: "number", value: input.slice(start, index), position: start })
      continue
    }

    if (/[A-Za-z_]/.test(character)) {
      const start = index
      while (index < input.length && /[A-Za-z0-9_]/.test(input[index] ?? "")) index++
      tokens.push({ type: "ident", value: input.slice(start, index), position: start })
      continue
    }

    const two = input.slice(index, index + 2)
    if (TWO_CHAR_PUNCT.includes(two)) {
      tokens.push({ type: "punct", value: two, position: index })
      index += 2
      continue
    }
    if (ONE_CHAR_PUNCT.includes(character)) {
      tokens.push({ type: "punct", value: character, position: index })
      index++
      continue
    }

    fail(`Unexpected character "${character}"`, index)
  }

  tokens.push({ type: "eof", value: "", position: input.length })
  return tokens
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class QueryParser {
  private position = 0

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[this.position + offset] ?? { type: "eof", value: "", position: 0 }
  }

  private next(): Token {
    const token = this.peek()
    this.position++
    return token
  }

  private isKeyword(keyword: string, offset = 0): boolean {
    const token = this.peek(offset)
    return token.type === "ident" && token.value.toUpperCase() === keyword
  }

  private matchKeyword(keyword: string): boolean {
    if (!this.isKeyword(keyword)) return false
    this.next()
    return true
  }

  private expectKeyword(keyword: string): void {
    if (!this.matchKeyword(keyword)) {
      fail(`Expected ${keyword}`, this.peek().position)
    }
  }

  private matchPunct(value: string): boolean {
    const token = this.peek()
    if (token.type !== "punct" || token.value !== value) return false
    this.next()
    return true
  }

  private expectPunct(value: string): void {
    if (!this.matchPunct(value)) {
      fail(`Expected "${value}"`, this.peek().position)
    }
  }

  private expectIdent(): string {
    const token = this.next()
    if (token.type !== "ident" || KEYWORDS.has(token.value.toUpperCase())) {
      fail("Expected identifier", token.position)
    }
    return token.value
  }

  private expectNumber(): number {
    const token = this.next()
    if (token.type !== "number") fail("Expected number", token.position)
    const value = Number(token.value)
    if (!Number.isFinite(value)) fail("Invalid number", token.position)
    return value
  }

  parse(): ParsedQuery {
    this.expectKeyword("MATCH")
    const start = this.parseNode()

    let edge: EdgePattern | undefined
    let end: NodePattern | undefined

    if (this.matchPunct("-")) {
      edge = this.parseEdgeBracket("out")
      this.expectPunct("->")
      end = this.parseNode()
    } else if (this.matchPunct("<-")) {
      edge = this.parseEdgeBracket("in")
      this.expectPunct("-")
      end = this.parseNode()
    }

    const where = this.matchKeyword("WHERE") ? this.parseOr() : undefined
    this.expectKeyword("RETURN")
    const returns = this.parseProjections()

    let orderBy: ParsedQuery["orderBy"]
    if (this.matchKeyword("ORDER")) {
      this.expectKeyword("BY")
      const variable = this.expectIdent()
      this.expectPunct(".")
      const property = this.expectIdent()
      let direction: "ASC" | "DESC" = "ASC"
      if (this.matchKeyword("DESC")) direction = "DESC"
      else this.matchKeyword("ASC")
      orderBy = { variable, property, direction }
    }

    let limit: number | undefined
    let skip: number | undefined
    for (;;) {
      if (this.matchKeyword("LIMIT")) {
        limit = this.expectNumber()
        continue
      }
      if (this.matchKeyword("SKIP")) {
        skip = this.expectNumber()
        continue
      }
      break
    }

    if (this.peek().type !== "eof") {
      fail(`Unexpected token "${this.peek().value}"`, this.peek().position)
    }

    return {
      start,
      ...(edge ? { edge } : {}),
      ...(end ? { end } : {}),
      ...(where ? { where } : {}),
      returns,
      ...(orderBy ? { orderBy } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(skip !== undefined ? { skip } : {})
    }
  }

  private parseNode(): NodePattern {
    this.expectPunct("(")
    const variable = this.expectIdent()
    this.expectPunct(":")
    const labelToken = this.next()
    if (labelToken.type !== "ident") fail("Expected node label", labelToken.position)
    const label = labelToken.value.toLowerCase()
    if (label !== "symbol" && label !== "file" && label !== "repository") {
      fail(`Unsupported node label "${labelToken.value}"`, labelToken.position)
    }
    this.expectPunct(")")
    return { variable, label: label as Label }
  }

  private parseEdgeBracket(direction: Direction): EdgePattern {
    this.expectPunct("[")
    let variable = "e"
    if (this.peek().type === "ident" && this.peek().value !== ":" && !this.isKeywordAny()) {
      variable = this.expectIdent()
    }
    this.expectPunct(":")
    const labelToken = this.next()
    if (labelToken.type !== "ident") fail("Expected relationship label", labelToken.position)
    this.expectPunct("]")
    return { variable, label: labelToken.value.toUpperCase(), direction }
  }

  private isKeywordAny(): boolean {
    return this.peek().type === "ident" && KEYWORDS.has(this.peek().value.toUpperCase())
  }

  private parseProjections(): readonly Projection[] {
    const projections: Projection[] = []
    do {
      const variable = this.expectIdent()
      this.expectPunct(".")
      const property = this.expectIdent()
      let alias = `${variable}_${property}`
      if (this.matchKeyword("AS")) {
        alias = this.expectIdent()
      }
      projections.push({ variable, property, alias })
    } while (this.matchPunct(","))
    return projections
  }

  private parseOr(): WhereNode {
    const items: WhereNode[] = [this.parseAnd()]
    while (this.matchKeyword("OR")) {
      items.push(this.parseAnd())
    }
    return items.length === 1 ? (items[0] as WhereNode) : { type: "or", items }
  }

  private parseAnd(): WhereNode {
    const items: WhereNode[] = [this.parsePredicate()]
    while (this.matchKeyword("AND")) {
      items.push(this.parsePredicate())
    }
    return items.length === 1 ? (items[0] as WhereNode) : { type: "and", items }
  }

  private parsePredicate(): Predicate {
    const variable = this.expectIdent()
    this.expectPunct(".")
    const property = this.expectIdent()

    let operator: Predicate["operator"] | undefined
    if (this.matchPunct("=")) operator = "="
    else if (this.matchPunct("!=") || this.matchPunct("<>")) operator = "!="
    else if (this.matchPunct(">=")) operator = ">="
    else if (this.matchPunct("<=")) operator = "<="
    else if (this.matchPunct(">")) operator = ">"
    else if (this.matchPunct("<")) operator = "<"
    else if (this.matchKeyword("CONTAINS")) operator = "CONTAINS"
    else if (this.matchKeyword("IN")) operator = "IN"
    else if (this.isKeyword("STARTS")) {
      this.next()
      this.expectKeyword("WITH")
      operator = "STARTS_WITH"
    } else if (this.isKeyword("ENDS")) {
      this.next()
      this.expectKeyword("WITH")
      operator = "ENDS_WITH"
    } else {
      fail("Expected comparison operator", this.peek().position)
    }
    if (operator === undefined) {
      throw new QueryLanguageError({
        message: "Expected comparison operator",
        position: this.peek().position
      })
    }

    const value = this.parseValue()
    return { type: "predicate", variable, property, operator, value }
  }

  private parseValue(): Value {
    if (this.matchPunct("[")) {
      const values: (string | number | boolean)[] = []
      if (!this.matchPunct("]")) {
        do {
          const value = this.parsePrimitive()
          if (value === null) {
            fail("Lists cannot contain null", this.peek().position)
          }
          values.push(value as string | number | boolean)
        } while (this.matchPunct(","))
        this.expectPunct("]")
      }
      return values
    }
    return this.parsePrimitive()
  }

  private parsePrimitive(): string | number | boolean | null {
    const token = this.next()
    if (token.type === "string") return token.value
    if (token.type === "number") return Number(token.value)
    if (token.type === "punct" && token.value === "-") {
      const numberToken = this.next()
      if (numberToken.type !== "number") fail("Expected number after '-'", numberToken.position)
      return -Number(numberToken.value)
    }
    if (token.type === "ident") {
      const keyword = token.value.toUpperCase()
      if (keyword === "TRUE") return true
      if (keyword === "FALSE") return false
      if (keyword === "NULL") return null
    }
    return fail("Expected a literal value", token.position)
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const EDGE_KINDS: Readonly<Record<string, string>> = {
  CALLS: "call",
  CALL: "call",
  CALL_REFERENCE: "call_reference",
  USAGE: "usage",
  REFERENCES: "reference",
  REFERENCE: "reference",
  EXTENDS: "extends",
  IMPLEMENTS: "implements",
  CONTAINS: "contains",
  THROWS: "throws",
  RAISES: "raises"
}

interface VariableInfo {
  readonly kind: "node" | "edge"
  readonly label?: Label
  readonly nodeAlias?: string
  readonly fileAlias?: string
  readonly repoAlias?: string
  readonly edgeAlias?: string
}

type Row = Readonly<Record<string, unknown>>

const MAX_LIMIT = 500
const DEFAULT_LIMIT = 100

export const QueryLanguageLive = Layer.effect(
  QueryLanguage,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const execute = (
      queryText: string,
      options: ExecuteQueryOptions = {}
    ): Effect.Effect<QueryResult, QueryLanguageError | StoreError> =>
      Effect.gen(function* () {
        const parsed = yield* Effect.try({
          try: () => new QueryParser(tokenize(queryText)).parse(),
          catch: (error) =>
            error instanceof QueryLanguageError
              ? error
              : new QueryLanguageError({ message: String(error) })
        })

        const variables = new Map<string, VariableInfo>()
        const joins: Fragment[] = []
        variables.set(parsed.start.variable, {
          kind: "node",
          label: parsed.start.label,
          nodeAlias: "n0",
          fileAlias: "f0",
          repoAlias: "r0"
        })

        if (parsed.edge && parsed.end) {
          if (parsed.start.label !== "symbol" || parsed.end.label !== "symbol") {
            return yield* Effect.fail(
              new QueryLanguageError({
                message: "Relationship patterns currently support only Symbol -> Symbol."
              })
            )
          }
          const kind = EDGE_KINDS[parsed.edge.label]
          if (!kind) {
            return yield* Effect.fail(
              new QueryLanguageError({
                message: `Unsupported relationship "${parsed.edge.label}". Supported: ${Object.keys(EDGE_KINDS).join(", ")}`
              })
            )
          }
          variables.set(parsed.end.variable, {
            kind: "node",
            label: parsed.end.label,
            nodeAlias: "n1",
            fileAlias: "f1",
            repoAlias: "r1"
          })
          variables.set(parsed.edge.variable, { kind: "edge", edgeAlias: "e" })

          const edgeJoin =
            parsed.edge.direction === "out"
              ? sql`JOIN edges e ON e.src_symbol_id = n0.id JOIN symbols n1 ON e.dst_symbol_id = n1.id`
              : sql`JOIN edges e ON e.dst_symbol_id = n0.id JOIN symbols n1 ON e.src_symbol_id = n1.id`
          joins.push(
            edgeJoin,
            sql`JOIN files f1 ON n1.file_id = f1.id`,
            sql`JOIN repos r1 ON f1.repo_id = r1.id`
          )
        }

        const from =
          parsed.start.label === "symbol"
            ? sql`FROM symbols n0 JOIN files f0 ON n0.file_id = f0.id JOIN repos r0 ON f0.repo_id = r0.id ${sql.join(" ", false)(joins)}`
            : parsed.start.label === "file"
              ? sql`FROM files f0 JOIN repos r0 ON f0.repo_id = r0.id`
              : sql`FROM repos r0`

        const conditions: Fragment[] = []
        if (parsed.edge) {
          const kind = EDGE_KINDS[parsed.edge.label]
          if (kind) conditions.push(sql`e.kind = ${kind}`)
        }
        if (options.repoId) {
          if (parsed.start.label === "repository") {
            conditions.push(sql`r0.id = ${options.repoId}`)
          } else {
            conditions.push(sql`f0.repo_id = ${options.repoId}`)
          }
        }

        const columnFor = (variable: string, property: string): Fragment => {
          const info = variables.get(variable)
          if (!info) {
            throw new QueryLanguageError({
              message: `Unknown variable "${variable}". Declared: ${Array.from(variables.keys()).join(", ")}`
            })
          }
          if (info.kind === "edge") {
            if (property === "kind") return sql`e.kind`
            if (property === "id") return sql`e.id`
            throw new QueryLanguageError({
              message: `Unsupported relationship property "${property}". Allowed: kind, id`
            })
          }
          const node = info.nodeAlias as string
          const file = info.fileAlias as string
          const repo = info.repoAlias as string
          if (info.label === "symbol") {
            const mapping: Record<string, Fragment> = {
              id: sql`${sql.literal(node)}.id`,
              name: sql`${sql.literal(node)}.name`,
              qualifiedName: sql`${sql.literal(node)}.qualified_name`,
              kind: sql`${sql.literal(node)}.kind`,
              language: sql`${sql.literal(node)}.language`,
              visibility: sql`${sql.literal(node)}.visibility`,
              containerName: sql`${sql.literal(node)}.container_name`,
              startLine: sql`${sql.literal(node)}.start_line`,
              endLine: sql`${sql.literal(node)}.end_line`,
              signature: sql`${sql.literal(node)}.signature`,
              doc: sql`${sql.literal(node)}.doc`,
              exported: sql`${sql.literal(node)}.exported`,
              filePath: sql`${sql.literal(file)}.path`,
              repoId: sql`${sql.literal(file)}.repo_id`,
              repoName: sql`${sql.literal(repo)}.name`
            }
            const column = mapping[property]
            if (!column) {
              throw new QueryLanguageError({
                message: `Unsupported Symbol property "${property}". Allowed: ${Object.keys(mapping).join(", ")}`
              })
            }
            return column
          }
          if (info.label === "file") {
            const mapping: Record<string, Fragment> = {
              id: sql`${sql.literal(file)}.id`,
              path: sql`${sql.literal(file)}.path`,
              language: sql`${sql.literal(file)}.language`,
              parseStatus: sql`${sql.literal(file)}.parse_status`,
              sizeBytes: sql`${sql.literal(file)}.size_bytes`,
              repoId: sql`${sql.literal(file)}.repo_id`,
              repoName: sql`${sql.literal(repo)}.name`
            }
            const column = mapping[property]
            if (!column) {
              throw new QueryLanguageError({
                message: `Unsupported File property "${property}". Allowed: ${Object.keys(mapping).join(", ")}`
              })
            }
            return column
          }
          const mapping: Record<string, Fragment> = {
            id: sql`${sql.literal(repo)}.id`,
            name: sql`${sql.literal(repo)}.name`,
            rootPath: sql`${sql.literal(repo)}.root_path`,
            indexedAt: sql`${sql.literal(repo)}.indexed_at`,
            indexDurationMs: sql`${sql.literal(repo)}.index_duration_ms`
          }
          const column = mapping[property]
          if (!column) {
            throw new QueryLanguageError({
              message: `Unsupported Repository property "${property}". Allowed: ${Object.keys(mapping).join(", ")}`
            })
          }
          return column
        }

        const compilePredicate = (predicate: Predicate): Fragment => {
          const column = columnFor(predicate.variable, predicate.property)
          const bound = (value: unknown) => (typeof value === "boolean" ? (value ? 1 : 0) : value)
          switch (predicate.operator) {
            case "=":
              return sql`${column} = ${bound(predicate.value)}`
            case "!=":
              return sql`${column} <> ${bound(predicate.value)}`
            case ">":
            case "<":
            case ">=":
            case "<=":
              return sql`${column} ${sql.literal(predicate.operator)} ${bound(predicate.value)}`
            case "CONTAINS":
              return sql`${column} LIKE ${`%${String(predicate.value)}%`}`
            case "STARTS_WITH":
              return sql`${column} LIKE ${`${String(predicate.value)}%`}`
            case "ENDS_WITH":
              return sql`${column} LIKE ${`%${String(predicate.value)}`}`
            case "IN": {
              const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value]
              if (values.length === 0) {
                throw new QueryLanguageError({ message: "IN list cannot be empty" })
              }
              return sql`${column} IN ${sql.in(values.map(bound))}`
            }
          }
        }

        const compileWhere = (node: WhereNode): Fragment => {
          if (node.type === "predicate") return compilePredicate(node)
          if (node.type === "and") return sql.and(node.items.map(compileWhere))
          return sql.or(node.items.map(compileWhere))
        }

        if (parsed.where) conditions.push(compileWhere(parsed.where))
        const where = conditions.length > 0 ? sql`WHERE ${sql.and(conditions)}` : sql``

        const totalRows = yield* sql<{ count: number }>`
          SELECT COUNT(*) as count ${from} ${where};
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "query_graph count failed", cause: e }))
        )
        const total = totalRows[0]?.count ?? 0

        const requestedLimit =
          options.limit !== undefined
            ? Math.min(options.limit, parsed.limit ?? MAX_LIMIT)
            : (parsed.limit ?? DEFAULT_LIMIT)
        const limit = Math.min(MAX_LIMIT, Math.max(1, requestedLimit))
        const skip = Math.max(0, parsed.skip ?? 0)

        const selectColumns = parsed.returns.map((projection, index) => {
          const column = columnFor(projection.variable, projection.property)
          return sql`${column} AS ${sql.literal(`c${index}`)}`
        })

        const orderBy = parsed.orderBy
          ? sql`ORDER BY ${columnFor(parsed.orderBy.variable, parsed.orderBy.property)} ${sql.literal(parsed.orderBy.direction)}`
          : sql``

        const dataRows = yield* sql<Record<string, unknown>>`
          SELECT ${sql.csv(selectColumns)} ${from} ${where} ${orderBy}
          LIMIT ${limit} OFFSET ${skip};
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "query_graph execution failed", cause: e })
          )
        )

        const columns = parsed.returns.map((projection) => projection.alias)
        const rows: Row[] = dataRows.map((row) => {
          const mapped: Record<string, unknown> = {}
          parsed.returns.forEach((projection, index) => {
            mapped[projection.alias] = row[`c${index}`]
          })
          return mapped
        })

        return {
          columns,
          rows,
          total,
          returned: rows.length,
          truncated: skip + rows.length < total
        }
      }).pipe(
        Effect.catchAllDefect((defect) =>
          defect instanceof QueryLanguageError ? Effect.fail(defect) : Effect.die(defect)
        )
      )

    return { execute }
  })
)
