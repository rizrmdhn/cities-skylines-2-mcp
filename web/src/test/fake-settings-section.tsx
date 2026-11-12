import { BellIcon } from "lucide-react"

import { FieldGroup } from "@/components/ui/field"
import { defineSettingsSection } from "@/features/settings/define-section"
import { HotkeyRow, NumberRow, SelectRow, SwitchRow, TextRow } from "@/features/settings/fields"
import { useSetting } from "@/features/settings/use-settings"

/** What a real feature's sections/<id>.tsx looks like, for the registry tests ("fake" is its feature id). */
function FakeSettings() {
  const enabled = useSetting("fake.enabled", false)
  const mode = useSetting<"quiet" | "loud">("fake.mode", "quiet")
  const interval = useSetting("fake.intervalSeconds", 60)
  const name = useSetting<string | null>("fake.name", null)
  const hotkey = useSetting<string | null>("fake.hotkey", null)
  return (
    <FieldGroup>
      <SwitchRow setting={enabled} label="Enable fake" description="Turns the fake feature on." />
      <SelectRow
        setting={mode}
        label="Mode"
        options={[
          { value: "quiet", label: "Quiet" },
          { value: "loud", label: "Loud" },
        ]}
      />
      <NumberRow setting={interval} label="Interval" min={5} max={3600} unit="s" />
      <TextRow setting={name} label="Name" placeholder="Unnamed" />
      <HotkeyRow setting={hotkey} label="Shortcut" />
    </FieldGroup>
  )
}

export default defineSettingsSection({
  id: "fake",
  title: "Fake feature",
  description: "A section registered by the tests.",
  icon: BellIcon,
  component: FakeSettings,
})

/** A section whose component throws, to see that the page survives it. */
export const broken = defineSettingsSection({
  id: "broken",
  title: "Broken feature",
  component: () => {
    throw new Error("section exploded")
  },
})
