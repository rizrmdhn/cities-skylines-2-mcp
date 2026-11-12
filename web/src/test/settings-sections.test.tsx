import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { defineSettingsSection } from "@/features/settings/define-section"
import { activeSettingsSections, registeredSettingsSections } from "@/features/settings/registry"
import { captureHotkey, hotkeyParts } from "@/features/settings/hotkey"
import { mockDesktopSettings } from "@/test/desktop-settings"
import { renderApp } from "@/test/render-app"

// Registering a section is one line in sections/index.ts; here the list is replaced by the
// sections of test/fake-settings-section.tsx, exactly as a feature's file would appear in it.
vi.mock("@/features/settings/sections", async () => {
  const fake = await import("@/test/fake-settings-section")
  return { broken: fake.broken, fake: fake.default }
})

const DEFAULTS = {
  "fake.enabled": false,
  "fake.mode": "quiet",
  "fake.intervalSeconds": 60,
  "fake.name": null,
  "fake.hotkey": null,
}

const intervalRule = (value: unknown) =>
  typeof value === "number" && value >= 5 && value <= 3600 ? undefined : "must be between 5 and 3600"

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}

async function openFakeSection(options: Parameters<typeof mockDesktopSettings>[0] = {}) {
  const settings = mockDesktopSettings({
    values: DEFAULTS,
    features: ["fake"],
    validate: { "fake.intervalSeconds": intervalRule },
    ...options,
  })
  const view = renderApp("/settings")
  const section = await screen.findByRole("region", { name: "Fake feature" })
  await screen.findByLabelText("Bridge URL") // the settings have arrived
  return { ...view, settings, section }
}

describe("settings section registry", () => {
  it("lists the registered sections", () => {
    expect(registeredSettingsSections().map((section) => section.id)).toEqual(["broken", "fake"])
  })

  it("keeps only the sections of started features", () => {
    const all = registeredSettingsSections()
    expect(activeSettingsSections(["settings-api"], all)).toEqual([])
    expect(activeSettingsSections(["settings-api", "fake"], all).map((section) => section.id)).toEqual(["fake"])
    expect(activeSettingsSections(["fake", "broken"]).map((section) => section.id)).toEqual(["broken", "fake"])
  })

  it("wants the feature's kebab-case id", () => {
    const component = () => null
    expect(defineSettingsSection({ id: "game-detection", title: "Game", component }).id).toBe("game-detection")
    expect(() => defineSettingsSection({ id: "Game Detection", title: "Game", component })).toThrow(/kebab-case/)
    expect(() => defineSettingsSection({ id: "", title: "Game", component })).toThrow()
  })
})

describe("a registered section on the settings page", () => {
  it("is not shown when the feature did not start", async () => {
    mockDesktopSettings({ values: DEFAULTS })
    renderApp("/settings")
    await screen.findByRole("region", { name: "Connection" })
    expect(screen.queryByRole("region", { name: "Fake feature" })).not.toBeInTheDocument()
  })

  it("is shown between Appearance and About, with its title and description", async () => {
    const { section } = await openFakeSection()
    expect(section).toHaveAttribute("id", "fake")
    expect(section).toHaveTextContent("A section registered by the tests.")
    const regions = screen.getAllByRole("region").map((region) => region.getAttribute("id"))
    expect(regions.indexOf("fake")).toBeGreaterThan(regions.indexOf("appearance"))
    expect(regions.indexOf("fake")).toBeLessThan(regions.indexOf("about"))
  })

  it("keeps the page when another section throws", async () => {
    const { section } = await openFakeSection({ features: ["fake", "broken"] })
    expect(await screen.findByText("The Broken feature settings could not be shown")).toBeInTheDocument()
    expect(screen.getByText("section exploded")).toBeInTheDocument()
    expect(within(section).getByRole("switch", { name: "Enable fake" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Connection" })).toBeInTheDocument()
  })

  it("shows the stored values", async () => {
    const { section } = await openFakeSection({
      values: { ...DEFAULTS, "fake.enabled": true, "fake.intervalSeconds": 30, "fake.name": "Harbor" },
    })
    expect(within(section).getByRole("switch", { name: "Enable fake" })).toBeChecked()
    expect(within(section).getByLabelText("Interval")).toHaveValue(30)
    expect(within(section).getByLabelText("Name")).toHaveValue("Harbor")
  })

  it("disables rows whose key no feature defines", async () => {
    const { section } = await openFakeSection({ values: { "fake.enabled": false } })
    expect(within(section).getByRole("switch", { name: "Enable fake" })).toBeEnabled()
    expect(within(section).getByLabelText("Interval")).toBeDisabled()
    expect(within(section).getByLabelText("Name")).toBeDisabled()
  })
})

describe("switch row", () => {
  it("saves immediately, updates optimistically and then says Saved", async () => {
    const gate = deferred()
    const { user, section, settings } = await openFakeSection({ holdPosts: gate.promise })
    const toggle = within(section).getByRole("switch", { name: "Enable fake" })
    expect(toggle).not.toBeChecked()

    await user.click(toggle)
    // the answer has not arrived: the switch already shows the new value and the row says Saving
    await waitFor(() => expect(toggle).toBeChecked())
    expect(within(section).getByText("Saving…")).toBeInTheDocument()
    expect(settings.posts).toEqual([{ "fake.enabled": true }])

    gate.release()
    expect(await within(section).findByText("Saved")).toBeInTheDocument()
    expect(toggle).toBeChecked()
  })

  it("goes back to the old value and shows the message when the save is refused", async () => {
    const { user, section } = await openFakeSection({
      validate: { "fake.enabled": () => "needs the game to be running" },
    })
    const toggle = within(section).getByRole("switch", { name: "Enable fake" })
    await user.click(toggle)
    expect(await within(section).findByText("needs the game to be running")).toBeInTheDocument()
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeInvalid()
    expect(toggle).toHaveAccessibleDescription(/needs the game to be running/)
  })

  it("can be operated with the keyboard", async () => {
    const { user, section, settings } = await openFakeSection()
    within(section).getByRole("switch", { name: "Enable fake" }).focus()
    await user.keyboard(" ")
    await waitFor(() => expect(settings.posts).toEqual([{ "fake.enabled": true }]))
  })
})

describe("select row", () => {
  it("saves the picked option", async () => {
    const { user, section, settings } = await openFakeSection()
    await user.click(within(section).getByRole("combobox", { name: "Mode" }))
    await user.click(await screen.findByRole("option", { name: "Loud" }))
    await waitFor(() => expect(settings.posts).toEqual([{ "fake.mode": "loud" }]))
    expect(within(section).getByRole("combobox", { name: "Mode" })).toHaveTextContent("Loud")
  })
})

describe("number row", () => {
  it("saves on Enter and on leaving the field", async () => {
    const { user, section, settings } = await openFakeSection()
    const field = within(section).getByLabelText("Interval")
    await user.clear(field)
    await user.type(field, "120{Enter}")
    await waitFor(() => expect(settings.posts).toEqual([{ "fake.intervalSeconds": 120 }]))
    await user.clear(field)
    await user.type(field, "30")
    await user.tab()
    await waitFor(() => expect(settings.posts.at(-1)).toEqual({ "fake.intervalSeconds": 30 }))
  })

  it("checks the range before sending", async () => {
    const { user, section, settings } = await openFakeSection()
    const field = within(section).getByLabelText("Interval")
    await user.clear(field)
    await user.type(field, "2{Enter}")
    expect(await within(section).findByText("Enter a whole number from 5 to 3600.")).toBeInTheDocument()
    expect(field).toBeInvalid()
    expect(settings.posts).toEqual([])
  })

  it("shows the main process's message for this field and keeps what was typed", async () => {
    const { user, section } = await openFakeSection({
      validate: { "fake.intervalSeconds": () => "must be a multiple of 5" },
    })
    const field = within(section).getByLabelText("Interval")
    await user.clear(field)
    await user.type(field, "33{Enter}")
    expect(await within(section).findByText("must be a multiple of 5")).toBeInTheDocument()
    expect(field).toHaveValue(33)
    expect(field).toHaveAccessibleDescription(/must be a multiple of 5/)
  })

  it("goes back to the saved value on Escape", async () => {
    const { user, section, settings } = await openFakeSection()
    const field = within(section).getByLabelText("Interval")
    await user.clear(field)
    await user.type(field, "99{Escape}")
    expect(field).toHaveValue(60)
    expect(settings.posts).toEqual([])
  })
})

describe("text row", () => {
  it("saves the text, and null when it is emptied", async () => {
    const { user, section, settings } = await openFakeSection({
      values: { ...DEFAULTS, "fake.name": "Old" },
    })
    const field = within(section).getByLabelText("Name")
    await user.clear(field)
    await user.type(field, "  New name {Enter}")
    await waitFor(() => expect(settings.posts).toEqual([{ "fake.name": "New name" }]))
    await user.clear(field)
    await user.tab()
    await waitFor(() => expect(settings.posts.at(-1)).toEqual({ "fake.name": null }))
  })

  it("does not send an unchanged value", async () => {
    const { user, section, settings } = await openFakeSection({
      values: { ...DEFAULTS, "fake.name": "Same" },
    })
    const field = within(section).getByLabelText("Name")
    await user.type(field, "x{Backspace}")
    await user.tab()
    expect(settings.posts).toEqual([])
  })
})

describe("hotkey row", () => {
  it("records the next key combination as an Electron accelerator", async () => {
    const { user, section, settings } = await openFakeSection()
    const button = within(section).getByRole("button", { name: /^Shortcut/ })
    await user.click(button)
    expect(button).toHaveTextContent("Press a shortcut…")
    await user.keyboard("{Control>}{Shift>}o{/Shift}{/Control}")
    await waitFor(() => expect(settings.posts).toEqual([{ "fake.hotkey": "CommandOrControl+Shift+O" }]))
    expect(await within(section).findByRole("button", { name: /^Shortcut/ })).toHaveTextContent("Ctrl")
    expect(within(section).getByRole("button", { name: /^Shortcut/ })).toHaveTextContent("Shift")
  })

  it("asks for a modifier instead of taking a bare letter", async () => {
    const { user, section, settings } = await openFakeSection()
    await user.click(within(section).getByRole("button", { name: /^Shortcut/ }))
    await user.keyboard("o")
    expect(await within(section).findByText(/Hold Ctrl or Alt/)).toBeInTheDocument()
    expect(settings.posts).toEqual([])
  })

  it("accepts a function key alone, cancels on Escape and clears", async () => {
    const { user, section, settings } = await openFakeSection({
      values: { ...DEFAULTS, "fake.hotkey": "CommandOrControl+Alt+K" },
    })
    await user.click(within(section).getByRole("button", { name: /^Shortcut/ }))
    expect(within(section).getByRole("button", { name: /^Shortcut/ })).toHaveTextContent("Press a shortcut…")
    await user.keyboard("{Escape}")
    expect(within(section).getByRole("button", { name: /^Shortcut/ })).not.toHaveTextContent("Press a shortcut…")
    expect(settings.posts).toEqual([])

    await user.click(within(section).getByRole("button", { name: /^Shortcut/ }))
    fireEvent.keyDown(within(section).getByRole("button", { name: /^Shortcut/ }), { key: "F9", code: "F9" })
    await waitFor(() => expect(settings.posts).toEqual([{ "fake.hotkey": "F9" }]))

    await user.click(await within(section).findByRole("button", { name: "Clear shortcut" }))
    await waitFor(() => expect(settings.posts.at(-1)).toEqual({ "fake.hotkey": null }))
    expect(await within(section).findByRole("button", { name: /Record shortcut/ })).toHaveAccessibleName(/^Shortcut/)
  })

  it("shows the main process's message when the shortcut is taken", async () => {
    const { user, section } = await openFakeSection({
      validate: { "fake.hotkey": () => "already used by another application" },
    })
    await user.click(within(section).getByRole("button", { name: /^Shortcut/ }))
    await user.keyboard("{Alt>}j{/Alt}")
    expect(await within(section).findByText("already used by another application")).toBeInTheDocument()
  })
})

describe("hotkey helpers", () => {
  const key = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) =>
    captureHotkey({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })

  it("builds accelerators from the physical key", () => {
    expect(key("KeyO", { ctrlKey: true, shiftKey: true })).toEqual({
      kind: "accelerator",
      accelerator: "CommandOrControl+Shift+O",
    })
    expect(key("Digit5", { altKey: true })).toEqual({ kind: "accelerator", accelerator: "Alt+5" })
    expect(key("ArrowUp", { ctrlKey: true })).toEqual({ kind: "accelerator", accelerator: "CommandOrControl+Up" })
    expect(key("F12")).toEqual({ kind: "accelerator", accelerator: "F12" })
    expect(key("Numpad3", { ctrlKey: true })).toEqual({ kind: "accelerator", accelerator: "CommandOrControl+num3" })
  })

  it("refuses bare keys, bare shift, modifiers alone and unknown keys", () => {
    expect(key("KeyO").kind).toBe("needs-modifier")
    expect(key("KeyO", { shiftKey: true }).kind).toBe("needs-modifier")
    expect(key("ControlLeft", { ctrlKey: true }).kind).toBe("modifier-only")
    expect(key("MediaPlayPause", { ctrlKey: true }).kind).toBe("unsupported")
  })

  it("displays an accelerator as keys", () => {
    expect(hotkeyParts("CommandOrControl+Shift+Up")).toEqual(["Ctrl", "Shift", "↑"])
  })
})
