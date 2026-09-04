# Stable Graph Layer Colors

## Problem

Adding an unaggregated points layer changes the graph request from aggregate-only
data to sampled raw data. Graph Builder currently assigns automatic colors from
the order in which group values arrive. Aggregate packets and sampled raw chunks
can expose the same groups in different orders, so adding or removing points
reassigns existing groups to different palette slots.

## Design

Resolve legend group keys through one deterministic pure function before assigning
automatic styles. Explicit Value Order entries come first. Remaining discovered
groups use deterministic lexical order. The raw-frame dictionary contributes
candidate values but does not control ordering because it is populated from sampled
row encounter order.

The renderer continues receiving styles keyed by group value, so no palette values
or automatic colors need to be persisted. Explicit per-group style overrides remain
unchanged.

## Verification

Add a regression test that supplies identical groups in conflicting aggregate and
raw dictionary orders and verifies the resolved order is identical. Also cover
deduplication, missing values, dictionary-only values, and explicit Value Order.
