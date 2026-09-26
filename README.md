# Domus

Domus is a browser-based room builder and layout planner. It keeps the room,
openings, finishes, and furniture as semantic data and uses Three.js only to
render and interact with that data.

The application is local-first. It has no accounts, database, or cloud sync.
An opt-in experimental AI assistant is available through a small gateway that
runs with Vite during local development and preview.

## What it does

### Build Room

- Start from rectangle, angled-corner, L-shaped, or recessed room templates.
- Drag walls and corners in a dimensioned 2D workspace; split a wall by adding a
  corner.
- Work in metric or imperial units.
- Add, position, resize, and restyle windows, doors, and custom openings.
- Inspect the architecture in a neutral 3D preview. Direct sun rays are
  intentionally disabled in this workspace.

### Plan Room

- Place, move, rotate, duplicate, and remove procedural furniture.
- Use wall, object, and room-centre snapping with deterministic collision and
  clearance checks.
- Switch between Cutaway, Top, Front, Right, Back, and Left views.
- Toggle room, product, spacing, and clearance annotations.
- Change PBR floor finishes, wall and ceiling colours, baseboard styles, and
  ceiling-light settings.
- Enable paired suns or just cinematic sun shadows in rooms with
  glazed openings.
- Ask the experimental AI assistant for layout advice or validated furniture
  proposals using Gemini, OpenAI, or a server-reachable Ollama model.
- Export the complete physical room as a semantic GLB.

Both workspaces edit the same project. A change made in Build Room is available
immediately in Plan Room and vice versa.

## Run locally

You need Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

Vite serves the app at `http://localhost:5173` by default.

The experimental AI gateway is available with both `npm run dev` and
`npm run preview`. Open Plan Room and choose **AI Experimental**. Cloud keys are
encrypted in this browser and are never added to room project files.

Ollama defaults to `http://127.0.0.1:11434` on the machine running Domus. Exact
additional endpoints can be approved when starting the server:

```bash
OLLAMA_ALLOWED_ENDPOINTS=http://192.168.1.50:11434 npm run dev
```

Create and preview a production build with:

```bash
npm run build
npm run preview
```

## Main controls

| Action | Control |
| --- | --- |
| Undo | `Ctrl/Cmd + Z` |
| Redo | `Ctrl/Cmd + Y` or `Ctrl/Cmd + Shift + Z` |
| Rotate selected furniture 90° | `R` |
| Remove selected furniture | `Delete` or `Backspace` |
| Orbit the 3D view | Drag empty space with the left mouse button |
| Pan the 3D view | Drag with the right mouse button |
| Zoom | Mouse wheel or trackpad |
| Keep a furniture selection while orbiting | Hold `Shift` and drag empty space |
| Move furniture without snapping | Start dragging it, then hold `Shift` |
| Use the fine Build Room snap | Hold `Shift` while dragging in 2D |

Build Room walls, corners, and openings can be dragged directly. Selecting an
item opens its numeric controls for precise edits.

## Saving and export

`Save` stores one project snapshot in this browser under
`room-planner-project-v3`; `Load` restores it. Older local snapshot keys are
accepted and normalized when possible. Clearing site data removes the save.
There is no automatic save or cloud backup.

`Export GLB` is available in Plan Room. It exports the complete room rather
than the current cutaway: walls, floor, baseboards, frames, ceiling, and
furniture are grouped by semantic category. Cameras, selection outlines,
measurements, and other editing helpers are excluded.

## Current limitations

- The furniture catalogue uses procedural placeholder models and sample prices.
- Projects are local to one browser and there is one manual save slot.
- The renderer requires a browser with WebGL support.
- AI assistance is experimental, furniture-only, non-streaming, and intended
  for trusted local use. A static `dist` deployment does not provide its API
  routes; a production host must supply the gateway and add authentication,
  quotas, and abuse protection before public use.
- Multi-user projects, authentication, and cloud services are not implemented.

## Developer guides

- [Architecture](docs/ARCHITECTURE.md) — current state, data flow, renderer, and
  lifecycle.
- [Experimental AI](docs/AI.md) — setup, providers, safety boundaries, and
  current limitations.
