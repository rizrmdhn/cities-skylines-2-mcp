import { MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react"
import { useId } from "react"

import { useTheme } from "@/components/theme-provider"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from "@/components/ui/field"
import { Kbd } from "@/components/ui/kbd"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { SettingsSection } from "@/features/settings/section-card"

const THEMES = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
] as const

type Theme = (typeof THEMES)[number]["value"]

const isTheme = (value: unknown): value is Theme => THEMES.some((theme) => theme.value === value)

/** The header's theme menu as a setting (kept per window in local storage, like in the browser). */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const id = useId()
  return (
    <SettingsSection id="appearance" title="Appearance" icon={PaletteIcon}>
      <FieldGroup>
        <Field orientation="responsive">
          <FieldContent>
            <FieldTitle id={`${id}-label`}>Theme</FieldTitle>
            <FieldDescription id={`${id}-description`}>
              System follows the Windows setting. Press <Kbd>D</Kbd> anywhere to switch between
              light and dark.
            </FieldDescription>
          </FieldContent>
          <ToggleGroup
            variant="outline"
            spacing={0}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-description`}
            value={[theme]}
            onValueChange={(value: string[]) => {
              const next = value.at(-1)
              if (isTheme(next)) setTheme(next)
            }}
          >
            {THEMES.map(({ value, label, icon: Icon }) => (
              <ToggleGroupItem key={value} value={value}>
                <Icon data-icon="inline-start" />
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      </FieldGroup>
    </SettingsSection>
  )
}
