import { useMemo, useState } from "react";

import { FilterPanel } from "../src/components/filter";
import type { FieldRef, GraphData } from "../src/graphCore";
import type { TableFilterValue } from "../src/types/data";
import type { FilterRuleItem } from "../src/types/filter";

type HarnessVariant = "table" | "local";

const filterField: FieldRef = {
  name: "Build",
  type: "nominal",
};

const filterColumns: FieldRef[] = [filterField];

const localData: GraphData = {
  columns: ["Build"],
  rows: [["DV"], ["EV"], ["EV"], [null]],
};

const baseRemoteValues: TableFilterValue[] = [
  { value: "", rowCount: 2 },
  { value: "DV", rowCount: 24 },
  { value: "EV", rowCount: 76 },
];

function filterRemoteValues(search: string): TableFilterValue[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return baseRemoteValues;
  return baseRemoteValues.filter(({ value }) => {
    const label = value === "" ? "blank" : value.toLowerCase();
    return label.includes(needle);
  });
}

function createInitialRule(variant: HarnessVariant): FilterRuleItem {
  return {
    id: `${variant}-build-filter`,
    op: "AND",
    rule: {
      kind: "categorical",
      field: filterField,
      selected: variant === "table" ? ["EV"] : [],
      exclude: variant !== "table",
    },
  };
}

export function FilterValueCountsHarness({
  variant,
}: {
  variant: HarnessVariant;
}) {
  const [filters, setFilters] = useState<FilterRuleItem[]>(() => [createInitialRule(variant)]);
  const getCategoricalValues = useMemo(
    () => (variant !== "table"
      ? undefined
      : async (_field: string, search: string) => {
          const delayMs = search.trim().toLowerCase() === "dv" ? 220 : 5;
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, delayMs);
          });
          return filterRemoteValues(search);
        }),
    [variant],
  );
  const selectedValues = filters[0]?.rule.kind === "categorical"
    ? filters[0].rule.selected
    : [];

  return (
    <div>
      <output aria-label="Selected raw values">
        {selectedValues.length > 0 ? selectedValues.join(" | ") : "(none)"}
      </output>
      <FilterPanel
        data={localData}
        columns={filterColumns}
        filters={filters}
        onChange={setFilters}
        onClose={() => undefined}
        width={280}
        categoricalMode={variant === "table" ? "include" : "exclude"}
        getCategoricalValues={getCategoricalValues}
      />
    </div>
  );
}