import { CircleCheckIcon, CircleXIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { HistoryEntry } from "@/lib/bridge-types"

export function ResultBadge({ entry }: { entry: HistoryEntry }) {
  return entry.ok ? (
    <Badge variant="secondary">
      <CircleCheckIcon data-icon="inline-start" />
      Done
    </Badge>
  ) : (
    <Badge variant="destructive">
      <CircleXIcon data-icon="inline-start" />
      Failed {entry.status}
    </Badge>
  )
}
