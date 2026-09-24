# Lighting study: IKEA Kreativ reference and Domus

## What the reference actually shows

The three supplied IKEA Kreativ screenshots show the same empty room from a
front interior view and two cutaway views. The large wall and floor surfaces
have fairly even exposure. The ceiling is a warm grey, while the outside field
is cooler grey. Recessed fixtures read as small bright discs with restrained
halos. The fixtures do not create strong pools on the walls or floor. Junctions
and corners have gentle darkening; there are no large black bands.

The later close-up shows a softer but clearly visible corner gradient at the
ceiling, through the wall's middle, and down to the carpet. It broadens toward
the base. Its baseboard is light warm grey, while the carpet receives darker
perimeter shading. The ceiling lamp is a clean white disc; the nearby wall has
subtle local brightening without a sharply bounded cone.

The original linked design required login, but the [generic room](https://www.ikea.com/pt/en/home-design/room/?roomType=generic#150d9636-7ac6-4a75-a962-0c775e836fc0/9677faab-69c1-48d6-84d5-09b252b1e547)
loads publicly. Its Dollhouse, Front and Back views were inspected live. The
vertical corner darkening and floor junction shading stay in the same places
when the ceiling disappears in Dollhouse mode. Wall exposure does not jump
between those views. That behavior is consistent with persistent room-space
lighting and precomputed or material-side ambient occlusion, though it does not
reveal IKEA's actual implementation. IKEA publicly describes Kreativ as a mix
of 3D showrooms, computational photography and mixed reality; it does not
publish the lighting implementation for this room.

## What was wrong in Domus

- Ambient and hemisphere intensities fell almost to zero with room lights on.
  The remaining near-ceiling directional light produced a dark shell and broad
  structural shadows.
- Every ceiling fixture added a point light. Those lights made intense hotspots
  on the ceiling and upper walls while doing little for the room's base exposure.
- The fixture meshes sat partly inside the ceiling slab.
- The full-screen composer and FXAA ran even without a selected product, washing
  fine floor detail and spending an extra postprocessing pass.
- A generated room environment texture was allocated but never used by the scene.
- Door, trim, and fixture bodies cast disconnected shapes on the walls and
  carpet. The ceiling's shadow copy also obstructed the furniture shadow light.
- The first corner overlay had nearly the same width from top to bottom, so it
  read as a vertical column. The carpet lacked perimeter darkening.

## Current rendering recipe

- Hemisphere and ambient light approximate broad indoor bounce.
- One directional light retains a 1024-pixel PCF shadow map for furniture and
  contact depth. A wider filter and more overhead direction soften and shorten
  its projected shadows. A weaker non-shadowing fill reduces wall contrast.
- The ceiling underside has a stable warm plaster tone. Wall finishes add a
  modest emissive term proportional to their selected color to approximate the
  indirect light missing from this forward renderer.
- Direct room lights stay below the ceiling regardless of camera visibility.
  Hiding the ceiling changes presentation only. Architectural meshes no longer
  cast into the furniture shadow map.
- A small wall-space shader shades solid wall segments. Its corner gradient is
  visible near the ceiling and through the middle, then broadens toward the floor. A separate floor strip
  shades the carpet along the wall junction and corners. These overlays move
  with edited walls and need no full-screen AO pass.
- Recessed downlights are the default. One small 64-pixel radial texture is
  shared by all fixture halos. Each visible fixture has one matching wide,
  non-shadowing light. A centered grid keeps them back from the walls and is
  capped at nine fixtures for bounded rendering cost. Their wall illumination
  is broad and local, and their discs render clean white.
- The baseboard uses a light unlit finish. Its old standard material responded
  to room lighting and looked much greyer than the reference; the floor edge
  overlay remains on the carpet rather than on the baseboard.
- Native renderer MSAA handles the ordinary room. The composer runs only when
  selected furniture needs its outline. FXAA is removed.
- Window daylight remains a weak, non-shadowing local accent.

This deliberately favors the screenshot's lighting hierarchy over physically
correct light transport. The reference's cool carpet and nearly white walls
are finish choices. Neutral white is now the default wall finish and a swatch;
existing saved rooms retain their chosen color. Carpet 011 remains an optional
finish for direct comparison.

The walls already use a very rough (`0.94`) opaque standard material. Roughness
controls specular reflection; it does not refract light through an opaque wall
or produce diffuse interreflection. Three.js reserves transmission for
transparent physical materials. More wall roughness would not create the
reference's soft bounce. The bounded local lights and room-space gradients
approximate that effect without extra shadow maps or a full-screen pass.

## Visual verification

The Vite app was opened in a WebGL browser. The default cutaway and front views
were inspected before and after the changes; a sofa was added to inspect the
selected outline and unselected floor shadow. The revised front view has an
evenly lit wall and warm ceiling without the previous dark strip or ceiling
hotspots. The close-up iteration was visually checked in cutaway and front
views with neutral white walls, Carpet 011, and a test sofa. Door and fixture
shadows were absent; the sofa cast a shorter, softer carpet shadow, and the
wall and floor junctions retained shading in both views. `npm run build`
succeeds.

The later close-up pass was also checked live with neutral walls and Carpet 011.
In the front view the six fixtures form two centered rows, each has a local
light, the white baseboard stays light, and the corner shade is more legible
above the floor.

The side-by-side cutaway exposed two scales of occlusion in the IKEA image:
a broad falloff across each wall and the carpet, plus a narrow, darker contact
line at the actual wall junction. Domus now layers a short-range wall-corner seam
over its wider height-dependent shade. The carpet strip reaches farther into
the room and has a separate narrow contact term, strongest at corners. The
carpet's center finish is unchanged.

The baseboard has a shaded face and lighter top cap. Door casings are wider
and deeper than the baseboard, with a small projecting header; window frames
are slimmer and have a projecting sill. Their stable trim colors keep them
legible against white walls regardless of room light direction. The revised
cutaway and a door-facing view were inspected in the live WebGL app.

The next close-up showed that the contact seam still read as a narrow vertical
stripe. Its fade now spans 24 cm and its added peak opacity is 0.015, leaving
the broad wall gradient to carry most of the corner depth. The live cutaway
close-up shows a faint contact edge instead of the previous dark stripe. A
faint ceiling perimeter overlay adds depth where the warm ceiling meets the
walls and disappears with the ceiling in cutaway views. The floor shading and
carpet finish were left unchanged. The free-camera ceiling appears below 5°
elevation and disappears above 7°; side presets keep it visible.

IKEA sources: [Kreativ announcement](https://www.ingka.com/newsroom/ikea-launches-new-ai-powered-experience-empowering-customers-to-create-lifelike-room-designs/),
[technology FAQ](https://www.ikea.com/fi/en/customer-service/knowledge/articles/ff043ec6-3527-4de3-96e2-9368671ec281.html).
Three.js references: [standard material](https://threejs.org/docs/pages/MeshStandardMaterial.html),
[physical material transmission](https://threejs.org/docs/pages/MeshPhysicalMaterial.html),
[shadow map costs](https://threejs.org/manual/pages/shadows.html).
