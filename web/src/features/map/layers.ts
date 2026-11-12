import type { GridLayer } from "@/lib/bridge-types"

export const LAYER_LABELS: Record<GridLayer, string> = {
  landValue: "Land value",
  groundPollution: "Ground pollution",
  airPollution: "Air pollution",
  noisePollution: "Noise pollution",
  groundWater: "Ground water",
  groundWaterPollution: "Ground water pollution",
}

export function formatLayerValue(value: number) {
  return Math.abs(value) >= 100 ? Math.round(value).toString() : value.toFixed(1)
}
