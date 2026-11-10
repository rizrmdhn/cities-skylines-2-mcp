using System;
using System.Collections.Generic;
using System.Globalization;
using Colossal.Mathematics;
using Game.Net;
using Game.Prefabs;
using Game.Simulation;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;
using RoadFlags = Game.Prefabs.RoadFlags;

namespace CS2MCP
{
    /// <summary>
    /// POST /build/interchange: plans a whole interchange at an existing grade-separated
    /// crossing (diamond, parclo, cloverleaf) or at a dead end facing a through road
    /// (trumpet), and builds every ramp segment through /build/road/connect as one batch.
    /// The layout comes from InterchangePlanner; this file finds the site in the road
    /// network, projects ramp ends onto the real carriageways, picks the ramp prefab,
    /// and undoes the segments already built when a later one is refused.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private sealed class RoadEdgeInfo
        {
            public Entity Edge;
            public Entity Prefab;
            public Bezier4x3 Curve;
            public float2 Min;
            public float2 Max;
            /// <summary>+1: traffic runs start->end, -1: end->start, 0: two-way.</summary>
            public int OneWay;
            public bool Highway;
            public float Width;
        }

        private sealed class RoadAxis
        {
            public float2 Point;
            public float2 Dir;
            public float Height;
            public bool Highway;
            public float Width;
            public string Prefab;
        }

        private const float kInterchangeSnap = 4f;

        private static readonly Dictionary<string, string> kInterchangeNotes = new Dictionary<string, string>
        {
            ["diamond"] = "diamond: four ramps meeting the minor road at two terminals; the most common service interchange " +
                          "(highway to arterial/local road), cheap and compact, terminals work as ordinary junctions",
            ["parclo"] = "partial cloverleaf (Parclo A4 / B4, the Ontario 400-series standard): a diamond whose left turns at the " +
                         "terminals are replaced by two loop ramps; for busier service interchanges",
            ["cloverleaf"] = "full cloverleaf: four loops and four outer ramps, free-flowing with a single bridge (e.g. Simpang Susun " +
                             "Semanggi in Jakarta, the classic German Kleeblatt); a system interchange that needs a lot of land and " +
                             "weaves between consecutive loops",
            ["trumpet"] = "trumpet: three-leg free-flowing interchange with one bridge, a loop and a semi-direct ramp; the usual " +
                          "layout where a highway ends at another (and of single-toll-plaza exits on tolled expressways)",
        };

        private BridgeResponse BuildInterchange(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("type", out string type) || string.IsNullOrEmpty(type))
            {
                return BridgeResponse.Error(400, "provide ?type=diamond|parclo|cloverleaf|trumpet");
            }
            type = type.Trim().ToLowerInvariant();
            if (!kInterchangeNotes.ContainsKey(type))
            {
                return BridgeResponse.Error(400, $"unknown interchange type '{type}'; use diamond, parclo, cloverleaf or trumpet");
            }
            if (!request.TryGetFloat("x", out float x) || !request.TryGetFloat("z", out float z))
            {
                return BridgeResponse.Error(400,
                    "provide ?x=&z=: a point at the crossing of the two roads (trumpet: at the dead end of the road that should join the through road)");
            }
            bool dryRun = IsDryRun(request);
            bool force = IsForced(request);
            float searchRadius = request.TryGetFloat("searchRadius", out float rawSearch) ? math.clamp(rawSearch, 20f, 300f) : 120f;

            float designSpeed = request.TryGetFloat("designSpeed", out float rawSpeed) ? math.clamp(rawSpeed, 20f, 80f) : 40f;
            bool radiusGiven = request.TryGetFloat("radius", out float rawRadius);
            float radius = radiusGiven ? rawRadius : InterchangePlanner.MinimumRadius(designSpeed);
            if (radius < 20f || radius > 150f)
            {
                return BridgeResponse.Error(400, $"loop radius {radius:F0} m is outside 20-150 m; give radius or a designSpeed of 30-65 km/h");
            }
            var options = new InterchangeOptions
            {
                Type = type,
                Variant = request.Query.TryGetValue("variant", out string variant) ? variant.Trim() : "A",
                Radius = radius,
                RampLength = request.TryGetFloat("rampLength", out float rawLength) ? math.clamp(rawLength, 120f, 700f) : 260f,
                TerminalOffset = request.TryGetFloat("terminalOffset", out float rawOffset) ? math.clamp(rawOffset, 40f, 300f) : 90f,
                Clearance = request.TryGetFloat("clearance", out float rawClearance) ? math.clamp(rawClearance, 5f, 20f) : 8f,
            };

            var point = new float2(x, z);
            TerrainHeightData heightData = World.GetOrCreateSystemManaged<TerrainSystem>().GetHeightData();
            List<RoadEdgeInfo> edges = CollectRoadEdges(point, 1700f);
            if (edges.Count == 0)
            {
                return BridgeResponse.Error(404, $"no road within 1.7 km of ({x:F0}, {z:F0})");
            }

            var site = new InterchangeSite
            {
                LeftHandTraffic = World.GetOrCreateSystemManaged<Game.City.CityConfigurationSystem>().leftHandTraffic,
            };
            RoadAxis major;
            RoadAxis minor;
            Entity minorPrefabEntity = Entity.Null;
            string siteError = type == "trumpet"
                ? FindTrumpetSite(edges, point, searchRadius, ref heightData, site, out major, out minor, out minorPrefabEntity)
                : FindCrossingSite(edges, point, searchRadius, request.TryGetBool("swap", out bool swap) && swap, site, out major, out minor);
            if (siteError != null)
            {
                return BridgeResponse.Error(409, siteError);
            }

            // Ramp prefab: the one asked for, else the narrowest one-way road of the major road's class.
            Entity rampEntity;
            PrefabBase rampPrefab;
            if (request.Query.TryGetValue("ramp", out string rampName) && !string.IsNullOrEmpty(rampName))
            {
                if (!TryFindPrefabByName(RoadPrefabQuery, rampName, out rampEntity, out rampPrefab))
                {
                    return BridgeResponse.Error(404, $"no road prefab named '{rampName}' (see cs2_find_prefabs category road)");
                }
            }
            else if (!TryPickRampPrefab(major.Highway, force, out rampEntity, out rampPrefab))
            {
                return BridgeResponse.Error(409,
                    "no unlocked one-way road prefab found for the ramps; pass ramp=<one-way road prefab name> (cs2_find_prefabs category road) or force=true");
            }
            if (IsLocked(rampEntity) && !force)
            {
                return BridgeResponse.Error(409, $"ramp prefab '{rampPrefab.name}' is locked (milestone not reached); pass force=true to use it anyway");
            }
            int rampOneWay = OneWayOf(rampEntity);
            PrefabBase minorPrefab = minorPrefabEntity != Entity.Null
                ? World.GetOrCreateSystemManaged<PrefabSystem>().GetPrefab<PrefabBase>(minorPrefabEntity)
                : null;

            RoadProjector projector = (role, guess, travelDir, anyDirection) =>
                ProjectOnRoad(edges, role == RoadRole.Major ? major : minor, guess, travelDir, anyDirection, ref heightData);

            InterchangePlanner.Result plan;
            try
            {
                plan = InterchangePlanner.Plan(site, options, projector);
            }
            catch (PlanException e)
            {
                return BridgeResponse.Error(409, $"{type} interchange cannot be laid out here: {e.Message}");
            }
            if (rampOneWay == 0)
            {
                plan.Notes.Add($"ramp prefab '{rampPrefab.name}' is a two-way road; one-way ramps are the norm");
            }

            // One /build/road/connect step per segment, in travel order so each piece joins the previous one.
            var job = new BatchJob { Parent = request, StopOnError = !dryRun };
            var expectations = new Dictionary<BatchOperation, bool[]>();
            int segmentCount = 0;
            foreach (Ramp ramp in plan.Ramps)
            {
                for (int i = 0; i < ramp.Segments.Count; i++)
                {
                    RampSegment segment = ramp.Segments[i];
                    string prefabName = segment.UseMinorPrefab && minorPrefab != null ? minorPrefab.name : rampPrefab.name;
                    // A prefab whose traffic runs against the drawing direction is drawn end to start.
                    bool reverse = !segment.UseMinorPrefab && rampOneWay < 0;
                    var operation = new BatchOperation
                    {
                        Path = "/build/road/connect",
                        Label = ramp.Segments.Count > 1 ? $"{ramp.Name}, piece {i + 1}/{ramp.Segments.Count}" : ramp.Name,
                    };
                    AddSegmentQuery(operation.Query, segment, reverse, prefabName, force, dryRun);
                    bool joinsStart = i > 0 || ramp.JoinsStart;
                    bool joinsEnd = i < ramp.Segments.Count - 1 ? false : ramp.JoinsEnd;
                    expectations[operation] = reverse ? new[] { joinsEnd, joinsStart } : new[] { joinsStart, joinsEnd };
                    job.Operations.Add(operation);
                    segmentCount++;
                }
            }
            if (segmentCount > BridgeSystem.MaxBatchOperations)
            {
                return BridgeResponse.Error(400, $"the plan needs {segmentCount} segments, more than one batch may run");
            }

            object siteInfo = new
            {
                center = new { x = site.Center.x, z = site.Center.y },
                major = DescribeAxis(major),
                minor = DescribeAxis(minor),
                heightDifference = type == "trumpet" ? (float?)null : math.abs(major.Height - minor.Height),
                leftHandTraffic = site.LeftHandTraffic,
            };
            object designBasis = new
            {
                layout = kInterchangeNotes[type],
                loopRadius = radius,
                loopRadiusSource = radiusGiven
                    ? "given"
                    : $"AASHTO minimum radius R = V^2 / (127 (e + f)) for a {designSpeed:F0} km/h ramp at 6 % superelevation",
                rampGradeLimitPercent = InterchangePlanner.MaxGrade * 100f,
                rampGradePreferredPercent = InterchangePlanner.PreferredGrade * 100f,
                footprintRadius = math.round(plan.Footprint),
            };
            List<object> rampInfo = DescribeRamps(plan);

            if (dryRun)
            {
                job.BuildResponse = finished => InterchangeDryRunResponse(finished, type, rampPrefab.name, siteInfo, designBasis, rampInfo, plan.Notes);
            }
            else
            {
                job.Validate = result => ValidateJoined(result, expectations);
                job.Rollback = finished => InterchangeRollback(finished);
                job.BuildResponse = finished => InterchangeBuildResponse(finished, type, rampPrefab.name, siteInfo, designBasis, rampInfo, plan.Notes);
            }
            if (BridgeTools.AnyBusy(World) || !m_System.TryStartBatch(job))
            {
                return BridgeResponse.Error(409, "another build operation or batch is in progress, retry shortly");
            }
            // Completed by BridgeSystem once every segment has run.
            return null;
        }

        // ---- Site detection ---------------------------------------------------------------------------

        private List<RoadEdgeInfo> CollectRoadEdges(float2 center, float range)
        {
            var result = new List<RoadEdgeInfo>();
            using (NativeArray<Entity> entities = PlacedRoadQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity edge in entities)
                {
                    Entity prefab = EntityManager.GetComponentData<PrefabRef>(edge).m_Prefab;
                    if (!EntityManager.HasComponent<RoadData>(prefab))
                    {
                        continue;
                    }
                    Bezier4x3 curve = EntityManager.GetComponentData<Curve>(edge).m_Bezier;
                    float2 min = math.min(math.min(curve.a.xz, curve.b.xz), math.min(curve.c.xz, curve.d.xz));
                    float2 max = math.max(math.max(curve.a.xz, curve.b.xz), math.max(curve.c.xz, curve.d.xz));
                    if (math.any(center < min - range) || math.any(center > max + range))
                    {
                        continue;
                    }
                    RoadFlags flags = EntityManager.GetComponentData<RoadData>(prefab).m_Flags;
                    result.Add(new RoadEdgeInfo
                    {
                        Edge = edge,
                        Prefab = prefab,
                        Curve = curve,
                        Min = min,
                        Max = max,
                        OneWay = (flags & RoadFlags.DefaultIsForward) != 0 ? 1 : (flags & RoadFlags.DefaultIsBackward) != 0 ? -1 : 0,
                        Highway = (flags & RoadFlags.UseHighwayRules) != 0,
                        Width = EntityManager.HasComponent<NetGeometryData>(prefab)
                            ? EntityManager.GetComponentData<NetGeometryData>(prefab).m_DefaultWidth
                            : 8f,
                    });
                }
            }
            return result;
        }

        private int OneWayOf(Entity roadPrefab)
        {
            if (!EntityManager.HasComponent<RoadData>(roadPrefab))
            {
                return 0;
            }
            RoadFlags flags = EntityManager.GetComponentData<RoadData>(roadPrefab).m_Flags;
            return (flags & RoadFlags.DefaultIsForward) != 0 ? 1 : (flags & RoadFlags.DefaultIsBackward) != 0 ? -1 : 0;
        }

        private struct NearEdge
        {
            public RoadEdgeInfo Info;
            public float Distance;
            public float3 Position;
            public float2 Tangent;
        }

        private static List<NearEdge> EdgesNear(List<RoadEdgeInfo> edges, float2 point, float range)
        {
            var result = new List<NearEdge>();
            foreach (RoadEdgeInfo info in edges)
            {
                if (math.any(point < info.Min - range) || math.any(point > info.Max + range))
                {
                    continue;
                }
                float distance = MathUtils.Distance(info.Curve.xz, point, out float t);
                if (distance > range)
                {
                    continue;
                }
                float2 tangent = math.normalizesafe(MathUtils.Tangent(info.Curve, t).xz);
                if (math.lengthsq(tangent) == 0f)
                {
                    continue;
                }
                result.Add(new NearEdge { Info = info, Distance = distance, Position = MathUtils.Position(info.Curve, t), Tangent = tangent });
            }
            result.Sort((a, b) => a.Distance.CompareTo(b.Distance));
            return result;
        }

        /// <summary>Averages the carriageways running along seed into one axis (a dual carriageway becomes its centre line).</summary>
        private RoadAxis BuildAxis(List<NearEdge> near, NearEdge seed)
        {
            float2 perpendicular = new float2(-seed.Tangent.y, seed.Tangent.x);
            float lateral = 0f;
            float height = 0f;
            float width = 0f;
            bool highway = false;
            int count = 0;
            var seen = new List<float>();
            foreach (NearEdge candidate in near)
            {
                if (math.abs(math.dot(candidate.Tangent, seed.Tangent)) < 0.9f)
                {
                    continue;
                }
                float offset = math.dot(candidate.Position.xz - seed.Position.xz, perpendicular);
                if (math.abs(offset) > 60f)
                {
                    continue;
                }
                // Count each carriageway once, however many segments of it are in range.
                bool duplicate = false;
                foreach (float known in seen)
                {
                    if (math.abs(known - offset) < 4f)
                    {
                        duplicate = true;
                        break;
                    }
                }
                if (duplicate)
                {
                    continue;
                }
                seen.Add(offset);
                lateral += offset;
                height += candidate.Position.y;
                width += candidate.Info.Width;
                highway |= candidate.Info.Highway;
                count++;
            }
            PrefabBase prefab = World.GetOrCreateSystemManaged<PrefabSystem>().GetPrefab<PrefabBase>(seed.Info.Prefab);
            return new RoadAxis
            {
                Point = seed.Position.xz + perpendicular * (lateral / count),
                Dir = seed.Tangent,
                Height = height / count,
                Highway = highway,
                Width = width,
                Prefab = prefab != null ? prefab.name : null,
            };
        }

        /// <summary>Two roads crossing near point at different heights. Null on success, else why the site does not work.</summary>
        private string FindCrossingSite(List<RoadEdgeInfo> edges, float2 point, float searchRadius, bool swap,
            InterchangeSite site, out RoadAxis major, out RoadAxis minor)
        {
            major = null;
            minor = null;
            List<NearEdge> near = EdgesNear(edges, point, searchRadius);
            if (near.Count == 0)
            {
                return $"no road within {searchRadius:F0} m of ({point.x:F0}, {point.y:F0}); give a point at the crossing or raise searchRadius";
            }
            NearEdge first = near[0];
            NearEdge? second = null;
            foreach (NearEdge candidate in near)
            {
                if (math.abs(math.dot(candidate.Tangent, first.Tangent)) <= 0.77f)
                {
                    second = candidate;
                    break;
                }
            }
            if (!second.HasValue)
            {
                return $"only one road direction found within {searchRadius:F0} m of ({point.x:F0}, {point.y:F0}): an interchange needs two roads " +
                       "crossing there (for a road that ends at a through road use type=trumpet at its dead end)";
            }
            RoadAxis a = BuildAxis(near, first);
            RoadAxis b = BuildAxis(near, second.Value);
            if (math.abs(math.dot(a.Dir, b.Dir)) > 0.5f)
            {
                return "the two roads cross at less than 60 degrees; these layouts need a crossing closer to a right angle";
            }
            if (!InterchangePlanner.TryIntersectLines(a.Point, a.Dir, b.Point, b.Dir, out float2 center)
                || math.distance(center, point) > searchRadius + 80f)
            {
                return "could not locate the crossing point of the two roads near the given point";
            }
            float heightDifference = math.abs(a.Height - b.Height);
            if (heightDifference < 3.5f)
            {
                return $"the two roads are at the same level here (height difference {heightDifference:F1} m): an interchange needs one road to " +
                       "pass over or under the other. Replace the at-grade crossing with a bridge first (cs2_connect_road with e1/e2 of about 8, " +
                       "or raise one road), then call this again";
            }
            // Major = the highway; between equals, the wider road.
            bool aIsMajor = a.Highway != b.Highway ? a.Highway : a.Width >= b.Width;
            if (swap)
            {
                aIsMajor = !aIsMajor;
            }
            major = aIsMajor ? a : b;
            minor = aIsMajor ? b : a;
            site.Center = center;
            site.MajorDir = major.Dir;
            site.MinorDir = minor.Dir;
            return null;
        }

        /// <summary>A dead-end two-way road near point and the through road ahead of it. Null on success.</summary>
        private string FindTrumpetSite(List<RoadEdgeInfo> edges, float2 point, float searchRadius, ref TerrainHeightData heightData,
            InterchangeSite site, out RoadAxis major, out RoadAxis minor, out Entity stemPrefab)
        {
            major = null;
            minor = null;
            stemPrefab = Entity.Null;
            Entity deadEnd = Entity.Null;
            RoadEdgeInfo stemEdge = null;
            float best = searchRadius;
            foreach (RoadEdgeInfo info in edges)
            {
                if (math.any(point < info.Min - searchRadius) || math.any(point > info.Max + searchRadius))
                {
                    continue;
                }
                Edge ends = EntityManager.GetComponentData<Edge>(info.Edge);
                foreach (Entity node in new[] { ends.m_Start, ends.m_End })
                {
                    if (!EntityManager.HasBuffer<ConnectedEdge>(node) || EntityManager.GetBuffer<ConnectedEdge>(node, isReadOnly: true).Length != 1)
                    {
                        continue;
                    }
                    float distance = math.distance(EntityManager.GetComponentData<Node>(node).m_Position.xz, point);
                    if (distance < best)
                    {
                        best = distance;
                        deadEnd = node;
                        stemEdge = info;
                    }
                }
            }
            if (deadEnd == Entity.Null || !TryGetOutwardDirection(deadEnd, out float2 outward))
            {
                return $"no dead-end road within {searchRadius:F0} m of ({point.x:F0}, {point.y:F0}): a trumpet grows from the open end of the road " +
                       "that should join the through road (end that road 150-500 m short of it)";
            }
            if (stemEdge.OneWay != 0)
            {
                return "the dead-end road is one-way; the trumpet stem must be a two-way road (replace it with cs2_replace_road, or build the ramps with cs2_connect_road)";
            }
            float3 start = EntityManager.GetComponentData<Node>(deadEnd).m_Position;

            // Walk ahead of the dead end until the through road is crossed (both carriageways of a dual one).
            float firstHit = -1f;
            float lastHit = -1f;
            NearEdge? through = null;
            for (float distance = 16f; distance <= 700f; distance += 6f)
            {
                if (firstHit >= 0f && distance > firstHit + 70f)
                {
                    break;
                }
                float2 probe = start.xz + outward * distance;
                foreach (NearEdge candidate in EdgesNear(edges, probe, 6f))
                {
                    if (candidate.Info.Edge == stemEdge.Edge || math.abs(math.dot(candidate.Tangent, outward)) > 0.6f)
                    {
                        continue;
                    }
                    if (firstHit < 0f)
                    {
                        firstHit = distance;
                        through = candidate;
                    }
                    lastHit = distance;
                    break;
                }
            }
            if (!through.HasValue)
            {
                return "no road crosses the line ahead of the dead end within 700 m; point the dead end at the through road";
            }
            float2 throughDir = through.Value.Tangent;
            if (math.abs(math.dot(throughDir, outward)) > 0.35f)
            {
                return "the dead-end road meets the through road at too shallow an angle; a trumpet needs it roughly square (within 20 degrees)";
            }
            float2 center = start.xz + outward * ((firstHit + lastHit) * 0.5f);
            List<NearEdge> near = EdgesNear(edges, center, 60f);
            NearEdge seed = through.Value;
            major = BuildAxis(near.Count > 0 ? near : new List<NearEdge> { seed }, seed);
            major.Point = center;
            PrefabBase prefab = World.GetOrCreateSystemManaged<PrefabSystem>().GetPrefab<PrefabBase>(stemEdge.Prefab);
            minor = new RoadAxis
            {
                Point = start.xz,
                Dir = outward,
                Height = start.y,
                Highway = stemEdge.Highway,
                Width = stemEdge.Width,
                Prefab = prefab != null ? prefab.name : null,
            };
            stemPrefab = stemEdge.Prefab;
            float stemElevation = start.y - TerrainUtils.SampleHeight(ref heightData, start);
            site.Center = center;
            site.MajorDir = major.Dir;
            site.MinorDir = outward;
            site.StemStart = start.xz;
            site.StemElevation = math.abs(stemElevation) < 1.5f ? 0f : stemElevation;
            return null;
        }

        /// <summary>
        /// The point of a road's carriageway nearest to guess that carries travelDir: among the
        /// edges lying along the road's axis, the closest one whose traffic runs that way.
        /// </summary>
        private RoadHit ProjectOnRoad(List<RoadEdgeInfo> edges, RoadAxis axis, float2 guess, float2 travelDir,
            bool anyDirection, ref TerrainHeightData heightData)
        {
            float2 perpendicular = new float2(-axis.Dir.y, axis.Dir.x);
            float along = math.abs(math.dot(guess - axis.Point, axis.Dir));
            // Roads drift off the straight axis; allow more the farther out the point is.
            float reach = 40f + along * 0.15f;
            var hit = new RoadHit();
            float best = reach;
            foreach (RoadEdgeInfo info in edges)
            {
                if (math.any(guess < info.Min - reach) || math.any(guess > info.Max + reach))
                {
                    continue;
                }
                float distance = MathUtils.Distance(info.Curve.xz, guess, out float t);
                if (distance >= best)
                {
                    continue;
                }
                float2 tangent = math.normalizesafe(MathUtils.Tangent(info.Curve, t).xz);
                float alignment = math.dot(tangent, travelDir);
                float2 direction;
                if (info.OneWay == 0)
                {
                    if (math.abs(alignment) < 0.8f)
                    {
                        continue;
                    }
                    direction = alignment >= 0f ? tangent : -tangent;
                }
                else
                {
                    direction = tangent * info.OneWay;
                    float match = math.dot(direction, travelDir);
                    if (anyDirection ? math.abs(match) < 0.8f : match < 0.8f)
                    {
                        continue;
                    }
                }
                float3 position = MathUtils.Position(info.Curve, t);
                // Stay on this road: a parallel street farther from the axis is not it.
                if (math.abs(math.dot(position.xz - axis.Point, perpendicular)) > 45f + along * 0.15f)
                {
                    continue;
                }
                best = distance;
                float elevation = position.y - TerrainUtils.SampleHeight(ref heightData, position);
                hit = new RoadHit
                {
                    Found = true,
                    Position = position.xz,
                    Direction = direction,
                    TwoWay = info.OneWay == 0,
                    Elevation = math.abs(elevation) < 1.5f ? 0f : elevation,
                };
            }
            return hit;
        }

        /// <summary>The narrowest one-way road of the wanted class (highway ramps for a highway, else a one-way street).</summary>
        private bool TryPickRampPrefab(bool highway, bool allowLocked, out Entity prefabEntity, out PrefabBase prefab)
        {
            prefabEntity = Entity.Null;
            prefab = null;
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            float bestWidth = float.MaxValue;
            using (NativeArray<Entity> entities = RoadPrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    RoadFlags flags = EntityManager.GetComponentData<RoadData>(entity).m_Flags;
                    // Drawn in travel order, so only prefabs whose traffic follows the drawing direction.
                    if ((flags & RoadFlags.DefaultIsForward) == 0
                        || ((flags & RoadFlags.UseHighwayRules) != 0) != highway
                        || !EntityManager.HasComponent<NetGeometryData>(entity)
                        || (!allowLocked && IsLocked(entity)))
                    {
                        continue;
                    }
                    PrefabBase candidate = prefabSystem.GetPrefab<PrefabBase>(entity);
                    if (candidate == null)
                    {
                        continue;
                    }
                    float width = EntityManager.GetComponentData<NetGeometryData>(entity).m_DefaultWidth;
                    if (width < bestWidth - 0.01f
                        || (math.abs(width - bestWidth) <= 0.01f && string.CompareOrdinal(candidate.name, prefab.name) < 0))
                    {
                        bestWidth = width;
                        prefabEntity = entity;
                        prefab = candidate;
                    }
                }
            }
            return prefab != null;
        }

        // ---- Building ---------------------------------------------------------------------------------

        private static string Number(float value)
        {
            return value.ToString("0.###", CultureInfo.InvariantCulture);
        }

        private static void AddSegmentQuery(Dictionary<string, string> query, RampSegment segment, bool reverse, string prefab, bool force, bool dryRun)
        {
            float2 start = reverse ? segment.End : segment.Start;
            float2 end = reverse ? segment.Start : segment.End;
            query["prefab"] = prefab;
            query["x1"] = Number(start.x);
            query["z1"] = Number(start.y);
            query["x2"] = Number(end.x);
            query["z2"] = Number(end.y);
            if (segment.HasC1 && segment.HasC2)
            {
                float2 first = reverse ? segment.C2 : segment.C1;
                float2 second = reverse ? segment.C1 : segment.C2;
                query["cx"] = Number(first.x);
                query["cz"] = Number(first.y);
                query["c2x"] = Number(second.x);
                query["c2z"] = Number(second.y);
            }
            else if (segment.HasC1)
            {
                query["cx"] = Number(segment.C1.x);
                query["cz"] = Number(segment.C1.y);
            }
            // Always given: an end only joins roads near this height, so a ramp end never drops onto a road below a bridge.
            query["e1"] = Number(Level(reverse ? segment.E2 : segment.E1));
            query["e2"] = Number(Level(reverse ? segment.E1 : segment.E2));
            query["snap"] = Number(kInterchangeSnap);
            if (force)
            {
                query["force"] = "true";
            }
            if (dryRun)
            {
                query["dryRun"] = "true";
            }
        }

        /// <summary>Elevations within 1.5 m of the ground are built on it rather than as a knee-high viaduct.</summary>
        private static float Level(float elevation)
        {
            return math.abs(elevation) < 1.5f ? 0f : math.round(elevation * 10f) / 10f;
        }

        /// <summary>A built segment whose end should have joined a road but stayed free leaves the ramp disconnected.</summary>
        private static string ValidateJoined(BatchResult result, Dictionary<BatchOperation, bool[]> expectations)
        {
            if (!expectations.TryGetValue(result.Operation, out bool[] expected) || !(result.Body is JObject body))
            {
                return null;
            }
            string[] names = { "start", "end" };
            for (int i = 0; i < 2; i++)
            {
                if (!expected[i])
                {
                    continue;
                }
                JObject end = body[names[i]] as JObject;
                if (end == null)
                {
                    continue;
                }
                bool alone = end["junction"] is JObject && (end.Value<int?>("segmentsAtJunction") ?? 2) < 2;
                if (end.Value<string>("snappedTo") == "free point" || alone)
                {
                    return $"the segment was built but its {names[i]} did not join the road it should connect to";
                }
            }
            return null;
        }

        private static List<BatchOperation> InterchangeRollback(BatchJob job)
        {
            var undo = new List<BatchOperation>();
            for (int i = job.Results.Count - 1; i >= 0; i--)
            {
                BatchResult result = job.Results[i];
                if (result.Status != 200 || !((result.Body as JObject)?["segments"] is JArray segments))
                {
                    continue;
                }
                foreach (JToken segment in segments)
                {
                    JObject road = segment["road"] as JObject;
                    if (road == null)
                    {
                        continue;
                    }
                    var operation = new BatchOperation { Path = "/build/demolish", Label = "undo " + result.Operation.Label };
                    operation.Query["index"] = road.Value<int>("index").ToString(CultureInfo.InvariantCulture);
                    operation.Query["version"] = road.Value<int>("version").ToString(CultureInfo.InvariantCulture);
                    undo.Add(operation);
                }
            }
            return undo;
        }

        private static object DescribeAxis(RoadAxis axis)
        {
            return new
            {
                prefab = axis.Prefab,
                highway = axis.Highway,
                direction = new { x = axis.Dir.x, z = axis.Dir.y },
                height = axis.Height,
            };
        }

        private static List<object> DescribeRamps(InterchangePlanner.Result plan)
        {
            var list = new List<object>();
            foreach (Ramp ramp in plan.Ramps)
            {
                RampSegment first = ramp.Segments[0];
                RampSegment last = ramp.Segments[ramp.Segments.Count - 1];
                list.Add(new
                {
                    name = ramp.Name,
                    kind = ramp.Kind,
                    segments = ramp.Segments.Count,
                    length = math.round(ramp.Length),
                    gradePercent = math.round(ramp.Grade * 1000f) / 10f,
                    from = new { x = math.round(first.Start.x), z = math.round(first.Start.y), elevation = Level(first.E1) },
                    to = new { x = math.round(last.End.x), z = math.round(last.End.y), elevation = Level(last.E2) },
                });
            }
            return list;
        }

        private static BridgeResponse InterchangeDryRunResponse(BatchJob job, string type, string rampPrefab, object site, object designBasis,
            List<object> ramps, List<string> notes)
        {
            int cost = 0;
            var problems = new List<object>();
            foreach (BatchResult result in job.Results)
            {
                JObject body = result.Body as JObject;
                bool valid = result.Status == 200 && (body?.Value<bool?>("valid") ?? false);
                if (valid)
                {
                    cost += body.Value<int?>("cost") ?? 0;
                    continue;
                }
                problems.Add(new
                {
                    segment = result.Operation.Label,
                    errors = result.Status == 200 ? body?["errors"] : (JToken)result.Error,
                    from = new { x = result.Operation.Query["x1"], z = result.Operation.Query["z1"] },
                    to = new { x = result.Operation.Query["x2"], z = result.Operation.Query["z2"] },
                });
            }
            return BridgeResponse.Json(new
            {
                dryRun = true,
                valid = problems.Count == 0,
                type,
                rampPrefab,
                segments = job.Results.Count,
                estimatedCost = cost,
                site,
                designBasis,
                ramps,
                problems,
                notes,
                note = problems.Count == 0
                    ? "every segment passed the game's validation on its own; repeat without dryRun to build. Segments are checked " +
                      "one by one against the current city, so a conflict between two new ramps only shows when building (which rolls back)"
                    : "some segments are refused by the game (see problems): clear what is in the way, or change radius / rampLength / " +
                      "terminalOffset. Nothing was changed",
            });
        }

        private static BridgeResponse InterchangeBuildResponse(BatchJob job, string type, string rampPrefab, object site, object designBasis,
            List<object> ramps, List<string> notes)
        {
            if (job.Failed)
            {
                BatchResult failed = job.Results[job.Results.Count - 1];
                int undone = 0;
                var leftovers = new List<string>();
                foreach (BatchResult undo in job.RollbackResults)
                {
                    if (undo.Ok)
                    {
                        undone++;
                    }
                    else
                    {
                        leftovers.Add($"{undo.Operation.Query["index"]}:{undo.Operation.Query["version"]}");
                    }
                }
                string rollback = job.RollbackResults.Count == 0
                    ? "nothing had been built"
                    : $"rolled back {undone} segment(s)" +
                      (leftovers.Count > 0 ? $"; could not remove {string.Join(", ", leftovers)} (demolish them with cs2_demolish)" : "");
                return BridgeResponse.Error(409,
                    $"{type} interchange not built: step {job.Results.Count} of {job.Operations.Count} ({failed.Operation.Label}) failed: " +
                    $"{failed.Error}. {rollback}. Nodes left on the existing roads where ramps had joined are harmless. " +
                    "Run it with dryRun=true to see which segments the game refuses");
            }
            var built = new List<object>();
            foreach (BatchResult result in job.Results)
            {
                if ((result.Body as JObject)?["segments"] is JArray segments)
                {
                    foreach (JToken segment in segments)
                    {
                        built.Add(segment["road"]);
                    }
                }
            }
            return BridgeResponse.Json(new
            {
                built = true,
                type,
                rampPrefab,
                segments = job.Results.Count,
                site,
                designBasis,
                ramps,
                roads = built,
                notes,
                note = "built through the game's road tool, each ramp joined to the existing roads. Check it with cs2_screenshot " +
                       "and cs2_road_graph; run the simulation a while and use cs2_traffic_diagnose to see how it performs. " +
                       "cs2_history shows what it cost.",
            });
        }
    }
}
