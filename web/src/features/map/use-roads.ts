import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query"
import { useMemo } from "react"

import { ApiError } from "@/lib/api"
import type { RoadGraph, RoadNetworkPayload } from "@/lib/bridge-types"
import { roadNetworkQuery, roadTileQuery } from "@/lib/queries"
import type { RoadTile } from "@/lib/world"

/** A road segment for drawing: start, the curve's midpoint and end, plus flow (null = not a road). */
export interface RoadShape {
  sx: number
  sz: number
  mx: number
  mz: number
  ex: number
  ez: number
  flow: number | null
}

export interface RoadJunction {
  x: number
  z: number
  trafficLights: boolean
  roundabout: boolean
  outsideConnection: boolean
}

export interface RoadNetwork {
  roads: readonly RoadShape[]
  junctions: readonly RoadJunction[]
}

export interface Roads {
  /** "network": the whole city from /city/road-network; "tiles": per-area fallback for older mods. */
  source: "network" | "tiles"
  network: RoadNetwork | undefined
  fetching: boolean
  error: Error | null
  /** Tiles where the bridge returned fewer roads than it matched (tiles source only). */
  truncated: number
}

const FLAG_TRAFFIC_LIGHTS = 1
const FLAG_ROUNDABOUT = 2
const FLAG_OUTSIDE = 4

export function networkFromPayload(payload: RoadNetworkPayload): RoadNetwork {
  return {
    roads: payload.roads.map(([sx, sz, mx, mz, ex, ez, flow]) => ({
      sx,
      sz,
      mx,
      mz,
      ex,
      ez,
      flow: flow < 0 ? null : flow,
    })),
    junctions: payload.junctions.map(([x, z, flags]) => ({
      x,
      z,
      trafficLights: (flags & FLAG_TRAFFIC_LIGHTS) !== 0,
      roundabout: (flags & FLAG_ROUNDABOUT) !== 0,
      outsideConnection: (flags & FLAG_OUTSIDE) !== 0,
    })),
  }
}

interface TileRoads {
  network: RoadNetwork | undefined
  fetching: boolean
  error: Error | null
  truncated: number
}

/**
 * Merges road-graph tiles into one network. Tiles overlap at their edges (each request covers
 * the tile's circumscribed circle), so roads and junctions are de-duplicated by entity index.
 * Module level so useQueries can memoise it.
 */
function mergeTiles(results: UseQueryResult<RoadGraph>[]): TileRoads {
  const roads = new Map<number, RoadShape>()
  const junctions = new Map<number, RoadJunction>()
  let fetching = false
  let error: Error | null = null
  let truncated = 0
  let loaded = 0
  for (const result of results) {
    fetching ||= result.isFetching
    error ??= result.error
    if (!result.data) continue
    loaded++
    if (result.data.roadsMatched > result.data.roads.length) truncated++
    for (const road of result.data.roads) {
      roads.set(road.road.index, {
        sx: road.start.x,
        sz: road.start.z,
        mx: (road.start.x + road.end.x) / 2,
        mz: (road.start.z + road.end.z) / 2,
        ex: road.end.x,
        ez: road.end.z,
        flow: road.flowPercent,
      })
    }
    for (const junction of result.data.junctions) {
      if (!junction.trafficLights && !junction.roundabout && !junction.outsideConnection) continue
      junctions.set(junction.node.index, {
        x: junction.position.x,
        z: junction.position.z,
        trafficLights: junction.trafficLights,
        roundabout: junction.roundabout,
        outsideConnection: junction.outsideConnection,
      })
    }
  }
  return {
    network: loaded > 0 ? { roads: [...roads.values()], junctions: [...junctions.values()] } : undefined,
    fetching,
    error,
    truncated,
  }
}

/**
 * Roads for the map. The whole network comes from one /city/road-network request and is cached;
 * a mod without that route answers 404, and then the visible tiles of /city/road-graph are used.
 */
export function useRoads({
  enabled,
  tiles,
}: {
  enabled: boolean
  /** Tiles the view overlaps (null while zoomed out); only used by the fallback. */
  tiles: readonly RoadTile[] | null
}): Roads {
  const network = useQuery({ ...roadNetworkQuery(), enabled })
  const unsupported =
    network.error instanceof ApiError && network.error.status === 404 && network.error.kind === "bridge"
  const tileRoads = useQueries({
    queries: (enabled && unsupported ? (tiles ?? []) : []).map((tile) => roadTileQuery(tile)),
    combine: mergeTiles,
  })
  const converted = useMemo(
    () => (network.data ? networkFromPayload(network.data) : undefined),
    [network.data]
  )

  if (unsupported) return { source: "tiles", ...tileRoads }
  return {
    source: "network",
    network: converted,
    fetching: network.isFetching,
    error: network.error,
    truncated: 0,
  }
}
