# Planned AI Assistance

> **Status:** This is a design contract, not a description of a shipped feature.
> Domus currently has no backend, AI settings, provider SDKs, prompts, or model
> calls.

The goal is to let a user bring an OpenAI or Gemini API key, or use an Ollama
installation reachable by the Domus server. Every provider must feed the same
safe preview-and-approve workflow; the model never edits the project directly.

## Product behavior

The first AI experience should explain a room, answer layout questions, and
propose changes such as moving or rotating furniture. A proposal is shown in
the room before anything is committed. The user can accept or reject it, and an
accepted proposal becomes one undoable action.

AI is not responsible for measurements, polygon math, collision detection,
clearances, or final validity. Those remain deterministic application rules.
Unsupported local models may provide advice, but cannot produce executable
changes.

## Provider-neutral design

The initial provider IDs are `openai`, `gemini`, and `ollama`.

```text
Browser AI panel
  ├─ app-owned messages and current PlannerSnapshot
  ├─ provider/model choice
  └─ temporary cloud credential, when required
                    │ HTTPS
                    ▼
              POST /api/ai/turn
                    │
          provider-neutral orchestrator
             ┌──────┼────────┐
             ▼      ▼        ▼
          OpenAI  Gemini   Ollama
                    │
                    ▼
       normalized text / calls / proposal / error
```

The adapters translate one internal request into:

- OpenAI's Responses API with function tools and `store: false`.
- Gemini function calling and structured responses.
- Ollama's native chat, tool-calling, and structured-output API.

Conversation messages belong to Domus and are sent as needed on each turn.
Provider conversation IDs are not the source of truth. Adapters normalize text,
tool calls, refusals, usage metadata, and errors so UI and room logic do not
branch on provider-specific response shapes.

## Planned API contract

`POST /api/ai/turn` accepts a provider and model, app-owned conversation input,
the current `PlannerSnapshot`, a project revision, and an optional cloud
credential. It returns a normalized assistant message plus one of:

- a schema-validated `LayoutProposal`;
- an advice-only response;
- a capability, provider, validation, or connection error.

A proposal contains its base project revision, an explanation, warnings, and a
list of typed room operations. It does not contain arbitrary code or a complete
replacement snapshot.

Tools exposed to a model are read-only queries over semantic project data and
deterministic calculations, such as reading wall dimensions, checking a proposed
footprint, or finding valid placement candidates. The model cannot call store
mutators, browser APIs, network fetches, or the GLB exporter.

## Proposal safety flow

1. Capture the snapshot and monotonic project revision used for the request.
2. Let the provider call approved read/calculation tools within bounded turn,
   tool-call, token, and timeout limits.
3. Validate the returned proposal against a strict provider-neutral schema.
4. Re-run every operation through current geometry, collision, and clearance
   rules; reject unknown IDs, stale revisions, invalid numbers, and unsupported
   operations.
5. Render the valid result as a preview without changing saved project state.
6. Apply only after explicit user approval and record the original snapshot as
   one undo entry.

Changing the project while a request or preview is open makes that proposal
stale. Provider timeouts, malformed output, partial tool loops, or rejected
placements leave the project unchanged.

## In-app provider settings

The planned settings screen lets the user:

- select OpenAI, Gemini, or Ollama;
- enter or replace a cloud API key;
- choose a model and test the connection;
- select an approved Ollama endpoint and one of its installed models;
- see whether the model supports advice, tool calling, and structured proposals;
- remove a saved credential and all local AI conversation data.

AI settings are separate from `PlannerSnapshot`. They are not included in local
room saves or GLB exports.

### Cloud credentials

OpenAI and Gemini keys are persisted only in the user's browser:

1. Generate a non-exportable AES-GCM `CryptoKey` with Web Crypto.
2. Store that key and the encrypted provider credential in IndexedDB for the
   current browser profile and origin.
3. Decrypt into memory only when making a request.
4. Send the credential to the Domus backend over HTTPS for that request.
5. Have the backend forward it only to the provider's fixed official endpoint,
   redact it from logs and errors, and discard it after the call.

The raw key must never enter cookies, localStorage, project files, analytics,
server configuration, or a backend database. Settings show only masked key
metadata after saving.

This protects a key from casual inspection of stored browser data and avoids
server-side retention; it is not a defence against compromised code running on
the same origin. Such code can ask the browser to use the non-exportable key
while the application is open. A malicious backend can also observe a key that
must transit it. A strict Content Security Policy, dependency review, HTTPS,
request-log redaction, and a narrowly scoped proxy are therefore required.

IndexedDB normally survives browser restarts. Clearing site data, changing the
origin or browser profile, or losing the stored `CryptoKey` makes the credential
unrecoverable; the user must enter a new one.

### Ollama connections

Ollama is contacted by the Domus backend, not by the browser. The default
endpoint is `http://127.0.0.1:11434` on the application server. This supports a
server that hosts both Domus and Ollama.

A deployment may configure an exact allowlist of additional HTTP(S) endpoints
for Ollama running on another machine on the server's network. The settings UI
can select only those endpoints; arbitrary browser-supplied URLs are rejected so
the AI route cannot become a general server-side request proxy. Connection
tests use short timeouts, and the backend lists the installed models through
Ollama's model-list API.

The chosen endpoint and model are non-secret browser preferences. Before
enabling executable proposals, Domus performs a capability probe for reliable
tool calls and schema-constrained output. A model that fails the probe remains
available in clearly labelled advice-only mode.

## Deployment boundary

The first implementation is suitable for a single-user or otherwise
access-controlled installation. Before exposing it publicly, Domus needs
authentication, request quotas, abuse protection, per-user isolation, bounded
payload sizes, audit-safe logs, and explicit authorization for settings changes.

Cloud provider destinations are fixed in server code. Ollama allowlists are
deployment configuration, not project data. No endpoint may return a raw cloud
credential to the browser after it has been submitted for a request.

## Implementation acceptance checks

- OpenAI, Gemini, and a capable Ollama model produce the same validated proposal
  shape and preview behavior.
- An advice-only Ollama model can answer but cannot enable Apply.
- Accepting a proposal creates one undo entry; rejection, stale state, timeout,
  malformed output, and validation failure create none.
- Cloud keys survive a browser restart, remain unreadable as plain IndexedDB
  values, and disappear when the user removes them or clears site data.
- Server logs and errors contain no API key or complete sensitive request body.
- Only official cloud hosts and allowlisted Ollama endpoints are reachable.
- Provider switching does not move credentials or AI settings into room saves.

## Primary references

- OpenAI: [Responses API migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)
  and [function calling](https://developers.openai.com/api/docs/guides/function-calling)
- Gemini: [Function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- Ollama: [Tool calling](https://docs.ollama.com/capabilities/tool-calling),
  [structured outputs](https://docs.ollama.com/capabilities/structured-outputs),
  and [model listing](https://docs.ollama.com/api/tags)
