import { AlertDialog } from "@base-ui/react/alert-dialog"
import { Trash2Icon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { formatNumber } from "@/lib/format"

/**
 * "Clear data": asks before deleting the recorded history of the shown city, or of all cities.
 * Local to the Trends page on purpose; the shared UI kit has no alert dialog yet.
 */
export function ConfirmClear({
  city,
  cityCount,
  pending,
  onClear,
}: {
  /** The city shown on the page, or null when it has no data. */
  city: { name: string; samples: number } | null
  cityCount: number
  pending: boolean
  onClear: (target: "city" | "all") => void
}) {
  const [open, setOpen] = useState(false)
  const choose = (target: "city" | "all") => {
    setOpen(false)
    onClear(target)
  }
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger
        render={<Button variant="outline" size="sm" disabled={pending || cityCount === 0} />}
      >
        <Trash2Icon data-icon="inline-start" />
        Clear data…
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/20 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-popover p-5 text-sm text-popover-foreground shadow-lg transition duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0">
          <div className="flex flex-col gap-1.5">
            <AlertDialog.Title className="font-heading text-base font-semibold">
              Delete trend history?
            </AlertDialog.Title>
            <AlertDialog.Description className="text-muted-foreground">
              {city
                ? `This removes the ${formatNumber(city.samples)} recorded samples of ${city.name} from this computer. It cannot be undone; recording continues afterwards.`
                : `This removes the recorded history of every city from this computer. It cannot be undone.`}
            </AlertDialog.Description>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialog.Close render={<Button variant="outline" size="sm" />}>Cancel</AlertDialog.Close>
            {city && cityCount > 1 && (
              <Button variant="destructive" size="sm" onClick={() => choose("all")}>
                Delete all {cityCount} cities
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={() => choose(city ? "city" : "all")}>
              {city ? `Delete ${city.name}` : "Delete everything"}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
