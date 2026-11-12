import { createFileRoute } from "@tanstack/react-router"

import { WaitingForCity } from "@/components/waiting-for-city"
import { SpendingCard } from "@/features/activity/spending-card"
import { CityCard } from "@/features/dashboard/city-card"
import { DemandCard } from "@/features/dashboard/demand-card"
import { HappinessCard } from "@/features/dashboard/happiness-card"
import { RecentActivityCard } from "@/features/dashboard/recent-activity-card"
import { ServicesCard } from "@/features/dashboard/services-card"
import { WarningsCard } from "@/features/dashboard/warnings-card"
import { useConnection } from "@/lib/connection"

export const Route = createFileRoute("/")({
  component: DashboardPage,
})

function DashboardPage() {
  const connection = useConnection()
  if (!connection.ready) return <WaitingForCity />

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 p-4 lg:grid-cols-3">
      <CityCard className="lg:col-span-2" />
      <SpendingCard />
      <ServicesCard className="lg:col-span-3" />
      <HappinessCard />
      <WarningsCard />
      <DemandCard />
      <RecentActivityCard className="lg:col-span-3" />
    </div>
  )
}
