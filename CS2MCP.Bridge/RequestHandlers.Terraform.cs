using System;
using Game.Prefabs;
using Game.Simulation;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Landscaping (raise, lower, level, soften) through BridgeToolSystem's Terraform operation:
    /// the same brush definitions TerrainToolSystem creates while the player holds the mouse down.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private EntityQuery m_TerraformPrefabQuery;
        private bool m_TerraformPrefabQueryCreated;

        private EntityQuery TerraformPrefabQuery
        {
            get
            {
                if (!m_TerraformPrefabQueryCreated)
                {
                    m_TerraformPrefabQuery = EntityManager.CreateEntityQuery(
                        ComponentType.ReadOnly<PrefabData>(),
                        ComponentType.ReadOnly<TerraformingData>());
                    m_TerraformPrefabQueryCreated = true;
                }
                return m_TerraformPrefabQuery;
            }
        }

        private BridgeResponse Terraform(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("type", out string rawType) || string.IsNullOrEmpty(rawType))
            {
                return BridgeResponse.Error(400, "provide ?type=raise|lower|level|soften");
            }
            TerraformingType type;
            float sign = 1f;
            switch (rawType.Trim().ToLowerInvariant())
            {
                case "raise":
                    type = TerraformingType.Shift;
                    break;
                case "lower":
                    type = TerraformingType.Shift;
                    sign = -1f;
                    break;
                case "level":
                    type = TerraformingType.Level;
                    break;
                case "soften":
                case "smooth":
                    type = TerraformingType.Soften;
                    break;
                default:
                    return BridgeResponse.Error(400, $"unknown type '{rawType}'; use raise, lower, level or soften");
            }
            if (!request.TryGetFloat("x", out float x) || !request.TryGetFloat("z", out float z))
            {
                return BridgeResponse.Error(400, "provide ?x=&z= of the brush center");
            }
            float size = request.TryGetFloat("size", out float rawSize) ? math.clamp(rawSize, 10f, 1000f) : 100f;
            float strength = request.TryGetFloat("strength", out float rawStrength) ? math.clamp(rawStrength, 0.01f, 1f) : 0.5f;
            float seconds = request.TryGetFloat("seconds", out float rawSeconds) ? math.clamp(rawSeconds, 0.1f, 5f) : 1f;

            // Pick the height-terraforming prefab of this type (unlocked first).
            Entity prefabEntity = Entity.Null;
            PrefabBase prefab = null;
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            using (NativeArray<Entity> prefabs = TerraformPrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity candidate in prefabs)
                {
                    TerraformingData data = EntityManager.GetComponentData<TerraformingData>(candidate);
                    if (data.m_Type != type || data.m_Target != TerraformingTarget.Height)
                    {
                        continue;
                    }
                    if (prefabEntity == Entity.Null || (IsLocked(prefabEntity) && !IsLocked(candidate)))
                    {
                        prefabEntity = candidate;
                        prefab = prefabSystem.GetPrefab<PrefabBase>(candidate);
                    }
                }
            }
            if (prefabEntity == Entity.Null)
            {
                return BridgeResponse.Error(404, $"no {rawType} landscaping tool found in this game");
            }
            if (IsLocked(prefabEntity) && !IsForced(request))
            {
                return BridgeResponse.Error(409, $"landscaping tool '{prefab?.name}' is locked; pass force=true to use it anyway");
            }

            TerrainHeightData heightData = World.GetOrCreateSystemManaged<TerrainSystem>().GetHeightData();
            float3 center = new float3(x, 0f, z);
            center.y = TerrainUtils.SampleHeight(ref heightData, center);
            float3 target = center;
            if (type == TerraformingType.Level)
            {
                if (!request.TryGetFloat("height", out float height))
                {
                    return BridgeResponse.Error(400,
                        $"level needs ?height=<absolute terrain height in meters>; the ground at this point is {center.y:F1}m");
                }
                target.y = height;
            }

            // TerrainToolSystem.UpdateDefinitions scales shift/soften strength with the brush size.
            if (type == TerraformingType.Shift || type == TerraformingType.Soften)
            {
                float t = math.clamp(size / 5000f, 0f, 1f);
                strength *= math.lerp(0.4f, 1f, math.sin(t * math.PI * 0.5f));
            }
            strength *= sign;

            bool dryRun = IsDryRun(request);
            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueTerraform(prefabEntity, prefab, center, size, strength, target, seconds, dryRun, request, out string queueError))
            {
                return BridgeResponse.Error(409, queueError);
            }
            return null;
        }
    }
}
