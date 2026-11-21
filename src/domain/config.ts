import { Config } from "effect";

export interface AppConfigSettings {
	readonly dbPath: string;
	readonly concurrency: number;
	readonly ignoreGlobs: string[];
	readonly port: number;
}

export const appConfig = Config.all({
	dbPath: Config.string("CODEGRAPH_DB_PATH").pipe(
		Config.withDefault(".codegraph.sqlite"),
	),
	concurrency: Config.integer("CODEGRAPH_CONCURRENCY").pipe(
		Config.withDefault(4),
	),
	ignoreGlobs: Config.string("CODEGRAPH_IGNORE_GLOBS").pipe(
		Config.withDefault(
			"**/node_modules/**,**/dist/**,**/.git/**,**/.next/**,**/build/**",
		),
	),
	port: Config.integer("CODEGRAPH_PORT").pipe(Config.withDefault(4310)),
});
