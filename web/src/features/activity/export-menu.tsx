import { DownloadIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ExportFormat } from "@/features/activity/run-export"

/** "Export" button with a Markdown and a JSON entry; `what` says what is exported ("Session 2", "All shown sessions"). */
export function ExportMenu({
  what,
  label = "Export",
  iconOnly = false,
  onExport,
}: {
  what: string
  label?: string
  iconOnly?: boolean
  onExport: (format: ExportFormat) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size={iconOnly ? "icon-sm" : "sm"}
            aria-label={iconOnly ? `${label} ${what}` : undefined}
          />
        }
      >
        <DownloadIcon data-icon={iconOnly ? undefined : "inline-start"} />
        {!iconOnly && label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{what}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onExport("md")}>Markdown report (.md)</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onExport("json")}>JSON, all details (.json)</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
