import { useState } from "react";

import { TabulateLayout } from "../src/components/tabulate/TabulateLayout.tsx";

interface TabulateLayoutHarnessProps {
  containerWidth?: number;
  narrow?: boolean;
}

export function TabulateLayoutHarness({
  containerWidth = 1280,
  narrow = false,
}: TabulateLayoutHarnessProps) {
  const [width, setWidth] = useState(containerWidth);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button type="button" data-testid="shrink-container" onClick={() => setWidth(980)}>
          Shrink container
        </button>
        <output data-testid="container-width">{width}</output>
      </div>
      <div data-testid="tabulate-layout-harness" style={{ width, height: 640 }}>
        <TabulateLayout
          narrow={narrow}
          fields={<section className="sp-tabulate-fields-column" data-testid="fields-slot"><div style={{ width: "100%", height: "100%" }} /></section>}
          configuration={<section className="sp-tabulate-roles-column" data-testid="configuration-slot"><div style={{ width: "100%", height: "100%" }} /></section>}
          results={<section className="sp-tabulate-results-column" data-testid="results-slot"><div style={{ width: "100%", height: "100%" }} /></section>}
        />
      </div>
    </div>
  );
}