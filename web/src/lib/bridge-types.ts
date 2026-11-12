/** Payloads of the eight allowlisted bridge routes: only the fields the web app reads. */

export interface Ping {
  ok: boolean
  mod: string
  version: string
  gameMode: string
  isLoading: boolean
  bridgeEnabled: boolean
  readOnly: boolean
}

export interface GameState {
  gameMode: string
  isLoading: boolean
  cityLoaded: boolean
  cityName: string | null
  simulation: {
    paused: boolean
    selectedSpeed: number
    effectiveSpeed: number
    gameDateTime: string | null
    forcedPause: string | null
  } | null
}

export interface CityOverview {
  cityName: string
  population: number
  populationWithMoveIn: number
  averageHappiness: number
  averageHealth: number
  money: number
  xp: number
  gameDateTime: string | null
  simulationPaused: boolean
  simulationSpeed: number
}

export interface Demand {
  residential: {
    householdDemand: number
    buildingDemand: { lowDensity: number; mediumDensity: number; highDensity: number }
  }
  commercial: { companyDemand: number; buildingDemand: number }
  industrial: { companyDemand: number; buildingDemand: number }
  office: { companyDemand: number; buildingDemand: number }
}

/** /city/services: utility production against use (the game's own units). */
export interface Services {
  electricity: {
    production: number
    consumption: number
    fulfilledConsumption: number
    batteryCharge: number
    batteryCapacity: number
    import: number
    export: number
  }
  water: {
    freshCapacity: number
    freshConsumption: number
    sewageCapacity: number
    sewageConsumption: number
    freshImport: number
    freshExport: number
    sewageExport: number
  }
  garbage: { accumulationRate: number }
}

export const COVERAGE_SERVICES = [
  "healthcare",
  "fireRescue",
  "police",
  "emergencyShelter",
  "education",
  "post",
  "park",
  "welfare",
  "telecom",
] as const

export type CoverageServiceName = (typeof COVERAGE_SERVICES)[number]

export interface CoverageService {
  buildings: number
  residents: number
  underservedBuildings: number
  underservedPercent: number
  underservedResidents: number
  averageLevel: number
  providers: number | null
  /** Zoned buildings per coverage level on the info view's colour scale. */
  levels?: { none: number; low: number; medium: number; high: number }
  /** Per zone kind (residential, commercial...): buildings and how many are underserved. */
  byKind?: Record<string, { buildings: number; underserved: number }>
}

export const INFOVIEWS = [
  "education",
  "healthcare",
  "garbage",
  "police",
  "fireAndRescue",
  "disaster",
  "electricity",
  "water",
  "traffic",
  "post",
  "telecom",
] as const

export type InfoviewName = (typeof INFOVIEWS)[number]

/** An info view panel's indicator bar. */
export interface IndicatorValue {
  min: number
  max: number
  current: number
}

/** /city/infoview: the panel's bindings by name (numbers, indicators, or JSON for raw bindings). */
export interface Infoview {
  view: string
  refreshed: boolean
  refreshError: string | null
  readErrors?: string[] | null
  values: Record<string, unknown>
}

/**
 * /city/road-network: every segment as [startX, startZ, middleX, middleZ, endX, endZ, flowPercent,
 * flags] (flow -1 = not a road; flags 1 = part of a building) and the flagged junctions as
 * [x, z, flags] (1 traffic lights, 2 roundabout, 4 outside connection).
 */
export interface RoadNetworkPayload {
  roadCount: number
  junctionCount: number
  roads: number[][]
  junctions: number[][]
}

/** /city/coverage: how well zoned buildings are reached by each public service. */
export interface Coverage {
  zonedBuildings: number
  services: Partial<Record<string, CoverageService | { available: false; note?: string }>>
}

/** /city/traffic, city-wide figures only. */
export interface Traffic {
  cityTrafficFlowPercent: number
  cityTrafficVolume: number
  cityRoadsAveraged: number
  congestedRoads: { below50Percent: number; below25Percent: number }
  bottlenecks: { count: number; lanes: number }
}

/** /city/notifications: in-world warning icons counted by icon prefab name. */
export interface Notifications {
  total: number
  countsByType: Record<string, number>
}

export interface HappinessFactor {
  factor: string
  value: number
  health: number
  wellbeing: number
}

/** /city/happiness: the city info panel's happiness factors, most negative first. */
export interface Happiness {
  averageHappiness: number
  averageHealth: number
  factors: HappinessFactor[]
}

export interface HistoryEntry {
  id: number
  timeUtc: string
  gameTime: string | null
  path: string
  query: Record<string, string> | null
  status: number
  ok: boolean
  batchChild: boolean
  moneyDelta: number
  result: string | null
}

export interface History {
  sessionSpent: number
  spendingLimit: number | null
  spendingLimitRemaining: number | null
  spendingLimitSource: string
  batchRunning: boolean
  total: number
  returned: number
  entries: HistoryEntry[]
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Camera {
  pivot: Vec3
  position: Vec3
  angle: { x: number; y: number }
  zoom: number
}

export const GRID_LAYERS = [
  "landValue",
  "groundPollution",
  "airPollution",
  "noisePollution",
  "groundWater",
  "groundWaterPollution",
] as const

export type GridLayer = (typeof GRID_LAYERS)[number]

export interface GridMap {
  layer: string
  textureSize: number
  worldMin: number
  worldMax: number
  cellSize: number
  unit: string
  values: number[]
}

export interface RoadSegment {
  road: { index: number; version: number }
  prefab: string | null
  startNode: number
  endNode: number
  start: Vec3
  end: Vec3
  length: number
  partOfBuilding: boolean
  flowPercent: number | null
  volume: number | null
}

export interface Junction {
  node: { index: number; version: number }
  position: Vec3
  roadsConnected: number
  segmentsConnected: number
  partOfBuilding: boolean
  trafficLights: boolean
  roundabout: boolean
  outsideConnection: boolean
}

export interface RoadGraph {
  area: { x: number; z: number; radius: number }
  roadsMatched: number
  roads: RoadSegment[]
  junctions: Junction[]
}
