#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const usage = `Usage: codegraph-auto-index [options]

Options:
  --path <dir>          Repository root (default: current directory)
  --cli <path>          CodeGraph CLI path or command (default: CODEGRAPH_CLI, ./dist/cli/index.js, or "codegraph")
  --db <path>           Sets CODEGRAPH_DB_PATH for the run
  --debounce-ms <n>     Wait before indexing (default: 0)
  --watch               Start "index --watch" detached instead of one run
  --quiet               Suppress output unless the run fails
  --strict              Exit non-zero when indexing fails
  -h, --help            Show this help

Hook usage examples:
  node scripts/codegraph-auto-index.mjs --path . --quiet
  node scripts/codegraph-auto-index.mjs --path . --debounce-ms 1500 --quiet
`

const args = process.argv.slice(2)
const options = {
  path: process.cwd(),
  cli: process.env.CODEGRAPH_CLI,
  db: process.env.CODEGRAPH_DB_PATH,
  debounceMs: 0,
  watch: false,
  quiet: false,
  strict: false
}

for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === "-h" || arg === "--help") {
    console.log(usage)
    process.exit(0)
  }
  if (arg === "--watch") options.watch = true
  else if (arg === "--quiet") options.quiet = true
  else if (arg === "--strict") options.strict = true
  else if (arg === "--path") options.path = args[++index] ?? options.path
  else if (arg === "--cli") options.cli = args[++index]
  else if (arg === "--db") options.db = args[++index]
  else if (arg === "--debounce-ms") options.debounceMs = Number(args[++index] ?? 0)
  else if (!options.quiet) console.error(`[codegraph] Unknown option: ${arg}`)
}

const repo = resolve(options.path ?? process.cwd())
if (!existsSync(repo)) {
  if (!options.quiet) console.error(`[codegraph] Path does not exist: ${repo}`)
  process.exit(options.strict ? 1 : 0)
}

const localCli = join(repo, "dist/cli/index.js")
const cli = options.cli || (existsSync(localCli) ? localCli : "codegraph")
const isScript = cli.endsWith(".js") || cli.endsWith(".mjs") || cli.endsWith(".cjs")
const command = isScript ? process.execPath : cli
const commandPrefix = isScript ? [cli] : []

const env = { ...process.env }
if (options.db) env.CODEGRAPH_DB_PATH = options.db

const log = (message) => {
  if (!options.quiet) console.log(`[codegraph] ${message}`)
}

if (options.watch) {
  const child = spawnSync(command, [...commandPrefix, "index", repo, "--watch"], {
    env,
    stdio: "inherit"
  })
  process.exit(child.status ?? 0)
}

const sleep = (ms) =>
  new Promise((done) => {
    if (ms > 0) setTimeout(done, ms)
    else done()
  })

const lockDir = tmpdir()
const lockPath = join(
  lockDir,
  `codegraph-auto-index-${createHash("sha1").update(repo).digest("hex").slice(0, 12)}.lock`
)

const acquireLock = () => {
  try {
    const fd = openSync(lockPath, "wx")
    closeSync(fd)
    return true
  } catch {
    try {
      const ageMs = Date.now() - statSync(lockPath).mtimeMs
      if (ageMs > 10 * 60 * 1000) {
        unlinkSync(lockPath)
        const fd = openSync(lockPath, "wx")
        closeSync(fd)
        return true
      }
      const pid = readFileSync(lockPath, "utf8").trim()
      if (pid && !existsSync(`/proc/${pid}`) && process.platform === "linux") {
        unlinkSync(lockPath)
        const fd = openSync(lockPath, "wx")
        closeSync(fd)
        return true
      }
    } catch {
      // A concurrent run already owns the lock.
    }
    return false
  }
}

if (!acquireLock()) {
  log("index already running; skipping")
  process.exit(0)
}

const release = () => {
  try {
    unlinkSync(lockPath)
  } catch {
    // Already gone.
  }
}

process.on("exit", release)
process.on("SIGINT", () => {
  release()
  process.exit(130)
})
process.on("SIGTERM", () => {
  release()
  process.exit(143)
})

await sleep(Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 0)

log(`indexing ${repo}`)
const result = spawnSync(command, [...commandPrefix, "index", repo], {
  env,
  encoding: "utf8",
  timeout: 10 * 60 * 1000
})

release()

if (result.error || result.status !== 0) {
  const details = result.error?.message ?? result.stderr ?? result.stdout ?? "unknown error"
  if (!options.quiet || options.strict) {
    console.error(`[codegraph] auto-index failed: ${details}`)
  }
  process.exit(options.strict ? 1 : 0)
}

if (!options.quiet) {
  const summary = (result.stdout ?? "").trim().split("\n").slice(-2).join(" ")
  console.log(`[codegraph] ${summary || "index updated"}`)
}
