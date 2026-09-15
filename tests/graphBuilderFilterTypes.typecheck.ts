import type {
  EmbeddedGraphConfig,
  GraphBuilderItem,
  GraphRuntimeItem,
} from "../src/types/graphBuilder";
import type { FilterRuleItem } from "../src/types/filter";

declare const standaloneBase: GraphBuilderItem;
declare const filter: FilterRuleItem;

const standalone: GraphBuilderItem = {
  ...standaloneBase,
  // @ts-expect-error Standalone graph persistence cannot own dataset filters.
  filters: [filter],
};

const runtime: GraphRuntimeItem = {
  ...standaloneBase,
  filters: [filter],
};

const embedded: EmbeddedGraphConfig = {
  mode: standaloneBase.mode,
  modeStates: standaloneBase.modeStates,
  filters: [filter],
};

void standalone;
void runtime;
void embedded;