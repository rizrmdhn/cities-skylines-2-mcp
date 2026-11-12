import { CrosshairIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import type { Camera } from "@/lib/bridge-types"
import { MAP_COLOURS } from "@/features/map/draw"

function Swatch({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="size-2.5 rounded-full ring-1 ring-foreground/30" style={{ background: colour }} />
      {label}
    </span>
  )
}

export function OverlayCard({
  roads,
  markers,
  follow,
  camera,
  onRoadsChange,
  onReloadRoads,
  onMarkersChange,
  onFollowChange,
  onCentreCamera,
}: {
  roads: boolean
  markers: boolean
  follow: boolean
  camera: Camera | undefined
  onRoadsChange: (on: boolean) => void
  onReloadRoads: () => void
  onMarkersChange: (on: boolean) => void
  onFollowChange: (on: boolean) => void
  onCentreCamera: () => void
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>On the map</CardTitle>
        <CardDescription>Overlays drawn on top of the data layer</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="overlay-roads">Roads</FieldLabel>
              <FieldDescription>
                The whole network, loaded once and kept for 5 minutes; changes made through the
                bridge refresh it.
              </FieldDescription>
              <FieldDescription className="flex flex-wrap gap-x-3">
                <Swatch colour={MAP_COLOURS.roadFree} label="flowing" />
                <Swatch colour={MAP_COLOURS.roadSlow} label="slow" />
                <Swatch colour={MAP_COLOURS.roadJammed} label="jammed" />
              </FieldDescription>
            </FieldContent>
            <Switch id="overlay-roads" checked={roads} onCheckedChange={onRoadsChange} />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="overlay-markers">AI changes</FieldLabel>
              <FieldDescription className="flex flex-wrap gap-x-3">
                <Swatch colour={MAP_COLOURS.markerOk} label="done" />
                <Swatch colour={MAP_COLOURS.markerFailed} label="failed" />
              </FieldDescription>
            </FieldContent>
            <Switch id="overlay-markers" checked={markers} onCheckedChange={onMarkersChange} />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="overlay-follow">Follow game camera</FieldLabel>
              <FieldDescription>
                {camera
                  ? `Looking at x ${Math.round(camera.pivot.x)}, z ${Math.round(camera.pivot.z)}`
                  : "Camera position unavailable"}
              </FieldDescription>
            </FieldContent>
            <Switch id="overlay-follow" checked={follow} onCheckedChange={onFollowChange} />
          </Field>
        </FieldGroup>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!camera} onClick={onCentreCamera}>
            <CrosshairIcon data-icon="inline-start" />
            Centre on camera
          </Button>
          <Button variant="outline" size="sm" disabled={!roads} onClick={onReloadRoads}>
            <RefreshCwIcon data-icon="inline-start" />
            Reload roads
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
