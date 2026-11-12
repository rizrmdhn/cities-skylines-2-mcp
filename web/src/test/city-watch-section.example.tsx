import { EyeIcon } from "lucide-react"

import { FieldGroup } from "@/components/ui/field"
import { defineSettingsSection } from "@/features/settings/define-section"
import { NumberRow, SwitchRow } from "@/features/settings/fields"
import { useSetting } from "@/features/settings/use-settings"

function CityWatchSettings() {
  // The fallback gives the type and is what the row shows until the settings have loaded.
  const enabled = useSetting("city-watch.enabled", true)
  const interval = useSetting("city-watch.intervalSeconds", 60)
  return (
    <FieldGroup>
      <SwitchRow setting={enabled} label="Watch the city" description="Poll the bridge in the background." />
      <NumberRow
        setting={interval}
        label="Check every"
        description="How often the city is polled."
        min={5}
        max={3600}
        unit="seconds"
        disabled={!enabled.value}
      />
    </FieldGroup>
  )
}

export default defineSettingsSection({
  id: "city-watch", // the desktop feature's id
  title: "City watch",
  description: "Background polling of the city.",
  icon: EyeIcon,
  component: CityWatchSettings,
})
