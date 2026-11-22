import { Config } from "effect"

export interface AppConfigSettings {
  readonly dbPath: string
  readonly concurrency: number
  readonly ignoreGlobs: readonly string[]
  readonly port: number
  readonly watchDebounceMs: number
  readonly searchLimit: number
  readonly neighborhoodLimit: number
  readonly maxDepth: number
}

const parseGlobs = (raw: string): readonly string[] =>
  raw
    .split(",")
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0)

export const appConfig: Config.Config<AppConfigSettings> = Config.all({
  dbPath: Config.string("CODEGRAPH_DB_PATH").pipe(Config.withDefault(".codegraph.sqlite")),
  concurrency: Config.integer("CODEGRAPH_CONCURRENCY").pipe(Config.withDefault(4)),
  ignoreGlobs: Config.string("CODEGRAPH_IGNORE_GLOBS").pipe(
    Config.withDefault("**/node_modules/**,**/dist/**,**/.git/**,**/.next/**,**/build/**"),
    Config.map(parseGlobs)
  ),
  port: Config.integer("CODEGRAPH_PORT").pipe(Config.withDefault(4310)),
  watchDebounceMs: Config.integer("CODEGRAPH_WATCH_DEBOUNCE_MS").pipe(Config.withDefault(500)),
  searchLimit: Config.integer("CODEGRAPH_SEARCH_LIMIT").pipe(Config.withDefault(50)),
  neighborhoodLimit: Config.integer("CODEGRAPH_NEIGHBORHOOD_LIMIT").pipe(Config.withDefault(500)),
  maxDepth: Config.integer("CODEGRAPH_MAX_DEPTH").pipe(Config.withDefault(8))
})
