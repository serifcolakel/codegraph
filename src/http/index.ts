import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import {
  FileSystem,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Path
} from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Either, Schema } from "effect"
import { GraphQuery } from "../services/GraphQuery.js"
import { Indexer } from "../services/Indexer.js"
import { IndexStore } from "../services/IndexStore.js"

export const makeHttpRouter = Effect.gen(function* () {
  const store = yield* IndexStore
  const query = yield* GraphQuery
  const indexer = yield* Indexer
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const IndexRequest = Schema.Struct({
    path: Schema.String,
    name: Schema.optional(Schema.String),
    force: Schema.optional(Schema.Boolean)
  })

  const ReindexRequest = Schema.Struct({
    repoId: Schema.String,
    force: Schema.optional(Schema.Boolean)
  })

  const router = HttpRouter.empty.pipe(
    // 1. GET /api/repos
    HttpRouter.get(
      "/api/repos",
      Effect.gen(function* () {
        const repos = yield* store
          .listRepos()
          .pipe(
            Effect.catchAll((e) => HttpServerResponse.json({ error: e.message }, { status: 500 }))
          )
        return yield* HttpServerResponse.json(repos)
      })
    ),

    // 2. GET /api/graph?repo=&level=file|symbol&focus=&depth=
    HttpRouter.get(
      "/api/graph",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(req.url, "http://localhost")
        const repo = url.searchParams.get("repo") ?? ""
        const level = url.searchParams.get("level") ?? "file"
        const focus = url.searchParams.get("focus")
        const depth = parseInt(url.searchParams.get("depth") ?? "1", 10)

        if (level === "symbol" || focus) {
          if (focus) {
            const result = yield* query
              .neighborhood(focus, depth)
              .pipe(
                Effect.catchAll((e) =>
                  HttpServerResponse.json({ error: e.message }, { status: 500 })
                )
              )
            return yield* HttpServerResponse.json(result)
          } else {
            const search = yield* query
              .searchSymbols("", 100, repo)
              .pipe(
                Effect.catchAll((e) =>
                  HttpServerResponse.json({ error: e.message }, { status: 500 })
                )
              )
            return yield* HttpServerResponse.json({ nodes: search, edges: [] })
          }
        }

        const fileGraph = yield* query
          .fileGraph(repo)
          .pipe(
            Effect.catchAll((e) => HttpServerResponse.json({ error: e.message }, { status: 500 }))
          )
        return yield* HttpServerResponse.json(fileGraph)
      })
    ),

    // 3. GET /api/search?q=&repo=
    HttpRouter.get(
      "/api/search",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(req.url, "http://localhost")
        const q = url.searchParams.get("q") ?? ""
        const repo = url.searchParams.get("repo") ?? undefined

        const results = yield* query
          .searchSymbols(q, 30, repo)
          .pipe(
            Effect.catchAll((e) => HttpServerResponse.json({ error: e.message }, { status: 500 }))
          )
        return yield* HttpServerResponse.json(results)
      })
    ),

    // 4. GET /api/symbol/:id
    HttpRouter.get(
      "/api/symbol/:id",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaParams(Schema.Struct({ id: Schema.String }))
        const symbolId = decodeURIComponent(params.id)

        const details = yield* query.getSymbol(symbolId).pipe(
          Effect.catchTag("NotFoundError", () =>
            HttpServerResponse.json({ error: "Symbol not found" }, { status: 404 })
          ),
          Effect.catchAll((e) =>
            HttpServerResponse.json(
              { error: e._tag === "StoreError" ? e.message : "Unknown error" },
              { status: 500 }
            )
          )
        )

        return yield* HttpServerResponse.json(details)
      })
    ),

    // 6. POST /api/index - index or update a repository
    HttpRouter.post(
      "/api/index",
      Effect.gen(function* () {
        const parsed = yield* HttpServerRequest.schemaBodyJson(IndexRequest).pipe(Effect.either)
        if (Either.isLeft(parsed)) {
          return yield* HttpServerResponse.json(
            { error: "Invalid request body. Expected { path: string }." },
            { status: 400 }
          )
        }

        const input = parsed.right
        const rootPath = input.path.trim()
        if (!rootPath) {
          return yield* HttpServerResponse.json(
            { error: "Repository path is required." },
            { status: 400 }
          )
        }
        if (!path.isAbsolute(rootPath)) {
          return yield* HttpServerResponse.json(
            { error: "Repository path must be absolute." },
            { status: 400 }
          )
        }

        const options = {
          force: input.force ?? false,
          ...(input.name?.trim() ? { name: input.name.trim() } : {})
        }
        const result = yield* indexer.indexRepo(rootPath, options).pipe(Effect.either)
        if (Either.isLeft(result)) {
          return yield* HttpServerResponse.json({ error: result.left.message }, { status: 500 })
        }
        return yield* HttpServerResponse.json(result.right)
      })
    ),

    // 7. POST /api/reindex - refresh an existing repository
    HttpRouter.post(
      "/api/reindex",
      Effect.gen(function* () {
        const parsed = yield* HttpServerRequest.schemaBodyJson(ReindexRequest).pipe(Effect.either)
        if (Either.isLeft(parsed)) {
          return yield* HttpServerResponse.json(
            { error: "Invalid request body. Expected { repoId: string }." },
            { status: 400 }
          )
        }

        const repo = yield* store.getRepo(parsed.right.repoId).pipe(Effect.either)
        if (Either.isLeft(repo)) {
          return yield* HttpServerResponse.json({ error: repo.left.message }, { status: 500 })
        }
        if (!repo.right) {
          return yield* HttpServerResponse.json({ error: "Repository not found." }, { status: 404 })
        }

        const result = yield* indexer
          .indexRepo(repo.right.rootPath, {
            name: repo.right.name,
            force: parsed.right.force ?? false
          })
          .pipe(Effect.either)
        if (Either.isLeft(result)) {
          return yield* HttpServerResponse.json({ error: result.left.message }, { status: 500 })
        }
        return yield* HttpServerResponse.json(result.right)
      })
    ),

    // 5. GET / and /index.html - serve web/index.html
    HttpRouter.get(
      "/",
      Effect.gen(function* () {
        // Resolve relative to this module first so `serve` works from any cwd
        // (src/http and dist/http are both one level below the package root).
        const candidates = [
          fileURLToPath(new URL("../../web/index.html", import.meta.url)),
          path.resolve("web/index.html"),
          path.resolve("../web/index.html"),
          path.join(process.cwd(), "web/index.html")
        ]

        let htmlContent = ""
        for (const candidate of candidates) {
          const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))
          if (exists) {
            htmlContent = yield* fs.readFileString(candidate).pipe(Effect.orElseSucceed(() => ""))
            if (htmlContent) break
          }
        }

        if (!htmlContent) {
          return yield* HttpServerResponse.text("CodeGraph web/index.html not found", {
            status: 404
          })
        }

        return yield* HttpServerResponse.html(htmlContent)
      })
    ),

    HttpRouter.get(
      "/index.html",
      Effect.gen(function* () {
        const indexPath = fileURLToPath(new URL("../../web/index.html", import.meta.url))
        const html = yield* fs.readFileString(indexPath).pipe(Effect.orElseSucceed(() => ""))
        if (!html) {
          return yield* HttpServerResponse.text("CodeGraph web/index.html not found", {
            status: 404
          })
        }
        return yield* HttpServerResponse.html(html)
      })
    )
  )

  return router
})

export const serveHttp = (port: number = 4310) =>
  Effect.scoped(
    Effect.gen(function* () {
      const router = yield* makeHttpRouter
      const server = yield* NodeHttpServer.make(() => createServer(), { port })
      yield* server.serve(router)
      yield* Effect.logInfo(`Serving CodeGraph HTTP API and UI on http://localhost:${port}`)
      yield* Effect.never
    })
  )
