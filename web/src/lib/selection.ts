import { roundPoint, type WorldPoint } from "@/lib/world"

export const SELECTION_MODES = ["point", "box", "line"] as const
export type SelectionMode = (typeof SELECTION_MODES)[number]

export function isSelectionMode(value: string): value is SelectionMode {
  return (SELECTION_MODES as readonly string[]).includes(value)
}

export type Selection =
  | { kind: "point"; at: WorldPoint }
  | { kind: "box"; from: WorldPoint; to: WorldPoint }
  | { kind: "line"; from: WorldPoint; to: WorldPoint }

/** Compact URL form: "p:x,z", "b:x1,z1,x2,z2" or "l:x1,z1,x2,z2" (whole metres). */
export function encodeSelection(selection: Selection): string {
  if (selection.kind === "point") {
    const p = roundPoint(selection.at)
    return `p:${p.x},${p.z}`
  }
  const a = roundPoint(selection.from)
  const b = roundPoint(selection.to)
  return `${selection.kind === "box" ? "b" : "l"}:${a.x},${a.z},${b.x},${b.z}`
}

export function decodeSelection(value: string | undefined): Selection | undefined {
  if (!value) return undefined
  const match = /^([pbl]):(.+)$/.exec(value)
  if (!match) return undefined
  const numbers = match[2].split(",").map(Number)
  if (numbers.some((n) => !Number.isFinite(n))) return undefined
  if (match[1] === "p" && numbers.length === 2) {
    return { kind: "point", at: { x: numbers[0], z: numbers[1] } }
  }
  if (numbers.length !== 4) return undefined
  const from = { x: numbers[0], z: numbers[1] }
  const to = { x: numbers[2], z: numbers[3] }
  return match[1] === "b" ? { kind: "box", from, to } : { kind: "line", from, to }
}

const fmt = (p: WorldPoint) => {
  const r = roundPoint(p)
  return `(${r.x}, ${r.z})`
}

/** Box corners as min/max so the text does not depend on the drag direction. */
function boxCorners(selection: { from: WorldPoint; to: WorldPoint }) {
  return {
    min: { x: Math.min(selection.from.x, selection.to.x), z: Math.min(selection.from.z, selection.to.z) },
    max: { x: Math.max(selection.from.x, selection.to.x), z: Math.max(selection.from.z, selection.to.z) },
  }
}

export function describeSelection(selection: Selection): string {
  switch (selection.kind) {
    case "point":
      return `x=${Math.round(selection.at.x)}, z=${Math.round(selection.at.z)}`
    case "box": {
      const { min, max } = boxCorners(selection)
      return `${fmt(min)} to ${fmt(max)}`
    }
    case "line":
      return `${fmt(selection.from)} to ${fmt(selection.to)}`
  }
}

export function selectionSize(selection: Selection): string | undefined {
  if (selection.kind === "point") return undefined
  const dx = Math.abs(selection.to.x - selection.from.x)
  const dz = Math.abs(selection.to.z - selection.from.z)
  if (selection.kind === "box") return `${Math.round(dx)} × ${Math.round(dz)} m`
  return `${Math.round(Math.hypot(dx, dz))} m long`
}

export interface PromptTemplate {
  id: string
  label: string
  text: string
}

/** Ready-to-paste prompt snippets; `context` (e.g. "land value 412") is appended when given. */
export function promptTemplates(selection: Selection, context?: string): PromptTemplate[] {
  const why = context ? ` (${context})` : ""
  switch (selection.kind) {
    case "point": {
      const at = fmt(selection.at)
      return [
        { id: "coords", label: "Coordinates", text: `x=${Math.round(selection.at.x)}, z=${Math.round(selection.at.z)}` },
        { id: "place", label: "Place a building", text: `Place a building at ${at}${why}.` },
        { id: "inspect", label: "What's here", text: `What is around ${at}? Check buildings and roads within 200 m.` },
        { id: "camera", label: "Move camera", text: `Move the camera to ${at} and take a screenshot.` },
      ]
    }
    case "box": {
      const { min, max } = boxCorners(selection)
      return [
        { id: "coords", label: "Corners", text: `${fmt(min)} to ${fmt(max)}` },
        { id: "zone", label: "Zone area", text: `Zone residential in the area from ${fmt(min)} to ${fmt(max)}${why}.` },
        { id: "survey", label: "Survey area", text: `List the buildings, roads and zoning in the area from ${fmt(min)} to ${fmt(max)}.` },
      ]
    }
    case "line":
      return [
        { id: "coords", label: "Endpoints", text: `${fmt(selection.from)} to ${fmt(selection.to)}` },
        { id: "road", label: "Build road", text: `Build a two-lane road from ${fmt(selection.from)} to ${fmt(selection.to)}${why}.` },
        { id: "connect", label: "Connect roads", text: `Connect the road near ${fmt(selection.from)} to the road near ${fmt(selection.to)}.` },
      ]
  }
}
