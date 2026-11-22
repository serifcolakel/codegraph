import { defineConfig, devices } from "@playwright/test"

const PORT = 4321

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: [
      "mkdir -p e2e/.tmp",
      "rm -f e2e/.tmp/e2e.sqlite e2e/.tmp/e2e.sqlite-shm e2e/.tmp/e2e.sqlite-wal",
      "node dist/cli/index.js index e2e/fixtures/sample-repo --force",
      `node dist/cli/index.js serve --port ${PORT}`
    ].join(" && "),
    url: `http://127.0.0.1:${PORT}/api/repos`,
    env: { CODEGRAPH_DB_PATH: "e2e/.tmp/e2e.sqlite" },
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe"
  }
})
