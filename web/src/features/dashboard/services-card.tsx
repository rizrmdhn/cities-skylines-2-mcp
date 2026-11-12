import { useQuery } from "@tanstack/react-query"
import {
  BuildingIcon,
  CarIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  DropletIcon,
  FlameIcon,
  GraduationCapIcon,
  HandHeartIcon,
  HeartPulseIcon,
  MailIcon,
  RadioTowerIcon,
  RecycleIcon,
  ShieldIcon,
  TreesIcon,
  WavesIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"

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
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { ServiceDetails } from "@/features/dashboard/service-details"
import {
  serviceRows,
  type ServiceId,
  type ServiceRow,
  type Status,
} from "@/features/dashboard/service-status"
import type { Coverage, Notifications, Traffic } from "@/lib/bridge-types"
import { coverageQuery, notificationsQuery, servicesQuery, trafficQuery } from "@/lib/queries"

const SERVICE_ICONS: Record<ServiceId, LucideIcon> = {
  traffic: CarIcon,
  electricity: ZapIcon,
  water: DropletIcon,
  sewage: WavesIcon,
  garbage: RecycleIcon,
  healthcare: HeartPulseIcon,
  fireRescue: FlameIcon,
  police: ShieldIcon,
  emergencyShelter: BuildingIcon,
  education: GraduationCapIcon,
  post: MailIcon,
  park: TreesIcon,
  welfare: HandHeartIcon,
  telecom: RadioTowerIcon,
}

const STATUS: Record<
  Status,
  { label: string; icon: LucideIcon; variant: "secondary" | "outline" | "destructive" | "ghost" }
> = {
  good: { label: "Good", icon: CircleCheckIcon, variant: "secondary" },
  warning: { label: "Watch", icon: CircleAlertIcon, variant: "outline" },
  problem: { label: "Problem", icon: CircleXIcon, variant: "destructive" },
  unknown: { label: "No data", icon: CircleMinusIcon, variant: "ghost" },
}

export function StatusBadge({ status }: { status: Status }) {
  const { label, icon: Icon, variant } = STATUS[status]
  return (
    <Badge variant={variant}>
      <Icon data-icon="inline-start" />
      {label}
    </Badge>
  )
}

function ServiceSummary({ row }: { row: ServiceRow }) {
  const Icon = SERVICE_ICONS[row.id]
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3 pe-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted [&_svg]:size-4">
        <Icon />
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate">{row.label}</span>
        <StatusBadge status={row.status} />
        {row.warnings > 0 && row.id !== "garbage" && (
          <Badge variant="outline">
            {row.warnings} {row.warnings === 1 ? "warning" : "warnings"}
          </Badge>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <span className="text-base font-semibold tabular-nums">{row.value}</span>
        {row.valueLabel && (
          <span className="text-xs font-normal text-muted-foreground">{row.valueLabel}</span>
        )}
      </span>
    </span>
  )
}

function ServiceAccordion({
  rows,
  coverage,
  traffic,
  notifications,
}: {
  rows: ServiceRow[]
  coverage: Coverage | undefined
  traffic: Traffic | undefined
  notifications: Notifications | undefined
}) {
  return (
    <Accordion multiple>
      {rows.map((row) => (
        <AccordionItem key={row.id} value={row.id}>
          <AccordionTrigger className="items-center hover:no-underline">
            <ServiceSummary row={row} />
          </AccordionTrigger>
          <AccordionContent>
            <ServiceDetails
              row={row}
              coverage={coverage}
              traffic={traffic}
              notifications={notifications}
            />
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}

export function ServicesCard({ className }: { className?: string }) {
  const services = useQuery(servicesQuery())
  const coverage = useQuery(coverageQuery())
  const traffic = useQuery(trafficQuery())
  const notifications = useQuery(notificationsQuery())

  const rows = serviceRows({
    services: services.data,
    coverage: coverage.data,
    traffic: traffic.data,
    notifications: notifications.data,
  })
  const problems = rows.filter((row) => row.status === "problem").length
  const watch = rows.filter((row) => row.status === "warning").length
  const errors = [
    services.error && { title: "Could not load utilities", error: services.error },
    coverage.error && { title: "Could not load service coverage", error: coverage.error },
    traffic.error && { title: "Could not load traffic", error: traffic.error },
    notifications.error && { title: "Could not load warnings", error: notifications.error },
  ].filter((item): item is { title: string; error: Error } => Boolean(item))

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>City services</CardTitle>
        <CardDescription>
          From the game's own numbers: utilities against demand, coverage of zoned buildings and
          the warning icons in each area. Open a service for its in-game panel figures.
        </CardDescription>
        <CardAction className="flex flex-wrap gap-1.5">
          {problems > 0 && <Badge variant="destructive">{problems} need attention</Badge>}
          {watch > 0 && <Badge variant="outline">{watch} to watch</Badge>}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {errors.map((item) => (
          <QueryError key={item.title} title={item.title} error={item.error} />
        ))}
        <div className="grid gap-x-8 xl:grid-cols-2">
          {[rows.slice(0, Math.ceil(rows.length / 2)), rows.slice(Math.ceil(rows.length / 2))].map(
            (half, i) => (
              <ServiceAccordion
                key={i}
                rows={half}
                coverage={coverage.data}
                traffic={traffic.data}
                notifications={notifications.data}
              />
            )
          )}
        </div>
      </CardContent>
    </Card>
  )
}
