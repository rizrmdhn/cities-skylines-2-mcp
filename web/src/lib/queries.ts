import { keepPreviousData, QueryClient, queryOptions } from "@tanstack/react-query"

import { ApiError, apiGet } from "@/lib/api"
import type {
  Camera,
  CityOverview,
  Coverage,
  Demand,
  GameState,
  GridLayer,
  GridMap,
  Happiness,
  History,
  Infoview,
  InfoviewName,
  Notifications,
  Ping,
  RoadGraph,
  RoadNetworkPayload,
  Services,
  Traffic,
} from "@/lib/bridge-types"
import { tileArea, type RoadTile } from "@/lib/world"

/** Most entries the bridge returns; the activity page and the map markers share this query. */
export const HISTORY_LIMIT = 300

export const queryKeys = {
  ping: ["ping"] as const,
  state: ["state"] as const,
  overview: ["city", "overview"] as const,
  demand: ["city", "demand"] as const,
  history: ["history", HISTORY_LIMIT] as const,
  camera: ["camera"] as const,
  services: ["city", "services"] as const,
  coverage: ["city", "coverage"] as const,
  traffic: ["city", "traffic"] as const,
  notifications: ["city", "notifications"] as const,
  happiness: ["city", "happiness"] as const,
  gridmap: (layer: GridLayer) => ["city", "gridmap", layer] as const,
  infoview: (view: InfoviewName) => ["city", "infoview", view] as const,
  roadNetwork: ["city", "road-network"] as const,
  roadTiles: ["city", "road-tile"] as const,
  roadTile: (tile: RoadTile) => ["city", "road-tile", tile.tx, tile.tz] as const,
}

export const pingQuery = () =>
  queryOptions({
    queryKey: queryKeys.ping,
    queryFn: ({ signal }) => apiGet<Ping>("/ping", {}, signal),
    refetchInterval: 3_000,
    // ping is polled anyway; a failed ping is the "unreachable" state, not something to retry
    retry: false,
  })

export const stateQuery = () =>
  queryOptions({
    queryKey: queryKeys.state,
    queryFn: ({ signal }) => apiGet<GameState>("/state", {}, signal),
    refetchInterval: 5_000,
  })

export const overviewQuery = () =>
  queryOptions({
    queryKey: queryKeys.overview,
    queryFn: ({ signal }) => apiGet<CityOverview>("/city/overview", {}, signal),
    refetchInterval: 5_000,
  })

export const demandQuery = () =>
  queryOptions({
    queryKey: queryKeys.demand,
    queryFn: ({ signal }) => apiGet<Demand>("/city/demand", {}, signal),
    refetchInterval: 15_000,
  })

export const historyQuery = () =>
  queryOptions({
    queryKey: queryKeys.history,
    queryFn: ({ signal }) =>
      apiGet<History>("/history", { limit: HISTORY_LIMIT }, signal),
    refetchInterval: 5_000,
  })

export const cameraQuery = (follow: boolean) =>
  queryOptions({
    queryKey: queryKeys.camera,
    queryFn: ({ signal }) => apiGet<Camera>("/camera", {}, signal),
    refetchInterval: follow ? 1_000 : 5_000,
  })

/** Not polled: a grid can hold hundreds of thousands of values and is read on the game's main thread. */
export const gridmapQuery = (layer: GridLayer) =>
  queryOptions({
    queryKey: queryKeys.gridmap(layer),
    queryFn: ({ signal }) => apiGet<GridMap>("/city/gridmap", { layer }, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })

export const servicesQuery = () =>
  queryOptions({
    queryKey: queryKeys.services,
    queryFn: ({ signal }) => apiGet<Services>("/city/services", {}, signal),
    refetchInterval: 15_000,
  })

/** Walks every zoned building on the game's main thread: polled slowly, without gap clusters. */
export const coverageQuery = () =>
  queryOptions({
    queryKey: queryKeys.coverage,
    queryFn: ({ signal }) => apiGet<Coverage>("/city/coverage", { gaps: 0 }, signal),
    refetchInterval: 30_000,
  })

export const trafficQuery = () =>
  queryOptions({
    queryKey: queryKeys.traffic,
    queryFn: ({ signal }) => apiGet<Traffic>("/city/traffic", { limit: 1 }, signal),
    refetchInterval: 30_000,
  })

/** Only the counts per type are used, so ask for a single sample item. */
export const notificationsQuery = () =>
  queryOptions({
    queryKey: queryKeys.notifications,
    queryFn: ({ signal }) => apiGet<Notifications>("/city/notifications", { limit: 1 }, signal),
    refetchInterval: 15_000,
  })

export const happinessQuery = () =>
  queryOptions({
    queryKey: queryKeys.happiness,
    queryFn: ({ signal }) => apiGet<Happiness>("/city/happiness", {}, signal),
    refetchInterval: 30_000,
  })

/** Only fetched while its accordion item is open; the panel is recalculated on each request. */
export const infoviewQuery = (view: InfoviewName) =>
  queryOptions({
    queryKey: queryKeys.infoview(view),
    queryFn: ({ signal }) => apiGet<Infoview>("/city/infoview", { view }, signal),
    refetchInterval: 30_000,
  })

/**
 * The whole road network in one request. Roads change rarely: it stays fresh for 5 minutes and
 * is dropped when a change goes through the bridge or the user reloads it.
 */
export const roadNetworkQuery = () =>
  queryOptions({
    queryKey: queryKeys.roadNetwork,
    queryFn: ({ signal }) => apiGet<RoadNetworkPayload>("/city/road-network", {}, signal),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  })

/** Roads change rarely: a tile stays fresh for 5 minutes and cached for 30. */
export const ROAD_TILE_STALE_MS = 5 * 60_000

export const roadTileQuery = (tile: RoadTile) =>
  queryOptions({
    queryKey: queryKeys.roadTile(tile),
    queryFn: ({ signal }) => {
      const area = tileArea(tile)
      return apiGet<RoadGraph>(
        "/city/road-graph",
        { x: area.x, z: area.z, radius: area.radius, limit: 3_000 },
        signal
      )
    },
    staleTime: ROAD_TILE_STALE_MS,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  })

/** Retry only while the bridge is unreachable; a 4xx from the bridge will not change by asking again. */
export function shouldRetry(failureCount: number, error: unknown) {
  return error instanceof ApiError && error.kind === "unreachable" && failureCount < 3
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
        refetchIntervalInBackground: false,
      },
    },
  })
}
