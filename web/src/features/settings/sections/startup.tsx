import { PowerIcon } from "lucide-react"

import { FieldGroup } from "@/components/ui/field"
import { defineSettingsSection } from "@/features/settings/define-section"
import { SwitchRow } from "@/features/settings/fields"
import { useSetting } from "@/features/settings/use-settings"
import { useStartupStatus } from "@/lib/startup"

const SYSTEM_NOTES: Record<string, string> = {
  "disabled-in-windows": "Windows has it switched off under Task Manager > Startup apps; turning this on switches it back on.",
  "other-arguments": "The entry in Windows used other arguments and is rewritten at the next start.",
}

function StartupSettings() {
  const openAtLogin = useSetting("startup.openAtLogin", false)
  const startHidden = useSetting("startup.startHidden", true)
  const status = useStartupStatus()

  // Until the status has loaded the rows look enabled; the desktop app refuses a change anyway.
  const unsupported = status !== undefined && !status.supported
  const note = status?.system ? SYSTEM_NOTES[status.system] : undefined
  return (
    <FieldGroup>
      <SwitchRow
        setting={openAtLogin}
        disabled={unsupported}
        label="Start with Windows"
        description={
          unsupported
            ? (status.reason ?? "Not available here.")
            : `Start the companion when you sign in to Windows. The tray menu has the same switch.${note ? ` ${note}` : ""}`
        }
      />
      <SwitchRow
        setting={startHidden}
        disabled={unsupported}
        label="Start in the tray"
        description="At sign-in the companion starts without a window and waits in the system tray. Open it from the tray icon, or let game detection bring it forward when the game starts."
      />
      {status?.error && (
        <p role="alert" className="text-sm text-destructive">
          Windows refused the change: {status.error}
        </p>
      )}
    </FieldGroup>
  )
}

export default defineSettingsSection({
  id: "startup",
  title: "Start with Windows",
  description: "Launch the companion when you sign in, quietly, into the system tray.",
  icon: PowerIcon,
  component: StartupSettings,
})
