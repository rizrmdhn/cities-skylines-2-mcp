import { useQuery } from "@tanstack/react-query"

import { QueryError } from "@/components/query-error"
import { StatList } from "@/components/stat-list"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { humanizeName } from "@/features/dashboard/service-status"
import type { HappinessFactor } from "@/lib/bridge-types"
import { happinessQuery } from "@/lib/queries"

/** CitizenHappinessSystem.HappinessFactor names as the city info panel words them. */
const FACTOR_LABELS: Record<string, string> = {
  Telecom: "Telecom coverage",
  Crime: "Crime",
  AirPollution: "Air pollution",
  Apartment: "Housing quality",
  Electricity: "Electricity supply",
  Healthcare: "Healthcare",
  GroundPollution: "Ground pollution",
  NoisePollution: "Noise pollution",
  Water: "Water supply",
  WaterPollution: "Water pollution",
  Sewage: "Sewage",
  Garbage: "Garbage",
  Entertainment: "Entertainment",
  Education: "Education",
  Mail: "Mail",
  Welfare: "Welfare",
  Leisure: "Leisure",
  Tax: "Taxes",
  Buildings: "Building happiness",
  Consumption: "Consumption",
  TrafficPenalty: "Traffic",
  DeathPenalty: "Deaths",
  Homelessness: "Homelessness",
  ElectricityFee: "Electricity fee",
  WaterFee: "Water fee",
  Unemployment: "Unemployment",
}

export function factorLabel(factor: string) {
  return FACTOR_LABELS[factor] ?? humanizeName(factor)
}

const signed = (value: number) => (value > 0 ? `+${value}` : `${value}`)

/** Diverging bar: hurts to the left of the centre line, helps to the right. */
function FactorRow({ factor, max }: { factor: HappinessFactor; max: number }) {
  const width = `${(Math.abs(factor.value) / max) * 50}%`
  const label = factorLabel(factor.factor)
  return (
    <li className="flex flex-col gap-1" aria-label={`${label} ${signed(factor.value)}`}>
      <div className="flex items-baseline gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span
          className={
            factor.value < 0 ? "font-medium tabular-nums text-destructive" : "font-medium tabular-nums"
          }
        >
          {signed(factor.value)}
        </span>
      </div>
      <div aria-hidden className="relative h-1.5 rounded-full bg-muted">
        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
        <div
          className={
            factor.value < 0
              ? "absolute inset-y-0 right-1/2 rounded-l-full bg-destructive"
              : "absolute inset-y-0 left-1/2 rounded-r-full bg-primary"
          }
          style={{ width }}
        />
      </div>
      <span className="text-xs text-muted-foreground">
        wellbeing {signed(factor.wellbeing)} · health {signed(factor.health)}
      </span>
    </li>
  )
}

export function HappinessCard({ className }: { className?: string }) {
  const happiness = useQuery(happinessQuery())
  const data = happiness.data
  const max = Math.max(1, ...(data?.factors.map((factor) => Math.abs(factor.value)) ?? []))
  const hurting = data?.factors.filter((factor) => factor.value < 0) ?? []
  const helping = data?.factors.filter((factor) => factor.value > 0).reverse() ?? []

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Happiness</CardTitle>
        <CardDescription>
          What raises and lowers citizen happiness, as the city info panel shows it
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {happiness.isError ? (
          <QueryError title="Could not load happiness" error={happiness.error} />
        ) : !data ? (
          <Skeleton className="h-48" />
        ) : (
          <>
            <StatList
              stats={[
                { label: "Average happiness", value: `${data.averageHappiness}%` },
                { label: "Average health", value: `${data.averageHealth}%` },
              ]}
            />
            <Separator />
            {data.factors.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No factors yet. They appear once the simulation has run for a while.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {hurting.length > 0 && (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-medium text-muted-foreground">Lowering happiness</h3>
                    <ul aria-label="Lowering happiness" className="flex flex-col gap-3">
                      {hurting.map((factor) => (
                        <FactorRow key={factor.factor} factor={factor} max={max} />
                      ))}
                    </ul>
                  </section>
                )}
                {helping.length > 0 && (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-medium text-muted-foreground">Raising happiness</h3>
                    <ul aria-label="Raising happiness" className="flex flex-col gap-3">
                      {helping.map((factor) => (
                        <FactorRow key={factor.factor} factor={factor} max={max} />
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
