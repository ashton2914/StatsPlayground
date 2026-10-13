import { cloneElement, isValidElement, type ReactNode, type ReactElement } from "react";
interface OptionsEditorProps { options: Record<string, unknown>; onChange: (patch: Record<string, unknown>) => void; t: (key: string, opts?: Record<string, unknown>) => string; disabled?: boolean }
function getOpt<T>(options: Record<string, unknown>, key: string, fallback: T): T { return options[key] === undefined ? fallback : options[key] as T; }
function OptRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="gb-opt-row">
      <span className="gb-opt-label">{label}</span>
      <span className="gb-opt-ctrl">{isValidElement(children) ? cloneElement(children as ReactElement<{ "aria-label"?: string }>, { "aria-label": label }) : children}</span>
    </label>
  );
}

export function PointsOptions({ options, onChange, t, disabled = false }: OptionsEditorProps) {
  const summary = getOpt<string>(options, "summaryStat", "none");
  const errInterval = getOpt<string>(options, "errorInterval", "auto");
  const intStyle = getOpt<string>(options, "intervalStyle", "errorBar");
  // Default is "stacked" — "auto" remains a legacy value (older specs).
  // The renderer treats both the same; here we only need to make sure
  // the <select> shows a sensible selection for legacy values too, so
  // collapse "auto" → "stacked" for the dropdown's selected value.
  const jitterRaw = getOpt<string>(options, "jitter", "stacked");
  const jitter = jitterRaw === "auto" ? "stacked" : jitterRaw;
  const jitterLimit = getOpt<number>(options, "jitterLimit", 0.5);
  return (
    <>
      <OptRow label={t("graph.opt.summaryStat")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={summary}
          onChange={(e) => onChange({ summaryStat: e.target.value })}
        >
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="mean">{t("graph.opt.summary.mean")}</option>
          <option value="median">{t("graph.opt.summary.median")}</option>
          <option value="sum">{t("graph.opt.summary.sum")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.errorInterval")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={errInterval}
          onChange={(e) => onChange({ errorInterval: e.target.value })}
        >
          <option value="auto">{t("graph.opt.auto")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="stdErr">{t("graph.opt.interval.stdErr")}</option>
          <option value="stdDev">{t("graph.opt.interval.stdDev")}</option>
          <option value="ci95">{t("graph.opt.interval.ci95")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.intervalStyle")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={intStyle}
          onChange={(e) => onChange({ intervalStyle: e.target.value })}
        >
          <option value="errorBar">{t("graph.opt.style.errorBar")}</option>
          <option value="band">{t("graph.opt.style.band")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.jitter")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={jitter}
          onChange={(e) => onChange({ jitter: e.target.value })}
        >
          <option value="stacked">{t("graph.opt.jitterMode.stacked")}</option>
          <option value="uniform">{t("graph.opt.jitterMode.uniform")}</option>
          <option value="normal">{t("graph.opt.jitterMode.normal")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.jitterLimit")}>
        <input
          disabled={disabled}
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={jitterLimit}
          onChange={(e) => onChange({ jitterLimit: parseFloat(e.target.value) })}
          className="gb-slider"
        />
      </OptRow>
    </>
  );
}

export function LineOptions({ options, onChange, t, disabled = false }: OptionsEditorProps) {
  const rowOrder = getOpt<boolean>(options, "rowOrder", false);
  const connection = getOpt<string>(options, "connection", "line");
  const summary = getOpt<string>(options, "summaryStat", "mean");
  const fill = getOpt<string>(options, "fill", "none");
  const errInterval = getOpt<string>(options, "errorInterval", "auto");
  const intStyle = getOpt<string>(options, "intervalStyle", "errorBar");
  const missingFactors = getOpt<string>(options, "missingFactors", "skip");
  const missingValues = getOpt<string>(options, "missingValues", "connect");
  return (
    <>
      <OptRow label={t("graph.opt.rowOrder")}>
        <input
          disabled={disabled}
          type="checkbox"
          checked={rowOrder}
          onChange={(e) => onChange({ rowOrder: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.connection")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={connection}
          onChange={(e) => onChange({ connection: e.target.value })}
        >
          <option value="line">{t("graph.opt.conn.line")}</option>
          <option value="step">{t("graph.opt.conn.step")}</option>
          <option value="spline">{t("graph.opt.conn.spline")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.summaryStat")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={summary}
          onChange={(e) => onChange({ summaryStat: e.target.value })}
        >
          <option value="mean">{t("graph.opt.summary.mean")}</option>
          <option value="median">{t("graph.opt.summary.median")}</option>
          <option value="sum">{t("graph.opt.summary.sum")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.fill")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={fill}
          onChange={(e) => onChange({ fill: e.target.value })}
        >
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="toZero">{t("graph.opt.fillMode.toZero")}</option>
          <option value="between">{t("graph.opt.fillMode.between")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.errorInterval")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={errInterval}
          onChange={(e) => onChange({ errorInterval: e.target.value })}
        >
          <option value="auto">{t("graph.opt.auto")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="stdErr">{t("graph.opt.interval.stdErr")}</option>
          <option value="stdDev">{t("graph.opt.interval.stdDev")}</option>
          <option value="ci95">{t("graph.opt.interval.ci95")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.intervalStyle")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={intStyle}
          onChange={(e) => onChange({ intervalStyle: e.target.value })}
        >
          <option value="errorBar">{t("graph.opt.style.errorBar")}</option>
          <option value="band">{t("graph.opt.style.band")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.missingFactors")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={missingFactors}
          onChange={(e) => onChange({ missingFactors: e.target.value })}
        >
          <option value="skip">{t("graph.opt.missing.skip")}</option>
          <option value="include">{t("graph.opt.missing.include")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.missingValues")}>
        <select
          disabled={disabled}
          className="gb-opt-select"
          value={missingValues}
          onChange={(e) => onChange({ missingValues: e.target.value })}
        >
          <option value="connect">{t("graph.opt.missing.connect")}</option>
          <option value="break">{t("graph.opt.missing.break")}</option>
        </select>
      </OptRow>
    </>
  );
}
