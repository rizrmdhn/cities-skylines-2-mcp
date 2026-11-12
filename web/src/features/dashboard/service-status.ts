import type {
  Coverage,
  CoverageService,
  CoverageServiceName,
  Notifications,
  Services,
  Traffic,
} from "@/lib/bridge-types"

export type Status = "good" | "warning" | "problem" | "unknown"

/** Service areas the in-world warning icons are sorted into. */
export type NotificationGroup =
  | "disaster"
  | "traffic"
  | "fire"
  | "electricity"
  | "sewage"
  | "water"
  | "garbage"
  | "healthcare"
  | "police"
  | "education"
  | "other"

/**
 * The bridge reports icons by prefab name. Names are matched on keywords, first rule wins, so
 * "Water Damage" counts as a disaster and "Dead End" as traffic, not healthcare.
 */
const GROUP_RULES: [NotificationGroup, RegExp][] = [
  ["disaster", /destroy|collaps|flood|weather|disaster|damage|tornado|earthquake|tsunami|evacuat/],
  ["traffic", /traffic|bottleneck|dead ?end|road|parking|pedestrian|car\b/],
  ["fire", /fire|burn/],
  ["electricity", /electric|power|transformer|fuel|battery/],
  ["sewage", /sewage/],
  ["water", /water|pipe/],
  ["garbage", /garbage|landfill|recycl|trash/],
  ["healthcare", /sick|health|hospital|dead|death|hearse|corpse|patient|clinic/],
  ["police", /crime|police|prison|jail|criminal/],
  // not "educated": "Missing Uneducated Workers" is about jobs
  ["education", /school|student|universit|college/],
]

/** The warning group shown with each service. */
export const SERVICE_WARNING_GROUP: Partial<Record<ServiceId, NotificationGroup>> = {
  traffic: "traffic",
  electricity: "electricity",
  water: "water",
  sewage: "sewage",
  garbage: "garbage",
  healthcare: "healthcare",
  fireRescue: "fire",
  police: "police",
  emergencyShelter: "disaster",
  education: "education",
}

export function notificationGroup(type: string): NotificationGroup {
  const name = humanizeName(type).toLowerCase()
  return GROUP_RULES.find(([, pattern]) => pattern.test(name))?.[0] ?? "other"
}

/** "BuildingOnFire_Notification" -> "Building On Fire". */
export function humanizeName(name: string) {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+(notification|icon)$/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

export interface NotificationType {
  type: string
  label: string
  count: number
  group: NotificationGroup
}

/** Every warning type, most frequent first. */
export function notificationTypes(notifications: Notifications | undefined): NotificationType[] {
  return Object.entries(notifications?.countsByType ?? {})
    .map(([type, count]) => ({ type, label: humanizeName(type), count, group: notificationGroup(type) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export function warningsByGroup(notifications: Notifications | undefined) {
  const totals: Partial<Record<NotificationGroup, number>> = {}
  for (const item of notificationTypes(notifications)) {
    totals[item.group] = (totals[item.group] ?? 0) + item.count
  }
  return totals
}

export type ServiceId =
  | "traffic"
  | "electricity"
  | "water"
  | "sewage"
  | "garbage"
  | CoverageServiceName

export interface ServiceRow {
  id: ServiceId
  label: string
  status: Status
  /** Headline figure, e.g. "86%". */
  value: string
  /** What the headline means, e.g. "covered". */
  valueLabel: string
  detail: string
  /** 0-100 for the meter under the row; absent when there is no sensible share. */
  meter?: number
  /** In-world warning icons in this service area. */
  warnings: number
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const pct = (value: number) => `${Math.round(value)}%`
const clampPercent = (value: number) => Math.max(0, Math.min(100, value))

const NO_DATA = { status: "unknown" as const, value: "-", valueLabel: "", meter: undefined }

function trafficRow(traffic: Traffic | undefined, warnings: number): ServiceRow {
  const base = { id: "traffic" as const, label: "Traffic", warnings }
  if (!traffic) return { ...base, ...NO_DATA, detail: "Loading traffic" }
  if (traffic.cityRoadsAveraged === 0) return { ...base, ...NO_DATA, detail: "No roads yet" }
  const flow = traffic.cityTrafficFlowPercent
  return {
    ...base,
    status: flow >= 75 ? "good" : flow >= 50 ? "warning" : "problem",
    value: pct(flow),
    valueLabel: "flow",
    meter: clampPercent(flow),
    detail: `${whole.format(traffic.bottlenecks.count)} bottlenecks · ${whole.format(traffic.congestedRoads.below50Percent)} roads under 50% flow`,
  }
}

function electricityRow(services: Services | undefined, warnings: number): ServiceRow {
  const base = { id: "electricity" as const, label: "Electricity", warnings }
  if (!services) return { ...base, ...NO_DATA, detail: "Loading" }
  const e = services.electricity
  if (e.consumption === 0 && e.production === 0) {
    return { ...base, ...NO_DATA, detail: "No electricity network yet" }
  }
  const supplied = e.consumption > 0 ? (e.fulfilledConsumption / e.consumption) * 100 : 100
  const parts = [`Produces ${compact.format(e.production)}`, `uses ${compact.format(e.consumption)}`]
  if (e.import > 0) parts.push(`imports ${compact.format(e.import)}`)
  if (e.export > 0) parts.push(`exports ${compact.format(e.export)}`)
  if (e.batteryCapacity > 0) parts.push(`batteries ${pct((e.batteryCharge / e.batteryCapacity) * 100)}`)
  return {
    ...base,
    status:
      supplied >= 99 && e.production + e.import >= e.consumption
        ? "good"
        : supplied >= 90
          ? "warning"
          : "problem",
    value: pct(Math.min(supplied, 100)),
    valueLabel: "supplied",
    meter: clampPercent(supplied),
    detail: parts.join(" · "),
  }
}

/** Capacity against use: good with 10% headroom, warning when only just enough. */
function capacityRow(
  base: { id: ServiceId; label: string; warnings: number },
  capacity: number,
  use: number,
  extra: string[]
): ServiceRow {
  if (capacity === 0 && use === 0) return { ...base, ...NO_DATA, detail: "No network yet" }
  const ratio = use > 0 ? (capacity / use) * 100 : 100
  return {
    ...base,
    status: ratio >= 110 ? "good" : ratio >= 100 ? "warning" : "problem",
    value: pct(ratio),
    valueLabel: "of demand",
    meter: clampPercent(ratio),
    detail: [`Capacity ${compact.format(capacity)}`, `use ${compact.format(use)}`, ...extra].join(" · "),
  }
}

function waterRow(services: Services | undefined, warnings: number): ServiceRow {
  const base = { id: "water" as const, label: "Water", warnings }
  if (!services) return { ...base, ...NO_DATA, detail: "Loading" }
  const w = services.water
  return capacityRow(base, w.freshCapacity, w.freshConsumption, w.freshImport > 0 ? [`imports ${compact.format(w.freshImport)}`] : [])
}

function sewageRow(services: Services | undefined, warnings: number): ServiceRow {
  const base = { id: "sewage" as const, label: "Sewage", warnings }
  if (!services) return { ...base, ...NO_DATA, detail: "Loading" }
  const w = services.water
  return capacityRow(base, w.sewageCapacity, w.sewageConsumption, w.sewageExport > 0 ? [`exports ${compact.format(w.sewageExport)}`] : [])
}

/** The bridge has no garbage processing capacity, so the warning icons decide the status. */
function garbageRow(services: Services | undefined, warnings: number): ServiceRow {
  const base = { id: "garbage" as const, label: "Garbage & recycling", warnings }
  if (!services) return { ...base, ...NO_DATA, detail: "Loading" }
  return {
    ...base,
    status: warnings === 0 ? "good" : warnings < 20 ? "warning" : "problem",
    value: whole.format(warnings),
    valueLabel: warnings === 1 ? "warning" : "warnings",
    detail: `Garbage produced: ${compact.format(services.garbage.accumulationRate)}`,
  }
}

const COVERAGE_LABELS: Record<CoverageServiceName, string> = {
  healthcare: "Healthcare",
  fireRescue: "Fire & rescue",
  police: "Police",
  emergencyShelter: "Disaster shelters",
  education: "Education",
  post: "Post",
  park: "Parks & leisure",
  welfare: "Welfare",
  telecom: "Telecom",
}

function isCoverageService(value: unknown): value is CoverageService {
  return typeof value === "object" && value !== null && "underservedPercent" in value
}

function coverageRow(
  id: CoverageServiceName,
  coverage: Coverage | undefined,
  warnings: number
): ServiceRow {
  const base = { id, label: COVERAGE_LABELS[id], warnings }
  if (!coverage) return { ...base, ...NO_DATA, detail: "Loading coverage" }
  const service = coverage.services[id]
  if (!isCoverageService(service)) return { ...base, ...NO_DATA, detail: "Not available in this game" }
  if (service.buildings === 0) return { ...base, ...NO_DATA, detail: "No zoned buildings yet" }

  const covered = 100 - service.underservedPercent
  const facilities =
    service.providers === null ? "" : ` · ${whole.format(service.providers)} ${service.providers === 1 ? "facility" : "facilities"}`
  let status: Status =
    service.underservedPercent <= 10 ? "good" : service.underservedPercent <= 30 ? "warning" : "problem"
  if (service.providers === 0) status = "problem"
  // Active fires and destroyed buildings need attention whatever the coverage says.
  if ((id === "fireRescue" || id === "emergencyShelter") && warnings > 0) status = "problem"
  return {
    ...base,
    status,
    value: pct(covered),
    valueLabel: "covered",
    meter: clampPercent(covered),
    detail: `${whole.format(service.underservedResidents)} residents underserved${facilities}`,
  }
}

/** One row per service area, in the order the dashboard shows them. */
export function serviceRows(input: {
  services: Services | undefined
  coverage: Coverage | undefined
  traffic: Traffic | undefined
  notifications: Notifications | undefined
}): ServiceRow[] {
  const warnings = warningsByGroup(input.notifications)
  const w = (group: NotificationGroup) => warnings[group] ?? 0
  return [
    trafficRow(input.traffic, w("traffic")),
    electricityRow(input.services, w("electricity")),
    waterRow(input.services, w("water")),
    sewageRow(input.services, w("sewage")),
    garbageRow(input.services, w("garbage")),
    coverageRow("healthcare", input.coverage, w("healthcare")),
    coverageRow("fireRescue", input.coverage, w("fire")),
    coverageRow("police", input.coverage, w("police")),
    coverageRow("emergencyShelter", input.coverage, w("disaster")),
    coverageRow("education", input.coverage, w("education")),
    coverageRow("post", input.coverage, 0),
    coverageRow("park", input.coverage, 0),
    coverageRow("welfare", input.coverage, 0),
    coverageRow("telecom", input.coverage, 0),
  ]
}
