import { PanelBottomIcon } from "lucide-react"

import { FieldGroup } from "@/components/ui/field"
import { defineSettingsSection } from "@/features/settings/define-section"
import { SwitchRow } from "@/features/settings/fields"
import { useSetting } from "@/features/settings/use-settings"

function TraySettings() {
  const closeToTray = useSetting("tray.closeToTray", true)
  return (
    <FieldGroup>
      <SwitchRow
        setting={closeToTray}
        label="Keep running in the tray when the window is closed"
        description="Closing the window hides it and the app keeps watching the game from the system tray (left-click the tray icon to show or hide the window, right-click for the menu). Turn this off to quit when the window is closed. Quit from the tray menu always exits."
      />
    </FieldGroup>
  )
}

export default defineSettingsSection({
  id: "tray",
  title: "System tray",
  description: "The tray icon shows the connection to the game and has pause and speed controls.",
  icon: PanelBottomIcon,
  component: TraySettings,
})
