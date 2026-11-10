/**
 * MCP prompts (reusable workflows the user can pick in their client) and resources (live city
 * snapshots and a usage guide) for cs2-mcp. Tools stay in index.ts; this module only composes them.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type BridgeJson = (path: string, timeoutMs?: number) => Promise<unknown>;

function userPrompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

const SAFETY_RULES =
  "Ground rules: read state before acting; call cs2_save_game before the first change; run every build with " +
  "dryRun=true first and only apply what the game accepts; after changes, verify with cs2_screenshot or the " +
  "matching list tool; never demolish occupied buildings without asking me.";

export const GUIDE = `# Using cs2-mcp

## Coordinates and ids
- World coordinates are meters on the x/z plane, roughly -7168..7168; y is height. Heights come from the terrain
  automatically unless a tool takes y or an elevation.
- Entities are addressed by index + version (from the list/near/inspect tools). Ids go stale after demolition.
- Rotations are degrees: 0 faces +z, 90 faces +x (the facingDegrees of cs2_buildings_near uses the same convention).

## Safe changes
- cs2_save_game before large operations.
- Every build/demolish/zone/upgrade/move/terraform tool takes dryRun=true: the game validates (and prices) the change
  without applying it.
- Builds cost money like player builds and respect milestone locks (force=true overrides locks only).
- One build operation runs at a time: send build calls one after another, or put them in one cs2_batch.
- cs2_history lists what was changed and what it cost; the player may have set an AI spending limit (shown there).

## Typical flows
- Service gaps: cs2_coverage -> worstGaps -> cs2_find_prefabs -> cs2_place_roadside / cs2_place_building (dryRun) -> build.
- Upgrades: cs2_building_upgrades -> cs2_place_upgrade.
- Stations: cs2_place_building or cs2_place_roadside -> cs2_building_connections -> cs2_connect_road smooth=true.
- Moving a service building: cs2_move_building (keeps upgrades, workers and vehicles).
- Simulation: cs2_run_simulation for N in-game hours (closes milestone popups that would freeze it), cs2_wait_simulation
  until it pauses, then re-read cs2_city_overview / cs2_demand. A run that does not advance: cs2_popups.
- Specialized industry: cs2_economy (deficits) -> cs2_resources (richest clusters) -> cs2_specialized_area.
- Air, water and cargo lines: cs2_list_transit_stops type=airplane|ship|ferry|train (gates, piers, cargo terminals,
  outside connections) -> cs2_create_route.
- Builds stuck on "another build operation is in progress": cs2_tool_status.
- Why people are unhappy: cs2_happiness; what the economy lacks: cs2_economy; progress: cs2_progression -> cs2_dev_tree.
- Landscaping: cs2_terraform (raise/lower/level/soften), dryRun first.
- Many pieces at once (a road of several segments, roads plus zoning): cs2_batch, dryRun first.
- Interchanges: cs2_build_interchange dryRun=true -> read ramps/problems -> build. diamond or parclo joins a highway to
  an arterial or local road (service interchange); cloverleaf or trumpet joins two highways (system interchange). The
  two roads must already cross on different levels (trumpet: the minor road ends short of the through road).
- Traffic jams: cs2_traffic -> cs2_traffic_diagnose on the worst bottleneck -> one fix -> cs2_run_simulation ->
  cs2_traffic_diagnose again (see cs2://guide/traffic).

## Live resources
cs2://guide/traffic (traffic engineering playbook), cs2://game/state, cs2://city/overview, cs2://city/budget, cs2://city/demand, cs2://city/coverage, cs2://city/services
`;

export const TRAFFIC_GUIDE = `# Fixing traffic jams in Cities: Skylines II

Real-world traffic engineering, limited to what the game simulates and what the tools can change.

## Method (do not skip)
1. cs2_save_game.
2. Find the jam: cs2_traffic (worst roads, bottlenecks) and cs2_vehicles (queueHeads = where queues start,
   deadlocks = gridlock loops). The visible jam is often the tail; the cause is at the queue head.
3. cs2_traffic_diagnose on the queue head or bottleneck. Keep its baseline block.
4. Change ONE thing, dryRun first. Fix the cause the findings point to, not the symptom.
5. cs2_run_simulation for 3-6 in-game hours (traffic values refresh about every 45 in-game minutes; compare the
   same time of day if possible).
6. cs2_traffic_diagnose with the same focus and cs2_traffic around it. Keep the change only if flow rose and stopped
   vehicles fell without moving the jam next door. Otherwise undo it (the bridge cannot load a save; reverse the
   change, or reload the save in the game).

## Causes and fixes
| Finding | What happens | Fixes (tools) |
|---|---|---|
| signalDelay | Lights give each direction only part of the time | Remove lights or all-way stop on small junctions (cs2_set_junction_control); separate the dominant movement with a ramp or overpass (cs2_connect_road smooth=true, elevation) |
| crossingConflict | Busy unsignalised junction, vehicles wait for gaps | Lights (cs2_set_junction_control mode=lights); fewer conflicting movements: one-way minor leg (cs2_replace_road) or end the minor road before the junction |
| crossingTurns | Turns across oncoming traffic block the lane behind | Wider road with more lanes (cs2_upgrade_road); move the turn to a signalised junction; ramp for the dominant turn |
| shortJunctionSpacing | Queues spill from one junction into the next | Remove or merge one connection (cs2_demolish the short link), one-way pair, move the side road |
| laneDrop | Lanes merge at one point | Keep the lane count to the next junction (cs2_upgrade_road) or end the extra lane as an exit |
| lowCapacity | One lane per direction carries through traffic | Upgrade the road, or give the traffic another route |
| junctionLimited | Wide road jammed anyway | Do not add lanes (induced demand); fix the junctions, add parallel routes, add transit |
| throughTraffic | Minor road used as a shortcut | Road hierarchy: an arterial or highway route that is faster (cs2_build_road, cs2_upgrade_road); local streets should not be the fastest way through |
| outsideConnection | Traffic to the highway funnels through | Smooth on/off ramps, more ramp lanes, a second connection; cargo to rail, harbor or air |
| destinationCluster | One area attracts most trips | More access points from other directions, an arterial link, a transit line to it |
| truckHeavy | Freight in city traffic | Direct highway access for industry, cargo rail/harbor/airport, keep trucks off residential streets |
| carDependent | Almost all private cars | Bus or tram line along the corridor with stops at the destination clusters, mixed zoning to shorten trips |
| accessConflict | Vehicles entering from buildings interrupt flow | Serve buildings from a side street; separate through traffic |

## Principles that hold in the game
- Hierarchy: local streets -> collectors -> arterials -> highways, joined level by level. Avoid local streets
  connecting straight onto highways or big arterials.
- Fewer conflict points beat more lanes. Every junction on an arterial costs capacity; space them out.
- Drivers pick routes by cost; an alternative only helps when it is clearly better than the jammed road.
- Highways: on- and off-ramps need length and the same lane count in and out (no lane drop at the merge).
- Public transport and cargo rail remove vehicles; that scales better than widening.

## Real-world measures the game does not have
Signal timing plans, ramp metering, congestion pricing and tolls, flexible work hours, lane-by-lane
turn restrictions (vanilla). Do not propose them as tool actions.
`;

export function registerPromptsAndResources(server: McpServer, bridgeJson: BridgeJson): void {
  // ---- Resources -------------------------------------------------------------------------------
  server.registerResource(
    "cs2-guide",
    "cs2://guide",
    {
      title: "cs2-mcp usage guide",
      description: "Coordinates, entity ids, safe-change rules and typical tool flows",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
  );

  server.registerResource(
    "cs2-traffic-guide",
    "cs2://guide/traffic",
    {
      title: "Traffic engineering playbook",
      description: "Method and cause-to-fix table for traffic jams, matched to cs2_traffic_diagnose findings",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: TRAFFIC_GUIDE }] }),
  );

  const snapshots: Array<{ name: string; uri: string; title: string; path: string; description: string }> = [
    { name: "game-state", uri: "cs2://game/state", title: "Game state", path: "/state", description: "Mode, city name, pause/speed, in-game date" },
    { name: "city-overview", uri: "cs2://city/overview", title: "City overview", path: "/city/overview", description: "Population, happiness, health, money, XP" },
    { name: "city-budget", uri: "cs2://city/budget", title: "City budget", path: "/city/budget", description: "Income and expense breakdown" },
    { name: "city-demand", uri: "cs2://city/demand", title: "Zoning demand", path: "/city/demand", description: "RCI demand and its factors" },
    { name: "city-services", uri: "cs2://city/services", title: "Utilities", path: "/city/services", description: "Electricity, water, sewage, garbage" },
    { name: "city-coverage", uri: "cs2://city/coverage", title: "Service coverage", path: "/city/coverage", description: "Public service coverage and the worst gaps" },
  ];
  for (const snapshot of snapshots) {
    server.registerResource(
      snapshot.name,
      snapshot.uri,
      { title: snapshot.title, description: `${snapshot.description} (live from the running game)`, mimeType: "application/json" },
      async (uri) => {
        let payload: unknown;
        try {
          payload = await bridgeJson(snapshot.path, 20_000);
        } catch (err) {
          payload = { error: err instanceof Error ? err.message : String(err) };
        }
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
      },
    );
  }

  // ---- Prompts ---------------------------------------------------------------------------------
  server.registerPrompt(
    "city_health_check",
    {
      title: "City health check",
      description: "Read-only audit of the loaded city with prioritized recommendations",
    },
    () =>
      userPrompt(
        "Audit my Cities: Skylines II city without changing anything. Read cs2_city_overview, cs2_budget, " +
          "cs2_city_services, cs2_coverage, cs2_happiness, cs2_economy, cs2_demand, cs2_labor, cs2_notifications, " +
          "cs2_traffic and cs2_progression. Then report: " +
          "(1) the three most urgent problems with the numbers that prove them, (2) for each, a concrete fix using the " +
          "available tools (which tool, where, rough cost), (3) what to watch after the fix. Keep it short and ranked.",
      ),
  );

  server.registerPrompt(
    "fix_service_coverage",
    {
      title: "Fix a service coverage gap",
      description: "Find the worst coverage gap for a service and place a building there",
      argsSchema: {
        service: z
          .string()
          .optional()
          .describe("healthcare, fireRescue, police, park, post, education, emergencyShelter, welfare or telecom (default: the worst one)"),
      },
    },
    ({ service }) =>
      userPrompt(
        `${SAFETY_RULES}\n\n` +
          `Improve ${service ? `${service} coverage` : "the worst public service coverage"} in my city. ` +
          "Use cs2_coverage to find the worst gap (most underserved residents), check the area with cs2_buildings_near " +
          "and cs2_screenshot, pick a suitable unlocked building with cs2_find_prefabs and cs2_prefab_info, and place it " +
          "with cs2_place_roadside next to a road (dryRun first). If an existing building of that service is nearby, " +
          "consider cs2_building_upgrades / cs2_place_upgrade or cs2_move_building instead of a new one. Report the " +
          "coverage before and after (after running the simulation briefly with cs2_run_simulation).",
      ),
  );

  server.registerPrompt(
    "connect_station",
    {
      title: "Connect a station or depot",
      description: "Join a station's open track/road ends to the city's networks",
      argsSchema: {
        index: z.string().describe("Building entity index"),
        version: z.string().describe("Building entity version"),
      },
    },
    ({ index, version }) =>
      userPrompt(
        `${SAFETY_RULES}\n\n` +
          `Connect building ${index}:${version} to the city's networks. Call cs2_building_connections, then for every ` +
          "open end find the nearest compatible network (cs2_road_graph with allNets for tracks) and join it with " +
          "cs2_connect_road using smooth=true and a network prefab of the same kind (dryRun first). Re-run " +
          "cs2_building_connections at the end and report anything still open.",
      ),
  );

  server.registerPrompt(
    "plan_transit_line",
    {
      title: "Plan a public transport line",
      description: "Design and create a bus, tram, metro, train, ship, ferry or airplane line where it is needed most",
      argsSchema: {
        type: z.string().optional().describe("bus, tram, metro, train, ship, ferry or airplane (default bus)"),
        area: z.string().optional().describe("Optional area hint, e.g. 'x=1200,z=-300' or a district name"),
      },
    },
    ({ type, area }) =>
      userPrompt(
        `${SAFETY_RULES}\n\n` +
          `Plan a ${type ?? "bus"} line${area ? ` around ${area}` : ""}. Use cs2_traffic and cs2_buildings_near to find ` +
          "dense residential areas and job centers that are poorly connected, check existing lines with " +
          "cs2_list_transit_lines and stops with cs2_list_transit_stops, place missing stops (cs2_place_transit_stop for " +
          "bus/tram), create the line with cs2_create_transit_line (ship, ferry and airplane lines: cs2_create_route " +
          "between existing piers or gates and outside connections) and make sure a depot of that type exists. Report the " +
          "route, stop count and expected usage, and check cs2_list_transit_lines after running the simulation.",
      ),
  );

  server.registerPrompt(
    "fix_traffic_jam",
    {
      title: "Fix a traffic jam",
      description: "Find the worst jam, diagnose its cause and fix it one measured change at a time",
      argsSchema: {
        area: z.string().optional().describe("Optional area hint, e.g. 'x=1200,z=-300' (default: the worst jam in the city)"),
      },
    },
    ({ area }) =>
      userPrompt(
        `${SAFETY_RULES}\n\n` +
          `Fix the worst traffic jam${area ? ` around ${area}` : " in my city"}. Read the cs2://guide/traffic resource ` +
          "first and follow its method. Find the queue head with cs2_traffic and cs2_vehicles, run cs2_traffic_diagnose " +
          "on it and note the baseline. Explain the cause in one or two sentences using the findings and turning " +
          "movements. Then apply one fix at a time (dryRun first), run the simulation 3-6 in-game hours, diagnose the " +
          "same focus again and compare with the baseline. Keep a change only if it helped; stop after three attempts " +
          "and report each change with its before/after flow and stopped vehicles. Never demolish buildings to widen " +
          "roads without asking me.",
      ),
  );

  server.registerPrompt(
    "balance_budget",
    {
      title: "Balance the budget",
      description: "Find why the city loses money and propose tax, fee and budget changes",
    },
    () =>
      userPrompt(
        "Analyse my city's finances with cs2_budget, cs2_get_taxes, cs2_get_fees, cs2_service_budgets, cs2_get_loan and " +
          "cs2_statistics (Money, Income, Expense). Explain the main causes of the deficit or surplus, then propose at " +
          "most five concrete changes (cs2_set_tax, cs2_set_fee, cs2_set_service_budget, cs2_set_loan) with the expected " +
          "effect and the risk to demand or happiness. Do not apply anything until I confirm.",
      ),
  );
}
