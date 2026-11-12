import { useQuery } from "@tanstack/react-query"
import { BellOffIcon } from "lucide-react"

import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  notificationTypes,
  type NotificationGroup,
} from "@/features/dashboard/service-status"
import { formatNumber } from "@/lib/format"
import { notificationsQuery } from "@/lib/queries"

const GROUP_LABELS: Record<NotificationGroup, string> = {
  disaster: "Disaster",
  traffic: "Traffic",
  fire: "Fire",
  electricity: "Electricity",
  sewage: "Sewage",
  water: "Water",
  garbage: "Garbage",
  healthcare: "Health",
  police: "Crime",
  education: "Education",
  other: "Other",
}

const SHOWN = 12

/** Every in-world warning icon type with its count, most frequent first. */
export function WarningsCard({ className }: { className?: string }) {
  const notifications = useQuery(notificationsQuery())
  const types = notificationTypes(notifications.data)
  const shown = types.slice(0, SHOWN)
  const hidden = types.length - shown.length

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Warnings</CardTitle>
        <CardDescription>The warning icons over buildings and roads in the city</CardDescription>
        {notifications.data && (
          <CardAction>
            <Badge variant={notifications.data.total > 0 ? "outline" : "secondary"}>
              {formatNumber(notifications.data.total)} total
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {notifications.isError ? (
          <QueryError title="Could not load warnings" error={notifications.error} />
        ) : !notifications.data ? (
          <Skeleton className="h-40" />
        ) : types.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellOffIcon />
              </EmptyMedia>
              <EmptyTitle>No warnings</EmptyTitle>
              <EmptyDescription>Nothing in the city shows a warning icon right now.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul aria-label="Warning types" className="flex flex-col gap-2">
            {shown.map((item) => (
              <li key={item.type} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate" title={item.type}>
                  {item.label}
                </span>
                <Badge variant="ghost">{GROUP_LABELS[item.group]}</Badge>
                <span className="w-12 text-end font-medium tabular-nums">
                  {formatNumber(item.count)}
                </span>
              </li>
            ))}
            {hidden > 0 && (
              <li className="text-sm text-muted-foreground">
                and {hidden} more {hidden === 1 ? "type" : "types"}
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
