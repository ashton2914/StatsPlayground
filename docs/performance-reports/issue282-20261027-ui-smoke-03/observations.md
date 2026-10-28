# Native UI smoke 03

Unqualified debug build `efaa578479f7c6a9fe966c60dd9a078437f87a10`, two real
App lifecycle cycles against 300,000 × 20. All ten samples passed exact native/UI
logical checks after the FormulaBar Enter/blur repair. Catalog, first window,
distant scroll, durable edit and close all had actual matching native spans.
Raw timings are retained, including debug edit/scroll values above release
budgets. Sample count/debug profile/cold and other fixture tiers prevent
qualification. No values were dropped or replaced. A concurrent separate
cold-method diagnostic ran during this smoke, so this is collector correctness
evidence only.
