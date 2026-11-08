using System;
using System.Collections.Generic;
using Game.Prefabs;
using Game.Simulation;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Service building upgrades: what a building can be upgraded with (the upgrade menu's list,
    /// from the prefab's BuildingUpgradeElement buffer) and installing one through
    /// BridgeToolSystem's ServiceUpgrade operation (the game's object definition job with the
    /// building as owner, as ObjectToolSystem does in Upgrade mode).
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private bool TryGetUpgradableBuilding(BridgeRequest request, out Entity building, out BridgeResponse error)
        {
            building = Entity.Null;
            error = null;
            if (request.Query.TryGetValue("entity", out string raw) && !string.IsNullOrEmpty(raw))
            {
                if (!TryParseEntityRef(raw, out building))
                {
                    error = BridgeResponse.Error(400, "entity must be '<index>:<version>'");
                    return false;
                }
            }
            else if (request.TryGetInt("index", out int index) && request.TryGetInt("version", out int version))
            {
                building = new Entity { Index = index, Version = version };
            }
            else
            {
                error = BridgeResponse.Error(400, "provide ?index=&version= (or entity=<index>:<version>) of the building");
                return false;
            }
            if (!EntityManager.Exists(building) || !EntityManager.HasComponent<PrefabRef>(building))
            {
                error = BridgeResponse.Error(404, $"entity {building.Index}:{building.Version} does not exist (stale id?)");
                return false;
            }
            // Same as UpgradeMenuUISystem.GetUpgradable: a stop attached to a building upgrades its parent.
            if (EntityManager.HasComponent<Game.Objects.Attached>(building))
            {
                Entity parent = EntityManager.GetComponentData<Game.Objects.Attached>(building).m_Parent;
                if (parent != Entity.Null && EntityManager.Exists(parent))
                {
                    building = parent;
                }
            }
            if (!EntityManager.HasComponent<Game.Buildings.Building>(building))
            {
                error = BridgeResponse.Error(400, "entity is not a building");
                return false;
            }
            if (EntityManager.HasComponent<Game.Common.Destroyed>(building) || EntityManager.HasComponent<Game.Common.Deleted>(building))
            {
                error = BridgeResponse.Error(409, "the building is destroyed or being deleted");
                return false;
            }
            return true;
        }

        /// <summary>UpgradeMenuUISystem.ForbidMultipleUpgrades.</summary>
        private bool ForbidsMultipleUpgrades(Entity upgradePrefab)
        {
            if (EntityManager.HasComponent<BuildingExtensionData>(upgradePrefab))
            {
                return true;
            }
            return EntityManager.HasComponent<ServiceUpgradeData>(upgradePrefab)
                && EntityManager.GetComponentData<ServiceUpgradeData>(upgradePrefab).m_ForbidMultiple;
        }

        private bool IsUpgradeInstalled(Entity building, Entity upgradePrefab)
        {
            if (!EntityManager.HasBuffer<Game.Buildings.InstalledUpgrade>(building))
            {
                return false;
            }
            DynamicBuffer<Game.Buildings.InstalledUpgrade> installed = EntityManager.GetBuffer<Game.Buildings.InstalledUpgrade>(building, isReadOnly: true);
            for (int i = 0; i < installed.Length; i++)
            {
                Entity upgrade = installed[i].m_Upgrade;
                if (EntityManager.HasComponent<PrefabRef>(upgrade) && EntityManager.GetComponentData<PrefabRef>(upgrade).m_Prefab == upgradePrefab)
                {
                    return true;
                }
            }
            return false;
        }

        private BridgeResponse ListBuildingUpgrades(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!TryGetUpgradableBuilding(request, out Entity building, out error))
            {
                return error;
            }

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            Entity buildingPrefab = EntityManager.GetComponentData<PrefabRef>(building).m_Prefab;
            var available = new List<(int Priority, object Item)>();
            if (EntityManager.HasBuffer<BuildingUpgradeElement>(buildingPrefab))
            {
                DynamicBuffer<BuildingUpgradeElement> upgrades = EntityManager.GetBuffer<BuildingUpgradeElement>(buildingPrefab, isReadOnly: true);
                for (int i = 0; i < upgrades.Length; i++)
                {
                    Entity upgrade = upgrades[i].m_Upgrade;
                    if (!EntityManager.HasComponent<UIObjectData>(upgrade))
                    {
                        continue; // the upgrade menu only lists upgrades with UI data
                    }
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(upgrade);
                    bool forbidMultiple = ForbidsMultipleUpgrades(upgrade);
                    bool built = forbidMultiple && IsUpgradeInstalled(building, upgrade);
                    bool isExtension = EntityManager.HasComponent<BuildingExtensionData>(upgrade);
                    ServiceUpgradeData upgradeData = EntityManager.HasComponent<ServiceUpgradeData>(upgrade)
                        ? EntityManager.GetComponentData<ServiceUpgradeData>(upgrade)
                        : default;
                    available.Add((EntityManager.GetComponentData<UIObjectData>(upgrade).m_Priority, new
                    {
                        prefab = prefab != null ? prefab.name : null,
                        cost = upgradeData.m_UpgradeCost,
                        xp = upgradeData.m_XPReward,
                        locked = IsLocked(upgrade),
                        built,
                        canAddMore = !built,
                        placeable = EntityManager.HasComponent<PlaceableObjectData>(upgrade),
                        placement = isExtension
                            ? "fixed spot on the building (no position needed)"
                            : "placed beside the building: pass x/z (and rotation)",
                        maxPlacementDistance = upgradeData.m_MaxPlacementDistance > 0f ? (float?)upgradeData.m_MaxPlacementDistance : null,
                    }));
                }
            }
            available.Sort((a, b) => a.Priority.CompareTo(b.Priority));

            var installedList = new List<object>();
            if (EntityManager.HasBuffer<Game.Buildings.InstalledUpgrade>(building))
            {
                DynamicBuffer<Game.Buildings.InstalledUpgrade> installed = EntityManager.GetBuffer<Game.Buildings.InstalledUpgrade>(building, isReadOnly: true);
                for (int i = 0; i < installed.Length; i++)
                {
                    Entity upgrade = installed[i].m_Upgrade;
                    if (!EntityManager.Exists(upgrade))
                    {
                        continue;
                    }
                    float3 position = EntityManager.HasComponent<Game.Objects.Transform>(upgrade)
                        ? EntityManager.GetComponentData<Game.Objects.Transform>(upgrade).m_Position
                        : float3.zero;
                    installedList.Add(new
                    {
                        entity = new { index = upgrade.Index, version = upgrade.Version },
                        prefab = PrefabNameOf(upgrade),
                        position = new { x = math.round(position.x), z = math.round(position.z) },
                    });
                }
            }

            int modules = EntityManager.HasBuffer<BuildingModule>(buildingPrefab)
                ? EntityManager.GetBuffer<BuildingModule>(buildingPrefab, isReadOnly: true).Length
                : 0;
            var items = new List<object>();
            foreach (var entry in available)
            {
                items.Add(entry.Item);
            }
            return BridgeResponse.Json(new
            {
                building = new { index = building.Index, version = building.Version, prefab = PrefabNameOf(building) },
                available = items,
                installed = installedList,
                modules = modules > 0 ? (int?)modules : null,
                lockStalenessWarning = LockStalenessWarning,
                note = "install with cs2_place_upgrade. 'built' = a one-per-building upgrade already installed. " +
                       (modules > 0 ? "This building also has modules (e.g. port areas), which are not supported yet. " : "") +
                       "Removing an upgrade = cs2_demolish on its entity.",
            });
        }

        private BridgeResponse PlaceServiceUpgrade(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!TryGetUpgradableBuilding(request, out Entity building, out error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("upgrade", out string upgradeName) || string.IsNullOrEmpty(upgradeName))
            {
                return BridgeResponse.Error(400, "provide ?upgrade=<prefab name from cs2_building_upgrades>");
            }

            Entity buildingPrefab = EntityManager.GetComponentData<PrefabRef>(building).m_Prefab;
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            Entity upgradePrefab = Entity.Null;
            PrefabBase upgradeBase = null;
            var names = new List<string>();
            if (EntityManager.HasBuffer<BuildingUpgradeElement>(buildingPrefab))
            {
                DynamicBuffer<BuildingUpgradeElement> upgrades = EntityManager.GetBuffer<BuildingUpgradeElement>(buildingPrefab, isReadOnly: true);
                for (int i = 0; i < upgrades.Length; i++)
                {
                    PrefabBase candidate = prefabSystem.GetPrefab<PrefabBase>(upgrades[i].m_Upgrade);
                    if (candidate == null || !EntityManager.HasComponent<UIObjectData>(upgrades[i].m_Upgrade))
                    {
                        continue;
                    }
                    names.Add(candidate.name);
                    if (string.Equals(candidate.name, upgradeName, StringComparison.OrdinalIgnoreCase))
                    {
                        upgradePrefab = upgrades[i].m_Upgrade;
                        upgradeBase = candidate;
                    }
                }
            }
            if (upgradePrefab == Entity.Null)
            {
                return BridgeResponse.Error(404, names.Count == 0
                    ? "this building has no upgrades"
                    : $"'{upgradeName}' is not an upgrade of this building; available: {string.Join(", ", names)}");
            }
            if (!EntityManager.HasComponent<PlaceableObjectData>(upgradePrefab))
            {
                return BridgeResponse.Error(409, $"'{upgradeBase.name}' cannot be placed with the upgrade tool in game mode");
            }
            if (IsLocked(upgradePrefab) && !IsForced(request))
            {
                return BridgeResponse.Error(409, $"upgrade '{upgradeBase.name}' is locked (milestone/development tree); pass force=true to place anyway");
            }
            if (ForbidsMultipleUpgrades(upgradePrefab) && IsUpgradeInstalled(building, upgradePrefab))
            {
                return BridgeResponse.Error(409, $"'{upgradeBase.name}' is already installed and only one is allowed");
            }

            Game.Objects.Transform owner = EntityManager.GetComponentData<Game.Objects.Transform>(building);
            float3 position;
            quaternion rotation;
            bool hasX = request.TryGetFloat("x", out float x);
            bool hasZ = request.TryGetFloat("z", out float z);
            bool hasRotation = request.TryGetFloat("rotation", out float rotationDegrees);
            if (EntityManager.HasComponent<BuildingExtensionData>(upgradePrefab) && !hasX && !hasZ)
            {
                // Extensions sit at a fixed offset of the main building.
                BuildingExtensionData extension = EntityManager.GetComponentData<BuildingExtensionData>(upgradePrefab);
                position = Game.Objects.ObjectUtils.LocalToWorld(owner, extension.m_Position);
                rotation = owner.m_Rotation;
            }
            else
            {
                if (!hasX || !hasZ)
                {
                    return BridgeResponse.Error(400,
                        $"'{upgradeBase.name}' is placed beside the building: provide ?x=&z= (and rotation in degrees); " +
                        $"the building is at x={owner.m_Position.x:F0}, z={owner.m_Position.z:F0}");
                }
                position = new float3(x, 0f, z);
                TerrainHeightData heightData = World.GetOrCreateSystemManaged<TerrainSystem>().GetHeightData();
                position.y = TerrainUtils.SampleHeight(ref heightData, position);
                rotation = hasRotation ? quaternion.RotateY(math.radians(rotationDegrees)) : owner.m_Rotation;
            }
            bool dryRun = request.TryGetBool("dryRun", out bool rawDryRun) && rawDryRun;

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueServiceUpgrade(building, upgradePrefab, upgradeBase, position, rotation, dryRun, request))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            return null;
        }
    }
}
