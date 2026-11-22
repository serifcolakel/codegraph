import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { Context, Effect, Layer } from "effect"
import { GitError } from "../domain/errors.js"

const execFileAsync = promisify(execFile)

export interface GitChanges {
  readonly changedFiles: (
    rootPath: string,
    base?: string
  ) => Effect.Effect<readonly string[], GitError>
}

export const GitChanges = Context.GenericTag<GitChanges>("@codegraph/GitChanges")

export const GitChangesLive = Layer.succeed(GitChanges, {
  changedFiles: (rootPath: string, base?: string) =>
    Effect.tryPromise({
      try: async () => {
        const { stdout: topLevel } = await execFileAsync("git", [
          "-C",
          rootPath,
          "rev-parse",
          "--show-toplevel"
        ])
        if (resolve(topLevel.trim()) !== resolve(rootPath)) {
          throw new Error(`${rootPath} is not the git repository root`)
        }

        const range = base ? `${base}...HEAD` : "HEAD"
        const { stdout } = await execFileAsync("git", [
          "-C",
          rootPath,
          "diff",
          "--name-only",
          range
        ])
        return stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      },
      catch: (error) =>
        new GitError({
          message: `Failed to read git changes in ${rootPath}`,
          cause: error
        })
    })
})
