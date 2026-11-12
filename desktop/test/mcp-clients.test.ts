import { describe, expect, it } from "vitest"

import { buildLaunch, buildSnippet, clientById, inspectCodexText, locateClient, removeCommandFor } from "../src/mcp-clients.ts"

const launch = buildLaunch("C:\\App\\CS2MCP Companion.exe", "C:\\App\\resources\\mcp-server\\bin\\index.mjs", { token: "tok" })

describe("Codex", () => {
  const toml = buildSnippet("codex-toml", launch, false).text

  it("writes a config.toml table that inspectCodexText reads back as current", () => {
    const found = inspectCodexText(`model = "gpt-5"\n\n${toml}\n\n[other]\nx = 1\n`, launch)
    expect(found.state).toBe("current")
    expect(found.entry?.envKeys.sort()).toEqual(["CS2MCP_TOKEN", "ELECTRON_RUN_AS_NODE"])
  })

  it("reports outdated for another command and none when the table is absent", () => {
    expect(inspectCodexText('[mcp_servers.cs2]\ncommand = "node"\nargs = ["old.mjs"]\n', launch).state).toBe("outdated")
    expect(inspectCodexText('[mcp_servers.other]\ncommand = "node"\n', launch).state).toBe("none")
  })

  it("reads env from a [mcp_servers.cs2.env] sub-table (what `codex mcp add` writes)", () => {
    const text = `[mcp_servers.cs2]\ncommand = 'C:\\App\\CS2MCP Companion.exe'\nargs = ['C:\\App\\resources\\mcp-server\\bin\\index.mjs']\n\n[mcp_servers.cs2.env]\nELECTRON_RUN_AS_NODE = "1"\n`
    const found = inspectCodexText(text, launch)
    expect(found.state).toBe("current")
    expect(found.entry?.envKeys).toEqual(["ELECTRON_RUN_AS_NODE"])
  })

  it("builds the add command with repeated --env and masks the token for display", () => {
    const shown = buildSnippet("codex", launch, true).text
    expect(shown.startsWith("codex mcp add cs2 --env ELECTRON_RUN_AS_NODE=1 --env ")).toBe(true)
    expect(shown).toContain(" -- ")
    expect(shown).not.toContain("tok\"")
    expect(buildSnippet("codex", launch, false).text).toContain("CS2MCP_TOKEN=tok")
  })

  it("is found through CODEX_HOME", () => {
    const where = locateClient(
      clientById("codex")!,
      { home: "C:\\Users\\u", appData: "", localAppData: "", codexHome: "D:\\codex" },
      { exists: (path) => path === "D:\\codex", list: () => [] }
    )
    expect(where.detected).toBe(true)
    expect(where.configPath).toBe("D:\\codex\\config.toml")
  })
})

describe("Gemini CLI", () => {
  it("keeps a non-variadic option between the last -e and the server name", () => {
    const text = buildSnippet("gemini-cli", launch, false).text
    expect(text).toMatch(/^gemini mcp add -e \S+ -e \S+ --scope user cs2 /)
  })
})

it("has a remove command for every CLI client and none for the JSON ones", () => {
  expect(removeCommandFor("claude-code")).toBe("claude mcp remove cs2 --scope user")
  expect(removeCommandFor("codex")).toBe("codex mcp remove cs2")
  expect(removeCommandFor("gemini-cli")).toContain("gemini mcp remove")
  expect(removeCommandFor("cursor")).toBeNull()
})
