import type {
  Camera,
  CityOverview,
  Coverage,
  CoverageService,
  Demand,
  GameState,
  GridMap,
  Happiness,
  History,
  HistoryEntry,
  Infoview,
  Notifications,
  Ping,
  RoadGraph,
  RoadNetworkPayload,
  Services,
  Traffic,
} from "@/lib/bridge-types"

export const ping: Ping = {
  ok: true,
  mod: "CS2MCP",
  version: __APP_VERSION__,
  gameMode: "Game",
  isLoading: false,
  bridgeEnabled: true,
  readOnly: false,
}

export const state: GameState = {
  gameMode: "Game",
  isLoading: false,
  cityLoaded: true,
  cityName: "Riverside",
  simulation: {
    paused: false,
    selectedSpeed: 1,
    effectiveSpeed: 1,
    gameDateTime: "2026-03-14 08:30",
    forcedPause: null,
  },
}

export const overview: CityOverview = {
  cityName: "Riverside",
  population: 12345,
  populationWithMoveIn: 12500,
  averageHappiness: 63,
  averageHealth: 71,
  money: 1_500_000,
  xp: 4200,
  gameDateTime: "2026-03-14 08:30",
  simulationPaused: false,
  simulationSpeed: 1,
}

export const demand: Demand = {
  residential: {
    householdDemand: 40,
    buildingDemand: { lowDensity: 200, mediumDensity: 120, highDensity: 30 },
  },
  commercial: { companyDemand: 10, buildingDemand: 90 },
  industrial: { companyDemand: 5, buildingDemand: 140 },
  office: { companyDemand: 0, buildingDemand: 12 },
}

function entry(partial: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "path">): HistoryEntry {
  return {
    timeUtc: "2026-11-11T10:00:00Z",
    gameTime: "2026-03-14 08:00",
    query: null,
    status: 200,
    ok: true,
    batchChild: false,
    moneyDelta: 0,
    result: null,
    ...partial,
  }
}

/** Newest first, like the bridge. */
export const historyEntries: HistoryEntry[] = [
  entry({
    id: 5,
    path: "/build/place",
    query: { prefab: "ElementarySchool01", x: "120.5", z: "-340.2" },
    moneyDelta: -48000,
    result: '{"placed":true,"building":{"index":901,"version":1}}',
  }),
  entry({
    id: 4,
    path: "/build/road",
    query: { prefab: "Small Road", x1: "0", z1: "0", x2: "400", z2: "300" },
    moneyDelta: -12000,
  }),
  entry({
    id: 3,
    path: "/build/zone",
    query: { cx: "1000", cz: "2000", zone: "Residential" },
    ok: false,
    status: 400,
    result: '{"error":"area is not zonable"}',
  }),
  entry({ id: 2, path: "/city/taxes/set", query: { area: "residential", rate: "12" } }),
  entry({ id: 1, path: "/game/save", batchChild: true }),
]

export const history: History = {
  sessionSpent: 60000,
  spendingLimit: 100000,
  spendingLimitRemaining: 40000,
  spendingLimitSource: "game options",
  batchRunning: false,
  total: historyEntries.length,
  returned: historyEntries.length,
  entries: historyEntries,
}

export const camera: Camera = {
  pivot: { x: 500, y: 40, z: -250 },
  position: { x: 500, y: 600, z: -900 },
  angle: { x: 30, y: 45 },
  zoom: 700,
}

/** 4 x 4 cells of 3584 m; cell value = its index. */
export const gridmap: GridMap = {
  layer: "landValue",
  textureSize: 4,
  worldMin: -7168,
  worldMax: 7168,
  cellSize: 3584,
  unit: "land value per cell",
  values: Array.from({ length: 16 }, (_, i) => i),
}

export const roadGraph: RoadGraph = {
  area: { x: 0, z: 0, radius: 1000 },
  roadsMatched: 1,
  roads: [
    {
      road: { index: 10, version: 1 },
      prefab: "Small Road",
      startNode: 1,
      endNode: 2,
      start: { x: 0, y: 0, z: 0 },
      end: { x: 400, y: 0, z: 300 },
      length: 500,
      partOfBuilding: false,
      flowPercent: 80,
      volume: 12,
    },
  ],
  junctions: [],
}

/** Electricity short (90% of use supplied), water with headroom, sewage just enough. */
export const services: Services = {
  electricity: {
    production: 900,
    consumption: 1000,
    fulfilledConsumption: 900,
    batteryCharge: 0,
    batteryCapacity: 0,
    import: 0,
    export: 0,
  },
  water: {
    freshCapacity: 1500,
    freshConsumption: 1000,
    sewageCapacity: 1000,
    sewageConsumption: 1000,
    freshImport: 0,
    freshExport: 0,
    sewageExport: 0,
  },
  garbage: { accumulationRate: 2500 },
}

function covered(underservedPercent: number, providers: number): CoverageService {
  return {
    buildings: 400,
    residents: 12000,
    underservedBuildings: Math.round(4 * underservedPercent),
    underservedPercent,
    underservedResidents: Math.round(120 * underservedPercent),
    averageLevel: 0.6,
    providers,
  }
}

export const coverage: Coverage = {
  zonedBuildings: 400,
  services: {
    healthcare: covered(5, 3),
    fireRescue: covered(8, 2),
    police: covered(45, 1),
    emergencyShelter: covered(20, 1),
    education: covered(12, 4),
    post: covered(0, 1),
    park: covered(2, 6),
    welfare: covered(100, 0),
    telecom: { available: false, note: "telecom coverage map not available" },
  },
}

export const traffic: Traffic = {
  cityTrafficFlowPercent: 82,
  cityTrafficVolume: 40,
  cityRoadsAveraged: 900,
  congestedRoads: { below50Percent: 6, below25Percent: 1 },
  bottlenecks: { count: 2, lanes: 5 },
}

export const notifications: Notifications = {
  total: 23,
  countsByType: {
    "Garbage Piling Up": 12,
    "No Electricity": 5,
    "Building On Fire": 2,
    "Sick Citizens": 3,
    "Mystery Warning": 1,
  },
}

export const happiness: Happiness = {
  averageHappiness: 63,
  averageHealth: 71,
  factors: [
    { factor: "Tax", value: -6, health: 0, wellbeing: -6 },
    { factor: "NoisePollution", value: -3, health: -2, wellbeing: -1 },
    { factor: "Healthcare", value: 4, health: 4, wellbeing: 0 },
    { factor: "Leisure", value: 7, health: 1, wellbeing: 6 },
  ],
}

/** Panel figures per view, as /city/infoview returns them. */
export const infoviews: Record<string, Infoview> = {
  education: {
    view: "education",
    refreshed: true,
    refreshError: null,
    values: {
      elementaryStudents: 3952,
      elementaryEligible: 5167,
      elementaryCapacity: 4400,
      highSchoolStudents: 4012,
      highSchoolEligible: 5492,
      highSchoolCapacity: 5150,
      collegeStudents: 5043,
      collegeEligible: 5758,
      collegeCapacity: 10000,
      universityStudents: 9182,
      universityEligible: 9807,
      universityCapacity: 24850,
      elementaryAvailability: { min: 0, max: 1, current: 0.6 },
      educationData: { uneducated: 11.4, poorlyEducated: 13.8, educated: 25.8 },
    },
  },
  healthcare: {
    view: "healthcare",
    refreshed: false,
    refreshError: "job not ready",
    values: {
      averageHealth: 64.2,
      patientCount: 180,
      patientCapacity: 150,
      sickCount: 240,
      cemeteryUse: 900,
      cemeteryCapacity: 3000,
      deathRate: 3.5,
      processingRate: 12,
    },
  },
}

/** Two roads (one flowing, one jammed) and a junction with traffic lights. */
export const roadNetwork: RoadNetworkPayload = {
  roadCount: 2,
  junctionCount: 1,
  roads: [
    [0, 0, 200, 150, 400, 300, 80, 0],
    [400, 300, 450, 400, 500, 500, 20, 0],
  ],
  junctions: [[400, 300, 1]],
}

/**
 * A log with two AI sessions (more than 15 minutes apart), newest first like the bridge. The
 * second holds a batch of three road pieces (one failed) with a tax change interleaved, logged
 * the way the bridge logs it: the parts first, then the batch request, which started before them.
 */
export const sessionEntries: HistoryEntry[] = [
  entry({
    id: 10,
    path: "/build/place",
    timeUtc: "2026-11-11T09:12:00Z",
    gameTime: "2026-03-15 11:00",
    query: { prefab: "Park01", x: "500", z: "100" },
    moneyDelta: -5000,
    result: '{"placed":true}',
  }),
  entry({
    id: 9,
    path: "/build/batch",
    timeUtc: "2026-11-11T09:05:00Z",
    gameTime: "2026-03-15 10:00",
    moneyDelta: -30000,
    result: '{"ok":false,"total":3,"ran":3,"succeeded":2,"failed":1}',
  }),
  entry({
    id: 8,
    path: "/build/road/connect",
    timeUtc: "2026-11-11T09:05:20Z",
    gameTime: "2026-03-15 09:50",
    query: { prefab: "Small Road", x1: "400", z1: "300", x2: "600", z2: "300" },
    batchChild: true,
    ok: false,
    status: 400,
    result: '{"error":"segment overlaps a building"}',
  }),
  entry({
    id: 7,
    path: "/city/taxes/set",
    timeUtc: "2026-11-11T09:05:15Z",
    gameTime: "2026-03-15 09:45",
    query: { area: "commercial", rate: "11" },
  }),
  entry({
    id: 6,
    path: "/build/road/connect",
    timeUtc: "2026-11-11T09:05:10Z",
    gameTime: "2026-03-15 09:40",
    query: { prefab: "Small Road", x1: "200", z1: "300", x2: "400", z2: "300" },
    batchChild: true,
    moneyDelta: -15000,
  }),
  entry({
    id: 5,
    path: "/build/road/connect",
    timeUtc: "2026-11-11T09:05:01Z",
    gameTime: "2026-03-15 09:30",
    query: { prefab: "Small Road", x1: "0", z1: "300", x2: "200", z2: "300" },
    batchChild: true,
    moneyDelta: -15000,
  }),
  entry({
    id: 4,
    path: "/build/place",
    timeUtc: "2026-11-11T09:00:05Z",
    gameTime: "2026-03-15 09:00",
    query: { prefab: "ElementarySchool01", x: "120", z: "-340" },
    moneyDelta: -48000,
    result: '{"placed":true,"building":{"index":901,"version":1}}',
  }),
  entry({
    id: 3,
    path: "/build/zone",
    timeUtc: "2026-11-11T08:02:00Z",
    gameTime: "2026-03-14 12:00",
    query: { cx: "1000", cz: "2000", zone: "Residential" },
    ok: false,
    status: 400,
    result: '{"error":"area is not zonable"}',
  }),
  entry({
    id: 2,
    path: "/build/road",
    timeUtc: "2026-11-11T08:01:10Z",
    gameTime: "2026-03-14 10:00",
    query: { prefab: "Small Road", x1: "-400", z1: "0", x2: "0", z2: "0" },
    moneyDelta: -12000,
  }),
  entry({
    id: 1,
    path: "/city/taxes/set",
    timeUtc: "2026-11-11T08:00:00Z",
    gameTime: "2026-03-14 08:00",
    query: { area: "residential", rate: "12" },
  }),
]

export const sessionHistory: History = {
  ...history,
  sessionSpent: 95000,
  spendingLimitRemaining: 5000,
  total: sessionEntries.length,
  returned: sessionEntries.length,
  entries: sessionEntries,
}
