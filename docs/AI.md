# Experimental AI Assistant

> **Status:** The assistant is implemented as an opt-in experiment for trusted
> local installations. It is furniture-only and is not ready for a public or
> untrusted deployment.

Domus supports Gemini, OpenAI, and Ollama behind one proposal workflow. Models
can answer questions or suggest furniture changes, but they never mutate the
project directly.

## Try it with Gemini

1. Run `npm run dev` and open Plan Room.
2. Choose **AI Experimental**, select **Gemini**, and enter your API key.
3. Save the key, then choose **Test connection & load models**.
4. Pick a model, ask for a layout change, review the returned operations, and
   choose **Apply proposal** only if they are correct.

Do not put an API key in source code, an environment file, a room project, or a
chat message. The settings panel is the intended input path.

## Current implementation

The Vite development and preview servers mount three routes:

- `GET /api/ai/config` returns approved, non-secret Ollama endpoints.
- `POST /api/ai/models` tests a provider connection and lists models.
- `POST /api/ai/turn` sends one app-owned conversation turn and returns a
  normalized assistant message and optional proposal.

Adapters currently use:

- Gemini's native `generateContent` API with a response JSON schema.
- OpenAI's Responses API with `store: false` and `text.format` structured
  output.
- Ollama's native chat API with a JSON schema. If a model cannot produce valid
  structured output, Domus retries it as advice-only chat and disables Apply.

The gateway does not persist messages, snapshots, or credentials. A proposal
may contain at most eight operations and can only add, move, rotate, or remove
catalogue furniture.

## Safety and approval

The provider result is only a suggestion. The gateway checks its response
envelope, operation count, product/type names, and finite numbers. The browser
then:

1. verifies that the room still matches the revision sent to the model;
2. validates object and product identifiers;
3. applies every operation to a cloned snapshot;
4. runs the normal exact placement, collision, and clearance rules;
5. commits the complete result as one undoable action only after approval.

Any failure leaves the project unchanged. The current preview is an operation
card, not an in-room ghost rendering. AI cannot edit room geometry, openings,
materials, lighting, persistence, or export settings.

## Browser-held cloud keys

Gemini and OpenAI keys are saved as AES-GCM ciphertext in IndexedDB. Domus
generates a non-exportable Web Crypto key in the same browser profile, decrypts
the credential only for a request, and sends it through the gateway to a fixed
official provider host. The gateway keeps no copy after forwarding the request.

Raw keys are not stored in localStorage, cookies, project files, server
configuration, analytics, or a backend database. Removing a provider credential
deletes its encrypted record. Clearing site data deletes both the ciphertext and
its local encryption key; there is no recovery mechanism.

This design prevents casual extraction from stored browser data, but it is not
a defence against compromised code executing under the same origin: such code
could ask the browser to decrypt or use the credential. The gateway also sees
the key transiently while forwarding it. Public deployment therefore requires
HTTPS, a strict Content Security Policy, dependency review, log redaction, and
a narrowly scoped authenticated proxy.

## Ollama

Ollama is reached from the machine running the Domus server, not directly from
the browser. The default is `http://127.0.0.1:11434`. Approve exact LAN endpoints
with a comma-separated environment variable:

```bash
OLLAMA_ALLOWED_ENDPOINTS=http://192.168.1.50:11434,http://192.168.1.51:11434 npm run dev
```

The UI can select only configured endpoints, and the gateway rejects arbitrary
URLs so it cannot be used as a general network proxy. Installed models are read
from Ollama's tags endpoint. Models capable of the required structured output
can propose operations; other models remain useful for advice-only chat.

## Known experimental limits

- The gateway is a Vite development/preview plugin. Static `dist` hosting alone
  does not expose `/api/ai/*`.
- There is no authentication, rate limiting, streaming, audit log, or multi-user
  credential isolation.
- Each request includes the relevant conversation and full semantic snapshot;
  there is no provider-side conversation state or function-tool loop yet.
- Conversation history is panel-local and disappears when the panel unmounts or
  the page reloads.
- Provider and model support for strict schemas varies. Human review remains
  required even when a response validates.

Before public deployment, move the gateway into an authenticated production
server, add quotas and redacted observability, stream long turns, add contract
tests against provider fixtures, and build an in-room ghost preview.

## Provider references

- OpenAI: [Responses API migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)
  and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- Gemini: [Structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)
  and [model listing](https://ai.google.dev/api/models)
- Ollama: [chat API](https://docs.ollama.com/api/chat),
  [structured outputs](https://docs.ollama.com/capabilities/structured-outputs),
  and [model listing](https://docs.ollama.com/api/tags)
