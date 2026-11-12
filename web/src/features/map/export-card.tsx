import { useQuery } from "@tanstack/react-query"
import { ClipboardCopyIcon, ImageDownIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { canvasToBlob, renderMapExport, type ExportContent } from "@/features/map/export-image"
import { LAYER_LABELS } from "@/features/map/layers"
import type { GridLayer } from "@/lib/bridge-types"
import { downloadBlob } from "@/lib/download"
import {
  boundsFrame,
  cityBounds,
  EXPORT_SCALES,
  exportFileName,
  planExport,
  viewFrame,
  wholeMapFrame,
  type ExportArea,
  type ExportBackground,
  type ExportScale,
} from "@/lib/map-export"
import { overviewQuery } from "@/lib/queries"
import type { MapView, Size } from "@/lib/world"

const AREA_ITEMS: { value: ExportArea; label: string; hint: string }[] = [
  { value: "view", label: "This view", hint: "Exactly what the map shows now" },
  { value: "city", label: "Built-up area", hint: "Fitted around the roads and AI changes" },
  { value: "map", label: "Whole map", hint: "The full 14.3 km square" },
]

const BACKGROUND_ITEMS: { value: ExportBackground; label: string }[] = [
  { value: "light", label: "Light, with caption" },
  { value: "dark", label: "Dark, with caption" },
  { value: "transparent", label: "Transparent, no caption" },
]

const thousands = (n: number) => n.toLocaleString("en-US")

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Export the map as a PNG: save it or copy it to the clipboard. */
export function ExportCard({
  layer,
  view,
  size,
  content,
  roadsPartial,
}: {
  layer: GridLayer
  /** The view as shown right now (the "This view" area). */
  view: MapView
  size: Size | undefined
  content: ExportContent
  /** Roads come from the per-area fallback: whole-city areas may miss roads that were never loaded. */
  roadsPartial: boolean
}) {
  const overview = useQuery(overviewQuery())
  const [area, setArea] = useState<ExportArea>("view")
  const [scale, setScale] = useState<ExportScale>(2)
  const [background, setBackground] = useState<ExportBackground>("light")
  const [withCamera, setWithCamera] = useState(true)
  const [busy, setBusy] = useState<"save" | "copy" | null>(null)

  const bounds = useMemo(() => cityBounds(content.roads, content.markers), [content.roads, content.markers])
  const emptyCity = area === "city" && !bounds

  const plan = useMemo(() => {
    if (!size || size.width < 1 || size.height < 1) return undefined
    const frame =
      area === "view"
        ? viewFrame(view, size)
        : area === "city" && bounds
          ? boundsFrame(bounds, size)
          : wholeMapFrame(size)
    return planExport({ frame, scale, background })
  }, [area, view, size, bounds, scale, background])

  const fileName = exportFileName({
    city: overview.data?.cityName,
    layer: LAYER_LABELS[layer],
    date: overview.data?.gameDateTime,
  })

  /** The picture as a PNG; every failure (too large, no canvas, encoding) is a readable Error. */
  const makePng = async () => {
    if (!plan) throw new Error("The map has no size yet.")
    const canvas = await renderMapExport({
      plan,
      content: { ...content, camera: withCamera ? content.camera : undefined },
      caption: {
        city: overview.data?.cityName || "City",
        date: overview.data?.gameDateTime ?? null,
        layerLabel: LAYER_LABELS[layer],
      },
      background,
    })
    return canvasToBlob(canvas)
  }

  const save = async () => {
    setBusy("save")
    try {
      const result = await downloadBlob(await makePng(), fileName)
      if (result.status === "saved") {
        toast.success(`Saved ${fileName}`, result.path ? { description: result.path } : undefined)
      }
    } catch (error) {
      toast.error("Could not export the map", { description: message(error) })
    } finally {
      setBusy(null)
    }
  }

  const copy = async () => {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      toast.error("Could not copy the image", { description: "This browser cannot copy images to the clipboard." })
      return
    }
    setBusy("copy")
    try {
      // The item takes the pending PNG, so the clipboard write starts inside the click.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": makePng() })])
      toast.success("Copied the image to the clipboard")
    } catch (error) {
      toast.error("Could not copy the image", {
        description:
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Clipboard access was blocked. Save the image instead."
            : message(error),
      })
    } finally {
      setBusy(null)
    }
  }

  const disabled = !plan || plan.problem !== undefined || busy !== null

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Export image</CardTitle>
        <CardDescription>A PNG of the map as drawn here, rendered again at the chosen size</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldTitle>Area</FieldTitle>
            <ToggleGroup
              size="sm"
              variant="outline"
              spacing={0}
              aria-label="Export area"
              value={[area]}
              onValueChange={(value: string[]) => {
                const next = AREA_ITEMS.find((item) => item.value === value.at(-1))
                if (next) setArea(next.value)
              }}
            >
              {AREA_ITEMS.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value} title={item.hint}>
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {emptyCity && (
              <FieldDescription>Nothing built or changed yet: exporting the whole map.</FieldDescription>
            )}
            {area !== "view" && roadsPartial && content.roads && (
              <FieldDescription>
                This mod loads roads per area, so roads you have not looked at are missing.
              </FieldDescription>
            )}
          </Field>

          <Field>
            <FieldTitle>Size</FieldTitle>
            <ToggleGroup
              size="sm"
              variant="outline"
              spacing={0}
              aria-label="Export scale"
              value={[String(scale)]}
              onValueChange={(value: string[]) => {
                const next = EXPORT_SCALES.find((s) => String(s) === value.at(-1))
                if (next) setScale(next)
              }}
            >
              {EXPORT_SCALES.map((s) => (
                <ToggleGroupItem key={s} value={String(s)} aria-label={`${s}× the on-screen size`}>
                  {s}×
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription aria-live="polite" data-testid="export-size">
              {plan ? `${thousands(plan.pixels.width)} × ${thousands(plan.pixels.height)} px` : "Waiting for the map"}
            </FieldDescription>
            {plan?.problem && (
              <FieldDescription role="alert" className="text-destructive">
                {plan.problem}
              </FieldDescription>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="export-background">Background</FieldLabel>
            <Select
              items={BACKGROUND_ITEMS}
              value={background}
              onValueChange={(value) => value && setBackground(value as ExportBackground)}
            >
              <SelectTrigger id="export-background" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {BACKGROUND_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              The caption has the city, game date, layer with its colour scale and a scale bar.
            </FieldDescription>
          </Field>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="export-camera">Camera in the image</FieldLabel>
              <FieldDescription>
                {content.camera ? "Where the game camera is and looks" : "Camera position unavailable"}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="export-camera"
              checked={withCamera && content.camera !== undefined}
              disabled={!content.camera}
              onCheckedChange={setWithCamera}
            />
          </Field>
        </FieldGroup>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" disabled={disabled} onClick={save}>
            {busy === "save" ? <Spinner data-icon="inline-start" /> : <ImageDownIcon data-icon="inline-start" />}
            {busy === "save" ? "Rendering…" : "Save PNG"}
          </Button>
          <Button variant="outline" size="sm" disabled={disabled} onClick={copy}>
            {busy === "copy" ? <Spinner data-icon="inline-start" /> : <ClipboardCopyIcon data-icon="inline-start" />}
            {busy === "copy" ? "Copying…" : "Copy image"}
          </Button>
        </div>
        <p className="mt-2 truncate text-xs text-muted-foreground" title={fileName}>
          {fileName}
        </p>
      </CardContent>
    </Card>
  )
}
