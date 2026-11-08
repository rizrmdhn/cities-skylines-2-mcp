using System.Collections.Generic;
using Colossal.Mathematics;
using Game.Net;
using Game.Prefabs;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Open connection points of a building's own networks: the track, road, path and waterway ends
    /// that stations, depots, harbors and other buildings come with, which must be joined to the
    /// city's networks (cs2_connect_road snaps to them, smooth=true continues their direction).
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private const Layer kConnectableLayers = Layer.Road | Layer.TrainTrack | Layer.TramTrack | Layer.SubwayTrack
            | Layer.Pathway | Layer.Waterway | Layer.PublicTransportRoad;

        private static string LayerName(Layer layers)
        {
            if ((layers & Layer.TrainTrack) != 0) return "train track";
            if ((layers & Layer.SubwayTrack) != 0) return "subway track";
            if ((layers & Layer.TramTrack) != 0) return "tram track";
            if ((layers & Layer.Waterway) != 0) return "waterway";
            if ((layers & Layer.PublicTransportRoad) != 0) return "bus lane road";
            if ((layers & Layer.Road) != 0) return "road";
            if ((layers & Layer.Pathway) != 0) return "pedestrian path";
            return layers.ToString();
        }

        /// <summary>
        /// Horizontal direction in which a dead-end node's single edge would continue past the node.
        /// </summary>
        private bool TryGetOutwardDirection(Entity node, out float2 direction)
        {
            direction = default;
            if (!EntityManager.HasBuffer<ConnectedEdge>(node))
            {
                return false;
            }
            DynamicBuffer<ConnectedEdge> connected = EntityManager.GetBuffer<ConnectedEdge>(node, isReadOnly: true);
            if (connected.Length != 1)
            {
                return false;
            }
            Entity edge = connected[0].m_Edge;
            if (!EntityManager.HasComponent<Edge>(edge) || !EntityManager.HasComponent<Curve>(edge))
            {
                return false;
            }
            Edge ends = EntityManager.GetComponentData<Edge>(edge);
            Bezier4x3 curve = EntityManager.GetComponentData<Curve>(edge).m_Bezier;
            float3 tangent = ends.m_Start == node ? -MathUtils.StartTangent(curve) : MathUtils.EndTangent(curve);
            direction = math.normalizesafe(tangent.xz);
            return math.lengthsq(direction) > 0f;
        }

        private BridgeResponse ListBuildingConnections(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!TryGetUpgradableBuilding(request, out Entity building, out error))
            {
                return error;
            }

            // The building and its installed upgrades (extra platforms, terminals...) own sub-nets.
            var owners = new List<Entity> { building };
            if (EntityManager.HasBuffer<Game.Buildings.InstalledUpgrade>(building))
            {
                DynamicBuffer<Game.Buildings.InstalledUpgrade> upgrades = EntityManager.GetBuffer<Game.Buildings.InstalledUpgrade>(building, isReadOnly: true);
                for (int i = 0; i < upgrades.Length; i++)
                {
                    owners.Add(upgrades[i].m_Upgrade);
                }
            }

            var seen = new HashSet<Entity>();
            var open = new List<object>();
            var connectedCounts = new Dictionary<string, int>();
            foreach (Entity owner in owners)
            {
                if (!EntityManager.Exists(owner) || !EntityManager.HasBuffer<Game.Net.SubNet>(owner))
                {
                    continue;
                }
                DynamicBuffer<Game.Net.SubNet> subNets = EntityManager.GetBuffer<Game.Net.SubNet>(owner, isReadOnly: true);
                for (int i = 0; i < subNets.Length; i++)
                {
                    Entity edge = subNets[i].m_SubNet;
                    if (!EntityManager.HasComponent<Edge>(edge) || !EntityManager.HasComponent<PrefabRef>(edge))
                    {
                        continue;
                    }
                    Entity prefab = EntityManager.GetComponentData<PrefabRef>(edge).m_Prefab;
                    if (!EntityManager.HasComponent<NetData>(prefab))
                    {
                        continue;
                    }
                    Layer layers = EntityManager.GetComponentData<NetData>(prefab).m_RequiredLayers & kConnectableLayers;
                    if (layers == Layer.None)
                    {
                        continue;
                    }
                    Edge ends = EntityManager.GetComponentData<Edge>(edge);
                    foreach (Entity node in new[] { ends.m_Start, ends.m_End })
                    {
                        if (!seen.Add(node) || !EntityManager.HasComponent<Node>(node))
                        {
                            continue;
                        }
                        int degree = EntityManager.HasBuffer<ConnectedEdge>(node)
                            ? EntityManager.GetBuffer<ConnectedEdge>(node, isReadOnly: true).Length
                            : 0;
                        string kind = LayerName(layers);
                        if (degree != 1)
                        {
                            // Joined to something: count connections that leave the building's own networks.
                            if (degree > 1 && HasForeignEdge(node, owners))
                            {
                                connectedCounts[kind] = connectedCounts.TryGetValue(kind, out int c) ? c + 1 : 1;
                            }
                            continue;
                        }
                        float3 position = EntityManager.GetComponentData<Node>(node).m_Position;
                        float elevation = EntityManager.HasComponent<Game.Net.Elevation>(node)
                            ? math.csum(EntityManager.GetComponentData<Game.Net.Elevation>(node).m_Elevation) * 0.5f
                            : 0f;
                        bool hasDirection = TryGetOutwardDirection(node, out float2 outward);
                        open.Add(new
                        {
                            node = new { index = node.Index, version = node.Version },
                            kind,
                            network = PrefabNameOf(edge),
                            x = math.round(position.x * 10f) / 10f,
                            z = math.round(position.z * 10f) / 10f,
                            elevation = math.round(elevation * 10f) / 10f,
                            outwardDegrees = hasDirection ? (float?)math.round(math.degrees(math.atan2(outward.x, outward.y))) : null,
                            suggestedFarEnd = hasDirection
                                ? new { x = math.round(position.x + outward.x * 100f), z = math.round(position.z + outward.y * 100f) }
                                : null,
                        });
                    }
                }
            }

            return BridgeResponse.Json(new
            {
                building = new { index = building.Index, version = building.Version, prefab = PrefabNameOf(building) },
                openEnds = open,
                alreadyConnected = connectedCounts,
                note = open.Count == 0
                    ? "no open track/road ends: the building's networks are already joined (or it has none)"
                    : "join each open end with cs2_connect_road: put x1/z1 on the end (it snaps to the node) and use a network of the same kind; " +
                      "smooth=true makes the new piece leave in outwardDegrees. suggestedFarEnd is 100 m straight out.",
            });
        }

        private bool HasForeignEdge(Entity node, List<Entity> owners)
        {
            DynamicBuffer<ConnectedEdge> connected = EntityManager.GetBuffer<ConnectedEdge>(node, isReadOnly: true);
            for (int i = 0; i < connected.Length; i++)
            {
                Entity edge = connected[i].m_Edge;
                Entity owner = EntityManager.HasComponent<Game.Common.Owner>(edge)
                    ? EntityManager.GetComponentData<Game.Common.Owner>(edge).m_Owner
                    : Entity.Null;
                if (!owners.Contains(owner))
                {
                    return true;
                }
            }
            return false;
        }
    }
}
