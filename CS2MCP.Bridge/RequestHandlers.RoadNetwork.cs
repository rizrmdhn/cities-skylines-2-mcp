using System.Collections.Generic;
using Colossal.Mathematics;
using Game.Common;
using Game.Net;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// The whole road network in one compact answer, for drawing a city map: every segment as
    /// start, middle and end point (so curves keep their shape) with its traffic flow, and the
    /// junctions that carry traffic lights, a roundabout or an outside connection. One pass over
    /// the network, unlike /city/road-graph which answers for a circle at a time. Read-only.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private const int kRoadFlagPartOfBuilding = 1;
        private const int kJunctionFlagTrafficLights = 1;
        private const int kJunctionFlagRoundabout = 2;
        private const int kJunctionFlagOutsideConnection = 4;

        private BridgeResponse GetRoadNetwork(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            bool allNets = request.Query.TryGetValue("nets", out string nets)
                && string.Equals(nets, "all", System.StringComparison.OrdinalIgnoreCase);

            var roads = new List<int[]>();
            var nodes = new HashSet<Entity>();
            using (NativeArray<Entity> edges = (allNets ? NetEdgeQuery : TrafficRoadQuery).ToEntityArray(Allocator.Temp))
            {
                foreach (Entity edge in edges)
                {
                    Bezier4x3 curve = EntityManager.GetComponentData<Curve>(edge).m_Bezier;
                    float3 middle = MathUtils.Position(curve, 0.5f);
                    int flow = -1;
                    if (EntityManager.HasComponent<Road>(edge))
                    {
                        Road road = EntityManager.GetComponentData<Road>(edge);
                        flow = (int)math.round(math.csum(NetUtils.GetTrafficFlowSpeed(road) * 100f) * 0.25f);
                    }
                    int flags = EntityManager.HasComponent<Owner>(edge) ? kRoadFlagPartOfBuilding : 0;
                    roads.Add(new[]
                    {
                        (int)math.round(curve.a.x), (int)math.round(curve.a.z),
                        (int)math.round(middle.x), (int)math.round(middle.z),
                        (int)math.round(curve.d.x), (int)math.round(curve.d.z),
                        flow, flags,
                    });
                    Edge ends = EntityManager.GetComponentData<Edge>(edge);
                    nodes.Add(ends.m_Start);
                    nodes.Add(ends.m_End);
                }
            }

            var junctions = new List<int[]>();
            foreach (Entity node in nodes)
            {
                if (!EntityManager.HasComponent<Node>(node))
                {
                    continue;
                }
                int flags = 0;
                if (EntityManager.HasComponent<TrafficLights>(node)) flags |= kJunctionFlagTrafficLights;
                if (EntityManager.HasComponent<Roundabout>(node)) flags |= kJunctionFlagRoundabout;
                if (EntityManager.HasComponent<Game.Objects.OutsideConnection>(node)) flags |= kJunctionFlagOutsideConnection;
                if (flags == 0)
                {
                    continue;
                }
                float3 position = EntityManager.GetComponentData<Node>(node).m_Position;
                junctions.Add(new[] { (int)math.round(position.x), (int)math.round(position.z), flags });
            }

            return BridgeResponse.Json(new
            {
                roadCount = roads.Count,
                junctionCount = junctions.Count,
                format = new
                {
                    road = new[] { "startX", "startZ", "middleX", "middleZ", "endX", "endZ", "flowPercent", "flags" },
                    roadFlags = new { partOfBuilding = kRoadFlagPartOfBuilding },
                    junction = new[] { "x", "z", "flags" },
                    junctionFlags = new
                    {
                        trafficLights = kJunctionFlagTrafficLights,
                        roundabout = kJunctionFlagRoundabout,
                        outsideConnection = kJunctionFlagOutsideConnection,
                    },
                },
                roads,
                junctions,
                note = "positions in whole metres (x, z); middle = the curve at its midpoint; flowPercent as in cs2_traffic, " +
                       "-1 for networks that are not roads (nets=all); only junctions with a flag are listed.",
            });
        }
    }
}
