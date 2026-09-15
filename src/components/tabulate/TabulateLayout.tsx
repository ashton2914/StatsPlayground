import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { PanelSplitter } from "@/components/layout";
import { useLayoutPreferencesStore } from "@/stores/useLayoutPreferencesStore";

import "./tabulate.css";

const TABULATE_FIELDS_ID = "tabulate.fields";
const TABULATE_CONFIGURATION_ID = "tabulate.configuration";

const FIELDS_DEFAULT_WIDTH = 300;
const FIELDS_MIN_WIDTH = 240;
const FIELDS_MAX_WIDTH = 420;
const CONFIGURATION_DEFAULT_WIDTH = 360;
const CONFIGURATION_MIN_WIDTH = 320;
const CONFIGURATION_MAX_WIDTH = 520;
const RESULTS_MIN_WIDTH = 320;
const SPLITTER_TRACK_WIDTH = 28;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function fieldsMaxWidth(containerWidth: number | null) {
  if (containerWidth == null) {
    return FIELDS_MAX_WIDTH;
  }

  return Math.max(
    FIELDS_MIN_WIDTH,
    Math.min(FIELDS_MAX_WIDTH, containerWidth - SPLITTER_TRACK_WIDTH - RESULTS_MIN_WIDTH - CONFIGURATION_MIN_WIDTH),
  );
}

function configurationMaxWidth(containerWidth: number | null) {
  if (containerWidth == null) {
    return CONFIGURATION_MAX_WIDTH;
  }

  return Math.max(
    CONFIGURATION_MIN_WIDTH,
    Math.min(CONFIGURATION_MAX_WIDTH, containerWidth - SPLITTER_TRACK_WIDTH - RESULTS_MIN_WIDTH - FIELDS_MIN_WIDTH),
  );
}

function resolveDesktopWidths(preferredFieldsWidth: number, preferredConfigurationWidth: number, containerWidth: number | null) {
  const clampedFieldsWidth = clamp(preferredFieldsWidth, FIELDS_MIN_WIDTH, fieldsMaxWidth(containerWidth));
  const clampedConfigurationWidth = clamp(
    preferredConfigurationWidth,
    CONFIGURATION_MIN_WIDTH,
    configurationMaxWidth(containerWidth),
  );

  if (containerWidth == null) {
    return {
      fieldsWidth: clampedFieldsWidth,
      configurationWidth: clampedConfigurationWidth,
    };
  }

  const availableFixedWidth = Math.max(0, containerWidth - SPLITTER_TRACK_WIDTH - RESULTS_MIN_WIDTH);
  let fieldsWidth = clampedFieldsWidth;
  let configurationWidth = clampedConfigurationWidth;

  if (fieldsWidth + configurationWidth > availableFixedWidth) {
    let overflow = fieldsWidth + configurationWidth - availableFixedWidth;

    const configurationShrink = Math.min(overflow, configurationWidth - CONFIGURATION_MIN_WIDTH);
    configurationWidth -= configurationShrink;
    overflow -= configurationShrink;

    if (overflow > 0) {
      const fieldsShrink = Math.min(overflow, fieldsWidth - FIELDS_MIN_WIDTH);
      fieldsWidth -= fieldsShrink;
    }
  }

  return {
    fieldsWidth,
    configurationWidth,
  };
}

interface TabulateLayoutProps {
  fields: ReactNode;
  configuration: ReactNode;
  results: ReactNode;
  narrow: boolean;
  className?: string;
}

type TabulateLayoutStyle = CSSProperties & {
  "--tabulate-fields-width": string;
  "--tabulate-configuration-width": string;
};

export function TabulateLayout({
  fields,
  configuration,
  results,
  narrow,
  className,
}: TabulateLayoutProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const persistedFieldsWidth = useLayoutPreferencesStore((state) => state.sizes[TABULATE_FIELDS_ID]);
  const persistedConfigurationWidth = useLayoutPreferencesStore((state) => state.sizes[TABULATE_CONFIGURATION_ID]);
  const setPanelSize = useLayoutPreferencesStore((state) => state.setPanelSize);
  const resetPanelSize = useLayoutPreferencesStore((state) => state.resetPanelSize);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [fieldsWidth, setFieldsWidth] = useState(() => persistedFieldsWidth ?? FIELDS_DEFAULT_WIDTH);
  const [configurationWidth, setConfigurationWidth] = useState(
    () => persistedConfigurationWidth ?? CONFIGURATION_DEFAULT_WIDTH,
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const applyMeasuredWidth = (nextWidth: number) => {
      if (!Number.isFinite(nextWidth)) {
        return;
      }

      setContainerWidth(nextWidth);
    };

    applyMeasuredWidth(container.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (typeof nextWidth === "number") {
        applyMeasuredWidth(nextWidth);
      }
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  const maxFieldsWidth = useMemo(() => fieldsMaxWidth(containerWidth), [containerWidth]);
  const maxConfigurationWidth = useMemo(() => configurationMaxWidth(containerWidth), [containerWidth]);
  const resolvedWidths = useMemo(
    () => resolveDesktopWidths(fieldsWidth, configurationWidth, containerWidth),
    [configurationWidth, containerWidth, fieldsWidth],
  );

  const layoutClassName = [
    "sp-tabulate-view",
    narrow ? "sp-tabulate-view--narrow" : "sp-tabulate-view--desktop",
    className,
  ].filter(Boolean).join(" ");

  const layoutStyle: TabulateLayoutStyle | undefined = narrow
    ? undefined
    : {
        "--tabulate-fields-width": `${resolvedWidths.fieldsWidth}px`,
        "--tabulate-configuration-width": `${resolvedWidths.configurationWidth}px`,
      };

  const handleFieldsChange = (nextWidth: number) => {
    setFieldsWidth(clamp(nextWidth, FIELDS_MIN_WIDTH, FIELDS_MAX_WIDTH));
  };

  const handleFieldsCommit = (nextWidth: number) => {
    const preferredWidth = clamp(nextWidth, FIELDS_MIN_WIDTH, FIELDS_MAX_WIDTH);
    setFieldsWidth(preferredWidth);
    setPanelSize(TABULATE_FIELDS_ID, preferredWidth);
  };

  const handleFieldsReset = () => {
    setFieldsWidth(FIELDS_DEFAULT_WIDTH);
    resetPanelSize(TABULATE_FIELDS_ID);
  };

  const handleConfigurationChange = (nextWidth: number) => {
    setConfigurationWidth(clamp(nextWidth, CONFIGURATION_MIN_WIDTH, CONFIGURATION_MAX_WIDTH));
  };

  const handleConfigurationCommit = (nextWidth: number) => {
    const preferredWidth = clamp(nextWidth, CONFIGURATION_MIN_WIDTH, CONFIGURATION_MAX_WIDTH);
    setConfigurationWidth(preferredWidth);
    setPanelSize(TABULATE_CONFIGURATION_ID, preferredWidth);
  };

  const handleConfigurationReset = () => {
    setConfigurationWidth(CONFIGURATION_DEFAULT_WIDTH);
    resetPanelSize(TABULATE_CONFIGURATION_ID);
  };

  if (narrow) {
    return (
      <div ref={containerRef} className={layoutClassName}>
        {fields}
        {configuration}
        {results}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={layoutClassName} style={layoutStyle}>
      {fields}
      <div className="sp-tabulate-splitter-track">
        <PanelSplitter
          orientation="vertical"
          value={resolvedWidths.fieldsWidth}
          min={FIELDS_MIN_WIDTH}
          max={maxFieldsWidth}
          defaultValue={FIELDS_DEFAULT_WIDTH}
          unit="px"
          label="Resize tabulate fields panel"
          onChange={handleFieldsChange}
          onCommit={handleFieldsCommit}
          onReset={handleFieldsReset}
        />
      </div>
      {configuration}
      <div className="sp-tabulate-splitter-track">
        <PanelSplitter
          orientation="vertical"
          value={resolvedWidths.configurationWidth}
          min={CONFIGURATION_MIN_WIDTH}
          max={maxConfigurationWidth}
          defaultValue={CONFIGURATION_DEFAULT_WIDTH}
          unit="px"
          label="Resize tabulate configuration panel"
          onChange={handleConfigurationChange}
          onCommit={handleConfigurationCommit}
          onReset={handleConfigurationReset}
        />
      </div>
      {results}
    </div>
  );
}