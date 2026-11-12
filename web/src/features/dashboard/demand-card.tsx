import { useQuery } from "@tanstack/react-query"

import { QueryError } from "@/components/query-error"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import type { Demand } from "@/lib/bridge-types"
import { demandQuery } from "@/lib/queries"

/** The game's building demand runs 0-255. */
const DEMAND_MAX = 255

function demandRows(demand: Demand) {
  return [
    { label: "Residential, low density", value: demand.residential.buildingDemand.lowDensity },
    { label: "Residential, medium density", value: demand.residential.buildingDemand.mediumDensity },
    { label: "Residential, high density", value: demand.residential.buildingDemand.highDensity },
    { label: "Commercial", value: demand.commercial.buildingDemand },
    { label: "Industrial", value: demand.industrial.buildingDemand },
    { label: "Office", value: demand.office.buildingDemand },
  ]
}

export function DemandCard({ className }: { className?: string }) {
  const demand = useQuery(demandQuery())

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Zone demand</CardTitle>
        <CardDescription>
          Building demand on the game's 0 to 255 scale. Refreshes only while the simulation runs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {demand.isError ? (
          <QueryError title="Could not load demand" error={demand.error} />
        ) : demand.data ? (
          <div className="flex flex-col gap-3">
            {demandRows(demand.data).map((row) => (
              <Progress
                key={row.label}
                value={Math.min(100, (Math.max(0, row.value) / DEMAND_MAX) * 100)}
                aria-valuetext={`${row.value} of ${DEMAND_MAX}`}
              >
                <ProgressLabel>{row.label}</ProgressLabel>
                <span className="ms-auto text-sm tabular-nums text-muted-foreground">
                  {row.value}
                </span>
              </Progress>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
