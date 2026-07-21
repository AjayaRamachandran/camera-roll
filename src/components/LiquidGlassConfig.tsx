import { createContext, ReactNode, useContext, useMemo, useState } from "react";

/**
 * Global liquid-glass appearance.
 *
 * The glass material has two live knobs: how much it blurs the backdrop and how
 * strong its tint is. Rather than pin these per surface, they live here so a
 * single control can restyle every pane of glass in the app at once. Each
 * <Refract> reads these as its defaults (see Refract.tsx); a surface that needs
 * a bespoke look still overrides them with its own blur / tint props.
 */

export interface GlassPreset {
  /** Stable key + user-facing name. */
  name: string;
  /** Base backdrop blur in px (Refract scales it up for larger boxes). */
  blur: number;
  /** Background tint opacity, 0..1. */
  tint: number;
}

/** The three appearances the settings stepper moves between, lightest first. */
export const GLASS_PRESETS: GlassPreset[] = [
  { name: "Clear", blur: 0.5, tint: 0.2 },
  { name: "Normal", blur: 2, tint: 0.35 },
  { name: "Frosted", blur: 6, tint: 0.5 },
];

/** Start on the middle "Normal" appearance. */
const DEFAULT_PRESET_INDEX = 1;

interface GlassConfig {
  /** Live blur applied to glass surfaces that don't set their own. */
  blur: number;
  /** Live tint applied to glass surfaces that don't set their own. */
  tint: number;
  /** Index of the active preset in GLASS_PRESETS. */
  presetIndex: number;
  setPresetIndex: (index: number) => void;
}

const LiquidGlassContext = createContext<GlassConfig | null>(null);

export function LiquidGlassProvider({ children }: { children: ReactNode }) {
  const [presetIndex, setPresetIndex] = useState(DEFAULT_PRESET_INDEX);

  const value = useMemo<GlassConfig>(() => {
    const preset = GLASS_PRESETS[presetIndex] ?? GLASS_PRESETS[DEFAULT_PRESET_INDEX];
    return {
      blur: preset.blur,
      tint: preset.tint,
      presetIndex,
      setPresetIndex,
    };
  }, [presetIndex]);

  return (
    <LiquidGlassContext.Provider value={value}>
      {children}
    </LiquidGlassContext.Provider>
  );
}

/**
 * Read the live glass appearance. Safe to call outside the provider (falls back
 * to the default preset), so a lone <Refract> still renders sensibly.
 */
export function useLiquidGlass(): GlassConfig {
  const ctx = useContext(LiquidGlassContext);
  if (ctx) return ctx;
  const preset = GLASS_PRESETS[DEFAULT_PRESET_INDEX];
  return {
    blur: preset.blur,
    tint: preset.tint,
    presetIndex: DEFAULT_PRESET_INDEX,
    setPresetIndex: () => {},
  };
}
