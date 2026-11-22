export interface ComplexityFields {
  readonly cyclomatic: number
  readonly cognitive: number
  readonly loopDepth: number
  readonly loopCount: number
  readonly linearScanInLoop: number
  readonly allocInLoop: number
  readonly recursive: boolean
  readonly paramCount: number
}

interface ASTNode {
  readonly type: string
  readonly text: string
  readonly namedChildren: readonly ASTNode[]
}

const SCAN_CALLS = new Set([
  "find",
  "findIndex",
  "includes",
  "indexOf",
  "contains",
  "some",
  "every",
  "filter",
  "any",
  "all",
  "count",
  "position",
  "search",
  "first",
  "last"
])

const ALLOC_CALLS = new Set([
  "push",
  "unshift",
  "splice",
  "concat",
  "append",
  "add",
  "insert",
  "extend",
  "vec",
  "collect"
])

const LOOP_TYPES = new Set([
  "for_statement",
  "for_in_statement",
  "for_of_statement",
  "enhanced_for_statement",
  "for_expression",
  "for_loop",
  "while_statement",
  "while_expression",
  "do_statement",
  "do_while_statement",
  "loop_expression"
])

const IF_TYPES = new Set(["if_statement", "if_expression", "elif_clause", "elsif_clause"])
const CASE_TYPES = new Set([
  "switch_case",
  "case_clause",
  "when_entry",
  "match_arm",
  "case_statement"
])
const CATCH_TYPES = new Set(["catch_clause", "except_clause", "rescue_clause"])
const CONDITIONAL_TYPES = new Set(["conditional_expression", "ternary_expression"])
const LOGICAL_TYPES = new Set([
  "binary_expression",
  "boolean_operator",
  "conjunction_expression",
  "disjunction_expression"
])
const ALLOC_TYPES = new Set([
  "new_expression",
  "object_creation_expression",
  "array_creation_expression",
  "array_expression",
  "array",
  "list",
  "list_expression",
  "composite_literal",
  "slice_expression"
])
const NESTED_FUNCTION_TYPES = new Set([
  "function_definition",
  "function_declaration",
  "function_item",
  "function_signature_item",
  "method_declaration",
  "method_definition",
  "constructor_declaration",
  "lambda_literal",
  "lambda_expression",
  "closure_expression",
  "arrow_function"
])

const isLoop = (node: ASTNode): boolean =>
  LOOP_TYPES.has(node.type) ||
  node.type.includes("foreach") ||
  /(^|_)(for|while|loop)(_|$)/.test(node.type)

const isIf = (node: ASTNode): boolean =>
  IF_TYPES.has(node.type) || /(^|_)(if|elif|elsif)(_|$)/.test(node.type)

const isCase = (node: ASTNode): boolean =>
  CASE_TYPES.has(node.type) || /(^|_)(case|when|match_arm)(_|$)/.test(node.type)

const isCatch = (node: ASTNode): boolean =>
  CATCH_TYPES.has(node.type) || /(^|_)(catch|except|rescue)(_|$)/.test(node.type)

const calleeName = (text: string): string | undefined => {
  const open = text.indexOf("(")
  const head = (open === -1 ? text : text.slice(0, open)).trim()
  if (!head) return undefined
  const segments = head.split(/::|\.|->|:/).filter(Boolean)
  return segments[segments.length - 1]?.trim()
}

const isLogical = (node: ASTNode): boolean =>
  LOGICAL_TYPES.has(node.type) && /(?:&&|\|\||\band\b|\bor\b)/.test(node.text)

export const computeTreeComplexity = (
  body: ASTNode | null | undefined,
  name: string,
  paramCount: number
): ComplexityFields => {
  if (!body) {
    return {
      cyclomatic: 1,
      cognitive: 1,
      loopDepth: 0,
      loopCount: 0,
      linearScanInLoop: 0,
      allocInLoop: 0,
      recursive: false,
      paramCount
    }
  }

  let cyclomatic = 1
  let cognitive = 1
  let loopCount = 0
  let maxLoopDepth = 0
  let linearScanInLoop = 0
  let allocInLoop = 0
  let recursive = false
  const baseName = name.split(".").pop() ?? name

  const visit = (node: ASTNode, loopDepth: number, controlDepth: number): void => {
    if (node !== body && NESTED_FUNCTION_TYPES.has(node.type)) return

    let nextLoop = loopDepth
    let nextControl = controlDepth

    if (isLoop(node)) {
      cyclomatic += 1
      cognitive += 1 + controlDepth
      loopCount += 1
      nextLoop = loopDepth + 1
      maxLoopDepth = Math.max(maxLoopDepth, nextLoop)
      nextControl = controlDepth + 1
    } else if (isIf(node)) {
      cyclomatic += 1
      cognitive += 1 + controlDepth
      nextControl = controlDepth + 1
    } else if (isCase(node)) {
      cyclomatic += 1
      cognitive += 1 + controlDepth
      nextControl = controlDepth + 1
    } else if (isCatch(node)) {
      cyclomatic += 1
      cognitive += 1 + controlDepth
      nextControl = controlDepth + 1
    } else if (CONDITIONAL_TYPES.has(node.type)) {
      cyclomatic += 1
      cognitive += 1 + controlDepth
    } else if (isLogical(node)) {
      cyclomatic += 1
      cognitive += 1
    }

    const isCall =
      node.type.endsWith("call") ||
      node.type === "call_expression" ||
      node.type === "method_invocation" ||
      node.type === "invocation_expression" ||
      node.type === "function_call_expression"

    if (isCall) {
      const called = calleeName(node.text)
      if (called && called === baseName) recursive = true
      if (loopDepth > 0 && called) {
        if (SCAN_CALLS.has(called)) linearScanInLoop += 1
        if (ALLOC_CALLS.has(called)) allocInLoop += 1
      }
    }

    if (loopDepth > 0 && ALLOC_TYPES.has(node.type)) {
      allocInLoop += 1
    }

    for (const child of node.namedChildren) {
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
