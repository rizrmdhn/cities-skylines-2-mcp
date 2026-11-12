import type { InfoviewName } from "@/lib/bridge-types"
import type { ServiceId } from "@/features/dashboard/service-status"

/**
 * How each service shows its info view panel, following the game's own panels. Keys are the
 * panel's binding names as the bridge reports them (m_ElementaryStudents -> elementaryStudents).
 */
export type InfoBlock =
  /** used against capacity, like the school rows of the Education panel */
  | {
      kind: "meter"
      label: string
      used: string
      capacity: string
      unit: string
      extra?: { key: string; label: string }
    }
  /** an { min, max, current } indicator bar */
  | { kind: "indicator"; label: string; key: string }
  | { kind: "stats"; items: { key: string; label: string; digits?: number }[] }
  /** a raw binding (JSON written by the panel), shown as its numbers */
  | { kind: "raw"; key: string; label: string }

export interface InfoLayout {
  view: InfoviewName
  blocks: InfoBlock[]
}

const school = (level: string, label: string): InfoBlock => ({
  kind: "meter",
  label,
  used: `${level}Students`,
  capacity: `${level}Capacity`,
  unit: "students",
  extra: { key: `${level}Eligible`, label: "Eligible" },
})

export const INFO_LAYOUTS: Partial<Record<ServiceId, InfoLayout>> = {
  education: {
    view: "education",
    blocks: [
      school("elementary", "Elementary school"),
      school("highSchool", "High school"),
      school("college", "College"),
      school("university", "University"),
      { kind: "raw", key: "educationData", label: "Education distribution" },
    ],
  },
  healthcare: {
    view: "healthcare",
    blocks: [
      { kind: "meter", label: "Patients", used: "patientCount", capacity: "patientCapacity", unit: "patients" },
      { kind: "meter", label: "Cemeteries", used: "cemeteryUse", capacity: "cemeteryCapacity", unit: "in use" },
      {
        kind: "stats",
        items: [
          { key: "averageHealth", label: "Average health", digits: 1 },
          { key: "sickCount", label: "Sick citizens" },
          { key: "deathRate", label: "Death rate", digits: 1 },
          { key: "processingRate", label: "Deathcare processing", digits: 1 },
        ],
      },
      { kind: "indicator", label: "Healthcare availability", key: "healthcareAvailability" },
      { kind: "indicator", label: "Deathcare availability", key: "deathcareAvailability" },
    ],
  },
  garbage: {
    view: "garbage",
    blocks: [
      { kind: "meter", label: "Landfills", used: "storedGarbage", capacity: "capacity", unit: "stored" },
      {
        kind: "stats",
        items: [
          { key: "garbageRate", label: "Garbage produced", digits: 0 },
          { key: "processingRate", label: "Processing", digits: 0 },
        ],
      },
      { kind: "indicator", label: "Processing vs garbage", key: "processingAvailability" },
      { kind: "indicator", label: "Landfill availability", key: "landfillAvailability" },
    ],
  },
  police: {
    view: "police",
    blocks: [
      { kind: "meter", label: "Jails", used: "inJail", capacity: "jailCapacity", unit: "held" },
      { kind: "meter", label: "Prisons", used: "inPrison", capacity: "prisonCapacity", unit: "prisoners" },
      {
        kind: "stats",
        items: [
          { key: "criminals", label: "Criminals" },
          { key: "crimePerMonth", label: "Crimes per month" },
          { key: "arrestedCriminals", label: "Arrested" },
          { key: "escapedRate", label: "Escape rate", digits: 2 },
        ],
      },
      { kind: "indicator", label: "Average crime probability", key: "averageCrimeProbability" },
    ],
  },
  fireRescue: {
    view: "fireAndRescue",
    blocks: [{ kind: "indicator", label: "Average fire hazard", key: "averageFireHazard" }],
  },
  emergencyShelter: {
    view: "disaster",
    blocks: [
      { kind: "meter", label: "Emergency shelters", used: "shelteredCount", capacity: "shelterCapacity", unit: "sheltered" },
    ],
  },
  electricity: {
    view: "electricity",
    blocks: [
      { kind: "meter", label: "Consumption", used: "electricityConsumption", capacity: "electricityProduction", unit: "used" },
      {
        kind: "stats",
        items: [
          { key: "electricityProduction", label: "Production" },
          { key: "electricityTransmitted", label: "Transmitted" },
          { key: "electricityImport", label: "Import" },
          { key: "electricityExport", label: "Export" },
        ],
      },
      { kind: "indicator", label: "Battery charge", key: "batteryCharge" },
    ],
  },
  water: {
    view: "water",
    blocks: [
      { kind: "meter", label: "Fresh water", used: "waterConsumption", capacity: "waterCapacity", unit: "used" },
      {
        kind: "stats",
        items: [
          { key: "waterImport", label: "Import" },
          { key: "waterExport", label: "Export" },
        ],
      },
    ],
  },
  sewage: {
    view: "water",
    blocks: [
      { kind: "meter", label: "Sewage treatment", used: "sewageConsumption", capacity: "sewageCapacity", unit: "produced" },
      { kind: "stats", items: [{ key: "sewageExport", label: "Export" }] },
    ],
  },
  traffic: {
    view: "traffic",
    blocks: [{ kind: "raw", key: "trafficFlow", label: "Flow through the day" }],
  },
  post: {
    view: "post",
    blocks: [
      {
        kind: "stats",
        items: [
          { key: "collectedMail", label: "Mail collected" },
          { key: "deliveredMail", label: "Mail delivered" },
          { key: "mailProductionRate", label: "Mail produced", digits: 1 },
        ],
      },
      { kind: "indicator", label: "Post service availability", key: "postServiceAvailability" },
    ],
  },
  telecom: {
    view: "telecom",
    blocks: [{ kind: "indicator", label: "Network availability", key: "networkAvailability" }],
  },
}

/** Every binding key a layout shows, so the rest can be listed under "More figures". */
export function usedKeys(layout: InfoLayout) {
  const keys = new Set<string>()
  for (const block of layout.blocks) {
    if (block.kind === "meter") {
      keys.add(block.used)
      keys.add(block.capacity)
      if (block.extra) keys.add(block.extra.key)
    } else if (block.kind === "stats") {
      for (const item of block.items) keys.add(item.key)
    } else {
      keys.add(block.key)
    }
  }
  return keys
}
