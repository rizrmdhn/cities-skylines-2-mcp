import { PictureInPicture2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { hotkeyParts } from "@/features/settings/hotkey"
import { useOverlay } from "@/lib/overlay"

/**
 * Header button of the desktop app: shows or hides the always-on-top overlay window. Not rendered
 * in the browser companion or when the overlay is turned off in the settings.
 */
export function OverlayButton() {
  const { available, status, toggle } = useOverlay()
  if (!available || !status?.present || !status.enabled) return null

  const verb = status.open ? "Hide overlay" : "Show overlay"
  const hotkey = status.hotkey && status.hotkeyRegistered ? ` (${hotkeyParts(status.hotkey).join("+")})` : ""
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={status.open ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={verb}
            aria-pressed={status.open}
            disabled={toggle.isPending}
            onClick={() => toggle.mutate()}
          />
        }
      >
        <PictureInPicture2Icon />
      </TooltipTrigger>
      <TooltipContent>
        {verb}
        {hotkey}
      </TooltipContent>
    </Tooltip>
  )
}
