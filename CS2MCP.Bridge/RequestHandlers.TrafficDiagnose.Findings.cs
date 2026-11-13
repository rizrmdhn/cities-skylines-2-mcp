using System;
using System.Collections.Generic;
using Game.Net;
using Game.UI;
using Game.Vehicles;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Traffic diagnosis, findings half: rule-of-thumb causes from the layout, lanes, vehicles and queue
    /// heads, ordered by rank, each with cause/effect text, links to related findings and a concrete target.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private static string RefOf(Entity entity)
        {
            return $"{entity.Index}:{entity.Version}";
        }

        private static int SeverityScore(string severity)
        {
            switch (severity)
            {
                case "high": return 300;
                case "medium": return 200;
                case "low": return 150;
                default: return 100;
            }
        }

        private HashSet<string> LaneTurns(LaneInfo lane, TrafficSample avg)
        {
            if (lane.AllowedTurns.Count > 0)
            {
                return lane.AllowedTurns;
            }
            var turns = new HashSet<string>();
            if (avg.Lanes.TryGetValue(lane.Lane, out LaneSample ls))
            {
                foreach (KeyValuePair<string, int> pair in ls.Turns)
                {
                    turns.Add(pair.Key);
                }
            }
            return turns;
        }

        private List<Finding> BuildTrafficFindings(
            DiagnoseContext ctx, TrafficSample avg, List<TrafficSample> samples, DiagnoseNumbers num,
            List<ParallelStreet> parallel, List<QueueSummary> heads, NameSystem names)
        {
            var findings = new List<Finding>();
            int n = samples.Count;
            string crossingSide = ctx.LeftHand ? "right" : "left";

            Finding Add(string code, string severity, string evidence, string suggestion, string[] tools,
                string cause, string effect, JunctionInfo junction = null, object target = null, int weight = 0)
            {
                var finding = new Finding
                {
                    Id = "f" + (findings.Count + 1),
                    Code = code,
                    Severity = severity,
                    Evidence = evidence,
                    Suggestion = suggestion,
                    Tools = tools,
                    Cause = cause,
                    Effect = effect,
                    Junction = junction,
                    Target = target,
                    Score = weight,
                };
                findings.Add(finding);
                return finding;
            }
            string InSamples(int hits)
            {
                return n > 1 ? $" (in {hits} of {n} samples)" : "";
            }
            object RoadTarget(Entity edge, string suggestedPrefab)
            {
                return new { kind = "road", entity = EntityRef(edge), prefab = PrefabNameOf(edge), suggestedPrefab };
            }
            object JunctionTarget(JunctionInfo junction)
            {
                return new { kind = "junction", entity = EntityRef(junction.Node), control = junction.Control };
            }
            string RoadLabel(Entity edge)
            {
                string street = StreetNameOf(names, edge);
                return string.IsNullOrEmpty(street) ? $"road {RefOf(edge)} ({PrefabNameOf(edge)})" : $"{street} (road {RefOf(edge)}, {PrefabNameOf(edge)})";
            }
            string ReplaceTool(Entity edge, string prefab)
            {
                return $"cs2_replace_road roads={RefOf(edge)} prefab=\"{prefab}\" (dryRun=true first)";
            }

            // The queue head in the focus area (if any): findings at that junction rank higher.
            QueueSummary localHead = heads.Find(h => h.InScope);
            bool AtHead(JunctionInfo junction)
            {
                return localHead != null && (junction.Node == localHead.Owner || junction.Legs.Exists(l => l.Edge == localHead.Owner));
            }

            // ---- The queue starts outside the focus area ------------------------------------------------------
            int tracedTotal = 0;
            foreach (QueueSummary h in heads)
            {
                tracedTotal += h.QueuedTotal;
            }
            QueueSummary elsewhere = heads.Find(h => !h.InScope);
            if (elsewhere != null && avg.Stopped >= 3 && tracedTotal > 0 && elsewhere.QueuedTotal * 10 >= tracedTotal * 4
                && elsewhere.SamplesSeen * 2 >= n)
            {
                bool isNode = EntityManager.HasComponent<Node>(elsewhere.Owner) && !EntityManager.HasComponent<Edge>(elsewhere.Owner);
                string kind = isNode ? "junction" : "road";
                float distance = math.distance(elsewhere.Position.xz, ctx.FocusPosition.xz);
                Add("queueStartsElsewhere", "high",
                    $"{Math.Round((double)elsewhere.QueuedTotal / n, 1)} of the {avg.Stopped} stopped vehicles here queue behind a head " +
                    $"{math.round(distance)} m away: {kind} {RefOf(elsewhere.Owner)} ({PrefabNameOf(elsewhere.Owner)}), " +
                    $"waiting for {elsewhere.Blocker}, chain of up to {elsewhere.MaxChain + 1} vehicles" +
                    (elsewhere.Cycle ? " (the vehicles block each other in a loop: gridlock)" : "") + InSamples(elsewhere.SamplesSeen),
                    $"The jam does not start at the focus: it backs up from {kind} {RefOf(elsewhere.Owner)}. Diagnose that " +
                    "one first (cs2_traffic_diagnose with its index/version) and fix it; changes at the focus will not clear a " +
                    "queue that starts downstream.",
                    new[] { $"cs2_traffic_diagnose index={elsewhere.Owner.Index} version={elsewhere.Owner.Version}" },
                    $"a blockage or capacity limit at the queue head ({elsewhere.Blocker}) {math.round(distance)} m away",
                    "the queue spills back into the focus area, so everything stopped here is a symptom",
                    null,
                    new { kind, entity = EntityRef(elsewhere.Owner), prefab = PrefabNameOf(elsewhere.Owner), position = new { x = math.round(elsewhere.Position.x), z = math.round(elsewhere.Position.z) } },
                    1000);
            }

            // ---- Junctions ------------------------------------------------------------------------------------
            foreach (JunctionInfo junction in ctx.Junctions)
            {
                JunctionSample js = avg.Junctions[junction.Node];
                string at = $"junction {RefOf(junction.Node)}";
                int signal = Waiting(js.StoppedWaitingFor, BlockerType.Signal);
                int crossing = Waiting(js.StoppedWaitingFor, BlockerType.Crossing);
                int oncoming = Waiting(js.StoppedWaitingFor, BlockerType.Oncoming);
                int threshold = StoppedThreshold(js.Stopped);
                int headBonus = AtHead(junction) ? 120 : 0;
                Entity node = junction.Node;

                // Only when the condition holds in a majority of the samples: one frame of 5 cars at a red light is noise.
                int signalHits = CountSamples(samples, s =>
                {
                    JunctionSample j = s.Junctions[node];
                    return Waiting(j.StoppedWaitingFor, BlockerType.Signal) >= StoppedThreshold(j.Stopped);
                });
                int crossingHits = CountSamples(samples, s =>
                {
                    JunctionSample j = s.Junctions[node];
                    return Waiting(j.StoppedWaitingFor, BlockerType.Crossing) >= StoppedThreshold(j.Stopped);
                });
                bool signalPersistent = signalHits * 2 > n;
                bool crossingPersistent = crossingHits * 2 > n;

                // The leg with the most vehicles is where a change would act.
                LegInfo busiest = null;
                int busiestVehicles = -1;
                foreach (LegInfo leg in junction.Legs)
                {
                    int vehiclesOnLeg = 0;
                    foreach (LaneInfo lane in leg.Lanes)
                    {
                        if (avg.Lanes.TryGetValue(lane.Lane, out LaneSample ls))
                        {
                            vehiclesOnLeg += ls.Vehicles;
                        }
                    }
                    if (vehiclesOnLeg > busiestVehicles)
                    {
                        busiestVehicles = vehiclesOnLeg;
                        busiest = leg;
                    }
                }

                if (junction.Control == "trafficLights" && signalPersistent)
                {
                    string severity = signalHits * 3 >= n * 2 && signal >= 8 ? "high" : n == 1 && signal < 8 ? "low" : "medium";
                    Add("signalDelay", severity,
                        $"{at}: {signal} of {js.Stopped} stopped vehicles wait for a red light" + InSamples(signalHits),
                        $"Lights split green time between all directions, which lowers throughput at busy junctions with an uneven load. " +
                        $"Try removing the lights at {at} (cs2_set_junction_control mode=nolights or mode=stop for a small junction; dryRun " +
                        "first); on a big one, separate the dominant movement (overpass or ramp) or rebuild it as a roundabout in the game.",
                        new[] { $"cs2_set_junction_control index={node.Index} version={node.Version} mode=nolights (or stop)", "cs2_connect_road smooth=true" },
                        "traffic lights share green time between all directions at an unevenly loaded junction",
                        "vehicles queue on the legs waiting for green; the queue grows back along the approaching roads",
                        junction, JunctionTarget(junction), headBonus + math.min(signal, 60));
                }
                else if (junction.Control != "trafficLights" && junction.Control != "roundabout" && crossingPersistent)
                {
                    string severity = crossingHits * 3 >= n * 2 && crossing >= 8 ? "high" : n == 1 && crossing < 8 ? "low" : "medium";
                    Add("crossingConflict", severity,
                        $"{at}: {crossing} of {js.Stopped} stopped vehicles wait for crossing traffic (no lights)" + InSamples(crossingHits),
                        $"Unsignalised junctions stall when both roads are busy. Give {at} priority control with traffic lights " +
                        "(cs2_set_junction_control mode=lights, dryRun first), convert it to a roundabout in the game, or reduce the " +
                        "number of conflicting movements (make a minor leg one-way or end it before the junction).",
                        new[] { $"cs2_set_junction_control index={node.Index} version={node.Version} mode=lights", "cs2_replace_road", "cs2_demolish" },
                        "both roads are busy at a junction without signals, so vehicles have to wait for gaps",
                        "vehicles stop for crossing traffic and the queue backs up along the minor and major legs",
                        junction, JunctionTarget(junction), headBonus + math.min(crossing, 60));
                }

                // Turning movements across oncoming traffic.
                int movementTotal = 0;
                int crossingTurns = 0;
                var crossingFrom = new Dictionary<Entity, int>();
                var movementsByLeg = new Dictionary<Entity, List<(string Turn, int Count, int Stopped)>>();
                foreach (KeyValuePair<(Entity From, Entity To), int[]> pair in js.Movements)
                {
                    LegInfo from = junction.Legs.Find(l => l.Edge == pair.Key.From);
                    LegInfo to = junction.Legs.Find(l => l.Edge == pair.Key.To);
                    string turn = TurnOf(-from.Outward, to.Outward);
                    movementTotal += pair.Value[0];
                    if (!movementsByLeg.TryGetValue(from.Edge, out var list))
                    {
                        list = new List<(string, int, int)>();
                        movementsByLeg.Add(from.Edge, list);
                    }
                    list.Add((turn, pair.Value[0], pair.Value[1]));
                    if (turn == crossingSide)
                    {
                        crossingTurns += pair.Value[0];
                        crossingFrom.TryGetValue(from.Edge, out int soFar);
                        crossingFrom[from.Edge] = soFar + pair.Value[0];
                    }
                }
                float turnShare = movementTotal > 0 ? (float)crossingTurns / movementTotal : 0f;
                if (oncoming >= threshold || (movementTotal > 0 && turnShare >= 0.3f && crossingTurns >= 5))
                {
                    Entity worstFrom = Entity.Null;
                    int worstCount = 0;
                    foreach (KeyValuePair<Entity, int> pair in crossingFrom)
                    {
                        if (pair.Value > worstCount)
                        {
                            worstCount = pair.Value;
                            worstFrom = pair.Key;
                        }
                    }
                    string wider = worstFrom != Entity.Null ? SuggestWiderRoadPrefab(ctx, worstFrom) : null;
                    string where = worstFrom != Entity.Null ? $" from {RoadLabel(worstFrom)}" : "";
                    Add("crossingTurns", "medium",
                        $"{at}: {oncoming} stopped vehicles wait for oncoming traffic; {math.round(turnShare * 100f)}% of counted movements turn {crossingSide} across it{where}",
                        $"Turns across oncoming traffic ({crossingSide} turns here) block the lane behind them. Real-world fixes: " +
                        (wider != null ? $"a dedicated turn lane (replace {RoadLabel(worstFrom)} with '{wider}'), " : "a dedicated turn lane (a wider road with more lanes), ") +
                        "moving the turn to a nearby junction with lights, a roundabout, or a grade-separated ramp for the dominant turn.",
                        wider != null
                            ? new[] { ReplaceTool(worstFrom, wider), $"cs2_set_junction_control index={node.Index} version={node.Version} mode=lights" }
                            : new[] { "cs2_replace_road", $"cs2_set_junction_control index={node.Index} version={node.Version} mode=lights" },
                        $"vehicles turning {crossingSide} have to cross oncoming traffic and wait in the through lane",
                        "the waiting turners block the lane behind them, so the whole approach queues",
                        junction, worstFrom != Entity.Null ? RoadTarget(worstFrom, wider) : JunctionTarget(junction),
                        headBonus + math.min(oncoming, 60));
                }

                // Spacing, lane drops.
                foreach (LegInfo leg in junction.Legs)
                {
                    if (leg.Length < kShortJunctionSpacing && leg.FarNodeRoads >= 3)
                    {
                        Add("shortJunctionSpacing", "medium",
                            $"{at}: the next junction ({RefOf(leg.FarNode)}) along {RoadLabel(leg.Edge)} is only {math.round(leg.Length)} m away",
                            $"Junctions this close leave no room for a queue, so one junction's queue blocks the other " +
                            $"(spillback). Remove or merge one of the two connections ({at} or {RefOf(leg.FarNode)}), make the short link " +
                            $"({RefOf(leg.Edge)}) one-way, or move the side road further away.",
                            new[] { "cs2_demolish", "cs2_replace_road", "cs2_build_road" },
                            "two junctions are closer than a queue is long",
                            "one junction's queue spills into the other and blocks its green phase",
                            junction, RoadTarget(leg.Edge, null), headBonus);
                    }
                }

                if (junction.Legs.Count == 2)
                {
                    LegInfo a = junction.Legs[0];
                    LegInfo b = junction.Legs[1];
                    if (a.LanesToward > b.LanesAway || b.LanesToward > a.LanesAway)
                    {
                        LegInfo wide = a.LanesToward > b.LanesAway ? a : b;
                        LegInfo narrow = wide == a ? b : a;
                        string target = SuggestWiderRoadPrefab(ctx, narrow.Edge);
                        Add("laneDrop", "medium",
                            $"{at}: {wide.LanesToward} lanes arrive from {RoadLabel(wide.Edge)} but only {narrow.LanesAway} continue on {RoadLabel(narrow.Edge)}",
                            "A lane drop forces merges at one point and is a classic bottleneck. Keep the lane count " +
                            (target != null
                                ? $"until the next junction: replace {RoadLabel(narrow.Edge)} with '{target}' "
                                : "until the next junction (upgrade the narrow segment) ") +
                            "or end the extra lane as an exit.",
                            target != null ? new[] { ReplaceTool(narrow.Edge, target) } : new[] { "cs2_upgrade_road", "cs2_replace_road" },
                            $"the road narrows from {wide.LanesToward} to {narrow.LanesAway} lane(s)",
                            $"vehicles merge at one point and the queue backs up along {RoadLabel(wide.Edge)}",
                            junction, RoadTarget(narrow.Edge, target), headBonus + 10);
                    }
                }

                // ---- Lane analysis per leg -----------------------------------------------------------------
                foreach (LegInfo leg in junction.Legs)
                {
                    var lanes = leg.Lanes.FindAll(l => !l.Bus);
                    if (lanes.Count == 0)
                    {
                        continue;
                    }
                    var stats = new List<(LaneInfo Lane, int Vehicles, int Stopped)>();
                    int total = 0;
                    foreach (LaneInfo lane in lanes)
                    {
                        avg.Lanes.TryGetValue(lane.Lane, out LaneSample ls);
                        int v = ls?.Vehicles ?? 0;
                        stats.Add((lane, v, ls?.Stopped ?? 0));
                        total += v;
                    }

                    if (lanes.Count >= 2 && total >= 6)
                    {
                        (LaneInfo Lane, int Vehicles, int Stopped) top = stats[0];
                        foreach (var entry in stats)
                        {
                            if (entry.Vehicles > top.Vehicles)
                            {
                                top = entry;
                            }
                        }
                        int others = total - top.Vehicles;
                        if (top.Vehicles >= 0.65f * total && top.Stopped >= 3 && others <= math.max(2f, 1.5f * (lanes.Count - 1)))
                        {
                            var allowed = new List<string>(LaneTurns(top.Lane, avg));
                            allowed.Sort(StringComparer.Ordinal);
                            string allowedText = allowed.Count > 0 ? string.Join("/", allowed) : "unknown turns";
                            string wider = SuggestWiderRoadPrefab(ctx, leg.Edge);
                            Add("laneImbalance", "medium",
                                $"{at}, {RoadLabel(leg.Edge)}: lane {top.Lane.Order} from the left (allows {allowedText}) holds {top.Vehicles} of {total} " +
                                $"vehicles ({top.Stopped} stopped) while the other {lanes.Count - 1} lane(s) hold {others}",
                                "One lane carries the queue because the movement it serves is overloaded or the other lanes serve " +
                                $"movements few vehicles make. Give the busy movement ({allowedText}) a second lane" +
                                (wider != null ? $" (replace {RoadLabel(leg.Edge)} with '{wider}')" : " (a wider road)") +
                                ", or change which lanes serve it by moving the junction's side road or turn restriction.",
                                wider != null ? new[] { ReplaceTool(leg.Edge, wider) } : new[] { "cs2_replace_road", "cs2_connect_road" },
                                $"lane {top.Lane.Order} serves the dominant movement ({allowedText}) and the other lanes do not share it",
                                "the used lane's queue blocks the junction approach while the spare lanes stay empty",
                                junction, RoadTarget(leg.Edge, wider), headBonus + math.min(top.Stopped, 40));
                        }
                    }

                    // A dominant turn that shares its lane with through traffic.
                    if (movementsByLeg.TryGetValue(leg.Edge, out var legMoves))
                    {
                        int legTotal = 0;
                        foreach (var move in legMoves)
                        {
                            legTotal += move.Count;
                        }
                        (string Turn, int Count, int Stopped) dominant = default;
                        foreach (var move in legMoves)
                        {
                            if (move.Turn != "straight" && move.Count > dominant.Count)
                            {
                                dominant = move;
                            }
                        }
                        if (dominant.Count >= 4 && dominant.Count >= 0.35f * legTotal)
                        {
                            var carrying = new List<(LaneInfo Lane, int Vehicles, int Stopped)>();
                            bool allShareStraight = true;
                            foreach (var entry in stats)
                            {
                                HashSet<string> turns = LaneTurns(entry.Lane, avg);
                                if (turns.Contains(dominant.Turn))
                                {
                                    carrying.Add(entry);
                                    allShareStraight &= turns.Contains("straight");
                                }
                            }
                            int sharedVehicles = 0;
                            int sharedStopped = 0;
                            foreach (var entry in carrying)
                            {
                                sharedVehicles += entry.Vehicles;
                                sharedStopped += entry.Stopped;
                            }
                            if (carrying.Count > 0 && allShareStraight && sharedVehicles >= 3)
                            {
                                var order = new List<string>();
                                foreach (var entry in carrying)
                                {
                                    order.Add(entry.Lane.Order.ToString());
                                }
                                string wider = SuggestWiderRoadPrefab(ctx, leg.Edge);
                                Add("missingTurnLane", "medium",
                                    $"{at}, {RoadLabel(leg.Edge)}: {dominant.Count} of {legTotal} vehicles turn {dominant.Turn} here, but the lane(s) allowing it " +
                                    $"(lane {string.Join(", ", order)} from the left) also carry through traffic ({sharedVehicles} vehicles, {sharedStopped} stopped)",
                                    $"A {dominant.Turn} turn sharing a lane with through traffic blocks the through vehicles whenever a turner waits. " +
                                    $"Add a dedicated {dominant.Turn}-turn lane" +
                                    (wider != null ? $": replace {RoadLabel(leg.Edge)} with '{wider}'" : " (a wider road with more lanes)") +
                                    ", or move that turn to another junction.",
                                    wider != null ? new[] { ReplaceTool(leg.Edge, wider) } : new[] { "cs2_replace_road" },
                                    $"the main {dominant.Turn} movement shares its lane with through traffic",
                                    "each waiting turner blocks through vehicles behind it, cutting the approach's capacity",
                                    junction, RoadTarget(leg.Edge, wider), headBonus + math.min(sharedStopped, 40));
                            }
                        }
                    }
                }
            }

            // ---- Capacity of the focus road --------------------------------------------------------------------
            int maxLanes = math.max(num.LanesForward, num.LanesBackward);
            Entity focusRoad = ctx.FocusIsEdge ? ctx.Focus : Entity.Null;
            if (focusRoad == Entity.Null)
            {
                float worst = float.MaxValue;
                foreach (LegInfo leg in ctx.Junctions[0].Legs)
                {
                    if (leg.WorstFlow < worst)
                    {
                        worst = leg.WorstFlow;
                        focusRoad = leg.Edge;
                    }
                }
            }
            string flowText = $"flow {math.round(num.Flow)}% on average, {math.round(num.WorstFlow)}% in the worst daily period";
            if (num.WorstFlow < 50f && maxLanes > 0 && maxLanes <= 1 && !num.Highway)
            {
                string wider = SuggestWiderRoadPrefab(ctx, focusRoad);
                Add("lowCapacity", "medium",
                    $"{flowText} with {maxLanes} lane per direction, volume {math.round(num.Volume)}",
                    "A single lane per direction carrying through traffic is under-built. " +
                    (wider != null
                        ? $"Upgrade {RoadLabel(focusRoad)} to '{wider}', "
                        : "Upgrade it to a road with more lanes, ") +
                    "or give the traffic another route so it does not need this road.",
                    wider != null ? new[] { ReplaceTool(focusRoad, wider), "cs2_build_road" } : new[] { "cs2_upgrade_road", "cs2_build_road" },
                    "one lane per direction is not enough for this volume",
                    "traffic slows down along the whole segment, especially in the busiest daily period",
                    null, RoadTarget(focusRoad, wider), 20);
            }
            else if (num.WorstFlow < 50f && maxLanes >= 3)
            {
                Add("junctionLimited", "info",
                    $"{flowText} even with {maxLanes} lanes per direction",
                    "Adding lanes rarely helps when a road this wide is jammed: capacity is limited by its junctions, " +
                    "and extra capacity attracts more traffic (induced demand). Fix the junctions above, add parallel " +
                    "routes, or move trips to public transport.",
                    new[] { "cs2_set_junction_control", "cs2_create_transit_line" },
                    "the road has lanes to spare but its junctions pass fewer vehicles than it delivers",
                    "queues form at the junctions and back up along the wide road");
            }

            // ---- Trip structure ------------------------------------------------------------------------------------
            int withKnownDestination = avg.Local + avg.Far + avg.Outside;
            int connectedParallel = parallel.FindAll(p => p.Connected).Count;
            if (withKnownDestination >= 10)
            {
                float through = (float)(avg.Far + avg.Outside) / withKnownDestination;
                if (through >= 0.5f && !num.Highway && maxLanes <= 2)
                {
                    ParallelStreet alternative = parallel.Find(p => p.Connected);
                    string suggestion;
                    string[] tools;
                    object target = ctx.FocusIsEdge ? RoadTarget(ctx.Focus, null) : null;
                    if (alternative != null)
                    {
                        string wider = SuggestWiderRoadPrefab(ctx, alternative.Sample);
                        suggestion = $"Upgrade the connected parallel street {RoadLabel(alternative.Sample)}, {math.round(alternative.Offset)} m away " +
                                     $"(detour {Math.Round(alternative.DetourRatio, 2)}x the length of this road)" +
                                     (wider != null ? $" to '{wider}'" : " to an arterial") + " so the pathfinder prefers it. ";
                        tools = wider != null
                            ? new[] { ReplaceTool(alternative.Sample, wider), "cs2_connect_road" }
                            : new[] { "cs2_upgrade_road", "cs2_connect_road" };
                        target = RoadTarget(alternative.Sample, wider);
                    }
                    else if (parallel.Count > 0)
                    {
                        suggestion = $"{parallel.Count} parallel street(s) run nearby but none connects to both ends of this road as a detour. " +
                                     "Link one to the roads at both ends (cs2_connect_road) and upgrade it, or build an arterial bypass. ";
                        tools = new[] { "cs2_connect_road", "cs2_build_road" };
                    }
                    else
                    {
                        suggestion = "There is no parallel street nearby, so build an arterial bypass or a highway link. ";
                        tools = new[] { "cs2_build_road", "cs2_upgrade_road", "cs2_connect_road" };
                    }
                    Add("throughTraffic", "high",
                        $"{math.round(through * 100f)}% of vehicles here are going further than the local area or out of the city, " +
                        $"on a road with {maxLanes} lane(s) per direction; {connectedParallel} connected alternative(s) nearby",
                        "Road hierarchy: through traffic belongs on arterials and highways, local streets should only " +
                        "serve their neighbourhood. " + suggestion +
                        "Cars choose the fastest route, so the alternative must be faster, not just available.",
                        tools,
                        "through traffic uses a street built for local trips because no faster alternative exists",
                        "the street's capacity is consumed by vehicles that do not belong to the neighbourhood",
                        null, target, 30);
                }
                if ((float)avg.Outside / withKnownDestination >= 0.4f)
                {
                    Add("outsideConnection", "medium",
                        $"{math.round(100f * avg.Outside / withKnownDestination)}% of vehicles here are heading out of the city",
                        "Traffic to and from the outside connections funnels through this area. Give the highway entrance " +
                        "more capacity (smooth ramps, more lanes), add a second highway connection, or move cargo to " +
                        "rail, harbor or air.",
                        new[] { "cs2_connect_road smooth=true", "cs2_upgrade_road", "cs2_place_building" },
                        "the route to the outside connection runs through this area",
                        "outside traffic competes with local trips for the same lanes");
                }
                int topCluster = 0;
                foreach (DestinationCell cell in avg.Cells.Values)
                {
                    topCluster = math.max(topCluster, cell.Vehicles);
                }
                if ((float)topCluster / withKnownDestination >= 0.4f)
                {
                    Add("destinationCluster", "medium",
                        $"{math.round(100f * topCluster / withKnownDestination)}% of vehicles here head to the same 500 m area (destinationClusters[0])",
                        "One destination area draws most of the traffic. Give it more access points from different " +
                        "directions, connect it to an arterial, or serve it by public transport.",
                        new[] { "cs2_connect_road", "cs2_build_road", "cs2_create_transit_line" },
                        "one destination attracts most of the trips",
                        "all those trips use the same few roads, which saturate");
                }
            }

            if (avg.Vehicles >= 10 && (float)avg.Trucks / avg.Vehicles >= 0.35f)
            {
                Add("truckHeavy", "medium",
                    $"{avg.Trucks} of {avg.Vehicles} vehicles are trucks",
                    "Freight is a large part of this jam. Real-world fixes: separate freight from city traffic (a " +
                    "direct highway access road for the industrial area), move goods by cargo rail, harbor or airport, " +
                    "and avoid routing trucks through residential streets.",
                    new[] { "cs2_economy", "cs2_build_road", "cs2_place_building" },
                    "freight vehicles use city streets",
                    "trucks are slow and long, so they cut the capacity of every lane they use");
            }

            if (avg.Vehicles >= 10 && (float)avg.PersonalCars / avg.Vehicles >= 0.7f)
            {
                Add("carDependent", "info",
                    $"{avg.PersonalCars} of {avg.Vehicles} vehicles are private cars",
                    "Most trips here are private cars. A bus or tram line along this corridor (with stops near the " +
                    "destination clusters) takes cars off the road; mixed zoning shortens trips.",
                    new[] { "cs2_create_transit_line", "cs2_place_transit_stop", "cs2_zone_area" },
                    "most trips are made by private car",
                    "car volume alone loads the road");
            }

            int spawn = Waiting(avg.StoppedBy, BlockerType.Spawn);
            if (avg.Stopped > 0 && spawn >= math.max(5, avg.Stopped * 0.3f))
            {
                Add("accessConflict", "medium",
                    $"{spawn} of {avg.Stopped} stopped vehicles are waiting to leave a building or enter the road",
                    "Driveways and parking on a busy road interrupt the flow. Serve the buildings from a side street, " +
                    "or give the through traffic a separate road.",
                    new[] { "cs2_build_road", "cs2_replace_road" },
                    "buildings and parking access the busy road directly",
                    "vehicles entering the road stop the through traffic");
            }

            if (findings.Count == 0)
            {
                Add("noClearCause", "info",
                    avg.Vehicles == 0 ? "no vehicles on or around the focus right now" : $"{avg.Vehicles} vehicles, {avg.Stopped} stopped, no dominant cause",
                    "Run the simulation until the jam forms and diagnose again (with samples=4), or check cs2_vehicles for " +
                    "queue heads and deadlocks further away (the jam may start elsewhere and back up to here).",
                    new[] { "cs2_run_simulation", "cs2_vehicles", "cs2_traffic" },
                    "none of the rules matched",
                    "the focus may simply not be jammed at this moment");
            }

            // ---- Cause / effect links, ranking -------------------------------------------------------------------
            void Link(Finding cause, Finding effect)
            {
                if (cause != effect && !cause.Causes.Contains(effect.Id))
                {
                    cause.Causes.Add(effect.Id);
                    effect.CausedBy.Add(cause.Id);
                }
            }
            bool IsGeometry(string code)
            {
                return code == "laneDrop" || code == "laneImbalance" || code == "missingTurnLane" || code == "shortJunctionSpacing";
            }
            bool IsOperation(string code)
            {
                return code == "signalDelay" || code == "crossingConflict" || code == "crossingTurns";
            }
            foreach (Finding geometry in findings)
            {
                if (!IsGeometry(geometry.Code))
                {
                    continue;
                }
                foreach (Finding other in findings)
                {
                    bool sameJunction = geometry.Junction != null && other.Junction == geometry.Junction;
                    if ((sameJunction && IsOperation(other.Code)) || other.Code == "lowCapacity" && geometry.Code == "laneDrop")
                    {
                        Link(geometry, other);
                    }
                }
            }
            Finding upstream = findings.Find(f => f.Code == "queueStartsElsewhere");
            foreach (Finding f in findings)
            {
                if (upstream != null && (IsOperation(f.Code) || f.Code == "accessConflict"))
                {
                    Link(upstream, f);
                }
                if ((f.Code == "throughTraffic" || f.Code == "truckHeavy" || f.Code == "destinationCluster" || f.Code == "outsideConnection")
                    && findings.Find(o => o.Code == "lowCapacity" || o.Code == "junctionLimited") is Finding capacity)
                {
                    Link(f, capacity);
                }
            }
            foreach (Finding f in findings)
            {
                f.Score += SeverityScore(f.Severity) + (f.Causes.Count > 0 && f.Code != "queueStartsElsewhere" ? 40 : 0);
            }
            findings.Sort((a, b) => b.Score != a.Score ? b.Score.CompareTo(a.Score) : string.CompareOrdinal(a.Id, b.Id));
            for (int i = 0; i < findings.Count; i++)
            {
                findings[i].Rank = i + 1;
            }
            return findings;
        }
    }
}
