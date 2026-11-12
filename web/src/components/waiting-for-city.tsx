import { Building2Icon } from "lucide-react"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

/** Shown instead of city data until a city is loaded; the header alert says why. */
export function WaitingForCity() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Building2Icon />
        </EmptyMedia>
        <EmptyTitle>Waiting for a city</EmptyTitle>
        <EmptyDescription>
          City data appears here as soon as the game has a city loaded.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
