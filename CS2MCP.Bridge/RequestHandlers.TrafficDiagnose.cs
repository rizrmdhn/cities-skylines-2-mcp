using System;
using System.Collections.Generic;
using Colossal.Mathematics;
using Game.Common;
using Game.Net;
using Game.Prefabs;
using Game.UI;
using Game.Vehicles;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;
using CarLane = Game.Net.CarLane;
using CarLaneFlags = Game.Net.CarLaneFlags;
using SubLane = Game.Net.SubLane;

namespace CS2MCP
{
    /// <summary>
    /// Why one road or junction is congested. Reads, for a focus road segment or junction: the junction
    /// layout (legs, lanes per direction, control, spacing to the next junction), the vehicles on and around
    /// it (type, what they wait for, where they are going and how far), the turning movements through each
    /// junction taken from the vehicles' own paths (current lane, navigation lanes, remaining PathElements),
    /// parallel streets that could share the load, and rule-of-thumb findings from traffic engineering
    /// mapped to the bridge's tools. Read-only.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private sealed class LegInfo
        {
            public Entity Edge;
            public Entity FarNode;
            public float2 Outward;
            public float Length;
            public int LanesToward;
            public int LanesAway;
            public int BusLanesToward;
            public bool Highway;
            public float Flow;
            public float Volume;
            public int FarNodeRoads;
        }

        private sealed class JunctionInfo
        {
            public Entity Node;
            public float3 Position;
            public string Control;
            public readonly List<LegInfo> Legs = new List<LegInfo>();
            public readonly Dictionary<(Entity From, Entity To), int[]> Movements = new Dictionary<(Entity From, Entity To), int[]>();
            public readonly Dictionary<string, int> StoppedWaitingFor = new Dictionary<string, int>();
            public int Stopped;
            public int Vehicles;
        }

        private sealed class DestinationCell
        {
            public int Vehicles;
            public float2 PositionSum;
            public readonly Dictionary<string, int> Kinds = new Dictionary<string, int>();
        }

        private sealed class ParallelStreet
        {
            public Entity Sample;
            public float Offset = float.MaxValue;
            public float FlowSum;
            public int Segments;
            public int Lanes;
        }

        // Turning movements look this many lanes/path elements ahead of each vehicle.
        private const int kPathLookahead = 48;
        // Junctions closer than this (m) along a leg spill queues into each other.
        private const float kShortJunctionSpacing = 60f;
        private const float kDestinationCellSize = 500f;

        private BridgeResponse DiagnoseTraffic(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            float localRadius = request.TryGetFloat("localRadius", out float rawLocal) ? math.clamp(rawLocal, 200f, 5000f) : 1000f;

            // ---- Focus ---------------------------------------------------------------------------
            Entity focus;
            if (request.TryGetInt("index", out int index) && request.TryGetInt("version", out int version))
            {
                focus = new Entity { Index = index, Version = version };
                if (!EntityManager.Exists(focus) || !(IsRoadEdge(focus) || IsRoadNode(focus)))
                {
                    return BridgeResponse.Error(404, $"{index}:{version} is not an existing road segment or junction");
                }
            }
            else if (request.TryGetFloat("x", out float px) & request.TryGetFloat("z", out float pz))
            {
                focus = FindTrafficFocus(new float2(px, pz), 300f);
                if (focus == Entity.Null)
                {
                    return BridgeResponse.Error(404, $"no road within 300 m of ({px}, {pz})");
                }
            }
            else
            {
                return BridgeResponse.Error(400, "provide ?index=&version= of a road segment or junction (from cs2_traffic bottlenecks/worstRoads or cs2_road_graph), or ?x=&z=");
            }

            bool focusIsEdge = EntityManager.HasComponent<Edge>(focus);
            var junctions = new List<JunctionInfo>();
            var scope = new HashSet<Entity>();
            float3 focusPosition;
            if (focusIsEdge)
            {
                Edge edge = EntityManager.GetComponentData<Edge>(focus);
                focusPosition = MathUtils.Position(EntityManager.GetComponentData<Curve>(focus).m_Bezier, 0.5f);
                scope.Add(focus);
                junctions.Add(BuildJunction(edge.m_Start));
                if (edge.m_End != edge.m_Start)
                {
                    junctions.Add(BuildJunction(edge.m_End));
                }
            }
            else
            {
                focusPosition = EntityManager.GetComponentData<Node>(focus).m_Position;
                junctions.Add(BuildJunction(focus));
            }
            foreach (JunctionInfo junction in junctions)
            {
                scope.Add(junction.Node);
                foreach (LegInfo leg in junction.Legs)
                {
                    scope.Add(leg.Edge);
                }
            }

            // ---- Vehicles ------------------------------------------------------------------------
            var types = new Dictionary<string, int>();
            var stoppedBy = new Dictionary<string, int>();
            var destinationKinds = new Dictionary<string, int>();
            var cells = new Dictionary<int2, DestinationCell>();
            int vehicles = 0;
            int stopped = 0;
            int local = 0;
            int far = 0;
            int outside = 0;
            int trucks = 0;
            int personalCars = 0;
            var ownerSequence = new List<Entity>(kPathLookahead + 8);
            using (NativeArray<Entity> cars = DrivingCarQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity car in cars)
                {
                    Entity lane = EntityManager.GetComponentData<CarCurrentLane>(car).m_Lane;
                    Entity laneOwner = OwnerOf(lane);
                    if (laneOwner == Entity.Null || !scope.Contains(laneOwner))
                    {
                        continue;
                    }
                    vehicles++;
                    string type = VehicleKind(car);
                    Increment(types, type);
                    if (type == "cargoTruck" || type == "deliveryTruck")
                    {
                        trucks++;
                    }
                    else if (type == "personalCar")
                    {
                        personalCars++;
                    }
                    float speed = EntityManager.HasComponent<Game.Objects.Moving>(car)
                        ? math.length(EntityManager.GetComponentData<Game.Objects.Moving>(car).m_Velocity)
                        : 0f;
                    bool isStopped = speed < kStoppedSpeed;
                    string waitingFor = null;
                    if (isStopped)
                    {
                        stopped++;
                        waitingFor = EntityManager.HasComponent<Blocker>(car)
                            ? EntityManager.GetComponentData<Blocker>(car).m_Type.ToString()
                            : BlockerType.None.ToString();
                        Increment(stoppedBy, waitingFor);
                    }

                    Entity destination = DestinationEntity(car);
                    string kind = DestinationKindOf(destination);
                    Increment(destinationKinds, kind);
                    if (kind == "outsideCity")
                    {
                        outside++;
                    }
                    if (TryGetEntityPosition(destination, out float3 destinationPosition))
                    {
                        if (kind != "outsideCity")
                        {
                            if (math.distance(destinationPosition.xz, focusPosition.xz) <= localRadius)
                            {
                                local++;
                            }
                            else
                            {
                                far++;
                            }
                        }
                        var cellKey = new int2((int)math.floor(destinationPosition.x / kDestinationCellSize), (int)math.floor(destinationPosition.z / kDestinationCellSize));
                        if (!cells.TryGetValue(cellKey, out DestinationCell cell))
                        {
                            cell = new DestinationCell();
                            cells.Add(cellKey, cell);
                        }
                        cell.Vehicles++;
                        cell.PositionSum += destinationPosition.xz;
                        Increment(cell.Kinds, kind);
                    }

                    // Turning movements: the owners (edges/nodes) of the lanes ahead of the vehicle.
                    BuildOwnerSequence(car, lane, ownerSequence);
                    foreach (JunctionInfo junction in junctions)
                    {
                        bool atJunction = laneOwner == junction.Node || junction.Legs.Exists(l => l.Edge == laneOwner);
                        if (!atJunction)
                        {
                            continue;
                        }
                        junction.Vehicles++;
                        if (isStopped)
                        {
                            junction.Stopped++;
                            Increment(junction.StoppedWaitingFor, waitingFor);
                        }
                        int k = ownerSequence.IndexOf(junction.Node);
                        if (k <= 0 || k + 1 >= ownerSequence.Count)
                        {
                            continue;
                        }
                        Entity from = ownerSequence[k - 1];
                        Entity to = ownerSequence[k + 1];
                        if (!junction.Legs.Exists(l => l.Edge == from) || !junction.Legs.Exists(l => l.Edge == to))
                        {
                            continue;
                        }
                        if (!junction.Movements.TryGetValue((from, to), out int[] counts))
                        {
                            counts = new int[2];
                            junction.Movements.Add((from, to), counts);
                        }
                        counts[0]++;
                        if (isStopped)
                        {
                            counts[1]++;
                        }
                    }
                }
            }

            // ---- Focus road numbers ----------------------------------------------------------------
            NameSystem names = World.GetOrCreateSystemManaged<NameSystem>();
            float focusFlow;
            float focusVolume;
            int focusLanesForward = 0;
            int focusLanesBackward = 0;
            bool focusHighway;
            if (focusIsEdge)
            {
                RoadFlowAndVolume(focus, out focusFlow, out focusVolume);
                CountCarLanes(focus, out focusLanesForward, out focusLanesBackward, out _, out _);
                focusHighway = IsHighwayRoad(focus);
            }
            else
            {
                // A junction's numbers: its busiest leg.
                focusFlow = 100f;
                focusVolume = 0f;
                focusHighway = false;
                foreach (LegInfo leg in junctions[0].Legs)
                {
                    focusFlow = math.min(focusFlow, leg.Flow);
                    focusVolume = math.max(focusVolume, leg.Volume);
                    focusLanesForward = math.max(focusLanesForward, leg.LanesToward);
                    focusLanesBackward = math.max(focusLanesBackward, leg.LanesAway);
                    focusHighway |= leg.Highway;
                }
            }

            List<object> parallel = focusIsEdge ? FindParallelStreets(focus, names) : new List<object>();

            // ---- Output -----------------------------------------------------------------------------
            bool leftHand = World.GetOrCreateSystemManaged<Game.City.CityConfigurationSystem>().leftHandTraffic;
            var junctionItems = new List<object>();
            var crossingTurnShares = new List<(JunctionInfo Junction, float Share, int Count)>();
            foreach (JunctionInfo junction in junctions)
            {
                var legItems = new List<object>();
                foreach (LegInfo leg in junction.Legs)
                {
                    legItems.Add(new
                    {
                        road = EntityRef(leg.Edge),
                        prefab = PrefabNameOf(leg.Edge),
                        street = StreetNameOf(names, leg.Edge),
                        bearingDegrees = math.round(BearingDegrees(leg.Outward)),
                        length = math.round(leg.Length),
                        lanesTowardJunction = leg.LanesToward,
                        lanesAwayFromJunction = leg.LanesAway,
                        busLanesTowardJunction = leg.BusLanesToward,
                        highway = leg.Highway,
                        flowPercent = math.round(leg.Flow),
                        volume = math.round(leg.Volume),
                        farEnd = new { junction = EntityRef(leg.FarNode), roads = leg.FarNodeRoads },
                    });
                }

                var movementItems = new List<(int Count, object Item)>();
                int movementTotal = 0;
                int crossingTurns = 0;
                foreach (KeyValuePair<(Entity From, Entity To), int[]> pair in junction.Movements)
                {
                    LegInfo from = junction.Legs.Find(l => l.Edge == pair.Key.From);
                    LegInfo to = junction.Legs.Find(l => l.Edge == pair.Key.To);
                    string turn = TurnOf(-from.Outward, to.Outward);
                    bool crossing = turn == (leftHand ? "right" : "left");
                    movementTotal += pair.Value[0];
                    if (crossing)
                    {
                        crossingTurns += pair.Value[0];
                    }
                    movementItems.Add((pair.Value[0], new
                    {
                        from = new { road = EntityRef(from.Edge), street = StreetNameOf(names, from.Edge), bearingDegrees = math.round(BearingDegrees(from.Outward)) },
                        to = new { road = EntityRef(to.Edge), street = StreetNameOf(names, to.Edge), bearingDegrees = math.round(BearingDegrees(to.Outward)) },
                        turn,
                        crossesOncomingTraffic = crossing,
                        vehicles = pair.Value[0],
                        stopped = pair.Value[1],
                    }));
                }
                movementItems.Sort((a, b) => b.Count.CompareTo(a.Count));
                if (movementTotal > 0)
                {
                    crossingTurnShares.Add((junction, (float)crossingTurns / movementTotal, crossingTurns));
                }
                var movementList = new List<object>();
                foreach (var entry in movementItems)
                {
                    movementList.Add(entry.Item);
                }

                junctionItems.Add(new
                {
                    junction = EntityRef(junction.Node),
                    position = new { x = math.round(junction.Position.x), z = math.round(junction.Position.z) },
                    roads = junction.Legs.Count,
                    control = junction.Control,
                    legs = legItems,
                    vehicles = junction.Vehicles,
                    stopped = junction.Stopped,
                    stoppedWaitingFor = junction.StoppedWaitingFor,
                    turningMovements = movementList,
                    movementsCounted = movementTotal,
                });
            }

            var destinationClusters = new List<object>();
            var cellList = new List<DestinationCell>(cells.Values);
            cellList.Sort((a, b) => b.Vehicles.CompareTo(a.Vehicles));
            for (int i = 0; i < cellList.Count && i < 5; i++)
            {
                DestinationCell cell = cellList[i];
                float2 center = cell.PositionSum / cell.Vehicles;
                destinationClusters.Add(new
                {
                    x = math.round(center.x),
                    z = math.round(center.y),
                    distance = math.round(math.distance(center, focusPosition.xz)),
                    vehicles = cell.Vehicles,
                    kinds = cell.Kinds,
                });
            }

            int withKnownDestination = local + far + outside;
            List<object> findings = BuildTrafficFindings(
                junctions, crossingTurnShares, leftHand, focusIsEdge, focusFlow, focusVolume,
                focusLanesForward, focusLanesBackward, focusHighway, vehicles, stopped, stoppedBy,
                trucks, personalCars, local, far, outside, withKnownDestination,
                cellList.Count > 0 ? cellList[0].Vehicles : 0, parallel.Count);

            return BridgeResponse.Json(new
            {
                focus = new
                {
                    kind = focusIsEdge ? "road" : "junction",
                    entity = EntityRef(focus),
                    prefab = PrefabNameOf(focus),
                    street = focusIsEdge ? StreetNameOf(names, focus) : null,
                    position = new { x = math.round(focusPosition.x), z = math.round(focusPosition.z) },
                    flowPercent = math.round(focusFlow),
                    volume = math.round(focusVolume),
                    lanes = focusIsEdge ? (object)new { forward = focusLanesForward, backward = focusLanesBackward } : null,
                    highway = focusHighway,
                },
                baseline = new
                {
                    flowPercent = math.round(focusFlow),
                    vehiclesNearby = vehicles,
                    stoppedNearby = stopped,
                    note = "re-run cs2_traffic_diagnose with the same focus after a change and a few in-game hours of simulation to compare",
                },
                vehicles = new
                {
                    total = vehicles,
                    stopped,
                    byType = types,
                    stoppedWaitingFor = stoppedBy,
                    destinations = destinationKinds,
                    trip = new
                    {
                        localRadius,
                        local,
                        farInCity = far,
                        outsideCity = outside,
                        throughSharePercent = withKnownDestination > 0 ? Math.Round(100.0 * (far + outside) / withKnownDestination, 1) : 0.0,
                    },
                    destinationClusters,
                },
                junctions = junctionItems,
                parallelStreets = parallel,
                findings,
                note = "vehicles = driving road vehicles on the focus road, its junctions and their legs (a snapshot; take " +
                       "it while traffic is jammed and repeat for stable numbers). turningMovements come from each vehicle's " +
                       "planned path through the junction; bearingDegrees: 0 = +z, 90 = +x, measured outward from the " +
                       "junction. trip.local = destination within localRadius of the focus, farInCity/outsideCity = traffic " +
                       "passing through. findings are rules of thumb from traffic engineering, not certainties: apply one " +
                       "change at a time (dryRun first), let the simulation run, then compare against baseline.",
            });
        }

        // ---- Findings ----------------------------------------------------------------------------------

        private List<object> BuildTrafficFindings(
            List<JunctionInfo> junctions, List<(JunctionInfo Junction, float Share, int Count)> crossingTurnShares,
            bool leftHand, bool focusIsEdge, float focusFlow, float focusVolume, int lanesForward, int lanesBackward,
            bool focusHighway, int vehicles, int stopped, Dictionary<string, int> stoppedBy, int trucks, int personalCars,
            int local, int far, int outside, int withKnownDestination, int topClusterVehicles, int parallelStreets)
        {
            var findings = new List<object>();
            void Add(string code, string severity, string evidence, string suggestion, string[] tools)
            {
                findings.Add(new { code, severity, evidence, suggestion, tools });
            }
            int Waiting(Dictionary<string, int> counts, BlockerType type)
            {
                return counts.TryGetValue(type.ToString(), out int n) ? n : 0;
            }

            string crossingSide = leftHand ? "right" : "left";
            foreach (JunctionInfo junction in junctions)
            {
                string at = $"junction {junction.Node.Index}:{junction.Node.Version}";
                int signal = Waiting(junction.StoppedWaitingFor, BlockerType.Signal);
                int crossing = Waiting(junction.StoppedWaitingFor, BlockerType.Crossing);
                int oncoming = Waiting(junction.StoppedWaitingFor, BlockerType.Oncoming);
                int threshold = math.max(5, (int)math.ceil(junction.Stopped * 0.3f));

                if (junction.Control == "trafficLights" && signal >= threshold)
                {
                    Add("signalDelay", "high",
                        $"{at}: {signal} of {junction.Stopped} stopped vehicles wait for a red light",
                        "Lights split green time between all directions, which lowers throughput at busy junctions with an " +
                        "uneven load. Try removing the lights (all-way priority or yield) or an all-way stop on a small " +
                        "junction; on a big one, separate the dominant movement (overpass or ramp) or rebuild it as a " +
                        "roundabout in the game.",
                        new[] { "cs2_set_junction_control mode=nolights|stop", "cs2_connect_road smooth=true" });
                }
                else if (junction.Control != "trafficLights" && junction.Control != "roundabout" && crossing >= threshold)
                {
                    Add("crossingConflict", "high",
                        $"{at}: {crossing} of {junction.Stopped} stopped vehicles wait for crossing traffic (no lights)",
                        "Unsignalised junctions stall when both roads are busy. Give priority with traffic lights, convert " +
                        "to a roundabout in the game, or reduce the number of conflicting movements (make a minor leg " +
                        "one-way or end it before the junction).",
                        new[] { "cs2_set_junction_control mode=lights", "cs2_replace_road", "cs2_demolish" });
                }

                (JunctionInfo Junction, float Share, int Count) turnShare = crossingTurnShares.Find(c => c.Junction == junction);
                if (oncoming >= threshold || (turnShare.Junction != null && turnShare.Share >= 0.3f && turnShare.Count >= 5))
                {
                    Add("crossingTurns", "medium",
                        $"{at}: {oncoming} stopped vehicles wait for oncoming traffic; " +
                        $"{math.round((turnShare.Junction != null ? turnShare.Share : 0f) * 100f)}% of counted movements turn {crossingSide} across it",
                        $"Turns across oncoming traffic ({crossingSide} turns here) block the lane behind them. Real-world fixes: " +
                        "a dedicated turn lane (a wider road with more lanes), moving the turn to a nearby junction " +
                        "with lights, a roundabout, or a grade-separated ramp for the dominant turn.",
                        new[] { "cs2_upgrade_road", "cs2_set_junction_control mode=lights", "cs2_connect_road smooth=true" });
                }

                foreach (LegInfo leg in junction.Legs)
                {
                    if (leg.Length < kShortJunctionSpacing && leg.FarNodeRoads >= 3)
                    {
                        Add("shortJunctionSpacing", "medium",
                            $"{at}: the next junction along road {leg.Edge.Index}:{leg.Edge.Version} is only {math.round(leg.Length)} m away",
                            "Junctions this close leave no room for a queue, so one junction's queue blocks the other " +
                            "(spillback). Remove or merge one of the two connections, make the short link one-way, or " +
                            "move the side road further away.",
                            new[] { "cs2_demolish", "cs2_replace_road", "cs2_build_road" });
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
                        Add("laneDrop", "medium",
                            $"{at}: {wide.LanesToward} lanes arrive from road {wide.Edge.Index}:{wide.Edge.Version} but only {narrow.LanesAway} continue",
                            "A lane drop forces merges at one point and is a classic bottleneck. Keep the lane count " +
                            "until the next junction (upgrade the narrow segment) or end the extra lane as an exit.",
                            new[] { "cs2_upgrade_road", "cs2_replace_road" });
                    }
                }
            }

            int maxLanes = math.max(lanesForward, lanesBackward);
            if (focusFlow < 50f && maxLanes > 0 && maxLanes <= 1 && !focusHighway)
            {
                Add("lowCapacity", "medium",
                    $"flow {math.round(focusFlow)}% with {maxLanes} lane per direction, volume {math.round(focusVolume)}",
                    "A single lane per direction carrying through traffic is under-built. Upgrade it to a road with " +
                    "more lanes, or give the traffic another route so it does not need this road.",
                    new[] { "cs2_upgrade_road", "cs2_build_road" });
            }
            else if (focusFlow < 50f && maxLanes >= 3)
            {
                Add("junctionLimited", "info",
                    $"flow {math.round(focusFlow)}% even with {maxLanes} lanes per direction",
                    "Adding lanes rarely helps when a road this wide is jammed: capacity is limited by its junctions, " +
                    "and extra capacity attracts more traffic (induced demand). Fix the junctions above, add parallel " +
                    "routes, or move trips to public transport.",
                    new[] { "cs2_set_junction_control", "cs2_create_transit_line" });
            }

            if (withKnownDestination >= 10)
            {
                float through = (float)(far + outside) / withKnownDestination;
                if (through >= 0.5f && !focusHighway && maxLanes <= 2)
                {
                    Add("throughTraffic", "high",
                        $"{math.round(through * 100f)}% of vehicles here are going further than the local area or out of the city, " +
                        $"on a road with {maxLanes} lane(s) per direction",
                        "Road hierarchy: through traffic belongs on arterials and highways, local streets should only " +
                        "serve their neighbourhood. " + (parallelStreets == 0
                            ? "There is no parallel street nearby, so build an arterial bypass or a highway link. "
                            : "Upgrade a parallel street to an arterial so the pathfinder prefers it. ") +
                        "Cars choose the fastest route, so the alternative must be faster, not just available.",
                        new[] { "cs2_build_road", "cs2_upgrade_road", "cs2_connect_road" });
                }
                if ((float)outside / withKnownDestination >= 0.4f)
                {
                    Add("outsideConnection", "medium",
                        $"{math.round(100f * outside / withKnownDestination)}% of vehicles here are heading out of the city",
                        "Traffic to and from the outside connections funnels through this area. Give the highway entrance " +
                        "more capacity (smooth ramps, more lanes), add a second highway connection, or move cargo to " +
                        "rail, harbor or air.",
                        new[] { "cs2_connect_road smooth=true", "cs2_upgrade_road", "cs2_place_building" });
                }
                if ((float)topClusterVehicles / withKnownDestination >= 0.4f)
                {
                    Add("destinationCluster", "medium",
                        $"{math.round(100f * topClusterVehicles / withKnownDestination)}% of vehicles here head to the same 500 m area (destinationClusters[0])",
                        "One destination area draws most of the traffic. Give it more access points from different " +
                        "directions, connect it to an arterial, or serve it by public transport.",
                        new[] { "cs2_connect_road", "cs2_build_road", "cs2_create_transit_line" });
                }
            }

            if (vehicles >= 10 && (float)trucks / vehicles >= 0.35f)
            {
                Add("truckHeavy", "medium",
                    $"{trucks} of {vehicles} vehicles are trucks",
                    "Freight is a large part of this jam. Real-world fixes: separate freight from city traffic (a " +
                    "direct highway access road for the industrial area), move goods by cargo rail, harbor or airport, " +
                    "and avoid routing trucks through residential streets.",
                    new[] { "cs2_economy", "cs2_build_road", "cs2_place_building" });
            }

            if (vehicles >= 10 && (float)personalCars / vehicles >= 0.7f)
            {
                Add("carDependent", "info",
                    $"{personalCars} of {vehicles} vehicles are private cars",
                    "Most trips here are private cars. A bus or tram line along this corridor (with stops near the " +
                    "destination clusters) takes cars off the road; mixed zoning shortens trips.",
                    new[] { "cs2_create_transit_line", "cs2_place_transit_stop", "cs2_zone_area" });
            }

            if (stopped > 0 && Waiting(stoppedBy, BlockerType.Spawn) >= math.max(5, stopped * 0.3f))
            {
                Add("accessConflict", "medium",
                    $"{Waiting(stoppedBy, BlockerType.Spawn)} of {stopped} stopped vehicles are waiting to leave a building or enter the road",
                    "Driveways and parking on a busy road interrupt the flow. Serve the buildings from a side street, " +
                    "or give the through traffic a separate road.",
                    new[] { "cs2_build_road", "cs2_replace_road" });
            }

            if (findings.Count == 0)
            {
                Add("noClearCause", "info",
                    vehicles == 0 ? "no vehicles on or around the focus right now" : $"{vehicles} vehicles, {stopped} stopped, no dominant cause",
                    "Run the simulation until the jam forms and diagnose again, or check cs2_vehicles for queue heads and " +
                    "deadlocks further away (the jam may start elsewhere and back up to here).",
                    new[] { "cs2_run_simulation", "cs2_vehicles", "cs2_traffic" });
            }
            return findings;
        }

        // ---- Junction layout ---------------------------------------------------------------------------

        private JunctionInfo BuildJunction(Entity node)
        {
            var junction = new JunctionInfo
            {
                Node = node,
                Position = EntityManager.GetComponentData<Node>(node).m_Position,
                Control = JunctionControl(node),
            };
            if (!EntityManager.HasBuffer<ConnectedEdge>(node))
            {
                return junction;
            }
            DynamicBuffer<ConnectedEdge> edges = EntityManager.GetBuffer<ConnectedEdge>(node, isReadOnly: true);
            for (int i = 0; i < edges.Length; i++)
            {
                Entity edgeEntity = edges[i].m_Edge;
                if (!IsRoadEdge(edgeEntity))
                {
                    continue;
                }
                Edge edge = EntityManager.GetComponentData<Edge>(edgeEntity);
                // Edges that only pass by (the node sits mid-curve) are not legs of this junction.
                if (edge.m_Start != node && edge.m_End != node)
                {
                    continue;
                }
                Curve curve = EntityManager.GetComponentData<Curve>(edgeEntity);
                bool atStart = edge.m_Start == node;
                Bezier4x3 b = curve.m_Bezier;
                float2 outward = atStart ? (b.b - b.a).xz : (b.c - b.d).xz;
                if (math.lengthsq(outward) < 0.0001f)
                {
                    outward = atStart ? (b.d - b.a).xz : (b.a - b.d).xz;
                }
                CountCarLanes(edgeEntity, out int forward, out int backward, out int busForward, out int busBackward);
                RoadFlowAndVolume(edgeEntity, out float flow, out float volume);
                Entity farNode = atStart ? edge.m_End : edge.m_Start;
                junction.Legs.Add(new LegInfo
                {
                    Edge = edgeEntity,
                    FarNode = farNode,
                    Outward = math.normalizesafe(outward),
                    Length = curve.m_Length,
                    // Forward lanes run start -> end: toward this node when it is the end node.
                    LanesToward = atStart ? backward : forward,
                    LanesAway = atStart ? forward : backward,
                    BusLanesToward = atStart ? busBackward : busForward,
                    Highway = IsHighwayRoad(edgeEntity),
                    Flow = flow,
                    Volume = volume,
                    FarNodeRoads = CountRoadLegs(farNode),
                });
            }
            return junction;
        }

        private string JunctionControl(Entity node)
        {
            if (EntityManager.HasComponent<Roundabout>(node))
            {
                return "roundabout";
            }
            if (EntityManager.HasComponent<TrafficLights>(node))
            {
                return "trafficLights";
            }
            if (EntityManager.HasComponent<Upgraded>(node)
                && (EntityManager.GetComponentData<Upgraded>(node).m_Flags.m_General & CompositionFlags.General.AllWayStop) != 0)
            {
                return "allWayStop";
            }
            return CountRoadLegs(node) >= 3 ? "priority" : "none";
        }

        private int CountRoadLegs(Entity node)
        {
            if (node == Entity.Null || !EntityManager.HasBuffer<ConnectedEdge>(node))
            {
                return 0;
            }
            int roads = 0;
            DynamicBuffer<ConnectedEdge> edges = EntityManager.GetBuffer<ConnectedEdge>(node, isReadOnly: true);
            for (int i = 0; i < edges.Length; i++)
            {
                Entity edgeEntity = edges[i].m_Edge;
                if (IsRoadEdge(edgeEntity))
                {
                    Edge edge = EntityManager.GetComponentData<Edge>(edgeEntity);
                    if (edge.m_Start == node || edge.m_End == node)
                    {
                        roads++;
                    }
                }
            }
            return roads;
        }

        /// <summary>Driving lanes of a road segment per direction (forward = from its start node to its end node).</summary>
        private void CountCarLanes(Entity edge, out int forward, out int backward, out int busForward, out int busBackward)
        {
            forward = backward = busForward = busBackward = 0;
            if (!EntityManager.HasBuffer<SubLane>(edge))
            {
                return;
            }
            DynamicBuffer<SubLane> lanes = EntityManager.GetBuffer<SubLane>(edge, isReadOnly: true);
            for (int i = 0; i < lanes.Length; i++)
            {
                Entity lane = lanes[i].m_SubLane;
                if (!EntityManager.HasComponent<CarLane>(lane) || !EntityManager.HasComponent<EdgeLane>(lane)
                    || EntityManager.HasComponent<MasterLane>(lane))
                {
                    continue;
                }
                CarLane carLane = EntityManager.GetComponentData<CarLane>(lane);
                if ((carLane.m_Flags & CarLaneFlags.Forbidden) != 0)
                {
                    continue;
                }
                bool bus = (carLane.m_Flags & CarLaneFlags.PublicOnly) != 0;
                float2 delta = EntityManager.GetComponentData<EdgeLane>(lane).m_EdgeDelta;
                bool twoway = (carLane.m_Flags & CarLaneFlags.Twoway) != 0;
                if (delta.y > delta.x || twoway)
                {
                    if (bus) busForward++; else forward++;
                }
                if (delta.y < delta.x || twoway)
                {
                    if (bus) busBackward++; else backward++;
                }
            }
        }

        private bool IsHighwayRoad(Entity edge)
        {
            if (!EntityManager.HasComponent<PrefabRef>(edge))
            {
                return false;
            }
            Entity prefab = EntityManager.GetComponentData<PrefabRef>(edge).m_Prefab;
            return EntityManager.HasComponent<RoadData>(prefab)
                && (EntityManager.GetComponentData<RoadData>(prefab).m_Flags & Game.Prefabs.RoadFlags.UseHighwayRules) != 0;
        }

        private void RoadFlowAndVolume(Entity edge, out float flow, out float volume)
        {
            if (!EntityManager.HasComponent<Road>(edge))
            {
                flow = 100f;
                volume = 0f;
                return;
            }
            Road road = EntityManager.GetComponentData<Road>(edge);
            flow = math.csum(NetUtils.GetTrafficFlowSpeed(road) * 100f) * 0.25f;
            volume = math.csum((road.m_TrafficFlowDistance0 + road.m_TrafficFlowDistance1) * kTrafficVolumeScale) * 0.25f;
        }

        // ---- Parallel streets --------------------------------------------------------------------------

        private List<object> FindParallelStreets(Entity focus, NameSystem names)
        {
            Bezier4x3 focusCurve = EntityManager.GetComponentData<Curve>(focus).m_Bezier;
            float focusLength = EntityManager.GetComponentData<Curve>(focus).m_Length;
            float2 mid = MathUtils.Position(focusCurve, 0.5f).xz;
            float2 direction = math.normalizesafe((focusCurve.d - focusCurve.a).xz);
            Entity focusAggregate = EntityManager.HasComponent<Aggregated>(focus)
                ? EntityManager.GetComponentData<Aggregated>(focus).m_Aggregate
                : Entity.Null;
            if (math.lengthsq(direction) < 0.5f)
            {
                return new List<object>();
            }

            var streets = new Dictionary<Entity, ParallelStreet>();
            using (NativeArray<Entity> edges = TrafficRoadQuery.ToEntityArray(Allocator.Temp))
            using (NativeArray<Curve> curves = TrafficRoadQuery.ToComponentDataArray<Curve>(Allocator.Temp))
            using (NativeArray<Road> roads = TrafficRoadQuery.ToComponentDataArray<Road>(Allocator.Temp))
            {
                for (int i = 0; i < edges.Length; i++)
                {
                    if (edges[i] == focus)
                    {
                        continue;
                    }
                    Bezier4x3 curve = curves[i].m_Bezier;
                    float2 otherMid = MathUtils.Position(curve, 0.5f).xz;
                    float2 offset = otherMid - mid;
                    if (math.lengthsq(offset) > 1200f * 1200f)
                    {
                        continue;
                    }
                    float2 otherDirection = math.normalizesafe((curve.d - curve.a).xz);
                    if (math.abs(math.dot(direction, otherDirection)) < 0.94f)
                    {
                        continue;
                    }
                    float side = math.abs(direction.x * offset.y - direction.y * offset.x);
                    float along = math.abs(math.dot(direction, offset));
                    if (side < 40f || side > 800f || along > focusLength * 0.5f + 150f)
                    {
                        continue;
                    }
                    Entity key = EntityManager.HasComponent<Aggregated>(edges[i])
                        ? EntityManager.GetComponentData<Aggregated>(edges[i]).m_Aggregate
                        : edges[i];
                    if (key == focusAggregate && key != Entity.Null)
                    {
                        continue;
                    }
                    if (!streets.TryGetValue(key, out ParallelStreet street))
                    {
                        street = new ParallelStreet();
                        streets.Add(key, street);
                    }
                    street.Segments++;
                    street.FlowSum += math.csum(NetUtils.GetTrafficFlowSpeed(roads[i]) * 100f) * 0.25f;
                    if (side < street.Offset)
                    {
                        street.Offset = side;
                        street.Sample = edges[i];
                        CountCarLanes(edges[i], out int forward, out int backward, out _, out _);
                        street.Lanes = forward + backward;
                    }
                }
            }

            var list = new List<ParallelStreet>(streets.Values);
            list.Sort((a, b) => a.Offset.CompareTo(b.Offset));
            var items = new List<object>();
            for (int i = 0; i < list.Count && i < 5; i++)
            {
                ParallelStreet street = list[i];
                Bezier4x3 curve = EntityManager.GetComponentData<Curve>(street.Sample).m_Bezier;
                float3 position = MathUtils.Position(curve, 0.5f);
                items.Add(new
                {
                    road = EntityRef(street.Sample),
                    prefab = PrefabNameOf(street.Sample),
                    street = StreetNameOf(names, street.Sample),
                    distance = math.round(street.Offset),
                    lanes = street.Lanes,
                    flowPercent = math.round(street.FlowSum / street.Segments),
                    position = new { x = math.round(position.x), z = math.round(position.z) },
                });
            }
            return items;
        }

        // ---- Helpers -------------------------------------------------------------------------------------

        /// <summary>The road segment nearest to a point, or its junction when the point is at a junction.</summary>
        private Entity FindTrafficFocus(float2 point, float maxDistance)
        {
            Entity best = Entity.Null;
            float bestDistance = maxDistance;
            using (NativeArray<Entity> edges = TrafficRoadQuery.ToEntityArray(Allocator.Temp))
            using (NativeArray<Curve> curves = TrafficRoadQuery.ToComponentDataArray<Curve>(Allocator.Temp))
            {
                for (int i = 0; i < edges.Length; i++)
                {
                    float distance = MathUtils.Distance(curves[i].m_Bezier.xz, point, out _);
                    if (distance < bestDistance)
                    {
                        bestDistance = distance;
                        best = edges[i];
                    }
                }
            }
            if (best == Entity.Null)
            {
                return best;
            }
            Edge edge = EntityManager.GetComponentData<Edge>(best);
            foreach (Entity node in new[] { edge.m_Start, edge.m_End })
            {
                if (math.distance(EntityManager.GetComponentData<Node>(node).m_Position.xz, point) < 25f && CountRoadLegs(node) >= 3)
                {
                    return node;
                }
            }
            return best;
        }

        /// <summary>
        /// The edges/nodes a vehicle will drive through, in order: its current lane, its navigation lanes,
        /// then its remaining path elements. Consecutive duplicates are collapsed.
        /// </summary>
        private void BuildOwnerSequence(Entity car, Entity currentLane, List<Entity> sequence)
        {
            sequence.Clear();
            void Push(Entity lane)
            {
                Entity owner = OwnerOf(lane);
                if (owner != Entity.Null && (sequence.Count == 0 || sequence[sequence.Count - 1] != owner))
                {
                    sequence.Add(owner);
                }
            }
            Push(currentLane);
            if (EntityManager.HasBuffer<CarNavigationLane>(car))
            {
                DynamicBuffer<CarNavigationLane> navigation = EntityManager.GetBuffer<CarNavigationLane>(car, isReadOnly: true);
                for (int i = 0; i < navigation.Length && sequence.Count < kPathLookahead; i++)
                {
                    Push(navigation[i].m_Lane);
                }
            }
            if (EntityManager.HasBuffer<Game.Pathfind.PathElement>(car) && EntityManager.HasComponent<Game.Pathfind.PathOwner>(car))
            {
                int start = math.max(0, EntityManager.GetComponentData<Game.Pathfind.PathOwner>(car).m_ElementIndex);
                DynamicBuffer<Game.Pathfind.PathElement> path = EntityManager.GetBuffer<Game.Pathfind.PathElement>(car, isReadOnly: true);
                for (int i = start; i < path.Length && sequence.Count < kPathLookahead; i++)
                {
                    Push(path[i].m_Target);
                }
            }
        }

        /// <summary>The road edge or node owning a lane, or Entity.Null.</summary>
        private Entity OwnerOf(Entity lane)
        {
            if (lane == Entity.Null || !EntityManager.Exists(lane) || !EntityManager.HasComponent<Lane>(lane)
                || !EntityManager.HasComponent<Owner>(lane))
            {
                return Entity.Null;
            }
            Entity owner = EntityManager.GetComponentData<Owner>(lane).m_Owner;
            return EntityManager.HasComponent<Edge>(owner) || EntityManager.HasComponent<Node>(owner) ? owner : Entity.Null;
        }

        private bool TryGetEntityPosition(Entity entity, out float3 position)
        {
            position = default;
            if (entity == Entity.Null || !EntityManager.Exists(entity))
            {
                return false;
            }
            if (EntityManager.HasComponent<Game.Objects.Transform>(entity))
            {
                position = EntityManager.GetComponentData<Game.Objects.Transform>(entity).m_Position;
                return true;
            }
            if (EntityManager.HasComponent<Node>(entity))
            {
                position = EntityManager.GetComponentData<Node>(entity).m_Position;
                return true;
            }
            if (EntityManager.HasComponent<Curve>(entity))
            {
                position = MathUtils.Position(EntityManager.GetComponentData<Curve>(entity).m_Bezier, 0.5f);
                return true;
            }
            return false;
        }

        private bool IsRoadEdge(Entity entity)
        {
            return entity != Entity.Null && EntityManager.Exists(entity) && EntityManager.HasComponent<Edge>(entity)
                && EntityManager.HasComponent<Road>(entity) && EntityManager.HasComponent<Curve>(entity)
                && !EntityManager.HasComponent<Deleted>(entity) && !EntityManager.HasComponent<Game.Tools.Temp>(entity);
        }

        private bool IsRoadNode(Entity entity)
        {
            return entity != Entity.Null && EntityManager.Exists(entity) && EntityManager.HasComponent<Node>(entity)
                && !EntityManager.HasComponent<Edge>(entity) && CountRoadLegs(entity) > 0;
        }

        private string StreetNameOf(NameSystem names, Entity edge)
        {
            if (!EntityManager.HasComponent<Aggregated>(edge))
            {
                return null;
            }
            Entity aggregate = EntityManager.GetComponentData<Aggregated>(edge).m_Aggregate;
            return aggregate == Entity.Null ? null : LabelOf(names, aggregate);
        }

        private static object EntityRef(Entity entity)
        {
            return entity == Entity.Null ? null : (object)new { index = entity.Index, version = entity.Version };
        }

        /// <summary>Compass bearing on the x/z plane: 0 = +z, 90 = +x.</summary>
        private static float BearingDegrees(float2 direction)
        {
            float degrees = math.degrees(math.atan2(direction.x, direction.y));
            return degrees < 0f ? degrees + 360f : degrees;
        }

        /// <summary>
        /// Turn from the arriving direction to the leaving one. +z is ahead and +x is to the right, so a
        /// negative cross product (z-up 2D) is a right turn.
        /// </summary>
        private static string TurnOf(float2 arriving, float2 leaving)
        {
            float dot = math.dot(arriving, leaving);
            if (dot < -0.85f)
            {
                return "uturn";
            }
            if (dot > 0.7f)
            {
                return "straight";
            }
            float cross = arriving.x * leaving.y - arriving.y * leaving.x;
            return cross < 0f ? "right" : "left";
        }
    }
}
