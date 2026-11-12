/**
 * Settings sections of desktop features. A feature adds ONE file
 * src/features/settings/sections/<id>.tsx that default-exports defineSettingsSection({...}) and
 * ONE line in src/features/settings/sections/index.ts. The settings page shows a section only when
 * the desktop app reports the feature as started (GET /api/desktop/info `features`).
 */
import type { LucideIcon } from "lucide-react"
import type { ComponentType } from "react"

import * as registeredSections from "@/features/settings/sections"

export interface SettingsSectionDefinition {
  /** The desktop feature id (kebab-case); the section renders only when info.features has it. Also the page anchor: /settings#<id>. */
  id: string
  /** Card title, e.g. "System tray". */
  title: string
  /** One line under the title. */
  description?: string
  icon?: LucideIcon
  /** The rows: SwitchRow, SelectRow, NumberRow, TextRow, HotkeyRow (fields.tsx), laid out in a FieldGroup. */
  component: ComponentType
}

const SECTION_ID = /^[a-z][a-z0-9-]*$/

/** Identity helper that types a section: export default defineSettingsSection({ ... }) */
export function defineSettingsSection(section: SettingsSectionDefinition): SettingsSectionDefinition {
  if (!SECTION_ID.test(section.id)) {
    throw new Error(`settings section id "${section.id}" must be the feature's kebab-case id`)
  }
  return section
}

/** Every registered section, in registration order (the list in sections/index.ts is alphabetical). */
export function registeredSettingsSections(): SettingsSectionDefinition[] {
  return Object.values(registeredSections as Record<string, SettingsSectionDefinition>)
}

/** The sections of the features that started in this desktop app. */
export function activeSettingsSections(
  features: readonly string[],
  sections: readonly SettingsSectionDefinition[] = registeredSettingsSections()
): SettingsSectionDefinition[] {
  return sections.filter((section) => features.includes(section.id))
}
