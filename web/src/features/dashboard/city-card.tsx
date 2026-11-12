import { useQuery } from "@tanstack/react-query"
import { PauseIcon, PlayIcon } from "lucide-react"

import { QueryError } from "@/components/query-error"
import { StatList } from "@/components/stat-list"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatMoney, formatNumber } from "@/lib/format"
import { overviewQuery } from "@/lib/queries"
import { speedLabel } from "@/lib/simulation"

export function CityCard({ className }: { className?: string }) {
  const overview = useQuery(overviewQuery())
  const city = overview.data

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{city ? city.cityName || "Unnamed city" : <Skeleton className="h-5 w-40" />}</CardTitle>
        <CardDescription>
          {city ? city.gameDateTime ?? "Game date unavailable" : <Skeleton className="h-4 w-28" />}
        </CardDescription>
        {city && (
          <CardAction>
            <Badge variant={city.simulationPaused ? "outline" : "secondary"}>
              {city.simulationPaused ? (
                <PauseIcon data-icon="inline-start" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {speedLabel(city.simulationPaused, city.simulationSpeed)}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {overview.isError ? (
          <QueryError title="Could not load the city overview" error={overview.error} />
        ) : city ? (
          <StatList
            stats={[
              {
                label: "Population",
                value: formatNumber(city.population),
                detail:
                  city.populationWithMoveIn > city.population
                    ? `${formatNumber(city.populationWithMoveIn)} with move-ins`
                    : undefined,
              },
              { label: "Money", value: formatMoney(city.money) },
              { label: "XP", value: formatNumber(city.xp) },
            ]}
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
