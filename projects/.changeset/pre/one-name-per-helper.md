---
"@neontechspace/fluxerly": major
---

Each helper has one public name, and the role hierarchy helpers join the other pure helpers in a namespace:

- The top-level `createPkce` export is removed. Use `oauth.createPkce`, which is unchanged
- The `hierarchy` namespace replaces `canManageHierarchy`, `compareHierarchy` and `isAboveInHierarchy` with `hierarchy.canManage`, `hierarchy.compare` and `hierarchy.isAbove`. The `HierarchyHelpers` type describes it

Migration: Replace `createPkce()` with `oauth.createPkce()`, and each loose hierarchy function with its `hierarchy` method
