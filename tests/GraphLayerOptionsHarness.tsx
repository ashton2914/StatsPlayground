import { useEffect, useState } from "react";
import { PointsOptions, LineOptions } from "../src/components/graphBuilder/shared/GraphLayerOptions";
import i18n from "../src/i18n";
export function GraphLayerOptionsHarness({ locale = "en", disabled = false }: { locale?: string; disabled?: boolean }) {
  const [ready, setReady] = useState(false);
  const [options, setOptions] = useState<Record<string, unknown>>({});
  useEffect(() => { void i18n.changeLanguage(locale).then(() => setReady(true)); }, [locale]);
  if (!ready) return null;
  return <><section aria-label="Scatter"><PointsOptions options={options} onChange={(patch) => setOptions({ ...options, ...patch })} t={i18n.t.bind(i18n)} disabled={disabled}/></section><section aria-label="Line"><LineOptions options={{}} onChange={() => {}} t={i18n.t.bind(i18n)} disabled={disabled}/></section><output>{JSON.stringify(options)}</output></>;
}
