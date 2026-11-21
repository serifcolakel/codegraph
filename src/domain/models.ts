import { Schema } from "effect"

export const SymbolKind = Schema.Literal(
  "function",
  "class",
  "interface",
  "type",
  "const",
  "method",
  "property",
  "enum"
)
export type SymbolKind = typeof SymbolKind.Type

export const EdgeKind = Schema.Literal(
  "import",
  "call",
  "reference",
  "extends",
  "implements",
  "contains"
)
export type EdgeKind = typeof EdgeKind.Type

export const RepoRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rootPath: Schema.String
})
export type RepoRecord = typeof RepoRecord.Type

export const FileRecord = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  hash: Schema.String,
  repoId: Schema.String
})
export type FileRecord = typeof FileRecord.Type

export const SymbolRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: SymbolKind,
  fileId: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  signature: Schema.String,
  exported: Schema.Boolean
})
export type SymbolRecord = typeof SymbolRecord.Type

export const EdgeRecord = Schema.Struct({
  id: Schema.String,
  srcSymbolId: Schema.String,
  dstSymbolId: Schema.String,
  kind: EdgeKind
})
export type EdgeRecord = typeof EdgeRecord.Type

export const ParsedSymbol = Schema.Struct({
  name: Schema.String,
  kind: SymbolKind,
  startLine: Schema.Number,
  endLine: Schema.Number,
  signature: Schema.String,
  exported: Schema.Boolean,
  containerName: Schema.optional(Schema.String)
})
export type ParsedSymbol = typeof ParsedSymbol.Type

export const ParsedEdge = Schema.Struct({
  srcName: Schema.String,
  dstName: Schema.String,
  kind: EdgeKind,
  srcLine: Schema.optional(Schema.Number),
  importPath: Schema.optional(Schema.String)
})
export type ParsedEdge = typeof ParsedEdge.Type

export const ParsedFile = Schema.Struct({
  path: Schema.String,
  symbols: Schema.Array(ParsedSymbol),
  edges: Schema.Array(ParsedEdge)
})
export type ParsedFile = typeof ParsedFile.Type

export const FileScanResult = Schema.Struct({
  path: Schema.String,
  absolutePath: Schema.String,
  hash: Schema.String
})
export type FileScanResult = typeof FileScanResult.Type

export const IndexReport = Schema.Struct({
  repoId: Schema.String,
  repoName: Schema.String,
  filesIndexed: Schema.Number,
  filesSkipped: Schema.Number,
  filesDeleted: Schema.Number,
  symbolsCount: Schema.Number,
  edgesCount: Schema.Number,
  durationMs: Schema.Number
})
export type IndexReport = typeof IndexReport.Type

export const StatsReport = Schema.Struct({
  repos: Schema.Number,
  files: Schema.Number,
  symbols: Schema.Number,
  edges: Schema.Number
})
export type StatsReport = typeof StatsReport.Type

// Graph Query models
export const SymbolWithFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: SymbolKind,
  fileId: Schema.String,
  filePath: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  signature: Schema.String,
  exported: Schema.Boolean,
  inDegree: Schema.optional(Schema.Number)
})
export type SymbolWithFile = typeof SymbolWithFile.Type

export const SymbolDetails = Schema.Struct({
  symbol: SymbolWithFile,
  outgoingEdges: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      srcSymbolId: Schema.String,
      dstSymbolId: Schema.String,
      kind: EdgeKind,
      targetSymbol: Schema.optional(SymbolWithFile)
    })
  ),
  incomingEdges: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      srcSymbolId: Schema.String,
      dstSymbolId: Schema.String,
      kind: EdgeKind,
      sourceSymbol: Schema.optional(SymbolWithFile)
    })
  )
})
export type SymbolDetails = typeof SymbolDetails.Type

export const ReferenceResult = Schema.Struct({
  edgeId: Schema.String,
  kind: EdgeKind,
  sourceSymbol: SymbolWithFile
})
export type ReferenceResult = typeof ReferenceResult.Type

export const NeighborhoodGraph = Schema.Struct({
  nodes: Schema.Array(SymbolWithFile),
  edges: Schema.Array(EdgeRecord)
})
export type NeighborhoodGraph = typeof NeighborhoodGraph.Type

export const FileGraphNode = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  symbolCount: Schema.Number,
  inDegree: Schema.Number
})
export type FileGraphNode = typeof FileGraphNode.Type

export const FileGraphEdge = Schema.Struct({
  srcFileId: Schema.String,
  srcPath: Schema.String,
  dstFileId: Schema.String,
  dstPath: Schema.String,
  weight: Schema.Number,
  kinds: Schema.Array(Schema.String)
})
export type FileGraphEdge = typeof FileGraphEdge.Type

export const FileGraph = Schema.Struct({
  nodes: Schema.Array(FileGraphNode),
  edges: Schema.Array(FileGraphEdge)
})
export type FileGraph = typeof FileGraph.Type
