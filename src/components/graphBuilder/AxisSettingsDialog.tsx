import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AutoSpec, GridLineStyle, RefLineStyle, RefLineX, RefLineY, YAxisConfig } from "@/graphCore";

export type AxisName = "x" | "y";

export interface AxisSettingsDialogProps {
  axis: AxisName;
  refLines?: RefLineX[] | RefLineY[];
  setRefLines?: ((next: RefLineX[]) => void) | ((next: RefLineY[]) => void);
  autoSpecLines?: boolean;
  setAutoSpecLines?: (next: boolean) => void;
  resolvedAutoSpec?: AutoSpec;
  autoSpecColName?: string;
  multiValueColCount?: number;
  axisConfig: YAxisConfig | undefined;
  setAxisConfig: (next: YAxisConfig | undefined) => void;
  onClose: () => void;
}

type AxisCategoryKey = "axis" | "tickGrid" | "refLines";

function isGridLineStyleEmpty(style: GridLineStyle | undefined): boolean {
  if (!style) return true;
  return style.color === undefined && style.width === undefined && style.style === undefined;
}

export function isAxisConfigEmpty(config: YAxisConfig | undefined): boolean {
  if (!config) return true;
  return config.min === undefined
    && config.max === undefined
    && config.tickInterval === undefined
    && config.decimals === undefined
    && (config.inverse === undefined || config.inverse === false)
    && (config.minorTickCount === undefined || config.minorTickCount === 0)
    && config.showAxisLine === undefined
    && config.tickPosition === undefined
    && config.showMajorGrid === undefined
    && config.showMinorGrid === undefined
    && isGridLineStyleEmpty(config.majorGridStyle)
    && isGridLineStyleEmpty(config.minorGridStyle);
}

export function AxisSettingsDialog({
  axis, refLines, setRefLines, autoSpecLines, setAutoSpecLines,
  resolvedAutoSpec, autoSpecColName, multiValueColCount,
  axisConfig, setAxisConfig, onClose,
}: AxisSettingsDialogProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState<AxisCategoryKey>("axis");
  const titleKey = axis === "y" ? "graph.yAxisSettings.title" : "graph.xAxisSettings.title";
  const titleFallback = axis === "y" ? "Y Axis Settings" : "X Axis Settings";
  const categories: { key: AxisCategoryKey; label: string }[] = [
    { key: "axis", label: t("graph.yAxisSettings.categoryAxis", { defaultValue: "Axis" }) },
    { key: "tickGrid", label: t("graph.yAxisSettings.categoryTickGrid", { defaultValue: "Tick Grid" }) },
    { key: "refLines", label: t("graph.yAxisSettings.categoryRefLines", { defaultValue: "Reference Lines" }) },
  ];
  return (
    <div className="sp-dialog-overlay" onClick={onClose}>
      <div className="sp-dialog sp-dialog-wide pref-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="sp-dialog-title">{t(titleKey, { defaultValue: titleFallback })}</div>
        <div className="sp-dialog-body pref-body">
          <nav className="pref-nav">
            {categories.map((category) => <button key={category.key} type="button" className={`pref-nav-item${active === category.key ? " pref-nav-item-active" : ""}`} onClick={() => setActive(category.key)}>{category.label}</button>)}
          </nav>
          <div className="pref-pane">
            {active === "axis" && <AxisSettingsEditor config={axisConfig} setConfig={setAxisConfig} />}
            {active === "tickGrid" && <GridSettingsEditor config={axisConfig} setConfig={setAxisConfig} />}
            {active === "refLines" && refLines && setRefLines && <RefLinesEditor axis={axis} refLines={refLines} setRefLines={setRefLines} autoSpecLines={!!autoSpecLines} setAutoSpecLines={setAutoSpecLines} resolvedAutoSpec={resolvedAutoSpec} autoSpecColName={autoSpecColName} multiValueColCount={multiValueColCount} />}
          </div>
        </div>
        <div className="sp-dialog-actions"><button className="sp-dialog-btn sp-dialog-btn-primary" onClick={onClose}>{t("prefs.done")}</button></div>
      </div>
    </div>
  );
}

interface EditorProps {
  config: YAxisConfig | undefined;
  setConfig: (next: YAxisConfig | undefined) => void;
}

function DecimalTextInput({ value, onChange, placeholder, className, ariaLabel }: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value !== undefined ? String(value) : "");
  useEffect(() => {
    const trimmed = text.trim();
    const parsed = trimmed === "" ? undefined : Number(trimmed);
    if (parsed !== value) setText(value !== undefined ? String(value) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <input type="text" inputMode="decimal" className={className} value={text} placeholder={placeholder} aria-label={ariaLabel} onChange={(event) => {
    const nextText = event.target.value;
    setText(nextText);
    const trimmed = nextText.trim();
    if (trimmed === "") { onChange(undefined); return; }
    const nextValue = Number(trimmed);
    if (Number.isFinite(nextValue) && nextValue > 0) onChange(nextValue);
  }} />;
}

function AxisSettingsEditor({ config, setConfig }: EditorProps) {
  const { t } = useTranslation();
  const current = config ?? {};
  const patch = useCallback((next: Partial<YAxisConfig>) => {
    const merged = { ...current, ...next };
    setConfig(isAxisConfigEmpty(merged) ? undefined : merged);
  }, [current, setConfig]);
  const parseNum = (value: string): number | undefined => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const parseInt0 = (value: string, min: number, max: number): number | undefined => {
    const parsed = parseNum(value);
    return parsed === undefined ? undefined : Math.max(min, Math.min(max, Math.round(parsed)));
  };
  return (
    <div className="gb-axis-editor">
      <div className="gb-axis-header"><span className="gb-axis-title">{t("graph.axis.title", { defaultValue: "Axis" })}</span><button type="button" className="gb-axis-reset" onClick={() => setConfig(undefined)} disabled={isAxisConfigEmpty(current)} title={t("graph.axis.resetHint", { defaultValue: "Restore fully automatic axis behavior" })}>{t("graph.axis.reset", { defaultValue: "Reset to default" })}</button></div>
      <div className="gb-axis-row"><label className="gb-axis-label">{t("graph.axis.range", { defaultValue: "Range" })}</label><div className="gb-axis-range"><input type="number" className="gb-axis-num" value={current.min ?? ""} step="any" placeholder={t("graph.axis.auto", { defaultValue: "Auto" })} onChange={(event) => patch({ min: parseNum(event.target.value) })} aria-label={t("graph.axis.min", { defaultValue: "Min" })} title={t("graph.axis.min", { defaultValue: "Min" })} /><span className="gb-axis-range-sep">—</span><input type="number" className="gb-axis-num" value={current.max ?? ""} step="any" placeholder={t("graph.axis.auto", { defaultValue: "Auto" })} onChange={(event) => patch({ max: parseNum(event.target.value) })} aria-label={t("graph.axis.max", { defaultValue: "Max" })} title={t("graph.axis.max", { defaultValue: "Max" })} /></div></div>
      <div className="gb-axis-row"><label className="gb-axis-label">{t("graph.axis.tickInterval", { defaultValue: "Tick interval" })}</label><DecimalTextInput className="gb-axis-num gb-axis-num-narrow" value={current.tickInterval} placeholder={t("graph.axis.auto", { defaultValue: "Auto" })} ariaLabel={t("graph.axis.tickInterval", { defaultValue: "Tick interval" })} onChange={(value) => patch({ tickInterval: value })} /></div>
      <div className="gb-axis-row"><label className="gb-axis-label">{t("graph.axis.decimals", { defaultValue: "Decimals" })}</label><input type="number" className="gb-axis-num gb-axis-num-narrow" value={current.decimals ?? ""} step={1} min={0} max={10} placeholder={t("graph.axis.auto", { defaultValue: "Auto" })} onChange={(event) => patch({ decimals: parseInt0(event.target.value, 0, 10) })} /></div>
      <div className="gb-axis-row"><label className="gb-axis-label">{t("graph.axis.minorTickCount", { defaultValue: "Minor ticks" })}</label><input type="number" className="gb-axis-num gb-axis-num-narrow" value={current.minorTickCount ?? ""} step={1} min={0} max={20} placeholder={t("graph.axis.none", { defaultValue: "None" })} onChange={(event) => { const value = parseInt0(event.target.value, 0, 20); patch({ minorTickCount: value && value > 0 ? value : undefined }); }} /></div>
      <div className="gb-axis-row"><label className="gb-axis-label gb-axis-label-checkbox"><input type="checkbox" checked={current.inverse === true} onChange={(event) => patch({ inverse: event.target.checked ? true : undefined })} /><span>{t("graph.axis.inverse", { defaultValue: "Reverse axis direction" })}</span></label></div>
      <div className="gb-axis-row"><label className="gb-axis-label gb-axis-label-checkbox"><input type="checkbox" checked={current.showAxisLine !== false} onChange={(event) => patch({ showAxisLine: event.target.checked ? undefined : false, tickPosition: event.target.checked ? current.tickPosition : undefined })} /><span>{t("graph.axis.showAxisLine", { defaultValue: "Show axis line & ticks" })}</span></label></div>
      <div className="gb-axis-row"><label className="gb-axis-label">{t("graph.axis.tickPosition", { defaultValue: "Tick position" })}</label><div className="gb-axis-radio-group">{(["outside", "inside"] as const).map((position) => { const disabled = current.showAxisLine === false; return <label key={position} className={`gb-axis-radio${disabled ? " gb-axis-radio-disabled" : ""}`}><input type="radio" name="gb-axis-tick-pos" value={position} checked={(current.tickPosition ?? "outside") === position} disabled={disabled} onChange={() => patch({ tickPosition: position === "outside" ? undefined : "inside" })} /><span>{position === "outside" ? t("graph.axis.tickOutside", { defaultValue: "Outside" }) : t("graph.axis.tickInside", { defaultValue: "Inside" })}</span></label>; })}</div></div>
    </div>
  );
}

const GRID_LINE_DEFAULT_COLOR_MAJOR = "#bdbdbd";
const GRID_LINE_DEFAULT_COLOR_MINOR = "#e2e2e2";
const GRID_LINE_DEFAULT_WIDTH = 1;
const GRID_LINE_DEFAULT_STYLE: RefLineStyle = "dashed";
const GRID_LINE_PRESETS: readonly string[] = ["#e2e2e2", "#bdbdbd", "#757575", "#000000", "#4a6cf7", "#2ca678", "#ef8a3a", "#e74c3c"];
const GRID_LINE_THEMES: readonly { major: string; minor: string }[] = [
  { major: GRID_LINE_DEFAULT_COLOR_MAJOR, minor: GRID_LINE_DEFAULT_COLOR_MINOR },
  { major: "#757575", minor: "#bdbdbd" }, { major: "#455a64", minor: "#b0bec5" },
  { major: "#1976d2", minor: "#bbdefb" }, { major: "#2e7d32", minor: "#c8e6c9" },
  { major: "#f57c00", minor: "#ffe0b2" }, { major: "#c62828", minor: "#ffcdd2" },
  { major: "#6a1b9a", minor: "#e1bee7" },
];

function GridSettingsEditor({ config, setConfig }: EditorProps) {
  const { t } = useTranslation();
  const current = config ?? {};
  const patch = useCallback((next: Partial<YAxisConfig>) => { const merged = { ...current, ...next }; setConfig(isAxisConfigEmpty(merged) ? undefined : merged); }, [current, setConfig]);
  const patchStyle = useCallback((which: "major" | "minor", next: Partial<GridLineStyle>) => {
    const key = which === "major" ? "majorGridStyle" : "minorGridStyle";
    const style = (which === "major" ? current.majorGridStyle : current.minorGridStyle) ?? {};
    const merged = { ...style, ...next };
    patch({ [key]: isGridLineStyleEmpty(merged) ? undefined : merged });
  }, [current.majorGridStyle, current.minorGridStyle, patch]);
  const applyGridTheme = useCallback((index: number) => {
    const theme = GRID_LINE_THEMES[index];
    if (!theme) return;
    const writeColor = (style: GridLineStyle | undefined, color: string) => { const merged = { ...(style ?? {}), color: index === 0 ? undefined : color }; return isGridLineStyleEmpty(merged) ? undefined : merged; };
    patch({ majorGridStyle: writeColor(current.majorGridStyle, theme.major), minorGridStyle: writeColor(current.minorGridStyle, theme.minor) });
  }, [current.majorGridStyle, current.minorGridStyle, patch]);
  const gridEmpty = current.showMajorGrid === undefined && current.showMinorGrid === undefined && isGridLineStyleEmpty(current.majorGridStyle) && isGridLineStyleEmpty(current.minorGridStyle);
  const renderGridSection = (which: "major" | "minor") => {
    const isMajor = which === "major";
    const shown = isMajor ? (current.showMajorGrid ?? false) : (current.showMinorGrid ?? false);
    const style = (isMajor ? current.majorGridStyle : current.minorGridStyle) ?? {};
    const defaultColor = isMajor ? GRID_LINE_DEFAULT_COLOR_MAJOR : GRID_LINE_DEFAULT_COLOR_MINOR;
    const color = style.color ?? defaultColor;
    return <div className={`gb-grid-section${shown ? "" : " gb-grid-section-off"}`}><label className="gb-axis-label-checkbox gb-grid-section-toggle"><input type="checkbox" checked={shown} onChange={(event) => patch({ [isMajor ? "showMajorGrid" : "showMinorGrid"]: event.target.checked || undefined })} /><span className="gb-grid-section-label">{isMajor ? t("graph.grid.showMajor", { defaultValue: "Major gridlines" }) : t("graph.grid.showMinor", { defaultValue: "Minor gridlines" })}</span></label><div className="gb-grid-style-row"><div className="gb-refline-swatch-row gb-grid-swatch-row">{GRID_LINE_PRESETS.map((preset) => { const selected = color.toLowerCase() === preset.toLowerCase(); return <button key={preset} type="button" className={`gb-refline-swatch${selected ? " gb-refline-swatch-selected" : ""}`} style={{ background: preset }} disabled={!shown} onClick={() => patchStyle(which, { color: preset === defaultColor ? undefined : preset })} title={preset} aria-label={preset} aria-pressed={selected} />; })}<span className="gb-refline-swatch-divider" /><input type="color" className={`gb-refline-color-picker${GRID_LINE_PRESETS.some((preset) => preset.toLowerCase() === color.toLowerCase()) ? "" : " gb-refline-color-picker-active"}`} value={color} disabled={!shown} onChange={(event) => patchStyle(which, { color: event.target.value === defaultColor ? undefined : event.target.value })} title={t("graph.refLine.customColor", { defaultValue: "Custom color" })} aria-label={t("graph.refLine.customColor", { defaultValue: "Custom color" })} /></div><div className="gb-grid-line-row"><select className="gb-grid-dash" value={style.style ?? GRID_LINE_DEFAULT_STYLE} disabled={!shown} onChange={(event) => patchStyle(which, { style: event.target.value as RefLineStyle })} title={t("graph.grid.style", { defaultValue: "Line style" })} aria-label={t("graph.grid.style", { defaultValue: "Line style" })}><option value="solid">{t("graph.refLine.styleSolid", { defaultValue: "Solid" })}</option><option value="dashed">{t("graph.refLine.styleDashed", { defaultValue: "Dashed" })}</option><option value="dotted">{t("graph.refLine.styleDotted", { defaultValue: "Dotted" })}</option></select><input type="number" className="gb-grid-width" value={style.width ?? GRID_LINE_DEFAULT_WIDTH} disabled={!shown} min={0.5} max={5} step={0.5} onChange={(event) => { const width = Number(event.target.value); patchStyle(which, { width: Number.isFinite(width) && width > 0 ? width : undefined }); }} title={t("graph.grid.width", { defaultValue: "Width" })} aria-label={t("graph.grid.width", { defaultValue: "Width" })} /></div></div></div>;
  };
  return <div className="gb-axis-editor"><div className="gb-axis-header"><span className="gb-axis-title">{t("graph.grid.title", { defaultValue: "Tick Grid" })}</span><button type="button" className="gb-axis-reset" onClick={() => patch({ showMajorGrid: undefined, showMinorGrid: undefined, majorGridStyle: undefined, minorGridStyle: undefined })} disabled={gridEmpty} title={t("graph.grid.resetHint", { defaultValue: "Restore default grid display" })}>{t("graph.axis.reset", { defaultValue: "Reset to default" })}</button></div><div className="gb-grid-theme-row" title={t("graph.grid.themeHint", { defaultValue: "Set major and minor gridline colors at once" })}><span className="gb-grid-theme-label">{t("graph.grid.theme", { defaultValue: "Theme" })}</span><div className="gb-grid-theme-swatches">{GRID_LINE_THEMES.map((theme, index) => { const selected = (current.majorGridStyle?.color ?? GRID_LINE_DEFAULT_COLOR_MAJOR).toLowerCase() === theme.major.toLowerCase() && (current.minorGridStyle?.color ?? GRID_LINE_DEFAULT_COLOR_MINOR).toLowerCase() === theme.minor.toLowerCase(); return <button key={theme.major} type="button" className={`gb-refline-swatch${selected ? " gb-refline-swatch-selected" : ""}`} style={{ background: `linear-gradient(90deg, ${theme.major} 0 50%, ${theme.minor} 50% 100%)` }} title={`${theme.major} / ${theme.minor}`} aria-label={`${theme.major} / ${theme.minor}`} aria-pressed={selected} onClick={() => applyGridTheme(index)} />; })}</div></div>{renderGridSection("major")}{renderGridSection("minor")}<div className="gb-grid-hint">{t("graph.grid.minorHint", { defaultValue: "Minor gridlines require at least one minor tick. Set Minor ticks in the Axis tab first." })}</div></div>;
}

interface RefLinesEditorProps {
  axis: AxisName;
  refLines: RefLineX[] | RefLineY[];
  setRefLines: ((next: RefLineX[]) => void) | ((next: RefLineY[]) => void);
  autoSpecLines?: boolean;
  setAutoSpecLines?: (next: boolean) => void;
  resolvedAutoSpec?: AutoSpec;
  autoSpecColName?: string;
  multiValueColCount?: number;
}

const REF_LINE_PRESETS: readonly string[] = ["#E60000", "#FF6F00", "#FFC400", "#76FF03", "#00C853", "#00B0FF", "#2962FF", "#6200EA", "#D500F9", "#000000"];
const REF_LINE_DEFAULT_COLOR = REF_LINE_PRESETS[0];
let refLineSequence = 0;
function nextRefLineId(): string { refLineSequence += 1; return `rl-${Date.now().toString(36)}-${refLineSequence}`; }

function RefLinesEditor(props: RefLinesEditorProps) {
  const { t } = useTranslation();
  const { axis, autoSpecLines, setAutoSpecLines, resolvedAutoSpec, autoSpecColName, multiValueColCount } = props;
  const lines = props.refLines as Array<RefLineX | RefLineY>;
  const setLines = (next: Array<RefLineX | RefLineY>) => { if (axis === "x") (props.setRefLines as (value: RefLineX[]) => void)(next as RefLineX[]); else (props.setRefLines as (value: RefLineY[]) => void)(next as RefLineY[]); };
  const readValue = (line: RefLineX | RefLineY) => "x" in line ? line.x : line.y;
  const writeValue = (value: number) => axis === "x" ? { x: value } : { y: value };
  const addLine = useCallback(() => { const base = { id: nextRefLineId(), label: "", style: "dashed" as const, color: REF_LINE_DEFAULT_COLOR, width: 1 }; setLines([...lines, axis === "x" ? { ...base, x: 0 } : { ...base, y: 0 }]); }, [axis, lines]);
  const updateLine = useCallback((id: string, patch: Partial<RefLineX> | Partial<RefLineY>) => setLines(lines.map((line) => line.id === id ? { ...line, ...patch } as RefLineX | RefLineY : line)), [lines]);
  const removeLine = useCallback((id: string) => setLines(lines.filter((line) => line.id !== id)), [lines]);
  const autoChips: { key: "lsl" | "target" | "usl"; value: number; color: string; label: string }[] = [];
  if (autoSpecLines && resolvedAutoSpec) {
    if (resolvedAutoSpec.lsl !== undefined) autoChips.push({ key: "lsl", value: resolvedAutoSpec.lsl, color: "#E60000", label: "LSL" });
    if (resolvedAutoSpec.target !== undefined) autoChips.push({ key: "target", value: resolvedAutoSpec.target, color: "#00C853", label: "Target" });
    if (resolvedAutoSpec.usl !== undefined) autoChips.push({ key: "usl", value: resolvedAutoSpec.usl, color: "#E60000", label: "USL" });
  }
  const axisColCopy = axis.toUpperCase();
  return <div className="gb-refline-editor">
    {setAutoSpecLines && <div className="gb-refline-auto-block"><label className="gb-refline-auto-toggle"><input type="checkbox" checked={!!autoSpecLines} onChange={(event) => setAutoSpecLines(event.target.checked)} /><span>{t("graph.refLine.autoSpec", { defaultValue: "Auto-show spec limits" })}</span></label><div className="gb-refline-auto-hint">{autoSpecLines ? multiValueColCount && multiValueColCount > 0 ? t("graph.refLine.autoSpecMulti", { defaultValue: "Drawing per-column spec lines from {{n}} multi-mode columns.", n: multiValueColCount }) : autoChips.length > 0 ? t("graph.refLine.autoSpecActive", { defaultValue: "Reading limits from {{col}}.", col: autoSpecColName ?? "" }) : autoSpecColName ? t("graph.refLine.autoSpecMissing", { defaultValue: "The {{axis}} column \"{{col}}\" has no spec extras (LSL / Target / USL).", axis: axisColCopy, col: autoSpecColName }) : t("graph.refLine.autoSpecNoCol", { defaultValue: "Drop a column on {{axis}} to read its spec limits.", axis: axisColCopy }) : multiValueColCount && multiValueColCount > 0 ? t("graph.refLine.autoSpecHintMulti", { defaultValue: "Read each multi-mode column's LSL / Target / USL and overlay them as per-column reference lines on the {{axis}} axis.", axis: axisColCopy }) : t("graph.refLine.autoSpecHint", { defaultValue: "Read LSL / Target / USL from the {{axis}} column's spec extras and overlay them as colored reference lines.", axis: axisColCopy })}</div>{autoChips.length > 0 && <div className="gb-refline-auto-chips">{autoChips.map((chip) => <span key={chip.key} className="gb-refline-auto-chip" style={{ borderColor: chip.color, color: chip.color }} title={`${chip.label} = ${chip.value}`}><span className="gb-refline-auto-chip-dash" style={{ background: chip.color }} />{chip.label} = {chip.value}</span>)}</div>}</div>}
    <div className="gb-refline-header"><span className="gb-refline-title">{t("graph.refLine.title", { defaultValue: "Reference Lines" })}</span><button type="button" className="gb-refline-add" onClick={addLine}>+ {t("graph.refLine.add", { defaultValue: "Add reference line" })}</button></div>
    {lines.length === 0 ? <div className="gb-refline-empty">{axis === "y" ? t("graph.refLine.emptyY", { defaultValue: "No reference lines yet. Click “Add reference line” to draw a horizontal marker on the Y axis." }) : t("graph.refLine.emptyX", { defaultValue: "No reference lines yet. Click “Add reference line” to draw a vertical marker on the X axis." })}</div> : <div className="gb-refline-list">{lines.map((line) => {
      const currentHex = normalizeHex(line.color);
      const isCustom = !REF_LINE_PRESETS.some((preset) => preset.toLowerCase() === currentHex.toLowerCase());
      return <div key={line.id} className="gb-refline-card"><div className="gb-refline-swatch-row">{REF_LINE_PRESETS.map((preset) => { const selected = preset.toLowerCase() === currentHex.toLowerCase(); return <button key={preset} type="button" className={`gb-refline-swatch${selected ? " gb-refline-swatch-selected" : ""}`} style={{ background: preset }} onClick={() => updateLine(line.id, { color: preset })} title={preset} aria-label={preset} aria-pressed={selected} />; })}<span className="gb-refline-swatch-divider" /><input type="color" className={`gb-refline-color-picker${isCustom ? " gb-refline-color-picker-active" : ""}`} value={currentHex} onChange={(event) => updateLine(line.id, { color: event.target.value })} title={t("graph.refLine.customColor", { defaultValue: "Custom color" })} /></div><div className="gb-refline-form-row"><input type="text" className="gb-refline-label-input" value={line.label} placeholder={t("graph.refLine.label", { defaultValue: "Label" })} onChange={(event) => updateLine(line.id, { label: event.target.value })} /><input type="number" className="gb-refline-num" value={Number.isFinite(readValue(line)) ? readValue(line) : 0} step="any" onChange={(event) => { const value = Number(event.target.value); updateLine(line.id, writeValue(Number.isFinite(value) ? value : 0)); }} /><select className="gb-refline-style" value={line.style} onChange={(event) => updateLine(line.id, { style: event.target.value as RefLineStyle })}><option value="solid">{t("graph.refLine.styleSolid", { defaultValue: "Solid" })}</option><option value="dashed">{t("graph.refLine.styleDashed", { defaultValue: "Dashed" })}</option><option value="dotted">{t("graph.refLine.styleDotted", { defaultValue: "Dotted" })}</option></select><input type="number" className="gb-refline-width" value={line.width} min={1} max={10} step={0.5} onChange={(event) => { const width = Number(event.target.value); updateLine(line.id, { width: Number.isFinite(width) && width > 0 ? width : 1 }); }} /><button type="button" className="gb-refline-remove" onClick={() => removeLine(line.id)} title={t("graph.refLine.remove", { defaultValue: "Remove" })} aria-label={t("graph.refLine.remove", { defaultValue: "Remove" })}>×</button></div></div>;
    })}</div>}
  </div>;
}

function normalizeHex(color: string | undefined): string {
  if (!color) return "#888888";
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const red = trimmed[1], green = trimmed[2], blue = trimmed[3];
    return `#${red}${red}${green}${green}${blue}${blue}`;
  }
  return "#888888";
}
