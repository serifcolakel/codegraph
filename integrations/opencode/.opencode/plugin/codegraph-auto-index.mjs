// Copy to <project>/.opencode/plugin/codegraph-auto-index.mjs
// Adjust event names if your opencode version exposes different events.
const SCRIPT = "/absolute/path/to/codegraph/scripts/codegraph-auto-index.mjs"

export const CodeGraphAutoIndex = async ({ $, directory }) => ({
  event: async ({ event }) => {
    if (event?.type !== "file.edited" && event?.type !== "session.idle") return
    await $`node ${SCRIPT} --path ${directory} --debounce-ms 1500 --quiet`.catch(() => {})
  }
})
