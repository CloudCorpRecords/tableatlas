# tableatlas

Which Dubai rooms are worth a night out, what is on this week, and which tables are still free? tableatlas is a local forwarding client for the hosted Dubai Table MCP service: it answers `tools/list` locally from the captured tool definitions and forwards every call to the service, returning the answers exactly as the service sends them back.

The four tools are all reads over published material. `list_venues` returns the catalogue of rooms Dubai Table books — kind, area, which nights are Dubai Table nights, zones with seat and minimum-spend ranges, booking-page and 360° tour links. `whats_on` returns the programme night by night, signature nights and venue nights, for up to 14 days from a start date. `check_availability` reads the live floor plan for a venue and a date and reports the tables still free, each with its zone, seats and minimum spend in AED. `desk_contact` returns how to reach a relationship manager at Dubai Table — the desk's own published WhatsApp and email details; it sends nothing.

**Labelled subset — 4 of the 13 captured tools are built.** The other nine are the booking and checkout machinery, and none of them is registered, appears in `tools/list`, or is a CLI command. `request_table` places a real table request and sends the guest's name and mobile number to the venue's relationship manager — a personal-data booking submit. `booking_status` and `cancel_booking` operate that booking flow's references, and cancel destructively cancels a real booking. `show_tables` is a hosted interactive table-picker widget whose form takes the booking request and the platform service fee; a stdio forwarding client cannot serve it faithfully, and its table data duplicates `check_availability`. `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout` and `cancel_checkout` form the UCP checkout funnel: `create_checkout` carries the buyer's name, email and phone, and `complete_checkout` places the table requests. The kept tools take no personal data, book nothing, and touch no checkout.

## The tools

- **`list_venues`** — Every room Dubai Table books across Dubai: kind, area, Dubai Table nights, whether an exact table can be chosen, zones with seat and minimum-spend ranges, no booking fee, booking page and 360° tour links. No parameters.
- **`whats_on`** — The programme night by night for the next N days from a `date` (default today in Dubai); `days` runs from 1 to 14, default 7. No required parameters.
- **`check_availability`** — Tables still free at a venue on a date, from the live floor plan minus tables already requested or confirmed. `venue` and `date` are required; optional `party` (1–30 guests), `zone` and `max_min_spend` (AED) filters narrow the result.
- **`desk_contact`** — How to reach a relationship manager (WhatsApp or email) for anything outside the listed venues, large groups, or special arrangements. No parameters.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/tableatlas mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "tableatlas": {
      "command": "npx",
      "args": ["-y", "@reneturcios/tableatlas", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/tableatlas
docker run --rm ghcr.io/cloudcorprecords/tableatlas whats_on '{}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
tableatlas list_venues '{}'
tableatlas whats_on '{"date":"2026-10-31","days":3}'
tableatlas check_availability '{"venue":"billionaire","date":"2026-10-31","party":6}'
tableatlas desk_contact '{}'
tableatlas --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand (including any of the nine omitted tools) or a malformed JSON argument.

## Configuration

- `DUBAITABLE_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://dubaitable.com/mcp`. (The override variable is a reconstruction added by this rebuild.)

The upstream registry record declares no headers, so no authentication header is ever sent; the tool surface was captured keyless.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `tableatlas error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface (the 4 kept tools, deep-equal, in order, with their `title` keys served verbatim and the `required` key present only where the capture carries one), asserts all nine omitted tools are absent at registry, MCP and CLI level, exercises the session handshake and its reuse, verifies that no `Authorization` header is ever sent under any environment, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
