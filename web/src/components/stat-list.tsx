import type { ReactNode } from "react"

export interface Stat {
  label: string
  value: ReactNode
  detail?: ReactNode
}

/** Label/value pairs in a responsive grid. */
export function StatList({ stats }: { stats: Stat[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
      {stats.map((stat) => (
        <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{stat.label}</dt>
          <dd className="truncate text-lg font-semibold tabular-nums">{stat.value}</dd>
          {stat.detail && (
            <dd className="truncate text-xs text-muted-foreground">{stat.detail}</dd>
          )}
        </div>
      ))}
    </dl>
  )
}
