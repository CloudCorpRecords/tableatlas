import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  TableatlasClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Dubai Table endpoint is
 * never contacted. (The one CLI forwarding test points the
 * CLI at a stub JSON-RPC server on 127.0.0.1 via the
 * DUBAITABLE_MCP_URL override.)
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/dubaitable-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const PRIMARY = "check_availability";
const ALL_TOOLS = [
  "list_venues",
  "whats_on",
  "check_availability",
  "desk_contact",
];
const OMITTED = [
  "show_tables",
  "request_table",
  "booking_status",
  "cancel_booking",
  "create_checkout",
  "get_checkout",
  "update_checkout",
  "complete_checkout",
  "cancel_checkout",
];
const NO_REQUIRED = ["list_venues", "whats_on", "desk_contact"];
const REQUIRED: Record<string, string[]> = {
  check_availability: ["venue", "date"],
};
const TITLES: Record<string, string> = {
  list_venues: "List venues",
  whats_on: "What's on",
  check_availability: "Check availability",
  desk_contact: "Contact your relationship manager",
};

const SAMPLE_RESULT = {
  content: [
    {
      type: "text",
      text: "{\"venue\":\"billionaire\",\"tables\":[{\"id\":\"T12\",\"zone\":\"Stage\",\"seats\":6,\"minSpendAed\":5000}]}",
    },
  ],
  structuredContent: {
    venue: "billionaire",
    tables: [{ id: "T12", zone: "Stage", seats: 6, minSpendAed: 5000 }],
  },
};

const SAMPLE_ARGS = { venue: "billionaire", date: "2026-10-31" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-t1" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "dubaitable", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new TableatlasClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function hasAuthHeader(call: Captured): boolean {
  return Object.keys(call.headers).some(
    (k) => k.toLowerCase() === "authorization",
  );
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 4 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 4);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 4 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool (name, title, description, inputSchema)", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("serves the captured title on every tool, verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (const tool of TOOL_DEFS) {
      assert.equal(tool.title, TITLES[tool.name], tool.name);
      assert.equal(
        tool.title,
        fixture.tools.find((t) => t.name === tool.name)!.title,
      );
    }
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
  });

  it("list_venues, whats_on and desk_contact carry NO required key, exactly as captured", () => {
    for (const name of NO_REQUIRED) {
      const tool = TOOL_DEFS.find((t) => t.name === name)!;
      assert.equal("required" in schemaOf(tool), false, name);
    }
  });

  it("check_availability requires exactly venue and date, as captured", () => {
    for (const [name, required] of Object.entries(REQUIRED)) {
      const tool = TOOL_DEFS.find((t) => t.name === name)!;
      assert.deepEqual(schemaOf(tool).required, required, name);
    }
  });

  it("carries object type, additionalProperties false and no $schema on every inputSchema", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(schemaOf(tool).additionalProperties, false);
      assert.equal("$schema" in schemaOf(tool), false);
    }
  });

  it("list_venues and desk_contact carry an empty properties object verbatim", () => {
    for (const name of ["list_venues", "desk_contact"]) {
      const tool = TOOL_DEFS.find((t) => t.name === name)!;
      assert.deepEqual(schemaOf(tool).properties, {}, name);
      assert.deepEqual(Object.keys(schemaOf(tool).properties), [], name);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.deepEqual(
        Object.keys(schemaOf(TOOL_DEFS[i]).properties),
        Object.keys(schemaOf(fixture.tools[i]).properties),
      );
    }
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[1]).properties), [
      "date", "days",
    ]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[2]).properties), [
      "venue", "date", "party", "zone", "max_min_spend",
    ]);
  });

  it("carries the captured property shapes across the surface", () => {
    const on = schemaOf(TOOL_DEFS[1]).properties;
    assert.equal(on.date.type, "string");
    assert.equal(on.days.type, "integer");
    assert.equal(on.days.minimum, 1);
    assert.equal(on.days.maximum, 14);
    assert.equal(on.days.default, 7);
    const avail = schemaOf(TOOL_DEFS[2]).properties;
    assert.equal(avail.venue.type, "string");
    assert.equal(avail.date.type, "string");
    assert.equal(avail.party.type, "integer");
    assert.equal(avail.party.minimum, 1);
    assert.equal(avail.party.maximum, 30);
    assert.equal(avail.zone.type, "string");
    assert.equal(avail.max_min_spend.type, "number");
  });

  it("carries property descriptions exactly where the capture carries them, and nowhere else", () => {
    const on = schemaOf(TOOL_DEFS[1]).properties;
    assert.equal(on.date.description, "Start date YYYY-MM-DD (Dubai). Default today.");
    assert.equal("description" in on.days, false);
    const avail = schemaOf(TOOL_DEFS[2]).properties;
    assert.equal(
      avail.venue.description,
      "Venue id or name (billionaire, gigi, bagatelle, lepiaf, verde, raspoutine, coucou) — or an event name like \"The List\".",
    );
    assert.equal(avail.date.description, "YYYY-MM-DD");
    assert.equal(
      avail.party.description,
      "Number of guests; returns tables seating party..party+4.",
    );
    assert.equal(
      avail.zone.description,
      "Restrict to one zone, e.g. Stage, Terrace, Veranda.",
    );
    assert.equal(
      avail.max_min_spend.description,
      "Only tables with a minimum spend at or under this, AED.",
    );
  });

  it("isKnownTool recognises all 4 built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    for (const name of OMITTED) assert.equal(isKnownTool(name), false);
    assert.equal(isKnownTool("list"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("labelled omission: the 9 booking/checkout tools are absent", () => {
  it("none of the omitted tools is among the served tool names (registry level)", () => {
    for (const name of OMITTED) {
      assert.equal(TOOL_NAMES.includes(name), false, name);
      assert.equal(TOOL_DEFS.some((t) => t.name === name), false, name);
    }
    assert.equal(TOOL_DEFS.length, 4);
  });

  it("isKnownTool rejects every omitted tool (registry level)", () => {
    for (const name of OMITTED) {
      assert.equal(isKnownTool(name), false, name);
    }
  });

  it("the MCP layer rejects every omitted tool as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    for (const name of OMITTED) {
      await assert.rejects(
        () => handleCallTool(c, name, {}),
        (err: unknown) =>
          err instanceof McpError && err.code === ErrorCode.MethodNotFound,
        name,
      );
    }
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://dubaitable.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-t1");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-t1");
  });

  it("sends clientInfo name tableatlas and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "tableatlas", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    await c.callTool("whats_on", {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-t1");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the DUBAITABLE_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new TableatlasClient({
      fetchFn: upstream.fetchFn,
      env: { DUBAITABLE_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { DUBAITABLE_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new TableatlasClient({
      fetchFn: upstream.fetchFn,
      env: { DUBAITABLE_MCP_URL: "   " },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no Authorization header is ever sent (record declares no headers)", () => {
  it("sends no Authorization header with an empty environment", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => !hasAuthHeader(call)));
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when key-like env vars are set", async () => {
    const upstream = makeUpstream();
    const c = new TableatlasClient({
      fetchFn: upstream.fetchFn,
      env: {
        DUBAITABLE_API_KEY: "should-never-be-sent",
        API_KEY: "also-ignored",
        AUTHORIZATION: "Bearer planted",
      },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(upstream.calls.length, 3);
    assert.ok(upstream.calls.every((call) => !hasAuthHeader(call)));
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new TableatlasClient({
      fetchFn: upstream.fetchFn,
      env: { DUBAITABLE_API_KEY: "should-never-be-sent" },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), ["Accept", "Content-Type"]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a check_availability call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PRIMARY);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a check_availability call with every field verbatim", async () => {
    const args = {
      venue: "gigi",
      date: "2026-11-13",
      party: 8,
      zone: "Terrace",
      max_min_spend: 7500,
    };
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "check_availability");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards list_venues, whats_on and desk_contact under their own names", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool("list_venues", {});
    await c.callTool("whats_on", { date: "2026-10-31", days: 3 });
    await c.callTool("desk_contact", {});
    const callParams = upstream.calls
      .filter((call) => call.body.method === "tools/call")
      .map((call) => call.body.params as Record<string, unknown>);
    assert.deepEqual(callParams.map((p) => p.name), [
      "list_venues",
      "whats_on",
      "desk_contact",
    ]);
    assert.deepEqual(callParams[0].arguments, {});
    assert.deepEqual(callParams[1].arguments, { date: "2026-10-31", days: 3 });
    assert.deepEqual(callParams[2].arguments, {});
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "unknown venue" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(PRIMARY, { venue: "nowhere", date: "2026-10-31" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      "whats_on",
      { days: 3 },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "whats_on");
    assert.deepEqual(params.arguments, { days: 3 });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as tableatlas error text", () => {
  it("maps a JSON-RPC error to `tableatlas error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "availability lookup failed upstream" },
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "tableatlas error: availability lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to tableatlas error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "tableatlas error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "tableatlas error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "tableatlas error: malformed response");
  });

  it("maps a non-2xx upstream status to tableatlas error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "tableatlas error: HTTP 500");
  });

  it("maps a throwing fetch to tableatlas error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^tableatlas error: /);
  });

  it("maps a throwing initialize fetch to tableatlas error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "tableatlas error: socket hang up");
  });

  it("maps a timed-out call to tableatlas error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^tableatlas error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRIMARY, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRIMARY, "venue=billionaire"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects null arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRIMARY, null),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid check_availability call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, "list_venues", undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(
    args: string[],
    env: Record<string, string | undefined> = {},
  ) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, ...env },
    });
  }

  function runCliAsync(
    args: string[],
    env: Record<string, string | undefined> = {},
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", cliPath, ...args],
        { cwd: root, env: { ...process.env, ...env } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(res.stderr, /list_venues/);
    assert.match(res.stderr, /check_availability/);
  });

  it("the usage text names none of the 9 omitted tools", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    for (const name of OMITTED) {
      assert.equal(res.stderr.includes(name), false, name);
    }
  });

  it("no omitted tool is a CLI command: each prints Usage and exits 2", () => {
    for (const name of OMITTED) {
      const res = runCli([name, "{}"]);
      assert.equal(res.status, 2, name);
      assert.match(res.stderr, /Usage:/, name);
      assert.doesNotMatch(res.stderr, new RegExp(`one of: [^\\n]*${name}`), name);
    }
  });

  it("a kept tool subcommand forwards to the upstream and prints its result", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push(body);
        if (body.method === "initialize") {
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "sess-cli",
          });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                serverInfo: { name: "dubaitable", version: "1.0.0" },
              },
            }),
          );
          return;
        }
        if (body.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (body.method === "tools/call") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: "CLI-STUB-RESULT" }],
              },
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/mcp`;
      const res = await runCliAsync(
        ["check_availability", JSON.stringify(SAMPLE_ARGS)],
        { DUBAITABLE_MCP_URL: url },
      );
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /CLI-STUB-RESULT/);
      const callBodies = seen.filter((b) => b.method === "tools/call");
      assert.equal(callBodies.length, 1);
      const params = callBodies[0].params as Record<string, unknown>;
      assert.equal(params.name, "check_availability");
      assert.deepEqual(params.arguments, SAMPLE_ARGS);
    } finally {
      server.close();
    }
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([PRIMARY, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([PRIMARY, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
