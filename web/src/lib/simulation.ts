import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiControl } from "@/lib/api"
import type { CityOverview, GameState } from "@/lib/bridge-types"
import { queryKeys } from "@/lib/queries"

/** The bridge's maximum speed (POST /sim/control clamps to 0..8); the game's own UI stops at 4. */
export const MAX_SPEED = 8
/** Fastest speed of the game's own speed controls. */
export const GAME_MAX_SPEED = 4

export interface SpeedChoice {
  speed: number
  label: string
  description: string
}

export const SPEED_CHOICES: readonly SpeedChoice[] = [
  { speed: 1, label: "1×", description: "Normal speed" },
  { speed: 2, label: "2×", description: "Double speed" },
  { speed: GAME_MAX_SPEED, label: "4×", description: "The game's own fastest speed" },
  {
    speed: MAX_SPEED,
    label: "8×",
    description:
      "Maximum: twice the game's fastest speed (4×), beyond what the in-game controls offer. Large cities may not keep up.",
  },
]

/** "2×", "0.5×" */
export function formatSpeed(speed: number) {
  return `${Number(speed.toFixed(2))}×`
}

/** The city card badge: "Paused", "2× speed", "8× speed (max)". */
export function speedLabel(paused: boolean, speed: number) {
  if (paused) return "Paused"
  return `${formatSpeed(speed)} speed${speed >= MAX_SPEED ? " (max)" : ""}`
}

/** One /sim/control call: a speed (0 pauses) and/or paused. */
export interface SimulationChange {
  speed?: number
  paused?: boolean
}

/** Answer of POST /sim/control. */
export interface SimulationControlResult {
  paused: boolean
  selectedSpeed: number
}

/** What the bridge does with a change (RequestHandlers.SimControl): speed first, then paused. */
export function applySimulationChange(
  current: SimulationControlResult,
  change: SimulationChange
): SimulationControlResult {
  let speed = current.selectedSpeed
  if (change.speed !== undefined) speed = Math.min(Math.max(change.speed, 0), MAX_SPEED)
  if (change.paused === true) speed = 0
  else if (change.paused === false && speed <= 0) speed = 1
  return { paused: speed <= 0, selectedSpeed: speed }
}

export function setSimulation(change: SimulationChange, signal?: AbortSignal) {
  return apiControl<SimulationControlResult>("/sim/control", { ...change }, signal)
}

interface Snapshot {
  state: GameState | undefined
  overview: CityOverview | undefined
}

/**
 * Pauses, resumes or changes the speed. The new state shows at once in /state and /city/overview
 * (header controls and city card), is rolled back with an error toast if the call fails, and both
 * queries are refetched afterwards either way.
 */
export function useSimulationControl() {
  const queryClient = useQueryClient()

  function write(result: SimulationControlResult) {
    queryClient.setQueryData<GameState>(queryKeys.state, (state) =>
      state?.simulation
        ? {
            ...state,
            simulation: {
              ...state.simulation,
              paused: result.paused,
              selectedSpeed: result.selectedSpeed,
            },
          }
        : state
    )
    queryClient.setQueryData<CityOverview>(queryKeys.overview, (overview) =>
      overview
        ? { ...overview, simulationPaused: result.paused, simulationSpeed: result.selectedSpeed }
        : overview
    )
  }

  return useMutation<SimulationControlResult, Error, SimulationChange, Snapshot>({
    mutationKey: ["sim", "control"],
    mutationFn: (change) => setSimulation(change),
    onMutate: async (change) => {
      // A poll landing after the optimistic write would show the old state for a moment.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.state }),
        queryClient.cancelQueries({ queryKey: queryKeys.overview }),
      ])
      const snapshot: Snapshot = {
        state: queryClient.getQueryData<GameState>(queryKeys.state),
        overview: queryClient.getQueryData<CityOverview>(queryKeys.overview),
      }
      const simulation = snapshot.state?.simulation
      if (simulation) write(applySimulationChange(simulation, change))
      return snapshot
    },
    onSuccess: (result) => write(result),
    onError: (error, _change, snapshot) => {
      if (snapshot) {
        queryClient.setQueryData(queryKeys.state, snapshot.state)
        queryClient.setQueryData(queryKeys.overview, snapshot.overview)
      }
      toast.error("Could not change the simulation speed", { description: error.message })
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.state }),
        queryClient.invalidateQueries({ queryKey: queryKeys.overview }),
      ]),
  })
}
