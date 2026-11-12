import { PictureInPicture2Icon } from "lucide-react"

import { FieldGroup } from "@/components/ui/field"
import { defineSettingsSection } from "@/features/settings/define-section"
import { HotkeyRow, NumberRow, SwitchRow } from "@/features/settings/fields"
import { useSetting } from "@/features/settings/use-settings"
import { useOverlay } from "@/lib/overlay"

function OverlaySettings() {
  const enabled = useSetting("overlay.enabled", true)
  const hotkey = useSetting<string | null>("overlay.hotkey", "CommandOrControl+Shift+O")
  const opacity = useSetting("overlay.opacity", 90)
  const clickThrough = useSetting("overlay.clickThrough", false)
  const { status } = useOverlay()

  // The save only checks the format; whether the system grants the shortcut shows up here.
  const hotkeyProblem = enabled.value && hotkey.value ? status?.hotkeyError : null
  return (
    <FieldGroup>
      <SwitchRow
        setting={enabled}
        label="Enable the overlay"
        description="A small always-on-top window with your city at a glance. Open it with the shortcut below, the button in the header or the tray menu. It shows over windowed and borderless-windowed games, not over exclusive fullscreen: set the game to borderless windowed."
      />
      <HotkeyRow
        setting={hotkey}
        disabled={!enabled.value}
        label="Show / hide shortcut"
        description={
          hotkeyProblem ? (
            <span role="alert" className="text-destructive">
              {hotkeyProblem}
            </span>
          ) : (
            "A system-wide shortcut, active while the companion runs, also inside the game. Record a combination with Ctrl, Alt or Shift, or clear it to use only the button and the tray."
          )
        }
      />
      <NumberRow
        setting={opacity}
        label="Opacity"
        description="How see-through the overlay window is, from 30 % (very) to 100 % (solid)."
        min={30}
        max={100}
        step={5}
        unit="%"
        disabled={!enabled.value}
      />
      <SwitchRow
        setting={clickThrough}
        label="Click through the overlay"
        description="Mouse clicks pass through the overlay to the game, so it can never get in the way. While this is on you can neither move it nor use its pause and speed buttons: turn it off here to do that."
        disabled={!enabled.value}
      />
    </FieldGroup>
  )
}

export default defineSettingsSection({
  id: "overlay",
  title: "Overlay",
  description: "An always-on-top mini window to watch your city while you play.",
  icon: PictureInPicture2Icon,
  component: OverlaySettings,
})
