import { expect, test } from "@playwright/test"

test.describe("CodeGraph web UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await expect(page.getByTestId("stat-indexed")).not.toHaveText("—")
  })

  test("shows index metadata and repository counts", async ({ page, request }) => {
    const response = await request.get("/api/repos")
    expect(response.ok()).toBeTruthy()
    const repos = (await response.json()) as Array<{
      id: string
      files: number
      symbols: number
      sourceBytes: number
      indexDurationMs: number
    }>
    expect(repos).toHaveLength(1)
    const repo = repos[0]
    if (!repo) throw new Error("expected an indexed repository")

    await expect(page.getByTestId("repo-select")).toHaveValue(repo.id)
    await expect(page.getByTestId("stat-indexed")).toHaveText(/ago|just now/)
    await expect(page.getByTestId("stat-indexed")).toHaveAttribute(
      "title",
      new RegExp(`${repo.indexDurationMs} ms`)
    )
    await expect(page.getByTestId("stat-source")).toHaveText(/\d+(\.\d+)? (B|KB|MB)/)
    await expect(page.getByTestId("stat-source")).toHaveAttribute(
      "title",
      `${repo.sourceBytes.toLocaleString("en-US")} bytes across ${repo.files.toLocaleString("en-US")} files`
    )
    await expect(page.getByTestId("stat-symbols")).toHaveText(repo.symbols.toLocaleString("en-US"))

    await expect(page.getByTestId("info-indexed")).toHaveText(/ago|just now/)
    await expect(page.getByTestId("info-source")).toHaveText(/\d+(\.\d+)? (B|KB|MB)/)
    await expect(page.getByTestId("info-files")).toHaveText(repo.files.toLocaleString("en-US"))
    await expect(page.getByTestId("info-symbols")).toHaveText(repo.symbols.toLocaleString("en-US"))
  })

  test("shows the index details dialog", async ({ page }) => {
    await page.getByTestId("details-button").click()
    await expect(page.getByTestId("details-modal")).toBeVisible()
    await expect(page.getByTestId("details-body")).toContainText("Parse coverage")
    await expect(page.getByTestId("details-languages")).toContainText("typescript")
    await expect(page.getByTestId("details-coverage")).toContainText("Parsed")
    await expect(page.getByTestId("details-imports")).toContainText("Resolved")
    await expect(page.getByTestId("details-jobs")).toBeVisible()
    await expect(page.getByTestId("details-source")).toContainText(/B|KB|MB/)

    await page.getByTestId("details-footer-close").click()
    await expect(page.getByTestId("details-modal")).not.toBeVisible()
  })

  test("renders the file graph with view stats", async ({ page }) => {
    await expect(page.getByTestId("view-mode")).toHaveText("File graph")
    await expect(page.getByTestId("graph-canvas")).toBeVisible()

    const nodes = Number((await page.getByTestId("stat-nodes").textContent())?.replace(/,/g, ""))
    const edges = Number((await page.getByTestId("stat-edges").textContent())?.replace(/,/g, ""))
    expect(nodes).toBeGreaterThan(0)
    expect(edges).toBeGreaterThan(0)
  })

  test("searches symbols and opens the symbol panel", async ({ page }) => {
    await page.getByTestId("search-input").fill("Calculator")
    await expect(page.getByTestId("search-dropdown")).toHaveClass(/open/)

    const results = page.getByTestId("search-result")
    await expect(results.first()).toBeVisible()
    await results.first().click()

    await expect(page.getByTestId("symbol-panel")).toBeVisible()
    await expect(page.getByTestId("panel-title")).toContainText("Calculator")
  })

  test("switches between file and symbol views", async ({ page }) => {
    await page.getByTestId("view-symbols").click()
    await expect(page.getByTestId("view-mode")).toHaveText("Top symbols")
    const nodes = Number((await page.getByTestId("stat-nodes").textContent())?.replace(/,/g, ""))
    expect(nodes).toBeGreaterThan(0)

    await page.getByTestId("view-files").click()
    await expect(page.getByTestId("view-mode")).toHaveText("File graph")
  })

  test("toggles the theme", async ({ page }) => {
    const html = page.locator("html")
    await expect(html).toHaveAttribute("data-theme", "dark")
    await page.getByTestId("theme-toggle").click()
    await expect(html).toHaveAttribute("data-theme", "light")
    await page.getByTestId("theme-toggle").click()
    await expect(html).toHaveAttribute("data-theme", "dark")
  })

  test("reindexes and refreshes the metadata bar", async ({ page }) => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          candidate.url().includes("/api/reindex") && candidate.request().method() === "POST"
      ),
      page.getByTestId("reindex-button").click()
    ])
    expect(response.ok()).toBeTruthy()
    await expect(page.getByTestId("toast")).toContainText("Index updated")
    await expect(page.getByTestId("stat-indexed")).toHaveText(/just now|\d+s ago/)
  })

  test("opens and cancels the index and delete dialogs", async ({ page }) => {
    await page.getByTestId("index-button").click()
    await expect(page.getByTestId("index-modal")).toBeVisible()
    await expect(page.getByTestId("index-path")).toBeVisible()
    await page.getByTestId("index-cancel").click()
    await expect(page.getByTestId("index-modal")).not.toBeVisible()

    await page.getByTestId("delete-button").click()
    await expect(page.getByTestId("delete-modal")).toBeVisible()
    await page.getByTestId("delete-cancel").click()
    await expect(page.getByTestId("delete-modal")).not.toBeVisible()
  })
})
