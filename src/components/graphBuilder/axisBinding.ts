import type { FieldRef, YAxisConfig } from "@/graphCore";
import type { GraphBuilderItem, GraphSlotKey } from "@/types/graphBuilder";

export function prepareAxisBinding(
  previousFieldName: string | undefined,
  nextFieldName: string | undefined,
  hadMulti: boolean,
  axisConfig: YAxisConfig | undefined,
): { bindingChanged: boolean; axisConfig: YAxisConfig | undefined } {
  const bindingChanged = hadMulti || previousFieldName !== nextFieldName;
  if (!bindingChanged) {
    return { bindingChanged, axisConfig };
  }
  if (!axisConfig) {
    return { bindingChanged, axisConfig: undefined };
  }

  const { min: _min, max: _max, tickInterval: _tickInterval, ...displayFields } = axisConfig;
  return {
    bindingChanged,
    axisConfig: Object.keys(displayFields).length > 0 ? displayFields : undefined,
  };
}

export function bindGraphBuilderField(
  item: GraphBuilderItem,
  slot: GraphSlotKey,
  field: FieldRef,
): GraphBuilderItem {
  if (item.mode === "3d") {
    return {
      ...item,
      modeStates: {
        ...item.modeStates,
        threeD: {
          ...item.modeStates.threeD,
          encoding: { ...item.modeStates.threeD.encoding, [slot]: field },
        },
      },
    };
  }
  if (item.mode !== "2d") return item;
  if (slot === "z" || slot === "groupZ") return item;

  const twoD = item.modeStates.twoD;
  const multiKey = slot === "x" ? "multiX" : slot === "y" ? "multiY" : null;
  const axisKey = slot === "x" ? "xAxis" : slot === "y" ? "yAxis" : null;
  const hadMulti = multiKey ? twoD[multiKey].length > 0 : false;
  const prepared = prepareAxisBinding(
    twoD.encoding[slot]?.name,
    field.name,
    hadMulti,
    axisKey ? twoD[axisKey] : undefined,
  );
  const nextTwoD = {
    ...twoD,
    encoding: { ...twoD.encoding, [slot]: field },
  };
  if (axisKey && prepared.bindingChanged) {
    nextTwoD[axisKey] = prepared.axisConfig;
    if (multiKey) nextTwoD[multiKey] = [];
  }

  return {
    ...item,
    modeStates: {
      ...item.modeStates,
      twoD: nextTwoD,
    },
  };
}