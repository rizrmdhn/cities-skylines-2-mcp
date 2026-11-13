using System;
using System.Collections.Generic;
using Game.Net;
using Game.UI;
using Game.Vehicles;
using Newtonsoft.Json.Linq;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Traffic diagnosis, report half: averages the samples, summarises the queue heads, derives ranked
    /// findings with cause/effect links and concrete targets, compares against a baseline and builds the response.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private sealed class DiagnoseNumbers
        {
            public float Flow;
            public float WorstFlow;
            public float[] FlowByPeriod;
            public float Volume;
            public int LanesForward;
            public int LanesBackward;
            public bool Highway;
        }

        private sealed class QueueSummary
        {
            public Entity Owner;
            public Entity HeadVehicle;
            public float3 Position;
            public string Blocker;
            public int QueuedTotal;
            public int BestQueued;
            public int SamplesSeen;
            public int MaxChain;
            public bool Cycle;
            public bool InScope;
        }

        private sealed class Finding
        {
            public string Id;
            public string Code;
            public string Severity;
            public string Evidence;
            public string Suggestion;
            public string Cause;
            public string Effect;
            public string[] Tools;
            public object Target;
            public JunctionInfo Junction;
            public int Score;
            public int Rank;
            public readonly List<string> CausedBy = new List<string>();
            public readonly List<string> Causes = new List<string>();
        }

        // ---- Aggregation -------------------------------------------------------------------------------

        private static int Div(int sum, int n)
        {
            return n <= 1 ? sum : (int)Math.Round(sum / (double)n, MidpointRounding.AwayFromZero);
        }

        private static void AddCounts(Dictionary<string, int> target, Dictionary<string, int> source)
        {
            foreach (KeyValuePair<string, int> pair in source)
            {
                target.TryGetValue(pair.Key, out int value);
                target[pair.Key] = value + pair.Value;
            }
        }

        private static Dictionary<string, int> DivCounts(Dictionary<string, int> sums, int n)
        {
            var result = new Dictionary<string, int>();
            foreach (KeyValuePair<string, int> pair in sums)
            {
                int value = Div(pair.Value, n);
                if (value > 0)
                {
                    result[pair.Key] = value;
                }
            }
            return result;
        }

        /// <summary>Per-sample averages (rounded). Observed lane turns stay summed over the samples.</summary>
        private static TrafficSample AverageSamples(List<TrafficSample> samples)
        {
            int n = samples.Count;
            if (n == 1)
            {
                return samples[0];
            }
            var sum = new TrafficSample { Frame = samples[n - 1].Frame };
            foreach (TrafficSample s in samples)
            {
                sum.Vehicles += s.Vehicles;
                sum.Stopped += s.Stopped;
                sum.Local += s.Local;
                sum.Far += s.Far;
                sum.Outside += s.Outside;
                sum.Trucks += s.Trucks;
                sum.PersonalCars += s.PersonalCars;
                AddCounts(sum.Types, s.Types);
                AddCounts(sum.StoppedBy, s.StoppedBy);
                AddCounts(sum.DestinationKinds, s.DestinationKinds);
                foreach (KeyValuePair<int2, DestinationCell> pair in s.Cells)
                {
                    if (!sum.Cells.TryGetValue(pair.Key, out DestinationCell cell))
                    {
                        cell = new DestinationCell();
                        sum.Cells.Add(pair.Key, cell);
                    }
                    cell.Vehicles += pair.Value.Vehicles;
                    cell.Raw += pair.Value.Raw;
                    cell.PositionSum += pair.Value.PositionSum;
                    AddCounts(cell.Kinds, pair.Value.Kinds);
                }
                foreach (KeyValuePair<Entity, JunctionSample> pair in s.Junctions)
                {
                    if (!sum.Junctions.TryGetValue(pair.Key, out JunctionSample js))
                    {
                        js = new JunctionSample();
                        sum.Junctions.Add(pair.Key, js);
                    }
                    js.Vehicles += pair.Value.Vehicles;
                    js.Stopped += pair.Value.Stopped;
                    AddCounts(js.StoppedWaitingFor, pair.Value.StoppedWaitingFor);
                    foreach (KeyValuePair<(Entity From, Entity To), int[]> movement in pair.Value.Movements)
                    {
                        if (!js.Movements.TryGetValue(movement.Key, out int[] counts))
                        {
                            counts = new int[2];
                            js.Movements.Add(movement.Key, counts);
                        }
                        counts[0] += movement.Value[0];
                        counts[1] += movement.Value[1];
                    }
                }
                foreach (KeyValuePair<Entity, LaneSample> pair in s.Lanes)
                {
                    if (!sum.Lanes.TryGetValue(pair.Key, out LaneSample ls))
                    {
                        ls = new LaneSample();
                        sum.Lanes.Add(pair.Key, ls);
                    }
                    ls.Vehicles += pair.Value.Vehicles;
                    ls.Stopped += pair.Value.Stopped;
                    AddCounts(ls.Turns, pair.Value.Turns);
                }
            }

            var avg = new TrafficSample
            {
                Frame = sum.Frame,
                Vehicles = Div(sum.Vehicles, n),
                Stopped = Div(sum.Stopped, n),
                Local = Div(sum.Local, n),
                Far = Div(sum.Far, n),
                Outside = Div(sum.Outside, n),
                Trucks = Div(sum.Trucks, n),
                PersonalCars = Div(sum.PersonalCars, n),
                Types = DivCounts(sum.Types, n),
                StoppedBy = DivCounts(sum.StoppedBy, n),
                DestinationKinds = DivCounts(sum.DestinationKinds, n),
            };
            foreach (KeyValuePair<int2, DestinationCell> pair in sum.Cells)
            {
                pair.Value.Vehicles = Div(pair.Value.Vehicles, n);
                var kinds = DivCounts(pair.Value.Kinds, n);
                pair.Value.Kinds.Clear();
                AddCounts(pair.Value.Kinds, kinds);
                avg.Cells.Add(pair.Key, pair.Value);
            }
            foreach (KeyValuePair<Entity, JunctionSample> pair in sum.Junctions)
            {
                var js = new JunctionSample
                {
                    Vehicles = Div(pair.Value.Vehicles, n),
                    Stopped = Div(pair.Value.Stopped, n),
                };
                AddCounts(js.StoppedWaitingFor, DivCounts(pair.Value.StoppedWaitingFor, n));
                foreach (KeyValuePair<(Entity From, Entity To), int[]> movement in pair.Value.Movements)
                {
                    int vehicles = Div(movement.Value[0], n);
                    if (vehicles > 0)
                    {
                        js.Movements.Add(movement.Key, new[] { vehicles, Div(movement.Value[1], n) });
                    }
                }
                avg.Junctions.Add(pair.Key, js);
            }
            foreach (KeyValuePair<Entity, LaneSample> pair in sum.Lanes)
            {
                pair.Value.Vehicles = Div(pair.Value.Vehicles, n);
                pair.Value.Stopped = Div(pair.Value.Stopped, n);
                avg.Lanes.Add(pair.Key, pair.Value);
            }
            return avg;
        }

        private static int CountSamples(List<TrafficSample> samples, Func<TrafficSample, bool> predicate)
        {
            int hits = 0;
            foreach (TrafficSample sample in samples)
            {
                if (predicate(sample))
                {
                    hits++;
                }
            }
            return hits;
        }

        private static int Waiting(Dictionary<string, int> counts, BlockerType type)
        {
            return counts.TryGetValue(type.ToString(), out int n) ? n : 0;
        }

        private static int StoppedThreshold(int stopped)
        {
            return math.max(5, (int)math.ceil(stopped * 0.3f));
        }

        /// <summary>Queue heads across samples, the one holding up most vehicles first.</summary>
        private List<QueueSummary> SummarizeQueueHeads(DiagnoseContext ctx, List<TrafficSample> samples)
        {
            var byOwner = new Dictionary<Entity, QueueSummary>();
            foreach (TrafficSample sample in samples)
            {
                var seen = new HashSet<Entity>();
                foreach (QueueTrace trace in sample.Heads)
                {
                    if (trace.Owner == Entity.Null)
                    {
                        continue;
                    }
                    if (!byOwner.TryGetValue(trace.Owner, out QueueSummary summary))
                    {
                        summary = new QueueSummary { Owner = trace.Owner, InScope = ctx.Scope.Contains(trace.Owner) };
                        byOwner.Add(trace.Owner, summary);
                    }
                    summary.QueuedTotal += trace.Queued;
                    summary.MaxChain = math.max(summary.MaxChain, trace.MaxChain);
                    summary.Cycle |= trace.Cycle;
                    if (trace.Queued > summary.BestQueued)
                    {
                        summary.BestQueued = trace.Queued;
                        summary.HeadVehicle = trace.Vehicle;
                        summary.Position = trace.Position;
                        summary.Blocker = trace.Blocker;
                    }
                    seen.Add(trace.Owner);
                }
                foreach (Entity owner in seen)
                {
                    byOwner[owner].SamplesSeen++;
                }
            }
            var list = new List<QueueSummary>(byOwner.Values);
            list.Sort((a, b) => b.QueuedTotal.CompareTo(a.QueuedTotal));
            return list;
        }

        private object QueueHeadItem(DiagnoseContext ctx, NameSystem names, QueueSummary q, int samples)
        {
            bool isNode = EntityManager.HasComponent<Node>(q.Owner) && !EntityManager.HasComponent<Edge>(q.Owner);
            return new
            {
                owner = EntityRef(q.Owner),
                kind = isNode ? "junction" : "road",
                prefab = PrefabNameOf(q.Owner),
                street = isNode ? null : StreetNameOf(names, q.Owner),
                position = new { x = math.round(q.Position.x), z = math.round(q.Position.z) },
                inFocusArea = q.InScope,
                distanceFromFocus = math.round(math.distance(q.Position.xz, ctx.FocusPosition.xz)),
                headVehicle = EntityRef(q.HeadVehicle),
                blockedBy = q.Blocker,
                chainLength = q.MaxChain + 1,
                vehiclesQueued = Math.Round((double)q.QueuedTotal / samples, 1),
                seenInSamples = q.SamplesSeen,
                deadlock = q.Cycle,
            };
        }

        // ---- Response ----------------------------------------------------------------------------------

        private BridgeResponse BuildDiagnoseResponse(DiagnoseContext ctx, BridgeRequest request, List<TrafficSample> samples, string samplingNote)
        {
            NameSystem names = World.GetOrCreateSystemManaged<NameSystem>();
            int n = samples.Count;
            TrafficSample avg = AverageSamples(samples);
            Entity focus = ctx.Focus;

            // ---- Focus road numbers --------------------------------------------------------------------
            var num = new DiagnoseNumbers();
            if (ctx.FocusIsEdge)
            {
                RoadFlowPeriods(focus, out num.Flow, out num.WorstFlow, out num.FlowByPeriod, out num.Volume);
                CountCarLanes(focus, out num.LanesForward, out num.LanesBackward, out _, out _);
                num.Highway = IsHighwayRoad(focus);
            }
            else
            {
                // A junction's numbers: its busiest leg.
                num.Flow = 100f;
                num.WorstFlow = 100f;
                num.FlowByPeriod = new[] { 100f, 100f, 100f, 100f };
                foreach (LegInfo leg in ctx.Junctions[0].Legs)
                {
                    num.Flow = math.min(num.Flow, leg.Flow);
                    if (leg.WorstFlow < num.WorstFlow)
                    {
                        num.WorstFlow = leg.WorstFlow;
                        num.FlowByPeriod = leg.FlowByPeriod;
                    }
                    num.Volume = math.max(num.Volume, leg.Volume);
                    num.LanesForward = math.max(num.LanesForward, leg.LanesToward);
                    num.LanesBackward = math.max(num.LanesBackward, leg.LanesAway);
                    num.Highway |= leg.Highway;
                }
            }

            List<ParallelStreet> parallel = ctx.FocusIsEdge ? FindParallelStreets(focus) : new List<ParallelStreet>();
            List<QueueSummary> heads = SummarizeQueueHeads(ctx, samples);
            List<Finding> findings = BuildTrafficFindings(ctx, avg, samples, num, parallel, heads, names);

            // ---- Junctions ---------------------------------------------------------------------------------
            var junctionItems = new List<object>();
            foreach (JunctionInfo junction in ctx.Junctions)
            {
                JunctionSample js = avg.Junctions[junction.Node];
                var legItems = new List<object>();
                foreach (LegInfo leg in junction.Legs)
                {
                    var laneItems = new List<object>();
                    foreach (LaneInfo lane in leg.Lanes)
                    {
                        avg.Lanes.TryGetValue(lane.Lane, out LaneSample ls);
                        var allowed = new List<string>(lane.AllowedTurns);
                        allowed.Sort(StringComparer.Ordinal);
                        laneItems.Add(new
                        {
                            laneFromLeft = lane.Order,
                            bus = lane.Bus,
                            allowedTurns = allowed,
                            observedTurns = ls != null ? ls.Turns : new Dictionary<string, int>(),
                            vehicles = ls?.Vehicles ?? 0,
                            stopped = ls?.Stopped ?? 0,
                        });
                    }
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
                        worstPeriodFlowPercent = math.round(leg.WorstFlow),
                        volume = math.round(leg.Volume),
                        farEnd = new { junction = EntityRef(leg.FarNode), roads = leg.FarNodeRoads },
                        lanes = laneItems,
                    });
                }

                var movementItems = new List<(int Count, object Item)>();
                int movementTotal = 0;
                foreach (KeyValuePair<(Entity From, Entity To), int[]> pair in js.Movements)
                {
                    LegInfo from = junction.Legs.Find(l => l.Edge == pair.Key.From);
                    LegInfo to = junction.Legs.Find(l => l.Edge == pair.Key.To);
                    string turn = TurnOf(-from.Outward, to.Outward);
                    bool crossing = turn == (ctx.LeftHand ? "right" : "left");
                    movementTotal += pair.Value[0];
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
                    vehicles = js.Vehicles,
                    stopped = js.Stopped,
                    stoppedWaitingFor = js.StoppedWaitingFor,
                    turningMovements = movementList,
                    movementsCounted = movementTotal,
                });
            }

            // ---- Destinations, alternatives ------------------------------------------------------------------
            var destinationClusters = new List<object>();
            var cellList = new List<DestinationCell>(avg.Cells.Values);
            cellList.Sort((a, b) => b.Vehicles.CompareTo(a.Vehicles));
            for (int i = 0; i < cellList.Count && i < 5; i++)
            {
                DestinationCell cell = cellList[i];
                float2 center = cell.PositionSum / math.max(1, cell.Raw);
                destinationClusters.Add(new
                {
                    x = math.round(center.x),
                    z = math.round(center.y),
                    distance = math.round(math.distance(center, ctx.FocusPosition.xz)),
                    vehicles = cell.Vehicles,
                    kinds = cell.Kinds,
                });
            }

            var parallelItems = new List<object>();
            foreach (ParallelStreet street in parallel)
            {
                Colossal.Mathematics.Bezier4x3 curve = EntityManager.GetComponentData<Curve>(street.Sample).m_Bezier;
                float3 position = Colossal.Mathematics.MathUtils.Position(curve, 0.5f);
                parallelItems.Add(new
                {
                    road = EntityRef(street.Sample),
                    prefab = PrefabNameOf(street.Sample),
                    street = StreetNameOf(names, street.Sample),
                    distance = math.round(street.Offset),
                    lanes = street.Lanes,
                    flowPercent = math.round(street.FlowSum / street.Segments),
                    position = new { x = math.round(position.x), z = math.round(position.z) },
                    connected = street.Connected,
                    detourMeters = street.Connected ? (object)math.round(street.DetourMeters) : null,
                    detourRatio = street.Connected && street.DetourRatio >= 0f ? (object)Math.Round(street.DetourRatio, 2) : null,
                });
            }

            // ---- Queue heads, baseline, comparison ---------------------------------------------------------
            var queueHeadItems = new List<object>();
            for (int i = 0; i < heads.Count && i < 3; i++)
            {
                queueHeadItems.Add(QueueHeadItem(ctx, names, heads[i], n));
            }
            double stoppedShare = avg.Vehicles > 0 ? Math.Round(100.0 * avg.Stopped / avg.Vehicles, 1) : 0.0;
            object baseline = new
            {
                flowPercent = math.round(num.Flow),
                worstPeriodFlowPercent = math.round(num.WorstFlow),
                vehiclesNearby = avg.Vehicles,
                stoppedNearby = avg.Stopped,
                stoppedSharePercent = stoppedShare,
                samples = n,
                note = "pass this block as `baseline` to cs2_traffic_diagnose after a change (same focus, same time of day) to get a comparison",
            };
            object comparison = BuildComparison(request, num, avg.Vehicles, avg.Stopped, stoppedShare);

            int withKnownDestination = avg.Local + avg.Far + avg.Outside;
            var frames = new List<uint>();
            var perSample = new List<object>();
            foreach (TrafficSample s in samples)
            {
                frames.Add(s.Frame);
                perSample.Add(new { vehicles = s.Vehicles, stopped = s.Stopped });
            }
            var findingItems = new List<object>();
            foreach (Finding f in findings)
            {
                findingItems.Add(new
                {
                    rank = f.Rank,
                    id = f.Id,
                    code = f.Code,
                    severity = f.Severity,
                    evidence = f.Evidence,
                    cause = f.Cause,
                    effect = f.Effect,
                    suggestion = f.Suggestion,
                    tools = f.Tools,
                    target = f.Target,
                    causedBy = f.CausedBy,
                    causes = f.Causes,
                });
            }

            return BridgeResponse.Json(new
            {
                focus = new
                {
                    kind = ctx.FocusIsEdge ? "road" : "junction",
                    entity = EntityRef(focus),
                    prefab = PrefabNameOf(focus),
                    street = ctx.FocusIsEdge ? StreetNameOf(names, focus) : null,
                    position = new { x = math.round(ctx.FocusPosition.x), z = math.round(ctx.FocusPosition.z) },
                    flowPercent = math.round(num.Flow),
                    worstPeriodFlowPercent = math.round(num.WorstFlow),
                    flowByPeriod = new[]
                    {
                        math.round(num.FlowByPeriod[0]), math.round(num.FlowByPeriod[1]),
                        math.round(num.FlowByPeriod[2]), math.round(num.FlowByPeriod[3]),
                    },
                    volume = math.round(num.Volume),
                    lanes = ctx.FocusIsEdge ? (object)new { forward = num.LanesForward, backward = num.LanesBackward } : null,
                    highway = num.Highway,
                },
                sampling = new
                {
                    requested = ctx.WantedSamples,
                    taken = n,
                    intervalFrames = ctx.IntervalFrames,
                    frames,
                    perSample,
                    note = samplingNote,
                },
                queueHead = heads.Count > 0 ? QueueHeadItem(ctx, names, heads[0], n) : null,
                otherQueueHeads = queueHeadItems.Count > 1 ? queueHeadItems.GetRange(1, queueHeadItems.Count - 1) : new List<object>(),
                baseline,
                comparison,
                vehicles = new
                {
                    total = avg.Vehicles,
                    stopped = avg.Stopped,
                    byType = avg.Types,
                    stoppedWaitingFor = avg.StoppedBy,
                    destinations = avg.DestinationKinds,
                    trip = new
                    {
                        localRadius = ctx.LocalRadius,
                        local = avg.Local,
                        farInCity = avg.Far,
                        outsideCity = avg.Outside,
                        throughSharePercent = withKnownDestination > 0 ? Math.Round(100.0 * (avg.Far + avg.Outside) / withKnownDestination, 1) : 0.0,
                    },
                    destinationClusters,
                },
                junctions = junctionItems,
                parallelStreets = parallelItems,
                findings = findingItems,
                note = "vehicles = driving road vehicles on the focus road, its junctions and their legs (averaged over " +
                       "`sampling.taken` samples; use samples=3..6 for stable numbers, a single snapshot varies). queueHead = " +
                       "where the longest queue in the focus area actually starts: stopped vehicles' blockers followed " +
                       "downstream; inFocusArea=false means the jam starts elsewhere (see the queueStartsElsewhere finding). " +
                       "Per leg, lanes lists the car lanes left to right with the turns they allow (from the junction's " +
                       "connection lanes) and what vehicles on them are about to do (observedTurns, summed over samples). " +
                       "flowPercent is the average of the four daily periods, worstPeriodFlowPercent the worst one. " +
                       "turningMovements come from each vehicle's planned path through the junction; bearingDegrees: 0 = +z, " +
                       "90 = +x, measured outward from the junction. trip.local = destination within localRadius of the " +
                       "focus, farInCity/outsideCity = traffic passing through. parallelStreets.connected = the street " +
                       "really links both ends of the focus as a detour (detourRatio = detour length / focus length). " +
                       "findings are ranked (rank 1 first) rules of thumb from traffic engineering, not certainties, with " +
                       "causedBy/causes ids linking them: apply one change at a time (dryRun first), let the simulation run, " +
                       "then diagnose again with `baseline` set to the baseline block above.",
            });
        }

        // ---- Baseline comparison -----------------------------------------------------------------------

        private static bool TryGetNumber(JObject source, out double value, params string[] keys)
        {
            value = 0;
            foreach (string key in keys)
            {
                JToken token = source.GetValue(key, StringComparison.OrdinalIgnoreCase);
                if (token != null && (token.Type == JTokenType.Float || token.Type == JTokenType.Integer))
                {
                    value = token.Value<double>();
                    return true;
                }
            }
            return false;
        }

        private object BuildComparison(BridgeRequest request, DiagnoseNumbers num, int vehicles, int stopped, double stoppedShare)
        {
            JObject source = null;
            if (request.Query.TryGetValue("baseline", out string raw) && !string.IsNullOrWhiteSpace(raw))
            {
                try
                {
                    source = JObject.Parse(raw);
                    if (source["baseline"] is JObject nested)
                    {
                        source = nested;
                    }
                }
                catch (Exception)
                {
                    return new { error = "baseline is not valid JSON; pass the baseline block of a previous result" };
                }
            }
            else
            {
                // Simple query fields: flowPercent / stopped / vehicles (also baselineFlowPercent ...).
                var simple = new JObject();
                foreach (KeyValuePair<string, string> pair in request.Query)
                {
                    string key = pair.Key.StartsWith("baseline", StringComparison.OrdinalIgnoreCase) && pair.Key.Length > 8
                        ? char.ToLowerInvariant(pair.Key[8]) + pair.Key.Substring(9)
                        : pair.Key;
                    if ((key == "flowPercent" || key == "worstPeriodFlowPercent" || key == "stopped" || key == "vehicles")
                        && double.TryParse(pair.Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double v))
                    {
                        simple[key] = v;
                    }
                }
                if (simple.Count > 0)
                {
                    source = simple;
                }
            }
            if (source == null)
            {
                return null;
            }

            bool hasFlow = TryGetNumber(source, out double bFlow, "flowPercent");
            bool hasWorst = TryGetNumber(source, out double bWorst, "worstPeriodFlowPercent");
            bool hasVehicles = TryGetNumber(source, out double bVehicles, "vehiclesNearby", "vehicles");
            bool hasStopped = TryGetNumber(source, out double bStopped, "stoppedNearby", "stopped");
            bool hasShare = TryGetNumber(source, out double bShare, "stoppedSharePercent");
            if (!hasShare && hasVehicles && hasStopped && bVehicles > 0)
            {
                bShare = 100.0 * bStopped / bVehicles;
                hasShare = true;
            }
            if (!(hasFlow || hasWorst || hasVehicles || hasStopped))
            {
                return new { error = "baseline has none of flowPercent, worstPeriodFlowPercent, vehiclesNearby/vehicles, stoppedNearby/stopped" };
            }

            double? flowDelta = hasFlow ? Math.Round(num.Flow - bFlow, 1) : (double?)null;
            double? worstDelta = hasWorst ? Math.Round(num.WorstFlow - bWorst, 1) : (double?)null;
            double? vehiclesDelta = hasVehicles ? Math.Round(vehicles - bVehicles, 1) : (double?)null;
            double? stoppedDelta = hasStopped ? Math.Round(stopped - bStopped, 1) : (double?)null;
            double? shareDelta = hasShare ? Math.Round(stoppedShare - bShare, 1) : (double?)null;

            int better = 0;
            int worse = 0;
            void Judge(double? delta, double threshold, bool higherIsBetter)
            {
                if (delta == null)
                {
                    return;
                }
                double signed = higherIsBetter ? delta.Value : -delta.Value;
                if (signed >= threshold)
                {
                    better++;
                }
                else if (signed <= -threshold)
                {
                    worse++;
                }
            }
            Judge(worstDelta ?? flowDelta, 5, true);
            Judge(shareDelta, 10, false);
            string verdict = better > 0 && worse == 0 ? "improved" : worse > 0 && better == 0 ? "worse" : better > 0 ? "mixed" : "unchanged";

            return new
            {
                baseline = new
                {
                    flowPercent = hasFlow ? (object)Math.Round(bFlow, 1) : null,
                    worstPeriodFlowPercent = hasWorst ? (object)Math.Round(bWorst, 1) : null,
                    vehicles = hasVehicles ? (object)Math.Round(bVehicles, 1) : null,
                    stopped = hasStopped ? (object)Math.Round(bStopped, 1) : null,
                    stoppedSharePercent = hasShare ? (object)Math.Round(bShare, 1) : null,
                },
                delta = new
                {
                    flowPercent = flowDelta,
                    worstPeriodFlowPercent = worstDelta,
                    vehicles = vehiclesDelta,
                    stopped = stoppedDelta,
                    stoppedSharePercentPoints = shareDelta,
                },
                verdict,
                note = "delta = now minus baseline (positive flow = better, positive stopped = worse). The verdict uses the worst-" +
                       "period flow (+/-5 points) and the stopped share (+/-10 points). Flow values update only 32 times per in-game " +
                       "day and vehicle counts follow the time of day: compare the same time of day after a few in-game days.",
            };
        }
    }
}
