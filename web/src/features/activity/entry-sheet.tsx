import { Link } from "@tanstack/react-router"
import { MapPinIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ResultBadge } from "@/features/activity/result-badge"
import type { HistoryEntry } from "@/lib/bridge-types"
import {
  actionLabel,
  formatDateTime,
  formatMoneyDelta,
  prettyJson,
} from "@/lib/format"
import { markerCentre, markerShapeFor } from "@/lib/history-markers"
import { encodeSelection } from "@/lib/selection"

/** Map search for an entry's position: centred on it, with the position selected. */
export function mapSearchFor(entry: HistoryEntry) {
  const shape = markerShapeFor(entry)
  if (!shape) return undefined
  const centre = markerCentre(shape)
  return {
    cx: Math.round(centre.x),
    cz: Math.round(centre.z),
    zoom: 5,
    sel: encodeSelection(
      shape.kind === "point"
        ? { kind: "point", at: shape.at }
        : { kind: "line", from: shape.from, to: shape.to }
    ),
  }
}

export function EntrySheet({
  entry,
  onClose,
}: {
  entry: HistoryEntry | undefined
  onClose: () => void
}) {
  const mapSearch = entry ? mapSearchFor(entry) : undefined
  const params = Object.entries(entry?.query ?? {})

  return (
    <Sheet open={entry !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-lg">
        {entry && (
          <>
            <SheetHeader>
              <SheetTitle className="capitalize">{actionLabel(entry.path)}</SheetTitle>
              <SheetDescription>
                #{entry.id} · {formatDateTime(entry.timeUtc)}
                {entry.gameTime ? ` · in game ${entry.gameTime}` : ""}
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-2">
                <ResultBadge entry={entry} />
                <Badge variant="outline">{formatMoneyDelta(entry.moneyDelta)}</Badge>
                {entry.batchChild && <Badge variant="outline">Part of a batch</Badge>}
                <Badge variant="ghost" className="font-mono">
                  {entry.path}
                </Badge>
              </div>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1 px-4">
              <div className="flex flex-col gap-4 pb-4">
                <section className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">Parameters</h3>
                  {params.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No parameters.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {params.map(([name, value]) => (
                          <TableRow key={name}>
                            <TableCell className="font-mono">{name}</TableCell>
                            <TableCell className="font-mono break-all whitespace-normal">
                              {value}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </section>
                <section className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">Result</h3>
                  <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
                    {entry.result ? prettyJson(entry.result) : "No result recorded."}
                  </pre>
                </section>
              </div>
            </ScrollArea>
            {mapSearch && (
              <SheetFooter>
                <Link to="/map" search={mapSearch} className={buttonVariants()}>
                  <MapPinIcon data-icon="inline-start" />
                  Show on map
                </Link>
              </SheetFooter>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
