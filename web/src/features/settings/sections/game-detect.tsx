import { GamepadIcon } from "lucide-react"

import { FieldGroup } from "@/components/ui/field"
import { defineSettingsSection } from "@/features/settings/define-section"
import { NumberRow, SelectRow, SwitchRow, TextRow } from "@/features/settings/fields"
import { useSetting } from "@/features/settings/use-settings"
import { describeGameState, useGameDetect } from "@/lib/game-detect"
import { useOverlayAvailable } from "@/lib/overlay"

type ExitAction = "nothing" | "hide" | "quit"

const EXIT_OPTIONS: { value: ExitAction; label: string }[] = [
  { value: "nothing", label: "Do nothing" },
  { value: "hide", label: "Hide to the tray" },
  { value: "quit", label: "Quit the companion" },
]

const PROCESS_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}\.exe$/i

function GameDetectSettings() {
  const enabled = useSetting("gameDetect.enabled", true)
  const interval = useSetting("gameDetect.intervalSeconds", 10)
  const processName = useSetting<string | null>("gameDetect.processName", null)
  const showWindow = useSetting("gameDetect.showWindowOnStart", false)
  const showOverlay = useSetting("gameDetect.showOverlayOnStart", false)
  const onExit = useSetting<ExitAction>("gameDetect.onExit", "nothing")
  const status = useGameDetect()
  const overlayAvailable = useOverlayAvailable()

  const unsupported = status !== undefined && !status.supported
  const off = !enabled.value || unsupported
  return (
    <FieldGroup>
      <SwitchRow
        setting={enabled}
        disabled={unsupported}
        label="Detect the game"
        description={
          <>
            Looks for the game process and asks the bridge now and then, so the companion knows when Cities: Skylines II starts
            and exits.
            {status && (
              <span role="status" className="mt-1 block">
                {describeGameState(status)}
              </span>
            )}
          </>
        }
      />
      <NumberRow
        setting={interval}
        label="Check every"
        description="How often the game is looked for. Checks are three times rarer while this window is open and the game runs."
        min={2}
        max={300}
        unit="seconds"
        disabled={off}
      />
      <TextRow
        setting={processName}
        label="Game process"
        description="The executable to look for; leave empty for Cities2.exe. If the bridge answers while this process is not found, the bridge is trusted."
        placeholder="Cities2.exe"
        validate={(value) => (PROCESS_NAME.test(value) ? undefined : "Enter an executable file name such as Cities2.exe")}
        disabled={off}
      />
      <SwitchRow
        setting={showWindow}
        label="Show the companion when the game starts"
        description="Brings the companion window forward when Cities: Skylines II starts, for instance after starting with Windows. A window that has to be created first may take the keyboard focus from the game."
        disabled={off}
      />
      {overlayAvailable && (
        <SwitchRow
          setting={showOverlay}
          label="Show the overlay when the game starts"
          description="Opens the always-on-top overlay (it must be enabled in the Overlay settings)."
          disabled={off}
        />
      )}
      <SelectRow
        setting={onExit}
        label="When the game exits"
        description="Hiding keeps the companion in the tray (it needs the tray icon) and closes the overlay; quitting exits the app. This only reacts to a game that was seen running while the companion was open."
        options={EXIT_OPTIONS}
        disabled={off}
      />
    </FieldGroup>
  )
}

export default defineSettingsSection({
  id: "game-detect",
  title: "Game detection",
  description: "Notice when Cities: Skylines II starts or exits and react.",
  icon: GamepadIcon,
  component: GameDetectSettings,
})
