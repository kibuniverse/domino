# React Bits sources

Upstream: https://github.com/DavidHDev/react-bits
Commit: 4d6a46d3f401736695c495f1e72ed429e0ed1b93
Retrieved: 2026-10-03
License: MIT + Commons Clause, retained in LICENSE.md. These files retain their upstream license and are not relicensed under Domino's MIT license.

- ShinyText: src/ts-default/TextAnimations/ShinyText/ShinyText.tsx. CSS import removed; styles live inside the runtime Shadow DOM.
- SpotlightCard: src/ts-default/Components/SpotlightCard/. CSS import and unused Position type removed; styling adapted to the compact target summary.
- AnimatedList: src/ts-default/Components/AnimatedList/AnimatedList.tsx. Adapted to typed items, stable IDs, controlled selection, native button semantics, local arrow navigation, and one-time entry animation.
- GlideSelect: supplied by the user on 2026-10-03 as the JavaScript + CSS React Bits component, separately from the pinned components above. Converted to TypeScript, CSS injected into Shadow DOM, menu portalled into the same shadow root to avoid panel clipping, outside-pointer detection uses composedPath, keyboard handling cooperates with Domino shortcuts, and pointer row detection accounts for list bounds. Retains Hugeicons dependencies and the supplied glide/pop effects.

The shipped runtime integrates these effects into the Domino editing interface; no standalone component entry points are exported. Include this license and attribution in the published package.
