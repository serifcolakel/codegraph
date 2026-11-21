import type { Language } from "../domain/languages.js"
import { parsePythonFile } from "./python.js"
import type { SourceParser } from "./types.js"

export type { SourceParser } from "./types.js"

// AST-backed parsers. Languages without an entry fall back to the regex parser.
const AST_PARSERS: Partial<Record<Language, SourceParser>> = {
  python: { parse: parsePythonFile }
}

export const astParserFor = (language: Language): SourceParser | undefined => AST_PARSERS[language]
