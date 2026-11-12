/**
 * Settings sections of desktop features. A feature adds ONE file
 * src/features/settings/sections/<id>.tsx that default-exports defineSettingsSection({...}) and
 * ONE line in src/features/settings/sections/index.ts. The settings page shows a section only when
 * the desktop app reports the feature as started (GET /api/desktop/info `features`).
 */
import * as registeredSections from "@/features/settings/sections"
import type { SettingsSectionDefinition } from "@/features/settings/define-section"

/** Every registered section, in registration order (the list in sections/index.ts is alphabetical). */
export function registeredSettingsSections(): SettingsSectionDefinition[] {
  return Object.values(registeredSections as Record<string, SettingsSectionDefinition>).filter(
    (section) => typeof section?.id === "string" && typeof section.component === "function"
  )
}

/** The sections of the features that started in this desktop app. */
export function activeSettingsSections(
  features: readonly string[],
  sections: readonly SettingsSectionDefinition[] = registeredSettingsSections()
): SettingsSectionDefinition[] {
  return sections.filter((section) => features.includes(section.id))
}
