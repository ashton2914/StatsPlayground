## Summary

<!-- Describe the user-visible or architectural change. -->

## Verification

<!-- List the commands and manual checks run. -->

## Analysis Checklist

Complete when this pull request changes an Analysis kind:

- [ ] Manifest, TypeScript document union, and Rust validator identities match.
- [ ] Descriptor, executor, view, editor, graph, and report registries are exhaustive.
- [ ] Persisted documents contain definitions/presentation only; Rust owns statistics.
- [ ] Stale fencing and shared Analysis store/Workspace lifecycle are preserved.
- [ ] Unsupported capabilities are explicit and focused kind/contract/UI gates pass.