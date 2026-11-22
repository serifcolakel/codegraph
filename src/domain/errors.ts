import { Data } from "effect"

export class WalkError extends Data.TaggedError("WalkError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class ParseError extends Data.TaggedError("ParseError")<{
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly entity: string
  readonly id: string
}> {}

export class GraphError extends Data.TaggedError("GraphError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class GitError extends Data.TaggedError("GitError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class QueryLanguageError extends Data.TaggedError("QueryLanguageError")<{
  readonly message: string
  readonly position?: number
}> {}
