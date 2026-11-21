import type { ParsedFile } from "../domain/models.js"

export interface SourceParser {
  readonly parse: (filePath: string, content: string) => ParsedFile
}
