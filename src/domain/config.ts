import { Config } from "effect"

export interface AppConfigSettings {
  readonly dbPath: string
  readonly concurrency: number
  readonly ignoreGlobs: readonly string[]
  readonly port: number
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
  port: Config.integer("CODEGRAPH_PORT").pipe(Config.withDefault(4310))
})
