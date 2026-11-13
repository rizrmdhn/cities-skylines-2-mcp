using System;
using System.Collections.Generic;
using Colossal.Mathematics;
using Game.Common;
using Game.Net;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Road changes through BridgeRoadToolSystem: Replace (the road tool's
    /// Replace mode) changes the road type of existing segments, e.g. widen a
    /// highway or turn a two-way street into a one-way one, keeping the nodes,
    /// connections and (where the width allows) the buildings along it; Connect
    /// builds a segment whose ends snap to existing junctions or split existing
    /// segments, so new links, ramps and track spurs are actually joined up.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private BridgeResponse ConnectRoad(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("prefab", out string prefabName) || string.IsNullOrEmpty(prefabName))
            {
                return BridgeResponse.Error(400, "provide ?prefab=<network prefab name> (see cs2_find_prefabs category road or net)");
            }
            if (!request.TryGetFloat("x1", out float x1) || !request.TryGetFloat("z1", out float z1)
                || !request.TryGetFloat("x2", out float x2) || !request.TryGetFloat("z2", out float z2))
            {
                return BridgeResponse.Error(400, "provide ?x1=&z1=&x2=&z2= world coordinates for both ends");
            }
            float snap = request.TryGetFloat("snap", out float rawSnap) ? math.clamp(rawSnap, 0f, 50f) : 8f;
            if (!TryFindPrefabByName(NetPrefabQuery, prefabName, out Entity prefabEntity, out PrefabBase prefab))
            {
                return BridgeResponse.Error(404, $"unknown network prefab '{prefabName}' (see cs2_find_prefabs category road or net)");
            }
            if (IsLocked(prefabEntity) && !IsForced(request))
            {
                return BridgeResponse.Error(409, $"prefab '{prefab.name}' is locked (milestone not reached); pass force=true to build anyway");
            }
            if (!EntityManager.HasComponent<NetData>(prefabEntity))
            {
                return BridgeResponse.Error(400, $"'{prefab.name}' is not a network prefab");
            }
            NetData netData = EntityManager.GetComponentData<NetData>(prefabEntity);

            TerrainHeightData heightData = World.GetOrCreateSystemManaged<TerrainSystem>().GetHeightData();
            // An end given an elevation only snaps to networks at that height, so a flyover end
            // above a road stays elevated instead of dropping onto (and splitting) the road below.
            float? e1 = request.TryGetFloat("e1", out float rawE1) ? math.clamp(rawE1, -30f, 60f) : (float?)null;
            float? e2 = request.TryGetFloat("e2", out float rawE2) ? math.clamp(rawE2, -30f, 60f) : (float?)null;
            BridgeRoadToolSystem.BuildEnd start = ResolveBuildEnd(new float2(x1, z1), snap, netData, ref heightData, e1);
            BridgeRoadToolSystem.BuildEnd end = ResolveBuildEnd(new float2(x2, z2), snap, netData, ref heightData, e2);
            // Free ends can be raised (bridges, flyovers) or lowered (tunnels); snapped ends keep the height of what they join.
            if (start.Entity == Entity.Null && e1.HasValue)
            {
                start.Elevation = e1.Value;
                start.Position.y += start.Elevation;
            }
            if (end.Entity == Entity.Null && e2.HasValue)
            {
                end.Elevation = e2.Value;
                end.Position.y += end.Elevation;
            }
            if (start.Entity != Entity.Null && start.Entity == end.Entity)
            {
                return BridgeResponse.Error(400, "both ends snap to the same junction or segment; move an end or lower snap");
            }
            float length = math.distance(start.Position.xz, end.Position.xz);
            if (length < 4f || length > 1500f)
            {
                return BridgeResponse.Error(400, $"segment length after snapping is {length:F0}m; it must be 4-1500m");
            }

            Bezier4x3 bezier;
            bool smooth = request.TryGetBool("smooth", out bool rawSmooth) && rawSmooth;
            bool hasControl = request.TryGetFloat("cx", out float cx) & request.TryGetFloat("cz", out float cz);
            bool hasSecondControl = request.TryGetFloat("c2x", out float c2x) & request.TryGetFloat("c2z", out float c2z);
            if (smooth && hasControl)
            {
                return BridgeResponse.Error(400, "use either smooth=true or a control point cx/cz, not both");
            }
            if (hasSecondControl && !hasControl)
            {
                return BridgeResponse.Error(400, "c2x/c2z is the second control point of a cubic curve; give cx/cz as the first");
            }
            if (smooth)
            {
                // Tangent-continuous ends: follow the road being split (merge/diverge ramps) or continue
                // a dead end (station tracks, road stubs); free ends point at the other end.
                float3 a = start.Position;
                float3 d = end.Position;
                float third = math.distance(a.xz, d.xz) / 3f;
                float2 dirA = SmoothEndDirection(start, d.xz - a.xz);
                float2 dirD = SmoothEndDirection(end, a.xz - d.xz);
                float3 b = a + new float3(dirA.x, 0f, dirA.y) * third;
                float3 c = d + new float3(dirD.x, 0f, dirD.y) * third;
                b.y = math.lerp(a.y, d.y, 1f / 3f);
                c.y = math.lerp(a.y, d.y, 2f / 3f);
                bezier = new Bezier4x3(a, b, c, d);
            }
            else if (hasControl && hasSecondControl)
            {
                // Cubic bezier with both control points given: the segment leaves the start toward
                // cx/cz and arrives at the end from c2x/c2z (S-curves, ramps with set end directions).
                float3 a = start.Position;
                float3 d = end.Position;
                bezier = new Bezier4x3(
                    a,
                    new float3(cx, math.lerp(a.y, d.y, 1f / 3f), cz),
                    new float3(c2x, math.lerp(a.y, d.y, 2f / 3f), c2z),
                    d);
            }
            else if (hasControl)
            {
                // Quadratic bezier through the control point, elevated to cubic.
                float3 a = start.Position;
                float3 d = end.Position;
                float3 m = new float3(cx, math.lerp(a.y, d.y, 0.5f), cz);
                bezier = new Bezier4x3(a, a + (m - a) * (2f / 3f), d + (m - d) * (2f / 3f), d);
            }
            else
            {
                bezier = NetUtils.StraightCurve(start.Position, end.Position);
            }
            // Follow the terrain between the ends, then lift the middle by the
            // interpolated end elevations (as cs2_build_road does for bridges).
            Curve raw = new Curve { m_Bezier = bezier, m_Length = MathUtils.Length(bezier) };
            bezier = NetUtils.AdjustPosition(raw, start.Entity != Entity.Null, false, end.Entity != Entity.Null, ref heightData).m_Bezier;
            bezier.b.y += math.lerp(start.Elevation, end.Elevation, 1f / 3f);
            bezier.c.y += math.lerp(start.Elevation, end.Elevation, 2f / 3f);
            bezier.a = start.Position;
            bezier.d = end.Position;

            if (TransitToolsBusy(out error))
            {
                return error;
            }
            BridgeRoadToolSystem tool = World.GetOrCreateSystemManaged<BridgeRoadToolSystem>();
            if (!tool.TryQueueBuild(prefabEntity, prefab, start, end, bezier, request, IsDryRun(request), IsReplace(request)))
            {
                return BridgeResponse.Error(409, "another road operation is in progress, retry shortly");
            }
            // Completed asynchronously by BridgeRoadToolSystem over the next tool frames.
            return null;
        }

        /// <summary>
        /// Snap like the road tool: the nearest junction of a compatible network
        /// within the snap distance, else the nearest compatible segment (split
        /// there, or its end node when the point is at an end), else a free point
        /// on the terrain. Compatible = the networks' layers can connect (so a
        /// track never joins a road).
        /// </summary>
        /// <summary>
        /// Direction the new segment should leave an end in: along the split road's tangent, or
        /// continuing a dead-end node's edge, oriented toward the other end; straight otherwise.
        /// </summary>
        private float2 SmoothEndDirection(BridgeRoadToolSystem.BuildEnd end, float2 toward)
        {
            float2 straight = math.normalizesafe(toward);
            if (end.Entity == Entity.Null)
            {
                return straight;
            }
            if (EntityManager.HasComponent<Edge>(end.Entity) && EntityManager.HasComponent<Curve>(end.Entity))
            {
                float2 tangent = math.normalizesafe(MathUtils.Tangent(EntityManager.GetComponentData<Curve>(end.Entity).m_Bezier, end.Split).xz);
                if (math.lengthsq(tangent) == 0f)
                {
                    return straight;
                }
                return math.dot(tangent, straight) >= 0f ? tangent : -tangent;
            }
            if (TryGetOutwardDirection(end.Entity, out float2 outward) && math.dot(outward, straight) > 0f)
            {
                return outward;
            }
            return straight;
        }

        /// <summary>
        /// How far (m) a snap candidate may sit above or below the requested end height
        /// (terrain + e1/e2) and still be joined.
        /// </summary>
        private const float SnapHeightTolerance = 4f;

        private BridgeRoadToolSystem.BuildEnd ResolveBuildEnd(float2 point, float snap, NetData netData, ref TerrainHeightData heightData, float? elevation = null)
        {
            Entity bestNode = Entity.Null;
            float bestNodeDistance = snap;
            Entity bestEdge = Entity.Null;
            float bestEdgeDistance = snap;
            float bestT = 0f;
            // With an explicit elevation, only networks near that height can be joined.
            float? targetHeight = elevation.HasValue
                ? TerrainUtils.SampleHeight(ref heightData, new float3(point.x, 0f, point.y)) + elevation.Value
                : (float?)null;
            using (NativeArray<Entity> edges = NetEdgeQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity edge in edges)
                {
                    Entity edgePrefab = EntityManager.GetComponentData<PrefabRef>(edge).m_Prefab;
                    if (!EntityManager.HasComponent<NetData>(edgePrefab))
                    {
                        continue;
                    }
                    NetData other = EntityManager.GetComponentData<NetData>(edgePrefab);
                    if ((netData.m_ConnectLayers & other.m_RequiredLayers) == 0 && (other.m_ConnectLayers & netData.m_RequiredLayers) == 0)
                    {
                        continue;
                    }
                    Bezier4x3 curve = EntityManager.GetComponentData<Curve>(edge).m_Bezier;
                    float2 min = math.min(math.min(curve.a.xz, curve.b.xz), math.min(curve.c.xz, curve.d.xz));
                    float2 max = math.max(math.max(curve.a.xz, curve.b.xz), math.max(curve.c.xz, curve.d.xz));
                    if (math.any(point < min - snap) || math.any(point > max + snap))
                    {
                        continue;
                    }
                    Edge ends = EntityManager.GetComponentData<Edge>(edge);
                    foreach (Entity node in new[] { ends.m_Start, ends.m_End })
                    {
                        float3 nodePosition = EntityManager.GetComponentData<Node>(node).m_Position;
                        if (targetHeight.HasValue && math.abs(nodePosition.y - targetHeight.Value) > SnapHeightTolerance)
                        {
                            continue;
                        }
                        float nodeDistance = math.distance(nodePosition.xz, point);
                        if (nodeDistance < bestNodeDistance)
                        {
                            bestNodeDistance = nodeDistance;
                            bestNode = node;
                        }
                    }
                    float edgeDistance = MathUtils.Distance(curve.xz, point, out float t);
                    if (targetHeight.HasValue && math.abs(MathUtils.Position(curve, t).y - targetHeight.Value) > SnapHeightTolerance)
                    {
                        continue;
                    }
                    if (edgeDistance < bestEdgeDistance)
                    {
                        bestEdgeDistance = edgeDistance;
                        bestEdge = edge;
                        bestT = t;
                    }
                }
            }

            var result = new BridgeRoadToolSystem.BuildEnd();
            if (bestNode == Entity.Null && bestEdge != Entity.Null && (bestT < 0.02f || bestT > 0.98f))
            {
                Edge ends = EntityManager.GetComponentData<Edge>(bestEdge);
                bestNode = bestT < 0.02f ? ends.m_Start : ends.m_End;
            }
            if (bestNode != Entity.Null)
            {
                result.Entity = bestNode;
                result.Position = EntityManager.GetComponentData<Node>(bestNode).m_Position;
                result.Elevation = EntityManager.HasComponent<Game.Net.Elevation>(bestNode)
                    ? math.csum(EntityManager.GetComponentData<Game.Net.Elevation>(bestNode).m_Elevation) * 0.5f
                    : 0f;
            }
            else if (bestEdge != Entity.Null)
            {
                result.Entity = bestEdge;
                result.Split = bestT;
                result.Position = MathUtils.Position(EntityManager.GetComponentData<Curve>(bestEdge).m_Bezier, bestT);
                result.Elevation = EntityManager.HasComponent<Game.Net.Elevation>(bestEdge)
                    ? math.csum(EntityManager.GetComponentData<Game.Net.Elevation>(bestEdge).m_Elevation) * 0.5f
                    : 0f;
            }
            else
            {
                result.Position = new float3(point.x, 0f, point.y);
                result.Position.y = TerrainUtils.SampleHeight(ref heightData, result.Position);
            }
            return result;
        }

        private BridgeResponse ReplaceRoad(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("prefab", out string prefabName) || string.IsNullOrEmpty(prefabName))
            {
                return BridgeResponse.Error(400, "provide ?prefab=<road prefab name> (see cs2_find_prefabs category road)");
            }
            if (!request.Query.TryGetValue("roads", out string rawRoads) || string.IsNullOrEmpty(rawRoads))
            {
                return BridgeResponse.Error(400,
                    "provide ?roads=<list separated by ';'>, each 'index:version' of a road segment from cs2_list_roads");
            }
            string[] items = rawRoads.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            if (items.Length > 50)
            {
                return BridgeResponse.Error(400, "too many segments in one replacement (max 50)");
            }

            var edges = new List<Entity>();
            for (int i = 0; i < items.Length; i++)
            {
                string item = items[i].Trim();
                if (!TryParseEntityRef(item, out Entity edge) || !EntityManager.Exists(edge)
                    || !EntityManager.HasComponent<Edge>(edge) || !EntityManager.HasComponent<Curve>(edge)
                    || !EntityManager.HasComponent<Composition>(edge))
                {
                    return BridgeResponse.Error(404, $"segment #{i + 1} ('{item}') is not an existing road segment (use index:version from cs2_list_roads)");
                }
                if (EntityManager.HasComponent<Temp>(edge) || EntityManager.HasComponent<Deleted>(edge))
                {
                    return BridgeResponse.Error(409, $"segment #{i + 1} ('{item}') is being modified; retry shortly");
                }
                if (EntityManager.HasComponent<Owner>(edge))
                {
                    return BridgeResponse.Error(409,
                        $"segment #{i + 1} ('{item}') belongs to a building or asset (e.g. an interchange); replace the owner instead");
                }
                if (!edges.Contains(edge))
                {
                    edges.Add(edge);
                }
            }

            if (!TryFindPrefabByName(RoadPrefabQuery, prefabName, out Entity prefabEntity, out PrefabBase prefab))
            {
                return BridgeResponse.Error(404, $"no road prefab named '{prefabName}' (see cs2_find_prefabs category road)");
            }
            if (IsLocked(prefabEntity) && !IsForced(request))
            {
                return BridgeResponse.Error(409, $"road prefab '{prefab.name}' is locked (milestone not reached); pass force=true to use it anyway");
            }
            bool invert = request.TryGetBool("invert", out bool rawInvert) && rawInvert;
            if (TransitToolsBusy(out error))
            {
                return error;
            }

            BridgeRoadToolSystem tool = World.GetOrCreateSystemManaged<BridgeRoadToolSystem>();
            if (!tool.TryQueueReplace(edges.ToArray(), prefabEntity, prefab, invert, request, IsDryRun(request)))
            {
                return BridgeResponse.Error(409, "another road operation is in progress, retry shortly");
            }
            // Completed asynchronously by BridgeRoadToolSystem over the next tool frames.
            return null;
        }
    }
}
