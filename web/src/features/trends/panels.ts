import type { ChartLine, TrendChartProps } from "@/features/trends/trend-chart"
import { formatMoney, formatNumber } from "@/lib/format"

/** The charts of the Trends page: which recorded values share a chart, and how they are shown. */
export interface Panel {
  id: string
  title: string
  description: string
  lines: ChartLine[]
  formatValue: (value: number) => string
  formatTick?: (value: number) => string
  bounds?: TrendChartProps["bounds"]
}

const sky = "text-sky-600 dark:text-sky-400"
const emerald = "text-emerald-600 dark:text-emerald-400"
const amber = "text-amber-600 dark:text-amber-400"
const violet = "text-violet-600 dark:text-violet-400"
const rose = "text-rose-600 dark:text-rose-400"
const indigo = "text-indigo-600 dark:text-indigo-400"

const money = (value: number) => formatMoney(value)
const moneyTick = (value: number) => formatMoney(value, { compact: true })

export const PANELS: Panel[] = [
  {
    id: "population",
    title: "Population",
    description: "Citizens living in the city",
    lines: [{ key: "population", label: "Population", className: sky }],
    formatValue: formatNumber,
  },
  {
    id: "money",
    title: "Money",
    description: "Treasury balance",
    lines: [{ key: "money", label: "Money", className: emerald }],
    formatValue: money,
    formatTick: moneyTick,
  },
  {
    id: "budget",
    title: "Income and expenses",
    description: "The game's monthly rates, updated hourly",
    lines: [
      { key: "income", label: "Income", className: emerald },
      { key: "expenses", label: "Expenses", className: rose },
    ],
    formatValue: money,
    formatTick: moneyTick,
  },
  {
    id: "wellbeing",
    title: "Happiness and health",
    description: "Citizen averages, 0 to 100",
    lines: [
      { key: "happiness", label: "Happiness", className: amber },
      { key: "health", label: "Health", className: violet },
    ],
    formatValue: formatNumber,
    bounds: { min: 0, max: 100 },
  },
  {
    id: "residential-demand",
    title: "Residential demand",
    description: "Building demand on the game's 0 to 255 scale",
    lines: [
      { key: "demandResidentialLow", label: "Low density", className: emerald },
      { key: "demandResidentialMedium", label: "Medium density", className: sky },
      { key: "demandResidentialHigh", label: "High density", className: violet },
    ],
    formatValue: formatNumber,
    bounds: { min: 0, max: 255 },
  },
  {
    id: "work-demand",
    title: "Commercial, industrial and office demand",
    description: "Building demand on the game's 0 to 255 scale",
    lines: [
      { key: "demandCommercial", label: "Commercial", className: sky },
      { key: "demandIndustrial", label: "Industrial", className: amber },
      { key: "demandOffice", label: "Office", className: violet },
    ],
    formatValue: formatNumber,
    bounds: { min: 0, max: 255 },
  },
  {
    id: "xp",
    title: "Experience",
    description: "City XP",
    lines: [{ key: "xp", label: "XP", className: indigo }],
    formatValue: formatNumber,
  },
]
