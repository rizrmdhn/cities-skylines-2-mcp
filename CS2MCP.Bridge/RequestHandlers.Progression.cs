using System;
using System.Collections.Generic;
using Game.City;
using Game.Prefabs;
using Game.Simulation;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Why citizens are (un)happy and how the city progresses: the city info panel's happiness
    /// factors, milestone / XP progress, and the development tree (points, nodes, purchasing).
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private EntityQuery m_HappinessFactorQuery;
        private bool m_HappinessFactorQueryCreated;
        private EntityQuery m_MilestonePrefabQuery;
        private bool m_MilestonePrefabQueryCreated;
        private EntityQuery m_DevTreeNodeQuery;
        private bool m_DevTreeNodeQueryCreated;

        private EntityQuery HappinessFactorQuery
        {
            get
            {
                if (!m_HappinessFactorQueryCreated)
                {
                    m_HappinessFactorQuery = EntityManager.CreateEntityQuery(ComponentType.ReadOnly<HappinessFactorParameterData>());
                    m_HappinessFactorQueryCreated = true;
                }
                return m_HappinessFactorQuery;
            }
        }

        private EntityQuery MilestonePrefabQuery
        {
            get
            {
                if (!m_MilestonePrefabQueryCreated)
                {
                    m_MilestonePrefabQuery = EntityManager.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<MilestoneData>());
                    m_MilestonePrefabQueryCreated = true;
                }
                return m_MilestonePrefabQuery;
            }
        }

        private EntityQuery DevTreeNodeQuery
        {
            get
            {
                if (!m_DevTreeNodeQueryCreated)
                {
                    m_DevTreeNodeQuery = EntityManager.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<DevTreeNodeData>());
                    m_DevTreeNodeQueryCreated = true;
                }
                return m_DevTreeNodeQuery;
            }
        }

        /// <summary>Same numbers as the city info panel (Game.UI.InGame.CityInfoUISystem happinessFactors).</summary>
        private BridgeResponse GetHappinessFactors()
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (HappinessFactorQuery.IsEmptyIgnoreFilter)
            {
                return BridgeResponse.Error(503, "happiness parameters are not loaded yet");
            }
            CitizenHappinessSystem happiness = World.GetOrCreateSystemManaged<CitizenHappinessSystem>();
            DynamicBuffer<HappinessFactorParameterData> parameters =
                EntityManager.GetBuffer<HappinessFactorParameterData>(HappinessFactorQuery.GetSingletonEntity(), isReadOnly: true);
            ComponentLookup<Locked> locked = m_System.ReadOnlyLookup<Locked>();

            var factors = new List<(int Value, object Item)>();
            int count = math.min((int)CitizenHappinessSystem.HappinessFactor.Count, parameters.Length);
            for (int i = 0; i < count; i++)
            {
                var factor = (CitizenHappinessSystem.HappinessFactor)i;
                float3 value = happiness.GetHappinessFactor(factor, parameters, ref locked);
                int rounded = (int)math.round(value.x);
                if (rounded == 0)
                {
                    continue;
                }
                factors.Add((rounded, new
                {
                    factor = factor.ToString(),
                    value = rounded,
                    health = math.round(value.y),
                    wellbeing = math.round(value.z),
                }));
            }
            // Most negative first: the panel shows what hurts most at the top.
            factors.Sort((a, b) => a.Value.CompareTo(b.Value));
            var items = new List<object>();
            foreach (var factor in factors)
            {
                items.Add(factor.Item);
            }

            Population population = default;
            if (TryGetCity(out Entity city, out _) && EntityManager.HasComponent<Population>(city))
            {
                population = EntityManager.GetComponentData<Population>(city);
            }
            return BridgeResponse.Json(new
            {
                averageHappiness = population.m_AverageHappiness,
                averageHealth = population.m_AverageHealth,
                factors = items,
                note = "the city info panel's happiness factors: value = effect on citizen happiness (negative hurts), " +
                       "split into health and wellbeing; zero factors are omitted. They update while the simulation runs.",
            });
        }

        private BridgeResponse GetProgression()
        {
            if (!TryGetCity(out Entity city, out BridgeResponse error))
            {
                return error;
            }
            MilestoneSystem milestones = World.GetOrCreateSystemManaged<MilestoneSystem>();
            DevTreeSystem devTree = World.GetOrCreateSystemManaged<DevTreeSystem>();
            int achieved = EntityManager.HasComponent<MilestoneLevel>(city)
                ? EntityManager.GetComponentData<MilestoneLevel>(city).m_AchievedMilestone
                : 0;
            int xp = EntityManager.HasComponent<XP>(city) ? EntityManager.GetComponentData<XP>(city).m_XP : 0;

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            object nextMilestone = null;
            using (NativeArray<Entity> entities = MilestonePrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    MilestoneData data = EntityManager.GetComponentData<MilestoneData>(entity);
                    if (data.m_Index != achieved + 1)
                    {
                        continue;
                    }
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(entity);
                    nextMilestone = new
                    {
                        index = data.m_Index,
                        name = prefab != null ? prefab.name : null,
                        xpRequired = data.m_XpRequried,
                        reward = data.m_Reward,
                        devTreePoints = data.m_DevTreePoints,
                        mapTiles = data.m_MapTiles,
                        loanLimit = data.m_LoanLimit,
                    };
                }
            }

            return BridgeResponse.Json(new
            {
                xp,
                milestone = new
                {
                    achieved,
                    currentXP = milestones.currentXP,
                    lastRequiredXP = milestones.lastRequiredXP,
                    nextRequiredXP = milestones.nextRequiredXP,
                    progressPercent = Math.Round(math.saturate(milestones.progress) * 100.0, 1),
                    next = nextMilestone,
                },
                devTreePoints = devTree.points,
                note = "XP comes from population growth and building things; each milestone unlocks buildings, " +
                       "map tiles, loans and development points. Spend points with cs2_dev_tree.",
            });
        }

        private bool IsEnabledLocked(Entity entity)
        {
            return entity != Entity.Null
                && EntityManager.HasComponent<Locked>(entity)
                && EntityManager.IsComponentEnabled<Locked>(entity);
        }

        /// <summary>DevTreeSystem.Purchase's conditions, with the reason when one fails (null = purchasable).</summary>
        private string WhyNotPurchasable(Entity node, int points)
        {
            DevTreeNodeData data = EntityManager.GetComponentData<DevTreeNodeData>(node);
            if (!IsEnabledLocked(node))
            {
                return "already purchased";
            }
            if (IsEnabledLocked(data.m_Service))
            {
                return "its service is not unlocked yet (milestone)";
            }
            if (EntityManager.HasBuffer<DevTreeNodeRequirement>(node))
            {
                DynamicBuffer<DevTreeNodeRequirement> requirements = EntityManager.GetBuffer<DevTreeNodeRequirement>(node, isReadOnly: true);
                bool any = false;
                bool met = false;
                for (int i = 0; i < requirements.Length; i++)
                {
                    if (requirements[i].m_Node == Entity.Null)
                    {
                        continue;
                    }
                    any = true;
                    if (!IsEnabledLocked(requirements[i].m_Node))
                    {
                        met = true;
                        break;
                    }
                }
                if (any && !met)
                {
                    return "a previous node in the tree must be purchased first";
                }
            }
            if (data.m_Cost > points)
            {
                return $"needs {data.m_Cost} points, {points} available";
            }
            return null;
        }

        private BridgeResponse GetDevTree(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            DevTreeSystem devTree = World.GetOrCreateSystemManaged<DevTreeSystem>();
            int points = devTree.points;
            request.Query.TryGetValue("service", out string serviceFilter);
            bool onlyAvailable = request.TryGetBool("available", out bool rawAvailable) && rawAvailable;
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();

            var byService = new SortedDictionary<string, List<object>>(StringComparer.OrdinalIgnoreCase);
            int purchased = 0;
            int purchasable = 0;
            using (NativeArray<Entity> nodes = DevTreeNodeQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity node in nodes)
                {
                    DevTreeNodeData data = EntityManager.GetComponentData<DevTreeNodeData>(node);
                    string service = data.m_Service != Entity.Null ? prefabSystem.GetPrefab<PrefabBase>(data.m_Service)?.name : null;
                    service = service ?? "General";
                    if (!string.IsNullOrEmpty(serviceFilter) && service.IndexOf(serviceFilter, StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }
                    string reason = WhyNotPurchasable(node, points);
                    bool isPurchased = reason == "already purchased";
                    if (isPurchased)
                    {
                        purchased++;
                    }
                    if (reason == null)
                    {
                        purchasable++;
                    }
                    if (onlyAvailable && reason != null)
                    {
                        continue;
                    }
                    if (!byService.TryGetValue(service, out List<object> list))
                    {
                        list = new List<object>();
                        byService[service] = list;
                    }
                    list.Add(new
                    {
                        node = prefabSystem.GetPrefab<PrefabBase>(node)?.name,
                        cost = data.m_Cost,
                        purchased = isPurchased,
                        canPurchase = reason == null,
                        reason = isPurchased || reason == null ? null : reason,
                    });
                }
            }
            return BridgeResponse.Json(new
            {
                points,
                purchased,
                purchasableNow = purchasable,
                services = byService,
                lockStalenessWarning = LockStalenessWarning,
                note = "buy a node with cs2_dev_tree_purchase; points come from milestones (cs2_progression).",
            });
        }

        private BridgeResponse PurchaseDevTreeNode(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("node", out string nodeName) || string.IsNullOrEmpty(nodeName))
            {
                return BridgeResponse.Error(400, "provide ?node=<node name from cs2_dev_tree>");
            }
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            Entity node = Entity.Null;
            using (NativeArray<Entity> nodes = DevTreeNodeQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity candidate in nodes)
                {
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(candidate);
                    if (prefab != null && string.Equals(prefab.name, nodeName, StringComparison.OrdinalIgnoreCase))
                    {
                        node = candidate;
                        break;
                    }
                }
            }
            if (node == Entity.Null)
            {
                return BridgeResponse.Error(404, $"unknown development tree node '{nodeName}' (list with cs2_dev_tree)");
            }
            DevTreeSystem devTree = World.GetOrCreateSystemManaged<DevTreeSystem>();
            int before = devTree.points;
            string reason = WhyNotPurchasable(node, before);
            if (reason != null)
            {
                return BridgeResponse.Error(409, $"cannot purchase '{nodeName}': {reason}");
            }
            // The development tree panel's own call; it re-checks every condition and unlocks at end of frame.
            devTree.Purchase(node);
            int after = devTree.points;
            if (after == before)
            {
                return BridgeResponse.Error(409, $"the game refused to purchase '{nodeName}'");
            }
            return BridgeResponse.Json(new
            {
                purchased = true,
                node = nodeName,
                cost = before - after,
                pointsLeft = after,
                note = "unlocked at the end of this frame; its buildings and upgrades become available",
            });
        }
    }
}
