import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";

import { PanelSplitter } from "@/components/layout";
import { useLayoutPreferencesStore } from "@/stores/useLayoutPreferencesStore";

const ANALYSIS_SUMMARY_ID = "analysis.summary";
const DEFAULT_SUMMARY_WIDTH = 280;
const MIN_SUMMARY_WIDTH = 240;
const MAX_SUMMARY_WIDTH = 480;
const NARROW_BREAKPOINT_QUERY = "(max-width: 900px)";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export interface AnalysisSummaryEntry {
  key: string;
  label: ReactNode;
  value: ReactNode;
}

export interface AnalysisShellProps {
  title: ReactNode;
  sourceName: ReactNode;
  summary: AnalysisSummaryEntry[];
  canEditInputs: boolean;
  onEditInputs?: () => void;
  resultsRef?: Ref<HTMLElement>;
  children: ReactNode;
}

export function AnalysisShell({
  title,
  sourceName,
  summary,
  canEditInputs,
  onEditInputs,
  resultsRef,
  children,
}: AnalysisShellProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const persistedSummaryWidth = useLayoutPreferencesStore((state) => state.sizes[ANALYSIS_SUMMARY_ID]);
  const setPanelSize = useLayoutPreferencesStore((state) => state.setPanelSize);
  const resetPanelSize = useLayoutPreferencesStore((state) => state.resetPanelSize);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [summaryWidth, setSummaryWidth] = useState(() => persistedSummaryWidth ?? DEFAULT_SUMMARY_WIDTH);
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }

    return window.matchMedia(NARROW_BREAKPOINT_QUERY).matches;
  });
  const preferredSummaryWidth = clamp(summaryWidth, MIN_SUMMARY_WIDTH, MAX_SUMMARY_WIDTH);
  const isCompact = isNarrow || (containerWidth != null && containerWidth <= 900);

  const maxSummaryWidth = containerWidth == null
    ? MAX_SUMMARY_WIDTH
    : Math.max(MIN_SUMMARY_WIDTH, Math.min(MAX_SUMMARY_WIDTH, containerWidth * 0.45));
  const effectiveSummaryWidth = containerWidth == null
    ? preferredSummaryWidth
    : clamp(summaryWidth, MIN_SUMMARY_WIDTH, maxSummaryWidth);

  const shellStyle: CSSProperties & Record<"--analysis-summary-width", string> = {
    "--analysis-summary-width": containerWidth == null
      ? `clamp(${MIN_SUMMARY_WIDTH}px, ${preferredSummaryWidth}px, min(45%, ${MAX_SUMMARY_WIDTH}px))`
      : `${effectiveSummaryWidth}px`,
  };

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

  useLayoutEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(NARROW_BREAKPOINT_QUERY);
    const applyMatch = (matches: boolean) => {
      setIsNarrow(matches);
    };
    const handleChange = (event: MediaQueryListEvent) => {
      applyMatch(event.matches);
    };

    applyMatch(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }

    mediaQuery.addListener(handleChange);
    return () => {
      mediaQuery.removeListener(handleChange);
    };
  }, []);

  const handleSummaryChange = (nextWidth: number) => {
    setSummaryWidth(clamp(nextWidth, MIN_SUMMARY_WIDTH, MAX_SUMMARY_WIDTH));
  };

  const handleSummaryCommit = (nextWidth: number) => {
    const preferredWidth = clamp(nextWidth, MIN_SUMMARY_WIDTH, MAX_SUMMARY_WIDTH);
    setSummaryWidth(preferredWidth);
    setPanelSize(ANALYSIS_SUMMARY_ID, preferredWidth);
  };

  const handleSummaryReset = () => {
    setSummaryWidth(DEFAULT_SUMMARY_WIDTH);
    resetPanelSize(ANALYSIS_SUMMARY_ID);
  };

  return (
    <div
      ref={containerRef}
      className="analysis-shell"
      data-analysis-shell-mode={isCompact ? "compact" : "desktop"}
      style={shellStyle}
    >
      <aside className="analysis-shell-info">
        <div className="analysis-shell-titlebar">{title}</div>
        <div className="analysis-shell-info-body">
          <div className="analysis-shell-source">
            <span>{t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: sourceName })}</span>
          </div>
          <dl className="analysis-shell-summary">
            {summary.map((entry) => (
              <div className="analysis-shell-summary-row" key={entry.key}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
          <button
            className="analysis-shell-edit-inputs"
            disabled={!canEditInputs}
            type="button"
            onClick={onEditInputs}
          >
            <i aria-hidden="true" className="fa-solid fa-sliders" />
            <span>{t("workspace.editInputs", { defaultValue: "Edit Inputs" })}</span>
          </button>
        </div>
      </aside>
      {isCompact ? null : (
        <div className="analysis-shell-splitter-track">
          <PanelSplitter
            orientation="vertical"
            value={effectiveSummaryWidth}
            min={MIN_SUMMARY_WIDTH}
            max={maxSummaryWidth}
            defaultValue={DEFAULT_SUMMARY_WIDTH}
            unit="px"
            label="Resize analysis summary panel"
            onChange={handleSummaryChange}
            onCommit={handleSummaryCommit}
            onReset={handleSummaryReset}
          />
        </div>
      )}
      <main className="analysis-shell-results" ref={resultsRef}>{children}</main>
    </div>
  );
}