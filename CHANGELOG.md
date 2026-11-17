# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Dubai Table MCP server. The 4 kept tools of the captured surface are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `list_venues`, `whats_on`, `check_availability`, `desk_contact`. Labelled subset: the captured booking and checkout tools — `request_table`, `booking_status`, `cancel_booking`, `show_tables`, `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout` — are omitted (a real PII booking submit, the booking flow's status/cancel operations, a hosted table-picker widget, and the UCP checkout funnel) and are not registered, served, or offered by the CLI. The capture carries a `title` key on every tool, served verbatim; only `check_availability` carries a `required` key (`venue`, `date`); `list_venues`, `whats_on` and `desk_contact` carry none and none is served.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `tableatlas error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `DUBAITABLE_MCP_URL`. The upstream record declares no headers, so no auth header is ever sent.
