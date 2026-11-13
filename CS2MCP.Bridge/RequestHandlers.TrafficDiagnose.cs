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
    /// layout (legs, lanes per direction and per lane with the turns each lane allows, control, spacing to
    /// the next junction), the vehicles on and around it (type, what they wait for, where they are going and
    /// how far), the head of the queue (stopped vehicles' blockers followed downstream, possibly outside the
    /// focus area), the turning movements through each junction taken from the vehicles' own paths, parallel
    /// streets that are really connected as detours, and ranked rule-of-thumb findings from traffic
    /// engineering mapped to the bridge's tools. Optionally samples over several simulation frames and
    /// compares against an earlier baseline. Read-only.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private sealed class LaneInfo
        {
            public Entity Lane;
            public bool Bus;
            public float Lateral;
            /// <summary>1 = leftmost lane as seen when arriving at the junction.</summary>
            public int Order;
            public readonly HashSet<string> AllowedTurns = new HashSet<string>();
        }

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
            public float WorstFlow;
            public float[] FlowByPeriod;
            public float Volume;
            public int FarNodeRoads;
            public readonly List<LaneInfo> Lanes = new List<LaneInfo>();
        }

        /// <summary>Static layout of a junction (counts per sample live in JunctionSample).</summary>
        private sealed class JunctionInfo
        {
            public Entity Node;
            public float3 Position;
            public string Control;
            public readonly List<LegInfo> Legs = new List<LegInfo>();
        }

        private sealed class LaneRef
        {
            public JunctionInfo Junction;
            public LegInfo Leg;
            public LaneInfo Lane;
        }

        private sealed class DestinationCell
        {
            public int Vehicles;
            public int Raw;
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
            public readonly List<Entity> Edges = new List<Entity>();
            public bool Connected;
            public float DetourMeters = -1f;
            public float DetourRatio = -1f;
        }

        private sealed class JunctionSample
        {
            public int Vehicles;
            public int Stopped;
            public readonly Dictionary<string, int> StoppedWaitingFor = new Dictionary<string, int>();
            public readonly Dictionary<(Entity From, Entity To), int[]> Movements = new Dictionary<(Entity From, Entity To), int[]>();
        }

        private sealed class LaneSample
        {
            public int Vehicles;
            public int Stopped;
            /// <summary>Turns the vehicles on this lane are about to take (their next junction lane); summed over samples.</summary>
            public readonly Dictionary<string, int> Turns = new Dictionary<string, int>();
        }

        /// <summary>One stopped vehicle's queue traced to its head, grouped by head vehicle.</summary>
        private sealed class QueueTrace
        {
            public Entity Vehicle;
            public Entity Owner;
            public float3 Position;
            public string Blocker;
            public int Queued;
            public int MaxChain;
            public bool Cycle;
        }

        /// <summary>One snapshot of the vehicles in scope.</summary>
        private sealed class TrafficSample
        {
            public uint Frame;
            public int Vehicles;
            public int Stopped;
            public int Local;
            public int Far;
            public int Outside;
            public int Trucks;
            public int PersonalCars;
            public Dictionary<string, int> Types = new Dictionary<string, int>();
            public Dictionary<string, int> StoppedBy = new Dictionary<string, int>();
            public Dictionary<string, int> DestinationKinds = new Dictionary<string, int>();
            public Dictionary<int2, DestinationCell> Cells = new Dictionary<int2, DestinationCell>();
            public Dictionary<Entity, JunctionSample> Junctions = new Dictionary<Entity, JunctionSample>();
            public Dictionary<Entity, LaneSample> Lanes = new Dictionary<Entity, LaneSample>();
            public List<QueueTrace> Heads = new List<QueueTrace>();
        }

        private sealed class DiagnoseContext
        {
            public Entity Focus;
            public bool FocusIsEdge;
            public float3 FocusPosition;
            public float LocalRadius;
            public bool LeftHand;
            public readonly List<JunctionInfo> Junctions = new List<JunctionInfo>();
            public readonly HashSet<Entity> Scope = new HashSet<Entity>();
            public readonly Dictionary<Entity, LaneRef> LaneLookup = new Dictionary<Entity, LaneRef>();
            public int WantedSamples = 1;
            public int IntervalFrames = 30;
            public List<RoadPrefabOption> RoadPrefabs;
        }

        private sealed class RoadPrefabOption
        {
            public string Name;
            public float Width;
            public Game.Prefabs.RoadFlags Flags;
            public Layer Layers;
        }

        private sealed class DiagnoseJob
        {
            public BridgeRequest Request;
            public DiagnoseContext Context;
            public readonly List<TrafficSample> Samples = new List<TrafficSample>();
            public uint NextFrame;
            public DateTime DeadlineUtc;
        }

        // Turning movements look this many lanes/path elements ahead of each vehicle.
        private const int kPathLookahead = 48;
        // Junctions closer than this (m) along a leg spill queues into each other.
        private const float kShortJunctionSpacing = 60f;
        private const float kDestinationCellSize = 500f;
        // Blocker chains are followed at most this many vehicles downstream.
        private const int kQueueTraceDepth = 40;
        private const int kDiagnoseMaxSamples = 10;

        private readonly List<DiagnoseJob> m_DiagnoseJobs = new List<DiagnoseJob>();

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

            int samples = request.TryGetInt("samples", out int rawSamples) ? math.clamp(rawSamples, 1, kDiagnoseMaxSamples) : 1;
            int interval = request.TryGetInt("intervalFrames", out int rawInterval) ? math.clamp(rawInterval, 1, 600) : 30;
            Game.Simulation.SimulationSystem sim = World.GetOrCreateSystemManaged<Game.Simulation.SimulationSystem>();
            string samplingNote = null;
            if (samples > 1 && sim.selectedSpeed <= 0f)
            {
                samples = 1;
                samplingNote = "the simulation is paused, so vehicles cannot move between samples: only 1 sample was taken. " +
                               "Unpause (cs2_set_speed) and repeat with samples>1 for averaged results.";
            }

            DiagnoseContext ctx = BuildDiagnoseContext(focus, localRadius);
            ctx.WantedSamples = samples;
            ctx.IntervalFrames = interval;
            TrafficSample first = TakeTrafficSample(ctx, sim.frameIndex);
            if (samples == 1)
            {
                return BuildDiagnoseResponse(ctx, request, new List<TrafficSample> { first }, samplingNote);
            }

            // Later samples are taken from BridgeSystem.OnUpdate (UpdateDiagnoseJobs) once the simulation has
            // advanced intervalFrames; the request is completed there. Finish before the listener times out.
            int timeoutMs = request.TimeoutMs > 0 ? math.clamp(request.TimeoutMs, 1000, 180000) : 10000;
            var job = new DiagnoseJob
            {
                Request = request,
                Context = ctx,
                NextFrame = sim.frameIndex + (uint)interval,
                DeadlineUtc = DateTime.UtcNow.AddMilliseconds(math.max(1500, timeoutMs - 2500)),
            };
            job.Samples.Add(first);
            m_DiagnoseJobs.Add(job);
            return null;
        }

        /// <summary>Called every frame from BridgeSystem.OnUpdate: takes due samples of pending diagnoses and completes them.</summary>
        public void UpdateDiagnoseJobs()
        {
            if (m_DiagnoseJobs.Count == 0)
            {
                return;
            }
            Game.Simulation.SimulationSystem sim = World.GetOrCreateSystemManaged<Game.Simulation.SimulationSystem>();
            uint frame = sim.frameIndex;
            bool paused = sim.selectedSpeed <= 0f;
            for (int i = m_DiagnoseJobs.Count - 1; i >= 0; i--)
            {
                DiagnoseJob job = m_DiagnoseJobs[i];
                if (job.Request.IsCompleted || job.Request.IsAbandoned)
                {
                    m_DiagnoseJobs.RemoveAt(i);
                    continue;
                }
                string note = null;
                bool finish = false;
                try
                {
                    if (paused)
                    {
                        note = $"the simulation was paused after {job.Samples.Count} of {job.Context.WantedSamples} samples; the result uses the samples taken";
                        finish = true;
                    }
                    else if (DateTime.UtcNow >= job.DeadlineUtc)
                    {
                        note = $"stopped after {job.Samples.Count} of {job.Context.WantedSamples} samples to answer before the request timed out " +
                               "(the simulation runs slowly; use a smaller intervalFrames or fewer samples)";
                        finish = true;
                    }
                    else if (frame >= job.NextFrame)
                    {
                        job.Samples.Add(TakeTrafficSample(job.Context, frame));
                        job.NextFrame = frame + (uint)job.Context.IntervalFrames;
                        finish = job.Samples.Count >= job.Context.WantedSamples;
                    }
                    if (finish)
                    {
                        m_DiagnoseJobs.RemoveAt(i);
                        job.Request.Complete(BuildDiagnoseResponse(job.Context, job.Request, job.Samples, note));
                    }
                }
                catch (Exception e)
                {
                    m_DiagnoseJobs.RemoveAt(i);
                    Mod.Log.Warn($"traffic diagnose failed: {e}");
                    job.Request.Complete(BridgeResponse.Error(500, $"{e.GetType().Name}: {e.Message}"));
                }
            }
        }

        // ---- Context -------------------------------------------------------------------------------------

        private DiagnoseContext BuildDiagnoseContext(Entity focus, float localRadius)
        {
            var ctx = new DiagnoseContext
            {
                Focus = focus,
                FocusIsEdge = EntityManager.HasComponent<Edge>(focus),
                LocalRadius = localRadius,
                LeftHand = World.GetOrCreateSystemManaged<Game.City.CityConfigurationSystem>().leftHandTraffic,
            };
            if (ctx.FocusIsEdge)
            {
                Edge edge = EntityManager.GetComponentData<Edge>(focus);
                ctx.FocusPosition = MathUtils.Position(EntityManager.GetComponentData<Curve>(focus).m_Bezier, 0.5f);
                ctx.Scope.Add(focus);
                ctx.Junctions.Add(BuildJunction(edge.m_Start));
                if (edge.m_End != edge.m_Start)
                {
                    ctx.Junctions.Add(BuildJunction(edge.m_End));
                }
            }
            else
            {
                ctx.FocusPosition = EntityManager.GetComponentData<Node>(focus).m_Position;
                ctx.Junctions.Add(BuildJunction(focus));
            }
            foreach (JunctionInfo junction in ctx.Junctions)
            {
                ctx.Scope.Add(junction.Node);
                foreach (LegInfo leg in junction.Legs)
                {
                    ctx.Scope.Add(leg.Edge);
                    foreach (LaneInfo lane in leg.Lanes)
                    {
                        ctx.LaneLookup[lane.Lane] = new LaneRef { Junction = junction, Leg = leg, Lane = lane };
                    }
                }
            }
            return ctx;
        }

        // ---- Sampling ------------------------------------------------------------------------------------

        private bool IsCarStopped(Entity car)
        {
            float speed = EntityManager.HasComponent<Game.Objects.Moving>(car)
                ? math.length(EntityManager.GetComponentData<Game.Objects.Moving>(car).m_Velocity)
                : 0f;
            return speed < kStoppedSpeed;
        }

        private TrafficSample TakeTrafficSample(DiagnoseContext ctx, uint frame)
        {
            var sample = new TrafficSample { Frame = frame };
            foreach (JunctionInfo junction in ctx.Junctions)
            {
                sample.Junctions[junction.Node] = new JunctionSample();
            }
            var ownerSequence = new List<Entity>(kPathLookahead + 8);
            var visited = new HashSet<Entity>();
            var traces = new Dictionary<Entity, QueueTrace>();
            using (NativeArray<Entity> cars = DrivingCarQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity car in cars)
                {
                    Entity lane = EntityManager.GetComponentData<CarCurrentLane>(car).m_Lane;
                    Entity laneOwner = OwnerOf(lane);
                    if (laneOwner == Entity.Null || !ctx.Scope.Contains(laneOwner))
                    {
                        continue;
                    }
                    sample.Vehicles++;
                    string type = VehicleKind(car);
                    Increment(sample.Types, type);
                    if (type == "cargoTruck" || type == "deliveryTruck")
                    {
                        sample.Trucks++;
                    }
                    else if (type == "personalCar")
                    {
                        sample.PersonalCars++;
                    }
                    bool isStopped = IsCarStopped(car);
                    string waitingFor = null;
                    if (isStopped)
                    {
                        sample.Stopped++;
                        waitingFor = EntityManager.HasComponent<Blocker>(car)
                            ? EntityManager.GetComponentData<Blocker>(car).m_Type.ToString()
                            : BlockerType.None.ToString();
                        Increment(sample.StoppedBy, waitingFor);
                        TraceQueueHead(car, visited, traces);
                    }

                    Entity destination = DestinationEntity(car);
                    string kind = DestinationKindOf(destination);
                    Increment(sample.DestinationKinds, kind);
                    if (kind == "outsideCity")
                    {
                        sample.Outside++;
                    }
                    if (TryGetEntityPosition(destination, out float3 destinationPosition))
                    {
                        if (kind != "outsideCity")
                        {
                            if (math.distance(destinationPosition.xz, ctx.FocusPosition.xz) <= ctx.LocalRadius)
                            {
                                sample.Local++;
                            }
                            else
                            {
                                sample.Far++;
                            }
                        }
                        var cellKey = new int2((int)math.floor(destinationPosition.x / kDestinationCellSize), (int)math.floor(destinationPosition.z / kDestinationCellSize));
                        if (!sample.Cells.TryGetValue(cellKey, out DestinationCell cell))
                        {
                            cell = new DestinationCell();
                            sample.Cells.Add(cellKey, cell);
                        }
                        cell.Vehicles++;
                        cell.Raw++;
                        cell.PositionSum += destinationPosition.xz;
                        Increment(cell.Kinds, kind);
                    }

                    // Per-lane counts on the lanes arriving at a junction, with the turn each vehicle will take.
                    if (ctx.LaneLookup.TryGetValue(lane, out LaneRef laneRef))
                    {
                        if (!sample.Lanes.TryGetValue(lane, out LaneSample laneSample))
                        {
                            laneSample = new LaneSample();
                            sample.Lanes.Add(lane, laneSample);
                        }
                        laneSample.Vehicles++;
                        if (isStopped)
                        {
                            laneSample.Stopped++;
                        }
                        string observed = ObservedTurn(car, laneRef.Junction.Node);
                        if (observed != null)
                        {
                            Increment(laneSample.Turns, observed);
                        }
                    }

                    // Turning movements: the owners (edges/nodes) of the lanes ahead of the vehicle.
                    BuildOwnerSequence(car, lane, ownerSequence);
                    foreach (JunctionInfo junction in ctx.Junctions)
                    {
                        bool atJunction = laneOwner == junction.Node || junction.Legs.Exists(l => l.Edge == laneOwner);
                        if (!atJunction)
                        {
                            continue;
                        }
                        JunctionSample js = sample.Junctions[junction.Node];
                        js.Vehicles++;
                        if (isStopped)
                        {
                            js.Stopped++;
                            Increment(js.StoppedWaitingFor, waitingFor);
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
                        if (!js.Movements.TryGetValue((from, to), out int[] counts))
                        {
                            counts = new int[2];
                            js.Movements.Add((from, to), counts);
                        }
                        counts[0]++;
                        if (isStopped)
                        {
                            counts[1]++;
                        }
                    }
                }
            }
            sample.Heads.AddRange(traces.Values);
            return sample;
        }

        /// <summary>
        /// Follows a stopped vehicle's Blocker downstream (the vehicle it waits for, a trailer standing for its
        /// towing vehicle) while the next vehicle is stopped too, bounded by kQueueTraceDepth and cycle-safe,
        /// and records the head of the chain. The head's lane owner may lie outside the focus area.
        /// </summary>
        private void TraceQueueHead(Entity car, HashSet<Entity> visited, Dictionary<Entity, QueueTrace> traces)
        {
            visited.Clear();
            visited.Add(car);
            Entity current = car;
            int chain = 0;
            bool cycle = false;
            while (chain < kQueueTraceDepth && EntityManager.HasComponent<Blocker>(current))
            {
                Blocker blocker = EntityManager.GetComponentData<Blocker>(current);
                Entity next = blocker.m_Blocker;
                if (blocker.m_Type == BlockerType.None || next == Entity.Null || !EntityManager.Exists(next))
                {
                    break;
                }
                if (EntityManager.HasComponent<Controller>(next))
                {
                    next = EntityManager.GetComponentData<Controller>(next).m_Controller;
                }
                if (next == current || next == Entity.Null || !EntityManager.Exists(next)
                    || !EntityManager.HasComponent<Car>(next) || !EntityManager.HasComponent<CarCurrentLane>(next)
                    || EntityManager.HasComponent<ParkedCar>(next) || !IsCarStopped(next))
                {
                    break;
                }
                if (!visited.Add(next))
                {
                    cycle = true;
                    break;
                }
                current = next;
                chain++;
            }
            if (!traces.TryGetValue(current, out QueueTrace trace))
            {
                Entity headLane = EntityManager.GetComponentData<CarCurrentLane>(current).m_Lane;
                trace = new QueueTrace
                {
                    Vehicle = current,
                    Owner = OwnerOf(headLane),
                    Position = EntityManager.HasComponent<Game.Objects.Transform>(current)
                        ? EntityManager.GetComponentData<Game.Objects.Transform>(current).m_Position
                        : default,
                    Blocker = EntityManager.HasComponent<Blocker>(current)
                        ? EntityManager.GetComponentData<Blocker>(current).m_Type.ToString()
                        : BlockerType.None.ToString(),
                };
                traces.Add(current, trace);
            }
            trace.Queued++;
            trace.MaxChain = math.max(trace.MaxChain, chain);
            trace.Cycle |= cycle;
        }

        private string ObservedTurn(Entity car, Entity node)
        {
            if (!EntityManager.HasBuffer<CarNavigationLane>(car))
            {
                return null;
            }
            DynamicBuffer<CarNavigationLane> navigation = EntityManager.GetBuffer<CarNavigationLane>(car, isReadOnly: true);
            for (int i = 0; i < navigation.Length && i < 16; i++)
            {
                Entity l = navigation[i].m_Lane;
                if (l != Entity.Null && EntityManager.Exists(l) && EntityManager.HasComponent<CarLane>(l) && OwnerOf(l) == node)
                {
                    return TurnOfFlags(EntityManager.GetComponentData<CarLane>(l).m_Flags);
                }
            }
            return null;
        }

        private static string TurnOfFlags(CarLaneFlags flags)
        {
            if ((flags & (CarLaneFlags.UTurnLeft | CarLaneFlags.UTurnRight)) != 0)
            {
                return "uturn";
            }
            if ((flags & (CarLaneFlags.TurnLeft | CarLaneFlags.GentleTurnLeft)) != 0)
            {
                return "left";
            }
            if ((flags & (CarLaneFlags.TurnRight | CarLaneFlags.GentleTurnRight)) != 0)
            {
                return "right";
            }
            return "straight";
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
            List<(Lane Data, string Turn)> nodeLanes = CollectNodeCarLanes(node);
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
                RoadFlowPeriods(edgeEntity, out float flow, out float worstFlow, out float[] flowByPeriod, out float volume);
                Entity farNode = atStart ? edge.m_End : edge.m_Start;
                var legInfo = new LegInfo
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
                    WorstFlow = worstFlow,
                    FlowByPeriod = flowByPeriod,
                    Volume = volume,
                    FarNodeRoads = CountRoadLegs(farNode),
                };
                BuildLegLanes(junction, legInfo, atStart, nodeLanes);
                junction.Legs.Add(legInfo);
            }
            return junction;
        }

        /// <summary>The car connection lanes inside a junction node, with the turn each makes.</summary>
        private List<(Lane Data, string Turn)> CollectNodeCarLanes(Entity node)
        {
            var result = new List<(Lane Data, string Turn)>();
            if (!EntityManager.HasBuffer<SubLane>(node))
            {
                return result;
            }
            DynamicBuffer<SubLane> lanes = EntityManager.GetBuffer<SubLane>(node, isReadOnly: true);
            for (int i = 0; i < lanes.Length; i++)
            {
                Entity lane = lanes[i].m_SubLane;
                if (!EntityManager.HasComponent<CarLane>(lane) || !EntityManager.HasComponent<Lane>(lane)
                    || EntityManager.HasComponent<MasterLane>(lane))
                {
                    continue;
                }
                CarLaneFlags flags = EntityManager.GetComponentData<CarLane>(lane).m_Flags;
                if ((flags & CarLaneFlags.Forbidden) != 0)
                {
                    continue;
                }
                result.Add((EntityManager.GetComponentData<Lane>(lane), TurnOfFlags(flags)));
            }
            return result;
        }

        /// <summary>
        /// The car lanes of a leg that arrive at the junction, ordered left to right, with the turns their
        /// connection lanes in the junction allow (matched through the pathfinding nodes of lane ends).
        /// </summary>
        private void BuildLegLanes(JunctionInfo junction, LegInfo leg, bool atStart, List<(Lane Data, string Turn)> nodeLanes)
        {
            if (!EntityManager.HasBuffer<SubLane>(leg.Edge))
            {
                return;
            }
            // Arriving direction is -Outward; with +x to the right and +z ahead, right = (d.y, -d.x).
            float2 right = new float2(-leg.Outward.y, leg.Outward.x);
            DynamicBuffer<SubLane> lanes = EntityManager.GetBuffer<SubLane>(leg.Edge, isReadOnly: true);
            for (int i = 0; i < lanes.Length; i++)
            {
                Entity lane = lanes[i].m_SubLane;
                if (!EntityManager.HasComponent<CarLane>(lane) || !EntityManager.HasComponent<EdgeLane>(lane)
                    || EntityManager.HasComponent<MasterLane>(lane) || !EntityManager.HasComponent<Curve>(lane))
                {
                    continue;
                }
                CarLane carLane = EntityManager.GetComponentData<CarLane>(lane);
                if ((carLane.m_Flags & CarLaneFlags.Forbidden) != 0)
                {
                    continue;
                }
                float2 delta = EntityManager.GetComponentData<EdgeLane>(lane).m_EdgeDelta;
                bool twoway = (carLane.m_Flags & CarLaneFlags.Twoway) != 0;
                bool arrives = twoway || (atStart ? delta.y < delta.x : delta.y > delta.x);
                if (!arrives)
                {
                    continue;
                }
                Bezier4x3 curve = EntityManager.GetComponentData<Curve>(lane).m_Bezier;
                float3 end = math.distancesq(curve.d.xz, junction.Position.xz) <= math.distancesq(curve.a.xz, junction.Position.xz) ? curve.d : curve.a;
                var info = new LaneInfo
                {
                    Lane = lane,
                    Bus = (carLane.m_Flags & CarLaneFlags.PublicOnly) != 0,
                    Lateral = math.dot(end.xz - junction.Position.xz, right),
                };
                if (EntityManager.HasComponent<Lane>(lane))
                {
                    Lane laneData = EntityManager.GetComponentData<Lane>(lane);
                    foreach ((Lane Data, string Turn) nodeLane in nodeLanes)
                    {
                        if (nodeLane.Data.m_StartNode.Equals(laneData.m_EndNode) || nodeLane.Data.m_StartNode.EqualsIgnoreCurvePos(laneData.m_EndNode))
                        {
                            info.AllowedTurns.Add(nodeLane.Turn);
                        }
                    }
                }
                leg.Lanes.Add(info);
            }
            leg.Lanes.Sort((a, b) => a.Lateral.CompareTo(b.Lateral));
            for (int i = 0; i < leg.Lanes.Count; i++)
            {
                leg.Lanes[i].Order = i + 1;
            }
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

        /// <summary>
        /// Flow of a road: the average of the four daily periods, the worst single period (peak-hour jams
        /// disappear in the average) and the four periods themselves.
        /// </summary>
        private void RoadFlowPeriods(Entity edge, out float flow, out float worstFlow, out float[] byPeriod, out float volume)
        {
            if (!EntityManager.HasComponent<Road>(edge))
            {
                flow = 100f;
                worstFlow = 100f;
                byPeriod = new[] { 100f, 100f, 100f, 100f };
                volume = 0f;
                return;
            }
            Road road = EntityManager.GetComponentData<Road>(edge);
            float4 periods = NetUtils.GetTrafficFlowSpeed(road) * 100f;
            flow = math.csum(periods) * 0.25f;
            worstFlow = math.cmin(periods);
            byPeriod = new[] { periods.x, periods.y, periods.z, periods.w };
            volume = math.csum((road.m_TrafficFlowDistance0 + road.m_TrafficFlowDistance1) * kTrafficVolumeScale) * 0.25f;
        }

        // ---- Parallel streets --------------------------------------------------------------------------

        /// <summary>
        /// Streets running parallel and near the focus segment, each checked for being a real alternative: a
        /// bounded shortest-path search over the road graph (focus segment excluded, one-way lanes respected)
        /// must reach both ends of the focus through the street. Connected streets come first.
        /// </summary>
        private List<ParallelStreet> FindParallelStreets(Entity focus)
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
                return new List<ParallelStreet>();
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
                    if (street.Edges.Count < 60)
                    {
                        street.Edges.Add(edges[i]);
                    }
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
            if (list.Count > 8)
            {
                list.RemoveRange(8, list.Count - 8);
            }

            // Connectivity: shortest detours around the focus segment from/to both of its end nodes.
            Edge focusEdge = EntityManager.GetComponentData<Edge>(focus);
            float maxCost = math.max(2500f, focusLength * 6f);
            var laneCache = new Dictionary<Entity, int2>();
            Dictionary<Entity, float> fromStart = RoadDistances(focusEdge.m_Start, focus, false, maxCost, laneCache);
            Dictionary<Entity, float> toEnd = RoadDistances(focusEdge.m_End, focus, true, maxCost, laneCache);
            Dictionary<Entity, float> fromEnd = RoadDistances(focusEdge.m_End, focus, false, maxCost, laneCache);
            Dictionary<Entity, float> toStart = RoadDistances(focusEdge.m_Start, focus, true, maxCost, laneCache);
            foreach (ParallelStreet street in list)
            {
                float best = float.MaxValue;
                foreach (Entity edgeEntity in street.Edges)
                {
                    Edge e = EntityManager.GetComponentData<Edge>(edgeEntity);
                    float length = EntityManager.GetComponentData<Curve>(edgeEntity).m_Length;
                    int2 lanes = LanesOf(edgeEntity, laneCache);
                    // u -> v along the edge needs forward lanes, v -> u needs backward lanes.
                    if (lanes.x > 0)
                    {
                        best = math.min(best, Detour(fromStart, e.m_Start, toEnd, e.m_End, length));
                        best = math.min(best, Detour(fromEnd, e.m_Start, toStart, e.m_End, length));
                    }
                    if (lanes.y > 0)
                    {
                        best = math.min(best, Detour(fromStart, e.m_End, toEnd, e.m_Start, length));
                        best = math.min(best, Detour(fromEnd, e.m_End, toStart, e.m_Start, length));
                    }
                }
                if (best < float.MaxValue)
                {
                    street.Connected = true;
                    street.DetourMeters = best;
                    street.DetourRatio = focusLength > 1f ? best / focusLength : -1f;
                }
            }
            list.Sort((a, b) =>
            {
                if (a.Connected != b.Connected)
                {
                    return a.Connected ? -1 : 1;
                }
                return a.Offset.CompareTo(b.Offset);
            });
            if (list.Count > 5)
            {
                list.RemoveRange(5, list.Count - 5);
            }
            return list;
        }

        private static float Detour(Dictionary<Entity, float> before, Entity entry, Dictionary<Entity, float> after, Entity exit, float length)
        {
            return before.TryGetValue(entry, out float a) && after.TryGetValue(exit, out float b) ? a + length + b : float.MaxValue;
        }

        /// <summary>Forward / backward driving lane counts of a road edge (x = start to end), cached.</summary>
        private int2 LanesOf(Entity edge, Dictionary<Entity, int2> cache)
        {
            if (!cache.TryGetValue(edge, out int2 lanes))
            {
                CountCarLanes(edge, out int forward, out int backward, out int busForward, out int busBackward);
                lanes = new int2(forward + busForward, backward + busBackward);
                cache[edge] = lanes;
            }
            return lanes;
        }

        /// <summary>
        /// Bounded Dijkstra over road nodes from a start node, never using the excluded edge and respecting
        /// one-way lanes. reverse = distances from each node TO the start instead of from the start.
        /// </summary>
        private Dictionary<Entity, float> RoadDistances(Entity start, Entity excludedEdge, bool reverse, float maxCost, Dictionary<Entity, int2> laneCache)
        {
            const int kMaxNodes = 700;
            var distance = new Dictionary<Entity, float> { [start] = 0f };
            var done = new HashSet<Entity>();
            var frontier = new List<Entity> { start };
            while (frontier.Count > 0 && done.Count < kMaxNodes)
            {
                int best = 0;
                for (int i = 1; i < frontier.Count; i++)
                {
                    if (distance[frontier[i]] < distance[frontier[best]])
                    {
                        best = i;
                    }
                }
                Entity node = frontier[best];
                frontier[best] = frontier[frontier.Count - 1];
                frontier.RemoveAt(frontier.Count - 1);
                if (!done.Add(node))
                {
                    continue;
                }
                float d = distance[node];
                if (d > maxCost)
                {
                    break;
                }
                if (!EntityManager.HasBuffer<ConnectedEdge>(node))
                {
                    continue;
                }
                var connected = new List<Entity>();
                DynamicBuffer<ConnectedEdge> buffer = EntityManager.GetBuffer<ConnectedEdge>(node, isReadOnly: true);
                for (int i = 0; i < buffer.Length; i++)
                {
                    connected.Add(buffer[i].m_Edge);
                }
                foreach (Entity edgeEntity in connected)
                {
                    if (edgeEntity == excludedEdge || !IsRoadEdge(edgeEntity))
                    {
                        continue;
                    }
                    Edge edge = EntityManager.GetComponentData<Edge>(edgeEntity);
                    if (edge.m_Start != node && edge.m_End != node)
                    {
                        continue;
                    }
                    Entity other = edge.m_Start == node ? edge.m_End : edge.m_Start;
                    // Searching forward leaves via the start node on forward lanes; searching backward is the mirror.
                    bool needForward = (edge.m_Start == node) != reverse;
                    int2 lanes = LanesOf(edgeEntity, laneCache);
                    if ((needForward ? lanes.x : lanes.y) <= 0)
                    {
                        continue;
                    }
                    float next = d + EntityManager.GetComponentData<Curve>(edgeEntity).m_Length;
                    if (!distance.TryGetValue(other, out float known) || next < known)
                    {
                        distance[other] = next;
                        frontier.Add(other);
                    }
                }
            }
            return distance;
        }

        // ---- Road prefab suggestions ---------------------------------------------------------------------

        private List<RoadPrefabOption> LoadRoadPrefabOptions()
        {
            var options = new List<RoadPrefabOption>();
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            using (NativeArray<Entity> prefabs = NetPrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity prefab in prefabs)
                {
                    if (!EntityManager.HasComponent<RoadData>(prefab) || !EntityManager.HasComponent<NetData>(prefab)
                        || !EntityManager.HasComponent<NetGeometryData>(prefab) || IsLocked(prefab))
                    {
                        continue;
                    }
                    NetData netData = EntityManager.GetComponentData<NetData>(prefab);
                    if (NetFamily(netData) != "road")
                    {
                        continue;
                    }
                    PrefabBase prefabBase = prefabSystem.GetPrefab<PrefabBase>(prefab);
                    string name = prefabBase != null ? prefabBase.name : null;
                    if (string.IsNullOrEmpty(name))
                    {
                        continue;
                    }
                    string lower = name.ToLowerInvariant();
                    if (lower.Contains("tunnel") || lower.Contains("bridge") || lower.Contains("elevated")
                        || lower.Contains("slope") || lower.Contains("ramp"))
                    {
                        continue;
                    }
                    options.Add(new RoadPrefabOption
                    {
                        Name = name,
                        Width = EntityManager.GetComponentData<NetGeometryData>(prefab).m_DefaultWidth,
                        Flags = EntityManager.GetComponentData<RoadData>(prefab).m_Flags,
                        Layers = netData.m_RequiredLayers,
                    });
                }
            }
            return options;
        }

        /// <summary>
        /// The next wider, unlocked road prefab of the same kind (same layers, highway rules and one-way
        /// default) as a road segment's current prefab, or null when none is wider.
        /// </summary>
        private string SuggestWiderRoadPrefab(DiagnoseContext ctx, Entity edge)
        {
            if (edge == Entity.Null || !EntityManager.HasComponent<PrefabRef>(edge))
            {
                return null;
            }
            Entity current = EntityManager.GetComponentData<PrefabRef>(edge).m_Prefab;
            if (!EntityManager.HasComponent<RoadData>(current) || !EntityManager.HasComponent<NetData>(current)
                || !EntityManager.HasComponent<NetGeometryData>(current))
            {
                return null;
            }
            ctx.RoadPrefabs ??= LoadRoadPrefabOptions();
            const Game.Prefabs.RoadFlags kKind = Game.Prefabs.RoadFlags.UseHighwayRules | Game.Prefabs.RoadFlags.DefaultIsForward | Game.Prefabs.RoadFlags.DefaultIsBackward;
            Game.Prefabs.RoadFlags flags = EntityManager.GetComponentData<RoadData>(current).m_Flags & kKind;
            Layer layers = EntityManager.GetComponentData<NetData>(current).m_RequiredLayers;
            float width = EntityManager.GetComponentData<NetGeometryData>(current).m_DefaultWidth;
            RoadPrefabOption best = null;
            foreach (RoadPrefabOption option in ctx.RoadPrefabs)
            {
                if (option.Layers != layers || (option.Flags & kKind) != flags || option.Width < width + 2f)
                {
                    continue;
                }
                if (best == null || option.Width < best.Width)
                {
                    best = option;
                }
            }
            return best?.Name;
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
