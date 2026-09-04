import { DistributionView, type DistributionViewProps } from "../../src/components/distribution/DistributionView";
import { useDistributionStore } from "../../src/stores/useDistributionStore";

export function DistributionViewStory(props: DistributionViewProps) {
  useDistributionStore.setState((state) => ({
    ...state,
    items: [props.item],
  }));
  return <DistributionView {...props} />;
}