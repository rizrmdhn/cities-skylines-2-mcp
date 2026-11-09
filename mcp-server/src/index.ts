#!/usr/bin/env node
/**
 * cs2-mcp - MCP server for Cities: Skylines II.
 *
 * Translates MCP tool calls into HTTP requests against the CS2MCP bridge mod
 * running inside the game (default http://127.0.0.1:8642, override with the
 * CS2_BRIDGE_URL environment variable).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerPromptsAndResources } from "./prompts.js";

const BRIDGE_URL = (process.env.CS2_BRIDGE_URL ?? "http://127.0.0.1:8642").replace(/\/+$/, "");
const BRIDGE_TOKEN = process.env.CS2MCP_TOKEN?.trim() ?? "";

class BridgeError extends Error {}

/** Routes that change game state; must match IsMutatingPath in CS2MCP.Bridge/HttpBridgeServer.cs. */
function isMutatingPath(path: string): boolean {
  return (
    path.startsWith("/build/") ||
    path.startsWith("/sim/") ||
    path.endsWith("/set") ||
    ["/game/save", "/ui/popups/dismiss", "/city/tiles/buy", "/city/dev-tree/purchase", "/transit/stops/place", "/transit/lines/create", "/transit/lines/delete"].includes(path)
  );
}

async function bridgeFetch(path: string, timeoutMs: number): Promise<Response> {
  const route = path.split("?", 1)[0];
  // The bridge decodes the query with Uri.UnescapeDataString, which keeps '+' literal, so spaces
  // (URLSearchParams writes them as '+'; a real '+' is already %2B) must go out as %20.
  const query = path.slice(route.length).replace(/\+/g, "%20");
  try {
    return await fetch(`${BRIDGE_URL}${route}${query}`, {
      method: isMutatingPath(route) ? "POST" : "GET",
      headers: BRIDGE_TOKEN ? { "X-CS2MCP-Token": BRIDGE_TOKEN } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new BridgeError(
      `Cannot reach the CS2 bridge at ${BRIDGE_URL} (${(err as Error).message}). ` +
        `Make sure Cities: Skylines II is running and the CS2MCP mod is enabled.`,
    );
  }
}

async function bridgeJson(path: string, timeoutMs = 12_000): Promise<unknown> {
  const res = await bridgeFetch(path, timeoutMs);
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const message = (payload as { error?: string })?.error ?? `bridge returned HTTP ${res.status}`;
    throw new BridgeError(String(message));
  }
  return payload;
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Single version source for the server: package.json (keep in step with the mod's csproj <Version>). */
const SERVER_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const server = new McpServer({ name: "cs2-mcp", version: SERVER_VERSION });

server.registerTool(
  "cs2_ping",
  {
    title: "Ping the game bridge",
    description:
      "Check that Cities: Skylines II is running with the CS2MCP bridge mod loaded. " +
      "Returns mod version, current game mode (MainMenu / Game / Editor) and whether a save is loading. " +
      "Works even while a save is still loading; use this first to diagnose connection issues.",
    inputSchema: {},
  },
  async () => {
    try {
      const ping = (await bridgeJson("/ping", 3_000)) as { version?: string };
      const bridgeVersion = ping.version ?? "unknown";
      return jsonResult({
        ...ping,
        serverVersion: SERVER_VERSION,
        versionWarning:
          bridgeVersion === SERVER_VERSION
            ? undefined
            : `bridge mod ${bridgeVersion} and MCP server ${SERVER_VERSION} differ; rebuild/redeploy both from the same checkout`,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_game_state",
  {
    title: "Get game state",
    description:
      "Get the current game state: game mode, whether a city is loaded, city name, " +
      "simulation pause/speed and the in-game date/time. simulation.forcedPause is 'popup' while a blocking " +
      "milestone/signature dialog holds the game at speed 0 (close it with cs2_dismiss_popups) and " +
      "'unfocused' while the game window lacks focus.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridgeJson("/state"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_city_overview",
  {
    title: "Get city overview",
    description:
      "Key statistics of the loaded city: population (plus citizens currently moving in), " +
      "average happiness and health, city treasury money, XP, in-game date and simulation speed. " +
      "Requires a loaded city.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridgeJson("/city/overview"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_demand",
  {
    title: "Get RCI zoning demand",
    description:
      "Residential (low/medium/high density), commercial, industrial, office and storage demand " +
      "of the loaded city (0-100), including the demand factors that explain WHY demand is high or low " +
      "(e.g. Taxes, Unemployment, EmptyZones, Homelessness). Positive factor values push demand up, " +
      "negative values push it down.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridgeJson("/city/demand"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_set_simulation",
  {
    title: "Pause / set simulation speed",
    description:
      "Control the simulation clock: pause/unpause the game and/or set the simulation speed " +
      "(0 = paused, 1 = normal, 2 = double, 4 = fastest UI speed; values up to 8 are accepted). " +
      "Returns the resulting state.",
    inputSchema: {
      paused: z.boolean().optional().describe("true to pause, false to resume"),
      speed: z.number().min(0).max(8).optional().describe("simulation speed multiplier (0-8)"),
    },
  },
  async ({ paused, speed }) => {
    if (paused === undefined && speed === undefined) {
      return errorResult(new Error("provide at least one of: paused, speed"));
    }
    const params = new URLSearchParams();
    if (speed !== undefined) params.set("speed", String(speed));
    if (paused !== undefined) params.set("paused", String(paused));
    try {
      return jsonResult(await bridgeJson(`/sim/control?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_screenshot",
  {
    title: "Take a screenshot",
    description:
      "Capture the current game view as a PNG image. Useful for seeing the city layout, " +
      "checking what the player is looking at, or verifying the result of an action. " +
      "Returns the image directly.",
    inputSchema: {
      width: z
        .number()
        .int()
        .min(64)
        .max(3840)
        .optional()
        .describe("Downscale the image to this width in pixels (default 1280, keeps aspect ratio)"),
    },
  },
  async ({ width }) => {
    const w = width ?? 1280;
    try {
      const res = await bridgeFetch(`/screenshot?width=${w}`, 30_000);
      if (!res.ok) {
        const text = await res.text();
        let message = `bridge returned HTTP ${res.status}`;
        try {
          message = (JSON.parse(text) as { error?: string })?.error ?? message;
        } catch {
          // keep default message
        }
        return errorResult(new BridgeError(message));
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        content: [
          { type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

/** Register a parameter-less tool that returns bridge JSON. */
function registerJsonTool(name: string, title: string, description: string, path: string) {
  server.registerTool(name, { title, description, inputSchema: {} }, async () => {
    try {
      return jsonResult(await bridgeJson(path));
    } catch (err) {
      return errorResult(err);
    }
  });
}

registerJsonTool(
  "cs2_budget",
  "Get budget breakdown",
  "Detailed city budget: total income/expenses, balance, and a per-source breakdown " +
    "(residential/commercial/industrial/office taxes, service fees, subsidies, service upkeep, " +
    "loan interest, electricity/water import-export, map tile upkeep). Values are monthly rates; " +
    "expenses are positive costs.",
  "/city/budget",
);

registerJsonTool(
  "cs2_city_services",
  "Get utility service status",
  "Electricity (production/consumption/battery/trade), water & sewage (capacity/consumption/trade) " +
    "and garbage accumulation of the loaded city. Compare production vs consumption to spot shortages.",
  "/city/services",
);

const COVERAGE_SERVICES = [
  "healthcare",
  "fireRescue",
  "police",
  "park",
  "post",
  "education",
  "emergencyShelter",
  "welfare",
  "telecom",
] as const;

server.registerTool(
  "cs2_coverage",
  {
    title: "Get public service coverage",
    description:
      "How well zoned buildings are covered by healthcare, fire & rescue, police, parks/leisure, post, education, " +
      "emergency shelters, welfare and telecom: per service the number and share of underserved buildings and residents, " +
      "level buckets (none/low/medium/high on the infoview's own colour scale), a breakdown by zone kind, provider count " +
      "and worstGaps: clusters of underserved buildings, most residents first, with a center x/z that is a good place for " +
      "a new service building. Optionally limited to an area (x, z, radius). Coverage updates as the simulation runs.",
    inputSchema: {
      service: z
        .array(z.enum(COVERAGE_SERVICES))
        .optional()
        .describe("Services to report (default all)"),
      x: z.number().optional().describe("Area center X (with z and radius)"),
      z: z.number().optional().describe("Area center Z"),
      radius: z.number().min(8).optional().describe("Area radius in meters"),
      minLevel: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Buildings below this level (0-1) count as underserved (default 0.34 = none or low). Telecom uses the game's happiness baseline instead"),
      cellSize: z.number().min(64).max(2048).optional().describe("Gap cluster cell size in meters (default 256)"),
      gaps: z.number().int().min(0).max(50).optional().describe("Max worstGaps per service (default 8)"),
      providers: z.boolean().optional().describe("Also list the provider buildings with their range and capacity"),
      limit: z.number().int().min(1).max(200).optional().describe("Max providers listed per service (default 30)"),
    },
  },
  async ({ service, x, z: zCoord, radius, minLevel, cellSize, gaps, providers, limit }) => {
    const params = new URLSearchParams();
    if (service?.length) params.set("service", service.join(","));
    if (x !== undefined && zCoord !== undefined) {
      params.set("x", String(x));
      params.set("z", String(zCoord));
      if (radius !== undefined) params.set("radius", String(radius));
    }
    if (minLevel !== undefined) params.set("minLevel", String(minLevel));
    if (cellSize !== undefined) params.set("cellSize", String(cellSize));
    if (gaps !== undefined) params.set("gaps", String(gaps));
    if (providers) params.set("providers", "true");
    if (limit !== undefined) params.set("limit", String(limit));
    const query = params.toString();
    try {
      return jsonResult(await bridgeJson(query ? `/city/coverage?${query}` : "/city/coverage", 20_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_economy",
  {
    title: "Get economy and production chains",
    description:
      "The city economy beyond demand: for every traded resource its production, consumption, net balance, local " +
      "production capacity, stored amount, import/export and which consumers use it (citizens, retail, industry, " +
      "offices, service upkeep...), biggest shortfall first; plus a company census per kind (commercial, office, " +
      "industrial, extractor, storage) with workers vs jobs, average profitability and companies still looking for a building.",
    inputSchema: {
      all: z.boolean().optional().describe("Also list resources with no activity"),
    },
  },
  async ({ all }) => {
    try {
      return jsonResult(await bridgeJson(all ? "/city/economy?all=true" : "/city/economy", 20_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_happiness",
  "Get happiness factors",
  "Why citizens are happy or unhappy: the city info panel's happiness factors (taxes, pollution, services, " +
    "homelessness, unemployment...) with their effect split into health and wellbeing, worst first, plus the " +
    "average happiness and health.",
  "/city/happiness",
);

registerJsonTool(
  "cs2_progression",
  "Get milestone progress",
  "XP, the achieved milestone, progress to the next one and what it rewards (money, development points, map " +
    "tiles, loan limit), and the development points available to spend.",
  "/city/progression",
);

server.registerTool(
  "cs2_dev_tree",
  {
    title: "List the development tree",
    description:
      "Development tree nodes grouped by service with cost, purchased state and why a node cannot be bought yet " +
      "(points, previous node, service not unlocked). Filter by service or show only what can be bought now.",
    inputSchema: {
      service: z.string().optional().describe("Service name substring, e.g. Healthcare, Transportation"),
      available: z.boolean().optional().describe("Only nodes that can be purchased now"),
    },
  },
  async ({ service, available }) => {
    const params = new URLSearchParams();
    if (service) params.set("service", service);
    if (available) params.set("available", "true");
    const query = bridgeQueryString(params);
    try {
      return jsonResult(await bridgeJson(query ? `/city/dev-tree?${query}` : "/city/dev-tree"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_dev_tree_purchase",
  {
    title: "Buy a development tree node",
    description:
      "Spend development points on a node from cs2_dev_tree, exactly like the development tree panel (the game " +
      "checks points and prerequisites). Irreversible: points are not refunded.",
    inputSchema: {
      node: z.string().describe("Node name from cs2_dev_tree"),
    },
  },
  async ({ node }) => {
    const params = new URLSearchParams({ node });
    try {
      return jsonResult(await bridgeJson(`/city/dev-tree/purchase?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_labor",
  "Get labor market",
  "Employment data: employed citizens, unemployment rate, homelessness, total/free jobs broken down " +
    "by required education level, and the population age structure (children/teens/adults/seniors).",
  "/city/labor",
);

server.registerTool(
  "cs2_statistics",
  {
    title: "Get statistic history",
    description:
      "Time series of a city statistic (sampled 32x per in-game day). Useful types: Population, Money, " +
      "Income, Expense, HouseholdCount, WorkerCount, Unemployed, TouristCount, CrimeRate, BirthRate, " +
      "DeathRate, CitizensMovedIn, CitizensMovedAway, ResidentialTaxableIncome, TrafficFlow-style passenger " +
      "counts (PassengerCountBus/Subway/Train...). An invalid type returns the full list of valid names.",
    inputSchema: {
      type: z.string().describe("StatisticType enum name, e.g. 'Population' or 'Money'"),
      parameter: z.number().int().optional().describe("Sub-index for parameterized statistics (default 0)"),
      samples: z.number().int().min(1).max(512).optional().describe("How many recent samples to return (default 64)"),
    },
  },
  async ({ type, parameter, samples }) => {
    const params = new URLSearchParams({ type });
    if (parameter !== undefined) params.set("parameter", String(parameter));
    if (samples !== undefined) params.set("samples", String(samples));
    try {
      return jsonResult(await bridgeJson(`/city/statistics?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_get_taxes",
  "Get tax rates",
  "Current tax rate and allowed range for each tax area: Residential, Commercial, Industrial, Office.",
  "/city/taxes",
);

server.registerTool(
  "cs2_set_tax",
  {
    title: "Set a tax rate",
    description:
      "Set the tax rate (integer percent) for one tax area. The rate is clamped to the game's allowed " +
      "range (returned in the response). Higher taxes raise income but lower demand and happiness.",
    inputSchema: {
      area: z.enum(["Residential", "Commercial", "Industrial", "Office"]).describe("Tax area to change"),
      rate: z.number().int().describe("New tax rate in percent"),
    },
  },
  async ({ area, rate }) => {
    try {
      return jsonResult(await bridgeJson(`/city/taxes/set?area=${area}&rate=${rate}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_policies",
  "List city policies",
  "All city-wide policies with their internal name, localized title, active state, locked state and " +
    "whether they take a slider adjustment value (e.g. Recycling, Education Subsidies, speed limits).",
  "/city/policies",
);

server.registerTool(
  "cs2_set_policy",
  {
    title: "Toggle a city policy",
    description:
      "Activate or deactivate a city-wide policy by its internal name (from cs2_policies). " +
      "Slider policies additionally accept an adjustment value. Locked policies cannot be set.",
    inputSchema: {
      name: z.string().describe("Policy internal name from cs2_policies"),
      active: z.boolean().describe("true to activate, false to deactivate"),
      adjustment: z.number().optional().describe("Slider value for slider policies (optional)"),
    },
  },
  async ({ name, active, adjustment }) => {
    const params = new URLSearchParams({ name, active: String(active) });
    if (adjustment !== undefined) params.set("adjustment", String(adjustment));
    try {
      return jsonResult(await bridgeJson(`/city/policies/set?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_service_budgets",
  "Get service budgets",
  "Per-service budget sliders (50-150%, 100 = default) with current efficiency, estimated upkeep cost " +
    "and building count for every city service (police, healthcare, education, transport, ...).",
  "/city/service-budgets",
);

server.registerTool(
  "cs2_set_service_budget",
  {
    title: "Set a service budget",
    description:
      "Set the budget percentage (50-150) for one city service by name (from cs2_service_budgets). " +
      "Lower budgets save money but reduce service efficiency; higher budgets do the opposite.",
    inputSchema: {
      service: z.string().describe("Service name from cs2_service_budgets"),
      percentage: z.number().int().min(50).max(150).describe("Budget percentage, 100 = default"),
    },
  },
  async ({ service, percentage }) => {
    const params = new URLSearchParams({ service, percentage: String(percentage) });
    try {
      return jsonResult(await bridgeJson(`/city/service-budgets/set?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_find_prefabs",
  {
    title: "Search placeable prefabs",
    description:
      "Search the game's building or road prefabs by name substring. Returns exact prefab names " +
      "needed by cs2_place_building, plus their type and locked state. Example queries: 'school', " +
      "'FireHouse', 'WindTurbine', 'Highway'.",
    inputSchema: {
      category: z
        .enum(["building", "road", "net", "tree"])
        .optional()
        .describe("Prefab category (default building); 'net' = all networks incl. train tracks, pipes, power lines, pedestrian paths"),
      query: z.string().optional().describe("Case-insensitive name substring filter"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
    },
  },
  async ({ category, query, limit }) => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (query) params.set("query", query);
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/prefabs?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_place_building",
  {
    title: "Place a building",
    description:
      "Place a building in the world at the given map coordinates (x, z in meters; the map is roughly " +
      "-7000 to +7000 on each axis, use cs2_list_buildings to see coordinates of existing buildings for " +
      "reference). Height is sampled from the terrain automatically. The game validates the placement " +
      "(collisions, terrain, water) and the call fails with an explanation if blocked. Costs city money " +
      "like a normal player action. Verify the result with cs2_screenshot or cs2_list_buildings.",
    inputSchema: {
      dryRun: z.boolean().optional().describe("Only run the game's validation and report validity and cost; nothing is built"),
      prefab: z.string().describe("Exact prefab name from cs2_find_prefabs"),
      x: z.number().describe("World X coordinate (meters)"),
      z: z.number().describe("World Z coordinate (meters)"),
      rotation: z.number().optional().describe("Rotation around Y axis in degrees (default 0)"),
      force: z.boolean().optional().describe("Place even if the prefab is milestone-locked"),
    },
  },
  async ({ prefab, x, z, rotation, force, dryRun }) => {
    const params = new URLSearchParams({ prefab, x: String(x), z: String(z) });
    if (rotation !== undefined) params.set("rotation", String(rotation));
    if (force) params.set("force", "true");
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/place?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_build_road",
  {
    title: "Build a road segment",
    description:
      "Build any network segment between two world coordinates (terrain-following): roads, train tracks, " +
      "pedestrian paths, power lines, pipes - any prefab from cs2_find_prefabs category 'road' or 'net'. " +
      "Straight by default; pass cx/cz for a curved segment through that control point. Length 8-1500m. " +
      "Endpoints on existing nodes connect to them. Costs city money; fails with an explanation if blocked.",
    inputSchema: {
      dryRun: z.boolean().optional().describe("Only run the game's validation and report validity and cost; nothing is built"),
      prefab: z.string().describe("Exact prefab name from cs2_find_prefabs (category road or net)"),
      x1: z.number().describe("Start X (meters)"),
      z1: z.number().describe("Start Z (meters)"),
      x2: z.number().describe("End X (meters)"),
      z2: z.number().describe("End Z (meters)"),
      cx: z.number().optional().describe("Curve control point X (with cz: builds a curve through it)"),
      cz: z.number().optional().describe("Curve control point Z"),
      e1: z.number().optional().describe("Elevation at start in meters (bridges/elevated; negative = tunnel-ish)"),
      e2: z.number().optional().describe("Elevation at end in meters"),
      force: z.boolean().optional().describe("Build even if the prefab is milestone-locked"),
    },
  },
  async ({ prefab, x1, z1, x2, z2, cx, cz, e1, e2, force, dryRun }) => {
    const params = new URLSearchParams({
      prefab,
      x1: String(x1),
      z1: String(z1),
      x2: String(x2),
      z2: String(z2),
    });
    if (cx !== undefined) params.set("cx", String(cx));
    if (cz !== undefined) params.set("cz", String(cz));
    if (e1 !== undefined) params.set("e1", String(e1));
    if (e2 !== undefined) params.set("e2", String(e2));
    if (force) params.set("force", "true");
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/road?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_list_buildings",
  {
    title: "List placed buildings",
    description:
      "List buildings existing in the city with their prefab name, world position and entity id " +
      "(index+version, needed for cs2_demolish). Filter by name substring to find specific buildings.",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive prefab-name substring filter"),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
    },
  },
  async ({ query, limit }) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/buildings?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_list_zones",
  "List zone types",
  "All zone types (residential low/medium/high, commercial, industrial, office...) with their " +
    "internal name, area type and locked state. Use the exact name with cs2_zone_area.",
  "/zones",
);

server.registerTool(
  "cs2_zone_area",
  {
    title: "Zone an area",
    description:
      "Paint zoning on all zonable cells within a radius around a point. Zone cells only exist " +
      "along roads (build a road first). Pass zone='None' to remove zoning. Buildings grow on zoned " +
      "cells while the simulation runs, driven by RCI demand (check cs2_demand).",
    inputSchema: {
      dryRun: z.boolean().optional().describe("Only run the game's validation and report validity and cost; nothing is built"),
      zone: z.string().describe("Exact zone name from cs2_list_zones, or 'None' to dezone"),
      x: z.number().describe("Center X (meters)"),
      z: z.number().describe("Center Z (meters)"),
      radius: z.number().min(8).max(200).optional().describe("Radius in meters (default 32)"),
      force: z.boolean().optional().describe("Zone even if the zone type is milestone-locked"),
    },
  },
  async ({ zone, x, z: zCoord, radius, force, dryRun }) => {
    const params = new URLSearchParams({ zone, x: String(x), z: String(zCoord) });
    if (radius !== undefined) params.set("radius", String(radius));
    if (force) params.set("force", "true");
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/zone?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_upgrade_road",
  {
    title: "Upgrade a road segment",
    description:
      "Apply upgrades to an existing road segment (from cs2_list_roads): grass, trees, wideSidewalk, " +
      "soundBarrier, parking, lighting, medianGrass, medianTrees. Combine multiple with commas. " +
      "The segment is recreated with the new composition via the game's tool pipeline.",
    inputSchema: {
      dryRun: z.boolean().optional().describe("Only run the game's validation and report validity and cost; nothing is built"),
      index: z.number().int().describe("Road segment entity index"),
      version: z.number().int().describe("Road segment entity version"),
      upgrades: z.string().describe("Comma-separated upgrade names, e.g. 'grass,lighting'"),
      side: z.enum(["both", "left", "right"]).optional().describe("Which side for side upgrades (default both)"),
    },
  },
  async ({ index, version, upgrades, side, dryRun }) => {
    const params = new URLSearchParams({ index: String(index), version: String(version), upgrades });
    if (side) params.set("side", side);
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/upgrade?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_list_roads",
  {
    title: "List road segments",
    description:
      "List road segments (edges) with entity id, prefab name, start/end coordinates and length. " +
      "Filter spatially with x/z/radius or by prefab-name substring. Use the entity id with cs2_demolish.",
    inputSchema: {
      query: z.string().optional().describe("Prefab-name substring filter"),
      x: z.number().optional().describe("Center X for spatial filter"),
      z: z.number().optional().describe("Center Z for spatial filter"),
      radius: z.number().optional().describe("Radius in meters for spatial filter (default 250)"),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
    },
  },
  async ({ query, x, z: zCoord, radius, limit }) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/roads?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_demolish",
  {
    title: "Demolish a building or road segment",
    description:
      "Demolish (bulldoze) one building (from cs2_list_buildings) or road segment (from cs2_list_roads) " +
      "identified by its entity index and version. Irreversible - double-check the target first.",
    inputSchema: {
      dryRun: z.boolean().optional().describe("Only run the game's validation and report validity and cost; nothing is built"),
      index: z.number().int().describe("Entity index from cs2_list_buildings"),
      version: z.number().int().describe("Entity version from cs2_list_buildings"),
    },
  },
  async ({ index, version, dryRun }) => {
    try {
      return jsonResult(await bridgeJson(`/build/demolish?index=${index}&version=${version}${dryRun ? "&dryRun=true" : ""}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_move_building",
  {
    title: "Relocate a building",
    description:
      "Move an existing building or object to a new spot and/or rotation WITHOUT demolishing it, exactly like the " +
      "game's Relocate button: same entity id, and the building keeps its upgrades, workers, vehicles and stats. " +
      "Allowed for the same objects the game allows (service buildings, signature buildings, service upgrades, " +
      "parks, props); zoned growables and hydro dams cannot be moved. Give x/z (new position) or dx/dz (offset) " +
      "and/or rotation in degrees (default keeps the current rotation). The game validates the new spot " +
      "(overlap, water, slope, road access...); dryRun=true only checks whether the move would be accepted.",
    inputSchema: {
      index: z.number().int().describe("Entity index (cs2_list_buildings / cs2_buildings_near)"),
      version: z.number().int().describe("Entity version"),
      x: z.number().optional().describe("New X (with z)"),
      z: z.number().optional().describe("New Z (with x)"),
      dx: z.number().optional().describe("Offset along X in meters (instead of x/z)"),
      dz: z.number().optional().describe("Offset along Z in meters (instead of x/z)"),
      rotation: z.number().optional().describe("New facing in degrees (same convention as cs2_place_building); default keeps it"),
      dryRun: z.boolean().optional().describe("Only check whether the game accepts the move"),
    },
  },
  async ({ index, version, x, z: zCoord, dx, dz, rotation, dryRun }) => {
    const params = new URLSearchParams({ index: String(index), version: String(version) });
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (dx !== undefined) params.set("dx", String(dx));
    if (dz !== undefined) params.set("dz", String(dz));
    if (rotation !== undefined) params.set("rotation", String(rotation));
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/move?${params.toString()}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_building_upgrades",
  {
    title: "List a building's upgrades",
    description:
      "The upgrade menu of a service building: every upgrade it can get (extension wings, extra garages, parking, " +
      "solar panels...) with cost, XP, locked state, whether a one-per-building upgrade is already built and how it " +
      "is placed (fixed spot vs. beside the building), plus the upgrades already installed with their entity ids.",
    inputSchema: {
      index: z.number().int().describe("Building entity index"),
      version: z.number().int().describe("Building entity version"),
    },
  },
  async ({ index, version }) => {
    try {
      return jsonResult(await bridgeJson(`/city/building-upgrades?index=${index}&version=${version}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_place_upgrade",
  {
    title: "Install a building upgrade",
    description:
      "Install an upgrade from cs2_building_upgrades on a service building through the game's upgrade pipeline " +
      "(cost, unlocks and validation by the game). Extensions go to their fixed spot automatically; upgrades placed " +
      "beside the building (parking lots, extra areas) need x/z and optionally rotation. dryRun=true only checks it " +
      "and reports the cost. Remove an installed upgrade with cs2_demolish on its entity.",
    inputSchema: {
      index: z.number().int().describe("Building entity index"),
      version: z.number().int().describe("Building entity version"),
      upgrade: z.string().describe("Upgrade prefab name from cs2_building_upgrades"),
      x: z.number().optional().describe("X for upgrades placed beside the building"),
      z: z.number().optional().describe("Z for upgrades placed beside the building"),
      rotation: z.number().optional().describe("Facing in degrees (default: the building's)"),
      force: z.boolean().optional().describe("Install even if the upgrade is locked"),
      dryRun: z.boolean().optional().describe("Only validate and report the cost"),
    },
  },
  async ({ index, version, upgrade, x, z: zCoord, rotation, force, dryRun }) => {
    const params = new URLSearchParams({ index: String(index), version: String(version), upgrade });
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (rotation !== undefined) params.set("rotation", String(rotation));
    if (force) params.set("force", "true");
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/service-upgrade?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_rename",
  {
    title: "Rename a building, district, street or line",
    description:
      "Give a building, district, transit line or street a custom name, like the game's rename field. For a street " +
      "pass any of its road segments; the whole named street is renamed. An empty name restores the default name.",
    inputSchema: {
      index: z.number().int().describe("Entity index"),
      version: z.number().int().describe("Entity version"),
      name: z.string().max(64).describe("New name ('' restores the default)"),
    },
  },
  async ({ index, version, name }) => {
    const params = new URLSearchParams({ index: String(index), version: String(version), name });
    try {
      return jsonResult(await bridgeJson(`/build/rename?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_get_camera",
  "Get camera state",
  "Current gameplay camera: pivot (look-at point), position, compass/tilt angles and zoom distance.",
  "/camera",
);

server.registerTool(
  "cs2_set_camera",
  {
    title: "Move the camera",
    description:
      "Point the gameplay camera: set the pivot (look-at world coordinates; height auto-sampled from " +
      "terrain unless y given), compass rotation angleX (degrees), tilt angleY (0-89) and zoom distance. " +
      "Combine with cs2_screenshot to LOOK at any place in the city - the AI's own eyes.",
    inputSchema: {
      x: z.number().optional().describe("Pivot X (requires z)"),
      z: z.number().optional().describe("Pivot Z (requires x)"),
      y: z.number().optional().describe("Pivot height (optional, terrain height used if omitted)"),
      angleX: z.number().optional().describe("Compass rotation in degrees"),
      angleY: z.number().optional().describe("Tilt in degrees (0 = horizontal, 89 = top-down)"),
      zoom: z.number().optional().describe("Camera distance (10-10000, larger = further out)"),
    },
  },
  async ({ x, z: zCoord, y, angleX, angleY, zoom }) => {
    const params = new URLSearchParams();
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (y !== undefined) params.set("y", String(y));
    if (angleX !== undefined) params.set("angleX", String(angleX));
    if (angleY !== undefined) params.set("angleY", String(angleY));
    if (zoom !== undefined) params.set("zoom", String(zoom));
    try {
      return jsonResult(await bridgeJson(`/camera/set?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_terrain",
  {
    title: "Get terrain & water map",
    description:
      "Sampled heightmap and water-depth grid of the whole map (14336x14336m). Returns row-major arrays; " +
      "waterDepths > 0 marks rivers/lakes/sea. Use to understand geography before planning construction.",
    inputSchema: {
      resolution: z.number().int().min(16).max(256).optional().describe("Grid resolution per axis (default 64)"),
    },
  },
  async ({ resolution }) => {
    const params = new URLSearchParams();
    if (resolution) params.set("resolution", String(resolution));
    try {
      return jsonResult(await bridgeJson(`/city/terrain?${bridgeQueryString(params)}`, 30_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_gridmap",
  {
    title: "Get data-layer grid",
    description:
      "The game's native cell-map grids as row-major arrays: landValue, groundPollution, airPollution, " +
      "noisePollution, groundWater, groundWaterPollution. Use to pick good locations (cheap land, clean " +
      "air, water for pumps) like a player reading infoviews.",
    inputSchema: {
      layer: z
        .enum(["landValue", "groundPollution", "airPollution", "noisePollution", "groundWater", "groundWaterPollution"])
        .describe("Which data layer to export"),
    },
  },
  async ({ layer }) => {
    try {
      return jsonResult(await bridgeJson(`/city/gridmap?layer=${layer}`, 30_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_zoning",
  {
    title: "Read current zoning",
    description:
      "Summary of painted zones: cells per zone type with occupied/empty split, whole-city or within a " +
      "radius. Empty zoned cells are where buildings will grow.",
    inputSchema: {
      x: z.number().optional().describe("Center X for area filter"),
      z: z.number().optional().describe("Center Z for area filter"),
      radius: z.number().optional().describe("Radius in meters (with x/z)"),
    },
  },
  async ({ x, z: zCoord, radius }) => {
    const params = new URLSearchParams();
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    try {
      return jsonResult(await bridgeJson(`/city/zoning?${bridgeQueryString(params)}`, 20_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_notifications",
  {
    title: "List warning notifications",
    description:
      "All active in-world warning icons (no electricity, no water, garbage piling up, abandoned buildings, " +
      "high rent...) with type counts, locations and target entities. The primary way to discover problems.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe("Max detailed items (default 100)"),
    },
  },
  async ({ limit }) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/notifications?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_inspect",
  {
    title: "Inspect an entity",
    description:
      "Detail view of one entity (building/road) by index+version: prefab, position, status flags " +
      "(abandoned/condemned/destroyed), renters with citizen/employee counts. Like clicking a building in game.",
    inputSchema: {
      index: z.number().int().describe("Entity index"),
      version: z.number().int().describe("Entity version"),
    },
  },
  async ({ index, version }) => {
    try {
      return jsonResult(await bridgeJson(`/entity/inspect?index=${index}&version=${version}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_get_loan",
  "Get city loan state",
  "Current loan principal, daily interest rate, daily payment and the city's creditworthiness (max borrowable).",
  "/city/loan",
);

server.registerTool(
  "cs2_set_loan",
  {
    title: "Borrow / repay loan",
    description:
      "Set the city's loan principal: higher than current = borrow more (cash added to treasury), " +
      "lower = repay, 0 = repay fully. Clamped to creditworthiness. Interest accrues daily.",
    inputSchema: {
      amount: z.number().int().min(0).describe("New total loan principal"),
    },
  },
  async ({ amount }) => {
    try {
      return jsonResult(await bridgeJson(`/city/loan/set?amount=${amount}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_get_fees",
  "Get service fees",
  "Current price the city charges per service (electricity, water, healthcare, education levels, garbage, " +
    "parking, public transport...) with slider ranges and estimated monthly income per fee.",
  "/city/fees",
);

server.registerTool(
  "cs2_set_fee",
  {
    title: "Set a service fee",
    description:
      "Set the fee/price for one service resource (name from cs2_get_fees). Higher fees raise income " +
      "but reduce usage and citizen happiness.",
    inputSchema: {
      resource: z.string().describe("Resource name from cs2_get_fees, e.g. 'Electricity'"),
      fee: z.number().describe("New fee value"),
    },
  },
  async ({ resource, fee }) => {
    const params = new URLSearchParams({ resource, fee: String(fee) });
    try {
      return jsonResult(await bridgeJson(`/city/fees/set?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_list_objects",
  {
    title: "List standalone trees/plants",
    description:
      "List standalone trees and plants (not building sub-objects) with entity ids and positions. " +
      "Filter by name or spatially. Use the entity id with cs2_demolish to remove them.",
    inputSchema: {
      query: z.string().optional().describe("Prefab-name substring filter"),
      x: z.number().optional().describe("Center X for spatial filter"),
      z: z.number().optional().describe("Center Z for spatial filter"),
      radius: z.number().optional().describe("Radius meters (default 250 with x/z)"),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
    },
  },
  async ({ query, x, z: zCoord, radius, limit }) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/objects?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_run_simulation",
  {
    title: "Run simulation for N in-game hours",
    description:
      "Unpause and run the simulation at the given speed, auto-pausing after the requested number of " +
      "in-game hours. Returns immediately with the target frame; poll cs2_game_state (frameIndex) to " +
      "track progress. Use cancel=true to stop early. The core loop for autonomous mayoring: " +
      "act, run time forward, observe results. Milestone / signature-building popups force the game to " +
      "speed 0 while open; by default this run closes them automatically (dismissPopups) so it is not " +
      "silently held paused. The response's forcedPause tells you if something still holds it.",
    inputSchema: {
      hours: z.number().min(0.1).max(96).optional().describe("In-game hours to run (required unless cancel)"),
      speed: z.number().min(0.5).max(8).optional().describe("Simulation speed while running (default 4)"),
      cancel: z.boolean().optional().describe("true to cancel a timed run and pause now"),
      dismissPopups: z
        .boolean()
        .optional()
        .describe("Auto-close blocking milestone/signature popups during this run (default true)"),
    },
  },
  async ({ hours, speed, cancel, dismissPopups }) => {
    const params = new URLSearchParams();
    if (cancel) params.set("cancel", "true");
    if (!cancel) params.set("dismissPopups", String(dismissPopups ?? true));
    if (hours !== undefined) params.set("hours", String(hours));
    if (speed !== undefined) params.set("speed", String(speed));
    try {
      return jsonResult(await bridgeJson(`/sim/run?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_save_game",
  {
    title: "Save the game",
    description:
      "Trigger a manual save (asynchronous). Use before large construction batches as a safety net. " +
      "Default name is timestamped 'CS2MCP ...'.",
    inputSchema: {
      name: z.string().optional().describe("Save name (default: timestamped)"),
    },
  },
  async ({ name }) => {
    const params = new URLSearchParams();
    if (name) params.set("name", name);
    try {
      return jsonResult(await bridgeJson(`/game/save?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerJsonTool(
  "cs2_tiles_info",
  "Get map tile info",
  "Owned/total map tiles, tiles available to purchase and upkeep settings. (Purchasing via API arrives in v0.9.)",
  "/city/tiles",
);

registerJsonTool(
  "cs2_list_districts",
  "List districts",
  "All districts with entity id, center position, polygon size and active policy count.",
  "/districts",
);

server.registerTool(
  "cs2_create_district",
  {
    title: "Create a district",
    description:
      "Draw a district over an area by polygon corners (3-32 points, world meters). Buildings and roads " +
      "inside get assigned to it; district policies can then be applied to just that area.",
    inputSchema: {
      dryRun: z.boolean().optional().describe("Only run the game's validation and report validity and cost; nothing is built"),
      nodes: z.string().describe("Polygon corners 'x1,z1;x2,z2;x3,z3;...' (counter-clockwise)"),
      prefab: z.string().optional().describe("District prefab name (default: the standard district)"),
    },
  },
  async ({ nodes, prefab, dryRun }) => {
    const params = new URLSearchParams({ nodes });
    if (prefab) params.set("prefab", prefab);
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/district?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_district_policies",
  {
    title: "List district policies",
    description:
      "Policies available for one district (speed limits, parking fees, combustion ban...) with " +
      "active/locked state. District from cs2_list_districts.",
    inputSchema: {
      index: z.number().int().describe("District entity index"),
      version: z.number().int().describe("District entity version"),
    },
  },
  async ({ index, version }) => {
    try {
      return jsonResult(await bridgeJson(`/district/policies?index=${index}&version=${version}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_set_district_policy",
  {
    title: "Toggle a district policy",
    description: "Activate/deactivate a policy on one district (policy name from cs2_district_policies).",
    inputSchema: {
      index: z.number().int().describe("District entity index"),
      version: z.number().int().describe("District entity version"),
      name: z.string().describe("Policy internal name"),
      active: z.boolean().describe("true to activate"),
      adjustment: z.number().optional().describe("Slider value for slider policies"),
    },
  },
  async ({ index, version, name, active, adjustment }) => {
    const params = new URLSearchParams({
      index: String(index),
      version: String(version),
      name,
      active: String(active),
    });
    if (adjustment !== undefined) params.set("adjustment", String(adjustment));
    try {
      return jsonResult(await bridgeJson(`/district/policies/set?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

const transitType = z.enum(["bus", "tram", "metro", "train"]);

/** An entity id (index+version) or a world point; the bridge takes "i:v" or "x,z" items joined by ';'. */
const entityOrPoint = z.union([
  z.object({ index: z.number().int(), version: z.number().int() }),
  z.object({ x: z.number(), z: z.number() }),
]);

function joinEntityOrPoints(items: z.infer<typeof entityOrPoint>[]): string {
  return items.map((item) => ("index" in item ? `${item.index}:${item.version}` : `${item.x},${item.z}`)).join(";");
}

/**
 * The bridge decodes query values with Uri.UnescapeDataString, which keeps '+'
 * literal, so spaces must go out as %20 (URLSearchParams writes '+'; a real '+'
 * is already %2B).
 */
function bridgeQueryString(params: URLSearchParams): string {
  return params.toString().replace(/\+/g, "%20");
}

server.registerTool(
  "cs2_list_transit_stops",
  {
    title: "List public transport stops",
    description:
      "List existing transit stops (bus/tram roadside stops, train/metro station platforms) with entity id, type, " +
      "name, position, owning station building, attached road and the lines already serving each stop. Filter by " +
      "type and/or spatially (sorted by distance when x/z given). prefabs=true also lists placeable roadside stop " +
      "prefabs for cs2_place_transit_stop.",
    inputSchema: {
      type: z.enum(["bus", "tram", "metro", "train", "airplane"]).optional().describe("Only stops of this transport type; airplane lists airport gates (passenger or cargo) and the map's air outside connections"),
      x: z.number().optional().describe("Center X for spatial filter"),
      z: z.number().optional().describe("Center Z for spatial filter"),
      radius: z.number().optional().describe("Radius in meters for spatial filter (default 500)"),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
      prefabs: z.boolean().optional().describe("Also list placeable roadside stop prefabs"),
    },
  },
  async ({ type, x, z: zCoord, radius, limit, prefabs }) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    if (limit) params.set("limit", String(limit));
    if (prefabs) params.set("prefabs", "true");
    try {
      return jsonResult(await bridgeJson(`/transit/stops?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_place_transit_stop",
  {
    title: "Place a bus/tram stop on a road",
    description:
      "Place a roadside bus or tram stop at the road nearest to (x, z), on the side of the road where the point is " +
      "(or on a specific road segment via road). Runs through the game's object tool pipeline: the game attaches " +
      "the stop to the road, snaps it to the curb, validates it (sidewalk, lanes, overlap, money) and charges the " +
      "normal cost. Train/metro stops are station buildings: use cs2_place_building for those. Returns the new " +
      "stop's entity id for cs2_create_transit_line. The road segment is regenerated, so its id may change.",
    inputSchema: {
      type: z.enum(["bus", "tram"]).describe("Stop type"),
      x: z.number().describe("World X of a point beside the road (meters)"),
      z: z.number().describe("World Z of a point beside the road (meters)"),
      road: z
        .object({ index: z.number().int(), version: z.number().int() })
        .optional()
        .describe("Force a specific road segment (from cs2_list_roads) instead of the nearest suitable one"),
      radius: z.number().min(4).max(200).optional().describe("Road search radius in meters (default 40)"),
      prefab: z.string().optional().describe("Exact stop prefab name (see cs2_list_transit_stops prefabs=true)"),
      force: z.boolean().optional().describe("Place even if the stop prefab is milestone-locked"),
    },
  },
  async ({ type, x, z: zCoord, road, radius, prefab, force }) => {
    const params = new URLSearchParams({ type, x: String(x), z: String(zCoord) });
    if (road) params.set("road", `${road.index}:${road.version}`);
    if (radius !== undefined) params.set("radius", String(radius));
    if (prefab) params.set("prefab", prefab);
    if (force) params.set("force", "true");
    try {
      return jsonResult(await bridgeJson(`/transit/stops/place?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_create_transit_line",
  {
    title: "Create a public transport line",
    description:
      "Create a bus/tram/metro/train line through existing stops, in order; the line automatically loops back to " +
      "the first stop. Each stop is a stop entity id, a station building id (its matching platform is used) or an " +
      "{x, z} point (snaps to the nearest existing stop of that type within snapRadius). Uses the game's own route " +
      "pipeline: it waits for the game to pathfind every segment, and fails with an explanation (e.g. 'no bus path " +
      "from stop #2 to stop #3') instead of creating a broken line. Needs a depot of the same type for vehicles.",
    inputSchema: {
      type: transitType.describe("Transport type"),
      stops: z.array(entityOrPoint).min(2).max(100).describe("Ordered stops (at least 2 different ones)"),
      name: z.string().max(64).optional().describe("Custom line name (default: the game's 'Bus Line N')"),
      color: z
        .string()
        .regex(/^#?[0-9a-fA-F]{6}$/)
        .optional()
        .describe("Line color as #RRGGBB (default: the game's color for this line type)"),
      snapRadius: z.number().min(5).max(300).optional().describe("Max distance for {x, z} stops to snap (default 60m)"),
      force: z.boolean().optional().describe("Create even if this line type is milestone-locked"),
    },
  },
  async ({ type, stops, name, color, snapRadius, force }) => {
    const params = new URLSearchParams({ type, stops: joinEntityOrPoints(stops) });
    if (name) params.set("name", name);
    if (color) params.set("color", color.startsWith("#") ? color : `#${color}`);
    if (snapRadius !== undefined) params.set("snapRadius", String(snapRadius));
    if (force) params.set("force", "true");
    try {
      return jsonResult(await bridgeJson(`/transit/lines/create?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_list_transit_lines",
  {
    title: "List public transport lines",
    description:
      "List transit lines with the same numbers the game's transportation panel shows: name, number, type, color, " +
      "active/visible, day/night schedule, stop count, vehicles, passengers on board, usage (occupancy) and length. " +
      "includeStops=true adds each stop in order with its waiting passengers. The game keeps no per-line ridership " +
      "history; city-wide passenger series are in cs2_statistics (PassengerCountBus, ...).",
    inputSchema: {
      type: transitType.optional().describe("Only lines of this transport type"),
      query: z.string().optional().describe("Case-insensitive line name substring"),
      includeStops: z.boolean().optional().describe("Include the ordered stop list with waiting passengers"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
    },
  },
  async ({ type, query, includeStops, limit }) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (query) params.set("query", query);
    if (includeStops) params.set("includeStops", "true");
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/transit/lines?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_delete_transit_line",
  {
    title: "Delete a public transport line",
    description:
      "Delete one transit line (from cs2_list_transit_lines) exactly like the game's own 'delete line' button. " +
      "Its stops stay in place. Irreversible: double-check the line first.",
    inputSchema: {
      index: z.number().int().describe("Line entity index"),
      version: z.number().int().describe("Line entity version"),
    },
  },
  async ({ index, version }) => {
    try {
      return jsonResult(await bridgeJson(`/transit/lines/delete?index=${index}&version=${version}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_list_map_tiles",
  {
    title: "List map tiles",
    description:
      "List map tiles with entity id, center, bounds, owned flag and natural features (buildable land, fertile " +
      "land, forest, oil, ore, water, fish), plus owned count, remaining tile permits and treasury. Filter by " +
      "ownership and spatially (sorted by distance when x/z given).",
    inputSchema: {
      owned: z.enum(["all", "owned", "unowned"]).optional().describe("Ownership filter (default all)"),
      x: z.number().optional().describe("Center X for spatial filter"),
      z: z.number().optional().describe("Center Z for spatial filter"),
      radius: z.number().optional().describe("Radius in meters for spatial filter (default 3000)"),
      features: z.boolean().optional().describe("Include natural features per tile (default true)"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max results (default 100)"),
    },
  },
  async ({ owned, x, z: zCoord, radius, features, limit }) => {
    const params = new URLSearchParams();
    if (owned) params.set("owned", owned);
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    if (features !== undefined) params.set("features", String(features));
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/tiles/list?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_buy_map_tiles",
  {
    title: "Buy map tiles",
    description:
      "Buy one or more unowned map tiles, by tile id (cs2_list_map_tiles) or by a point inside the tile. Uses the " +
      "game's own purchase logic (the Map Tiles panel's Purchase button): the game prices the tiles from their " +
      "features (price rises with tiles owned), requires enough tile permits (from milestones) and money, then " +
      "charges the treasury. Irreversible; returns the actual cost charged.",
    inputSchema: {
      tiles: z.array(entityOrPoint).min(1).max(50).describe("Tiles to buy: {index, version} or {x, z} inside the tile"),
    },
  },
  async ({ tiles }) => {
    const params = new URLSearchParams({ tiles: joinEntityOrPoints(tiles) });
    try {
      return jsonResult(await bridgeJson(`/city/tiles/buy?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_traffic",
  {
    title: "Traffic report",
    description:
      "Traffic diagnostics with the game's own numbers: the city-wide traffic flow (as the traffic info view " +
      "shows it), the roads with the lowest flow (0-100% per road like the road info panel, with volume and the " +
      "four daily periods) and every lane the game flags as a traffic bottleneck, grouped by road or intersection. " +
      "Filter spatially with x/z/radius. Use before and after road or transit changes to measure their effect; " +
      "values update 32 times per in-game day, so let the simulation run between checks.",
    inputSchema: {
      x: z.number().optional().describe("Center X for spatial filter"),
      z: z.number().optional().describe("Center Z for spatial filter"),
      radius: z.number().optional().describe("Radius in meters for spatial filter (default 1000)"),
      limit: z.number().int().min(1).max(200).optional().describe("How many worst roads to list (default 25)"),
      minVolume: z.number().min(0).optional().describe("Ignore roads with less volume than this when ranking (default 1)"),
    },
  },
  async ({ x, z: zCoord, radius, limit, minVolume }) => {
    const params = new URLSearchParams();
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    if (limit) params.set("limit", String(limit));
    if (minVolume !== undefined) params.set("minVolume", String(minVolume));
    try {
      return jsonResult(await bridgeJson(`/city/traffic?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_traffic_diagnose",
  {
    title: "Diagnose a traffic jam",
    description:
      "Why one road segment or junction is congested. Returns the junction layout (legs, lanes toward/away per " +
      "leg, lights/stop/roundabout/priority, distance to the next junction), the vehicles on and around it (type, " +
      "what stopped ones wait for, destinations, how many are passing through vs local, the 500 m areas most of them " +
      "head to), turning movements through each junction from the vehicles' own planned paths (with turns across " +
      "oncoming traffic marked), parallel streets that could take load, and findings: rule-of-thumb causes from traffic " +
      "engineering (signal delay, crossing conflicts, turns across traffic, short junction spacing, lane drops, through " +
      "traffic on minor roads, truck share, single destination cluster) each with evidence and the tools to fix it. " +
      "Pick the focus from cs2_traffic (bottlenecks / worstRoads) or cs2_vehicles (queueHeads). Take it while the jam " +
      "is present; the baseline block is what to compare after a change.",
    inputSchema: {
      index: z.number().int().optional().describe("Road segment or junction entity index (with version)"),
      version: z.number().int().optional().describe("Entity version"),
      x: z.number().optional().describe("Or a point: the nearest road within 300 m is used (its junction if the point is on one)"),
      z: z.number().optional().describe("Point Z"),
      localRadius: z
        .number()
        .min(200)
        .max(5000)
        .optional()
        .describe("Trips ending within this distance of the focus count as local, the rest as through traffic (default 1000)"),
    },
  },
  async ({ index, version, x, z: zCoord, localRadius }) => {
    const params = new URLSearchParams();
    if (index !== undefined) params.set("index", String(index));
    if (version !== undefined) params.set("version", String(version));
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (localRadius !== undefined) params.set("localRadius", String(localRadius));
    try {
      return jsonResult(await bridgeJson(`/city/traffic/diagnose?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_vehicles",
  {
    title: "Vehicle census and queue heads",
    description:
      "Every driving road vehicle (parked cars excluded) by type (personal car, taxi, bus, delivery/cargo truck, " +
      "service...) with how many are stopped, and for an area: their destinations (outside the city, residential, " +
      "commercial...) and what stopped vehicles wait for (vehicle ahead, red light, crossing or oncoming traffic). " +
      "queueHeads follows each stopped vehicle's blockers to the head of its queue, so it names the junctions or " +
      "roads actually holding traffic up and how many vehicles are stuck behind each; deadlocks lists loops of " +
      "vehicles blocking each other (gridlock). A live snapshot: repeat it to see what persists.",
    inputSchema: {
      x: z.number().optional().describe("Center X for the area breakdown"),
      z: z.number().optional().describe("Center Z for the area breakdown"),
      radius: z.number().optional().describe("Area radius in meters (default 500)"),
      limit: z.number().int().min(1).max(100).optional().describe("How many queue heads / deadlocks to list (default 15)"),
    },
  },
  async ({ x, z: zCoord, radius, limit }) => {
    const params = new URLSearchParams();
    if (x !== undefined) params.set("x", String(x));
    if (zCoord !== undefined) params.set("z", String(zCoord));
    if (radius !== undefined) params.set("radius", String(radius));
    if (limit) params.set("limit", String(limit));
    try {
      return jsonResult(await bridgeJson(`/city/vehicles?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_road_graph",
  {
    title: "Road graph of an area",
    description:
      "Road segments in an area with their junction ids (so you can see what connects to what), direction " +
      "(one-way roads run start to end), flow and volume, plus each junction's position, number of roads and " +
      "whether it has traffic lights or is a roundabout. Use it to plan road changes before cs2_replace_road, " +
      "cs2_build_road or cs2_demolish.",
    inputSchema: {
      x: z.number().describe("Center X"),
      z: z.number().describe("Center Z"),
      radius: z.number().min(1).max(2000).optional().describe("Radius in meters (default 300)"),
      limit: z.number().int().min(1).max(3000).optional().describe("Max road segments (default 400)"),
      query: z.string().optional().describe("Only prefabs whose name contains this"),
      allNets: z
        .boolean()
        .optional()
        .describe("Include every network, not just roads: train/subway/tram tracks (incl. stations' own tracks), paths..."),
    },
  },
  async ({ x, z: zCoord, radius, limit, query, allNets }) => {
    const params = new URLSearchParams({ x: String(x), z: String(zCoord) });
    if (radius !== undefined) params.set("radius", String(radius));
    if (limit) params.set("limit", String(limit));
    if (query) params.set("query", query);
    if (allNets) params.set("nets", "all");
    try {
      return jsonResult(await bridgeJson(`/city/road-graph?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_connect_road",
  {
    title: "Build a connected road or track",
    description:
      "Build a road, track or other network segment whose ends join the existing network, like drawing with the " +
      "road tool's snapping: each end snaps to the nearest junction of a compatible network within `snap` meters, " +
      "otherwise splits the nearest compatible segment at that point (a track never joins a road). Ends with " +
      "nothing in range start freely on the terrain. Straight, or curved through cx/cz (needed where tracks must " +
      "leave a junction smoothly). Use for new road links and ramps, and for track spurs to station tracks (find " +
      "those with cs2_building_connections). smooth=true makes each snapped end continue the direction of what it " +
      "joins (merge/diverge ramps onto a highway, track continuing a station's track end). Validated by the game; " +
      "costs money like a player build.",
    inputSchema: {
      prefab: z.string().describe("Exact network prefab name (cs2_find_prefabs category road or net)"),
      x1: z.number().describe("Start X"),
      z1: z.number().describe("Start Z"),
      x2: z.number().describe("End X"),
      z2: z.number().describe("End Z"),
      cx: z.number().optional().describe("Curve control point X (with cz)"),
      cz: z.number().optional().describe("Curve control point Z"),
      snap: z.number().min(0).max(50).optional().describe("Snap distance in meters (default 8; 0 = never snap)"),
      e1: z.number().optional().describe("Elevation of a free (unsnapped) start in meters: >0 bridge/flyover, <0 tunnel"),
      e2: z.number().optional().describe("Elevation of a free (unsnapped) end in meters"),
      smooth: z.boolean().optional().describe("Tangent-continuous ends: follow the split road or continue a dead end (not with cx/cz)"),
      force: z.boolean().optional().describe("Build even if the prefab is milestone-locked"),
      dryRun: z.boolean().optional().describe("Only run the game's validation and report validity and cost; nothing is built"),
    },
  },
  async ({ prefab, x1, z1, x2, z2, cx, cz, snap, e1, e2, smooth, force, dryRun }) => {
    const params = new URLSearchParams({
      prefab,
      x1: String(x1),
      z1: String(z1),
      x2: String(x2),
      z2: String(z2),
    });
    if (cx !== undefined) params.set("cx", String(cx));
    if (cz !== undefined) params.set("cz", String(cz));
    if (snap !== undefined) params.set("snap", String(snap));
    if (e1 !== undefined) params.set("e1", String(e1));
    if (e2 !== undefined) params.set("e2", String(e2));
    if (smooth) params.set("smooth", "true");
    if (force) params.set("force", "true");
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/road/connect?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_building_connections",
  {
    title: "Open track/road ends of a building",
    description:
      "The open ends of a building's own networks (train/subway/tram tracks of stations and depots, road and path " +
      "stubs, harbor waterways) that still need joining to the city, with position, elevation, network type and the " +
      "direction they point out of the building. Join each with cs2_connect_road (x1/z1 on the end, smooth=true). " +
      "Use right after placing a station, depot or harbor.",
    inputSchema: {
      index: z.number().int().describe("Building entity index"),
      version: z.number().int().describe("Building entity version"),
    },
  },
  async ({ index, version }) => {
    try {
      return jsonResult(await bridgeJson(`/city/building-connections?index=${index}&version=${version}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_terraform",
  {
    title: "Landscape the terrain",
    description:
      "Raise, lower, level or soften the terrain with the game's landscaping brush held at a point for `seconds` of " +
      "brush time (repeat for a stronger effect). level needs an absolute target height (read heights with " +
      "cs2_terrain). Validated by the game (owned tiles only); dryRun=true only checks it. Changing terrain under " +
      "buildings and roads can break them; prefer open ground.",
    inputSchema: {
      type: z.enum(["raise", "lower", "level", "soften"]).describe("Brush type"),
      x: z.number().describe("Brush center X"),
      z: z.number().describe("Brush center Z"),
      size: z.number().min(10).max(1000).optional().describe("Brush size in meters (default 100)"),
      strength: z.number().min(0.01).max(1).optional().describe("Brush strength 0-1 (default 0.5)"),
      seconds: z.number().min(0.1).max(5).optional().describe("Brush time in seconds (default 1)"),
      height: z.number().optional().describe("Target height in meters for level"),
      force: z.boolean().optional().describe("Use the tool even if it is locked"),
      dryRun: z.boolean().optional().describe("Only validate"),
    },
  },
  async ({ type, x, z: zCoord, size, strength, seconds, height, force, dryRun }) => {
    const params = new URLSearchParams({ type, x: String(x), z: String(zCoord) });
    if (size !== undefined) params.set("size", String(size));
    if (strength !== undefined) params.set("strength", String(strength));
    if (seconds !== undefined) params.set("seconds", String(seconds));
    if (height !== undefined) params.set("height", String(height));
    if (force) params.set("force", "true");
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/terraform?${params.toString()}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_prefab_info",
  {
    title: "Prefab dimensions and placement rules",
    description:
      "Footprint (lot in 8 m cells and meters), size, placement flags (e.g. Shoreline, RoadSide), placement " +
      "offset and cost of a building prefab, or the width and layers of a network prefab. Use before placing " +
      "large buildings such as harbors, stations and cargo terminals.",
    inputSchema: {
      name: z.string().describe("Exact prefab name (cs2_find_prefabs)"),
    },
  },
  async ({ name }) => {
    const params = new URLSearchParams({ name });
    try {
      return jsonResult(await bridgeJson(`/prefabs/info?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_buildings_near",
  {
    title: "Buildings near a point",
    description:
      "Buildings around a point, nearest first, with kind (residential/commercial/office/industrial/park/service), " +
      "footprint, position and the direction their front faces. Use to find free spots or the building to clear " +
      "before placing a station or depot.",
    inputSchema: {
      x: z.number().describe("Center X"),
      z: z.number().describe("Center Z"),
      radius: z.number().min(1).max(1000).optional().describe("Radius in meters (default 100)"),
      limit: z.number().int().min(1).max(300).optional().describe("Max results (default 40)"),
      query: z.string().optional().describe("Only prefabs whose name contains this"),
    },
  },
  async ({ x, z: zCoord, radius, limit, query }) => {
    const params = new URLSearchParams({ x: String(x), z: String(zCoord) });
    if (radius !== undefined) params.set("radius", String(radius));
    if (limit) params.set("limit", String(limit));
    if (query) params.set("query", query);
    try {
      return jsonResult(await bridgeJson(`/city/buildings/near?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_place_roadside",
  {
    title: "Place a building against a road",
    description:
      "Place a road-side building (station, depot, service building...) flush against a road segment, facing it: " +
      "at curve position t (0-1) along the segment, on its left or right side as seen driving from the segment's " +
      "start to its end. Position and rotation come from the road's geometry and the building's lot, so the front " +
      "touches the road edge. The game validates the placement; dryRun=true only reports it.",
    inputSchema: {
      prefab: z.string().describe("Exact building prefab name"),
      road: z.object({ index: z.number().int(), version: z.number().int() }).describe("Road segment (cs2_road_graph)"),
      side: z.enum(["left", "right"]).describe("Side of the road, as seen from the segment's start"),
      t: z.number().min(0).max(1).optional().describe("Position along the segment (default 0.5)"),
      gap: z.number().min(0).max(50).optional().describe("Extra distance from the road edge in meters (default 0)"),
      dryRun: z.boolean().optional().describe("Only compute the position and rotation"),
      force: z.boolean().optional().describe("Place even if the prefab is milestone-locked"),
    },
  },
  async ({ prefab, road, side, t, gap, dryRun, force }) => {
    const params = new URLSearchParams({ prefab, road: `${road.index}:${road.version}`, side });
    if (t !== undefined) params.set("t", String(t));
    if (gap !== undefined) params.set("gap", String(gap));
    if (dryRun) params.set("dryRun", "true");
    if (force) params.set("force", "true");
    try {
      return jsonResult(await bridgeJson(`/build/place/roadside?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_place_shoreline",
  {
    title: "Place a building on the shore",
    description:
      "Place a building that must stand on the water's edge (cargo/passenger harbors, water pumps, outlets...) at " +
      "the shoreline nearest a point, positioned and turned to face the land exactly like the game's placement " +
      "tool snaps it (the game then validates it). dryRun=true only reports the computed position and rotation. " +
      "Costs money like a player build.",
    inputSchema: {
      prefab: z.string().describe("Exact building prefab name"),
      x: z.number().describe("X of a point on the water's edge"),
      z: z.number().describe("Z of a point on the water's edge"),
      dryRun: z.boolean().optional().describe("Only compute the position and rotation"),
      force: z.boolean().optional().describe("Place even if the prefab is milestone-locked"),
    },
  },
  async ({ prefab, x, z: zCoord, dryRun, force }) => {
    const params = new URLSearchParams({ prefab, x: String(x), z: String(zCoord) });
    if (dryRun) params.set("dryRun", "true");
    if (force) params.set("force", "true");
    try {
      if (dryRun) {
        return jsonResult(await bridgeJson(`/build/place/shoreline?${bridgeQueryString(params)}`, 15_000));
      }
      // Compute the road-access hint first (the real placement completes asynchronously and cannot carry it).
      const probe = new URLSearchParams(params);
      probe.set("dryRun", "true");
      let roadAccess: unknown = undefined;
      try {
        roadAccess = ((await bridgeJson(`/build/place/shoreline?${bridgeQueryString(probe)}`, 15_000)) as any)?.computed?.roadAccess;
      } catch {
        /* the real call below reports the error */
      }
      const placed = (await bridgeJson(`/build/place/shoreline?${bridgeQueryString(params)}`, 15_000)) as any;
      return jsonResult(roadAccess ? { ...placed, roadAccess } : placed);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_replace_road",
  {
    title: "Replace road type",
    description:
      "Change the road type of existing segments in place, like the road tool's Replace mode: e.g. widen a " +
      "highway (Highway Oneway - 2 lanes -> 3 lanes) or turn a street into a one-way one. The game regenerates " +
      "the segments, lanes and zone blocks and validates the result (a wider road can remove buildings it " +
      "overlaps). invert=true flips the drawing direction, which sets the direction of one-way roads. The game " +
      "updates segments in place, so they normally keep their ids; the replaced segments are returned by position.",
    inputSchema: {
      roads: z
        .array(z.object({ index: z.number().int(), version: z.number().int() }))
        .min(1)
        .max(50)
        .describe("Road segments to replace (from cs2_list_roads or cs2_traffic)"),
      prefab: z.string().describe("New road prefab name (cs2_find_prefabs category road)"),
      invert: z.boolean().optional().describe("Flip the drawing direction (one-way roads then run the other way)"),
      force: z.boolean().optional().describe("Use the prefab even if it is milestone-locked"),
      dryRun: z.boolean().optional().describe("Only run the game's validation and report validity and cost; nothing is built"),
    },
  },
  async ({ roads, prefab, invert, force, dryRun }) => {
    const params = new URLSearchParams({
      roads: roads.map((r) => `${r.index}:${r.version}`).join(";"),
      prefab,
    });
    if (invert !== undefined) params.set("invert", String(invert));
    if (force) params.set("force", "true");
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/road/replace?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_line_policies",
  {
    title: "Transit line policies",
    description:
      "Policies available for one transit line (ticket price, vehicle count and similar options from the line " +
      "panel) with active state, current adjustment and slider range.",
    inputSchema: {
      index: z.number().int().describe("Line entity index (cs2_list_transit_lines)"),
      version: z.number().int().describe("Line entity version"),
    },
  },
  async ({ index, version }) => {
    const params = new URLSearchParams({ index: String(index), version: String(version) });
    try {
      return jsonResult(await bridgeJson(`/transit/lines/policies?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_set_line_policy",
  {
    title: "Set transit line policy",
    description:
      "Activate/deactivate a policy on one transit line (name from cs2_line_policies), e.g. the ticket price or " +
      "vehicle count slider, the same way the line panel does.",
    inputSchema: {
      index: z.number().int().describe("Line entity index"),
      version: z.number().int().describe("Line entity version"),
      name: z.string().describe("Policy internal name"),
      active: z.boolean().describe("true to activate"),
      adjustment: z.number().optional().describe("Slider value for slider policies"),
    },
  },
  async ({ index, version, name, active, adjustment }) => {
    const params = new URLSearchParams({
      index: String(index),
      version: String(version),
      name,
      active: String(active),
    });
    if (adjustment !== undefined) params.set("adjustment", String(adjustment));
    try {
      return jsonResult(await bridgeJson(`/transit/lines/policies/set?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_set_junction_control",
  {
    title: "Set junction traffic control",
    description:
      "Set how one road junction (node id from cs2_road_graph) is controlled, like the game's intersection " +
      "tools: lights = traffic lights, nolights = remove traffic lights, stop = all-way stop, default = the " +
      "game's automatic choice. Needs a junction of 3 or more roads. Save first: this recreates the junction.",
    inputSchema: {
      dryRun: z.boolean().optional().describe("Only run the game's validation and report validity and cost; nothing is built"),
      index: z.number().int().describe("Junction (node) entity index"),
      version: z.number().int().describe("Junction (node) entity version"),
      mode: z.enum(["lights", "nolights", "stop", "default"]).describe("Control to apply"),
    },
  },
  async ({ index, version, mode, dryRun }) => {
    const params = new URLSearchParams({ index: String(index), version: String(version), mode });
    if (dryRun) params.set("dryRun", "true");
    try {
      return jsonResult(await bridgeJson(`/build/junction?${bridgeQueryString(params)}`, 15_000));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_line_vehicles",
  {
    title: "Transit line vehicle models",
    description:
      "Vehicle models a transit line can use (the line panel's vehicle selection): the models currently chosen " +
      "and every candidate for the line's transport type with passenger capacity, role (engine, carriage, " +
      "multipleUnit or vehicle), max speed and the carriages an engine pulls.",
    inputSchema: {
      index: z.number().int().describe("Line entity index (cs2_list_transit_lines)"),
      version: z.number().int().describe("Line entity version"),
    },
  },
  async ({ index, version }) => {
    const params = new URLSearchParams({ index: String(index), version: String(version) });
    try {
      return jsonResult(await bridgeJson(`/transit/lines/vehicles?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_set_line_vehicles",
  {
    title: "Set transit line vehicle model",
    description:
      "Choose the vehicle model new vehicles on a transit line use, as the line panel's vehicle selection does: " +
      "primary = engine or single vehicle, secondary = carriage (names from cs2_line_vehicles). clear=true goes " +
      "back to a random model per vehicle. Vehicles already running keep their model.",
    inputSchema: {
      index: z.number().int().describe("Line entity index"),
      version: z.number().int().describe("Line entity version"),
      primary: z.string().optional().describe("Engine or single-vehicle model name"),
      secondary: z.string().optional().describe("Carriage model name (trains)"),
      clear: z.boolean().optional().describe("Remove the choice (random model per vehicle)"),
      force: z.boolean().optional().describe("Allow a milestone-locked model"),
    },
  },
  async ({ index, version, primary, secondary, clear, force }) => {
    const params = new URLSearchParams({ index: String(index), version: String(version) });
    if (primary !== undefined) params.set("primary", primary);
    if (secondary !== undefined) params.set("secondary", secondary);
    if (clear !== undefined) params.set("clear", String(clear));
    if (force !== undefined) params.set("force", String(force));
    try {
      return jsonResult(await bridgeJson(`/transit/lines/vehicles/set?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_popups",
  {
    title: "Blocking popup status",
    description:
      "Status of blocking UI popups (milestone reached, signature building unlocked). While one is open the game " +
      "forces the simulation to speed 0 every frame, so run/unpause commands appear to do nothing. Shows the " +
      "pending popups, whether blocking popups are enabled, auto-dismiss state and the current forced-pause reason.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridgeJson("/ui/popups"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_dismiss_popups",
  {
    title: "Close blocking popups",
    description:
      "Close every open milestone / signature-building popup exactly like its own close button, releasing the " +
      "forced pause. Milestone rewards are granted before the popup appears, so nothing is lost.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridgeJson("/ui/popups/dismiss"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_set_popups",
  {
    title: "Configure blocking popups",
    description:
      "blocking=false turns off the game's own 'blocking popups' interface option (saved to the game settings, " +
      "same as Options > Interface) so milestone/signature dialogs never pause the game. autoDismiss=true makes " +
      "the mod close such popups whenever they appear (not persisted; resets when the game restarts).",
    inputSchema: {
      blocking: z.boolean().optional().describe("Game option: show blocking popups (false = never show them)"),
      autoDismiss: z.boolean().optional().describe("Mod option: close blocking popups automatically"),
    },
  },
  async ({ blocking, autoDismiss }) => {
    const params = new URLSearchParams();
    if (blocking !== undefined) params.set("blocking", String(blocking));
    if (autoDismiss !== undefined) params.set("autoDismiss", String(autoDismiss));
    try {
      return jsonResult(await bridgeJson(`/ui/popups/set?${bridgeQueryString(params)}`));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cs2_wait_simulation",
  {
    title: "Wait for the simulation",
    description:
      "Block (up to maxSeconds, max 55) until the simulation is paused again - e.g. a cs2_run_simulation timed run " +
      "finished - then return the game state and city overview. Use it instead of polling cs2_game_state in a loop. " +
      "Returns early if a blocking popup holds the game (forcedPause='popup').",
    inputSchema: {
      maxSeconds: z.number().min(1).max(55).optional().describe("Longest time to wait in real seconds (default 50)"),
    },
  },
  async ({ maxSeconds }) => {
    const deadline = Date.now() + (maxSeconds ?? 50) * 1000;
    try {
      let state: any = await bridgeJson("/state");
      while (Date.now() < deadline) {
        const sim = state?.simulation;
        if (!sim || sim.paused || sim.forcedPause === "popup") break;
        await new Promise((r) => setTimeout(r, 2000));
        state = await bridgeJson("/state");
      }
      const overview = await bridgeJson("/city/overview").catch(() => null);
      const sim = state?.simulation;
      return jsonResult({
        finishedWaiting: Boolean(sim?.paused),
        stillRunning: Boolean(sim && !sim.paused),
        state,
        overview,
        note: sim && !sim.paused ? "still running: call cs2_wait_simulation again or do other read-only checks" : undefined,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerPromptsAndResources(server, bridgeJson);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`cs2-mcp ${SERVER_VERSION} running on stdio (bridge: ${BRIDGE_URL})`);
