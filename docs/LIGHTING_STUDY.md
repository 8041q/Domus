# Lighting study: IKEA Kreativ reference and Domus

## What the reference actually shows

The three supplied IKEA Kreativ screenshots show the same empty room from a
front interior view and two cutaway views. The large wall and floor surfaces
have fairly even exposure. The ceiling is a warm grey, while the outside field
is cooler grey. Recessed fixtures read as small bright discs with restrained
halos. The fixtures do not create strong pools on the walls or floor. Junctions
and corners have gentle darkening; there are no large black bands.

The exact linked IKEA room requires login, so its live 3D renderer, lighting
parameters, and frame cost could not be inspected. IKEA publicly describes
Kreativ as a mix of 3D showrooms, computational photography and mixed reality;
it does not publish the lighting implementation for this room. The rendering
recipe below is an inference from the supplied images, not a claim about IKEA's
internal code.

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

## Current rendering recipe

- Hemisphere and ambient light approximate broad indoor bounce.
- One directional light retains a 2048-pixel PCF shadow map for furniture and
  contact depth. A weaker non-shadowing fill reduces wall-to-wall contrast.
- The ceiling underside has a stable warm plaster tone. Wall finishes add a
  modest emissive term proportional to their selected color to approximate the
  indirect light missing from this forward renderer.
- Recessed downlights are the default. One small 64-pixel radial texture is
  shared by all fixture halos. Fixtures add no point lights or shadow maps.
- Native renderer MSAA handles the ordinary room. The composer runs only when
  selected furniture needs its outline. FXAA is removed.
- Window daylight remains a weak, non-shadowing local accent.

This deliberately favors the screenshot's lighting hierarchy over physically
correct light transport. The reference's cool carpet and nearly white walls
are finish choices; the default Domus wood floor and warm wall color still make
the two rooms look different even with similar lighting.

## Visual verification

The Vite app was opened in a WebGL browser. The default cutaway and front views
were inspected before and after the changes; a sofa was added to inspect the
selected outline and unselected floor shadow. The revised front view has an
evenly lit wall and warm ceiling without the previous dark strip or ceiling
hotspots. The cutaway retains crisp floor texture. `npm run build` succeeds.

IKEA sources: [Kreativ announcement](https://www.ingka.com/newsroom/ikea-launches-new-ai-powered-experience-empowering-customers-to-create-lifelike-room-designs/),
[technology FAQ](https://www.ikea.com/fi/en/customer-service/knowledge/articles/ff043ec6-3527-4de3-96e2-9368671ec281.html).
