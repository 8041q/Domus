# UI refactor notes

## Direction

This pass uses shadcn/ui's design-system approach rather than copying the previous mixed screen-specific styles. The app now has semantic theme tokens, a consistent radius/spacing/focus language, and reusable React UI primitives.

## Preserved intentionally

- Build Room: the world-anchored checker/grid behavior is unchanged.
- Build Room: the thick wall stroke and corner-dot editing model is unchanged.
- Plan Room: the underlying 3D work/view scene, camera behavior and room-planning interactions are unchanged.
- Planner geometry, placement, history, save/load and renderer state architecture were not redesigned.

## Changed intentionally

- Furnish Room is renamed to Plan Room throughout the TypeScript model, store, component names and documentation.
- Header, workflow navigation, buttons, panels, fields, cards, tabs, popovers, status bars and responsive behavior use one visual system.
- Build Room labels and angle annotations now match the shared UI system while retaining their collision-aware placement behavior.
- Plan Room room dimensions, product dimensions and spacing measurements use a unified neutral line + bordered white badge system.
- Product catalogue, selection inspector, room finishes, view controls and annotation settings were restyled for clearer hierarchy and larger interaction targets.

## Shared files

- `src/styles.css`: global semantic tokens and all shared visual rules.
- `src/ui.tsx`: reusable React/TypeScript primitives, `cn`, and dependency-free SVG icons.

## Dependency decision

The project was not migrated to Tailwind/Radix solely for styling. That would turn a UI pass into a build-stack migration and introduce unnecessary risk around the current Vite/Three.js prototype. The semantic token names and component patterns follow shadcn/ui conventions while keeping the current dependency graph intact.

## Validation

- `npm run build`: passes.
- Vite production output was regenerated in `dist/`.
- The build still reports Vite's bundle-size warning for the large Three.js application chunk; this is not a TypeScript/build failure and was outside the UI-only scope.
