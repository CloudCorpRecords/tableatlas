# BUILD REPORT — tableatlas

Clean-room rebuild of `com.dubaitable/booking`
v1.0.0 (remote-only MCP server at
`https://dubaitable.com/mcp`), built 2026-10-28
as a forwarding client. Package: `@reneturcios/tableatlas`
0.1.0, registry name `io.github.CloudCorpRecords/tableatlas`.

## Surface built

Labelled subset: **4 of 13 captured tools built**, 9 omitted
(see below).

| Tool | Required fields as served |
|------|---------------------------|
| `list_venues` | NO `required` key in the capture — served verbatim, none invented (its `properties` is an empty object, served verbatim) |
| `whats_on` | NO `required` key in the capture — served verbatim, none invented |
| `check_availability` | `venue`, `date` |
| `desk_contact` | NO `required` key in the capture — served verbatim, none invented (its `properties` is an empty object, served verbatim) |

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, exactly as captured: THIS
capture carries a `title` key on every tool, and the titles
are served verbatim. The capture also carries `annotations`,
`outputSchema`, `securitySchemes` and `_meta` keys per tool;
those were dropped at fixture slimming (recorded in the
fixture's `_source` note) and are NOT served. The tool
literals were generated programmatically from
`harness/fixtures/dubaitable-tools-original.json` by the
script at `/tmp/b48-tableatlas-scratch/gen.py` (parse +
re-serialise; the emitted `TOOL_DEFS` block was verified to
byte-match the block in `src/forward.ts`, and the
generator's own round-trip assertion confirmed the literals
parse back to the fixture's tool objects) — never retyped —
and the registration-integrity test suite plus the parity
harness confirmed the served literals deep-equal the
fixture's 4 tool objects, in order. Tools are registered via
the MCP SDK low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

## Omissions — the 9 booking + checkout tools

The booking + checkout machinery of the surface, omitted as
recorded in the fixture's `_source` note and the spec:

- `request_table` — places a REAL table request and SENDS
  the guest's name and mobile number (plus optional email)
  to the venue's relationship manager: a PII booking submit
  (the request_quote SAFETY-omission family).
- `booking_status`, `cancel_booking` — operate the omitted
  booking flow's references (status is keyed by booking ref
  + the guest's phone; `cancel_booking` destructively
  cancels a real booking).
- `show_tables` — a hosted interactive widget
  (`ui://widget/table-picker` + OpenAI output template)
  whose form takes the table request and the platform
  service fee: a hosted UI surface a stdio forwarding client
  cannot faithfully serve, and its table data duplicates
  `check_availability`.
- `create_checkout`, `get_checkout`, `update_checkout`,
  `complete_checkout`, `cancel_checkout` — the UCP checkout
  funnel: `create_checkout` carries the buyer's first/last
  name, email and phone; `complete_checkout` places the
  table requests (commits the booking). The funnel is
  omitted as one family (the printcraft `create_checkout`
  precedent, Batch 45).

The kept tools are the independent venue-discovery core:
the published venue catalogue (kinds, areas, zones,
minimum-spend ranges, tour/booking-page links), the nightly
programme, live table availability from the floor plan, and
a static read of how to reach a relationship manager (it
returns the desk's own published contact details; it sends
nothing). None of the kept tools takes or sends personal
data, books anything, or touches a checkout.

None of the omitted tools is registered, appears in
tools/list, or is a CLI command. Absence assertions in
`test/forward.test.ts`, covering all 9 names:

- Registry level: `TOOL_NAMES` includes none of the 9, no
  `TOOL_DEFS` entry carries any of those names,
  `TOOL_DEFS.length === 4`, and `isKnownTool` returns false
  for each of the 9.
- MCP layer: `handleCallTool` rejects each of the 9 with
  McpError MethodNotFound before any network hop (upstream
  call count 0 across all 9 rejections).
- CLI level: each of the 9 names as a subcommand prints
  Usage on stderr and exits 2, and the usage text names
  none of the 9 omitted tools.

## Fixture conflicts

**None.** The spec and the fixture agree on all 4 kept
tools' names, titles, descriptions, required fields
(`check_availability` requires `venue` + `date`;
`list_venues`, `whats_on` and `desk_contact` carry no
`required` key) and property shapes — including the empty
`properties` objects on `list_venues` and `desk_contact`,
served verbatim. The spec's note that this capture carries
a `title` key on every tool matches the fixture exactly,
and the fixture's `_source` note records the same 9-tool
omission set and reasons as the spec.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://dubaitable.com/mcp`.
- Env override `DUBAITABLE_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no
  auth header is ever sent. Tests assert that no
  `Authorization` header is sent under any environment —
  including with key-like env vars (`DUBAITABLE_API_KEY`,
  `API_KEY`, `AUTHORIZATION`) set — and that no `X-API-Key`
  header is ever sent; upstream requests carry only
  `Content-Type`, `Accept` and, when issued,
  `Mcp-Session-Id`.
- Error rendering `tableatlas error:` text for upstream
  failures — labelled reconstruction.
- Upstream results pass through verbatim, including
  `isError` and extra fields. tools/call is forwarded as
  streamable-HTTP JSON-RPC: initialize (protocolVersion
  `2025-03-26`) → notifications/initialized → tools/call,
  honouring `Mcp-Session-Id` when issued; plain-JSON and
  SSE replies are both parsed. The forwarding core takes an
  injectable fetch; tests stub the upstream — no live
  network calls in tests (the one CLI forwarding test uses
  a stub JSON-RPC server on 127.0.0.1 reached through the
  `DUBAITABLE_MCP_URL` override).

## Deviations

None.

## Lockfile

- Route: generated clean from birth in the build dir with
  no `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`
  (Route 3).
- Parses as JSON; `name` == `@reneturcios/tableatlas`.
- Package entries: **128**.
- sha256: `06cab233374a3d9cc9aeeded37bfa3f7cd46bdaccc9d1b5d0ea95b61ed9d2285`
  (re-verified unchanged after the subsequent offline
  `npm ci`).

## server.json

- Description exactly: "Dubai venue discovery: venue
  catalogue, nightly programme, live table availability." —
  **83 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI
  entry (`ghcr.io/cloudcorprecords/tableatlas:0.1.0`)
  carries **no** `version` field. Both entries carry
  packageArguments `[{type: positional, value: mcp}]` and
  transport stdio. Dockerfile (node:20-alpine, both stages)
  carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/tableatlas"`.
  Container workflow `IMAGE` is
  `ghcr.io/cloudcorprecords/tableatlas` and its smoke test
  asserts the server name `tableatlas`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli,
   forward, index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **63 tests, 63 pass, 0 fail**
   (registration-integrity suite deep-equals the served
   tools/list against the fixture's 4 tools, including the
   title keys, the required-key exactness — `venue`+`date`
   only on `check_availability` — and the verbatim empty
   `properties` objects on `list_venues`/`desk_contact`;
   plus absence assertions for all 9 omitted tools at
   registry, MCP-layer and CLI level, session
   handling/reuse, env override, the no-Authorization-header
   assertions under any environment, verbatim argument
   forwarding and result pass-through including upstream
   isError, SSE parsing, error rendering, MCP-layer
   validation, and CLI behaviour including a kept-tool
   subcommand forwarding against a localhost stub upstream).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/dubaitable-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/tableatlas/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/tableatlas/parity-out` → **verdict PASS, parity 100.0**
   (4/4 identical, 0 missing, 0 extra, no schema diffs).
   Output in `parity-out/`.
