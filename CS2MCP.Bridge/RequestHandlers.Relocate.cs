using Game.Prefabs;
using Game.Simulation;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Relocation of existing buildings and objects without demolishing and rebuilding them:
    /// the same operation as the selected-info panel's Relocate button, run through
    /// BridgeToolSystem's Move operation (the game's own object definition job).
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private BridgeResponse MoveObject(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            Entity entity;
            if (request.Query.TryGetValue("entity", out string rawEntity) && !string.IsNullOrEmpty(rawEntity))
            {
                if (!TryParseEntityRef(rawEntity, out entity))
                {
                    return BridgeResponse.Error(400, "entity must be '<index>:<version>'");
                }
            }
            else if (request.TryGetInt("index", out int index) && request.TryGetInt("version", out int version))
            {
                entity = new Entity { Index = index, Version = version };
            }
            else
            {
                return BridgeResponse.Error(400, "provide ?index=&version= (or entity=<index>:<version>) of the building to relocate");
            }
            if (!EntityManager.Exists(entity) || !EntityManager.HasComponent<Game.Objects.Transform>(entity)
                || !EntityManager.HasComponent<PrefabRef>(entity))
            {
                return BridgeResponse.Error(404, $"entity {entity.Index}:{entity.Version} does not exist or is not a placed object (stale id?)");
            }
            if (EntityManager.HasComponent<Game.Common.Deleted>(entity) || EntityManager.HasComponent<Game.Tools.Temp>(entity))
            {
                return BridgeResponse.Error(409, "entity is being deleted or is a tool preview");
            }
            string notMoveable = WhyNotMoveable(entity);
            if (notMoveable != null)
            {
                return BridgeResponse.Error(409, $"the game does not allow relocating this object: {notMoveable}");
            }

            Game.Objects.Transform current = EntityManager.GetComponentData<Game.Objects.Transform>(entity);
            bool hasX = request.TryGetFloat("x", out float x);
            bool hasZ = request.TryGetFloat("z", out float z);
            bool hasDx = request.TryGetFloat("dx", out float dx);
            bool hasDz = request.TryGetFloat("dz", out float dz);
            bool hasRotation = request.TryGetFloat("rotation", out float rotationDegrees);
            if ((hasX != hasZ) || ((hasX || hasZ) && (hasDx || hasDz)))
            {
                return BridgeResponse.Error(400, "give either x and z (new position) or dx/dz (offset), not a mix");
            }
            if (!hasX && !hasDx && !hasDz && !hasRotation)
            {
                return BridgeResponse.Error(400, "provide a new position (x,z), an offset (dx,dz) and/or a rotation in degrees");
            }

            float3 position = current.m_Position;
            if (hasX)
            {
                position.x = x;
                position.z = z;
            }
            else
            {
                position.x += hasDx ? dx : 0f;
                position.z += hasDz ? dz : 0f;
            }
            if (request.TryGetFloat("y", out float y))
            {
                position.y = y;
            }
            else if (hasX || hasDx || hasDz)
            {
                TerrainHeightData heightData = World.GetOrCreateSystemManaged<TerrainSystem>().GetHeightData();
                position.y = TerrainUtils.SampleHeight(ref heightData, position);
            }
            quaternion rotation = hasRotation ? quaternion.RotateY(math.radians(rotationDegrees)) : current.m_Rotation;
            bool dryRun = request.TryGetBool("dryRun", out bool rawDryRun) && rawDryRun;

            BridgeToolSystem tool = World.GetOrCreateSystemManaged<BridgeToolSystem>();
            if (!tool.TryQueueMove(entity, PrefabNameOf(entity), position, rotation, dryRun, request))
            {
                return BridgeResponse.Error(409, "another build operation is in progress, retry shortly");
            }
            // Completed asynchronously by BridgeToolSystem over the next tool frames.
            return null;
        }

        /// <summary>
        /// Null when the object may be relocated. Same rule as Game.UI.InGame.ActionsSection's
        /// 'moveable' flag (the Relocate button): static, non-native objects; buildings must not be
        /// water-powered, must be top-level or a service upgrade, and must not be growables
        /// (signature buildings excepted); other objects must be top-level and not outside connections.
        /// </summary>
        private string WhyNotMoveable(Entity entity)
        {
            if (!EntityManager.HasComponent<Game.Objects.Object>(entity) || !EntityManager.HasComponent<Game.Objects.Static>(entity))
            {
                return "not a static object";
            }
            if (EntityManager.HasComponent<Game.Common.Native>(entity))
            {
                return "it is part of the original map";
            }
            Entity prefab = EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab;
            bool hasOwner = EntityManager.HasComponent<Game.Common.Owner>(entity);
            if (EntityManager.HasComponent<Game.Buildings.Building>(entity))
            {
                if (EntityManager.HasComponent<Game.Buildings.WaterPowered>(entity))
                {
                    return "hydroelectric (water-powered) buildings cannot be relocated";
                }
                if (hasOwner && !EntityManager.HasComponent<Game.Buildings.ServiceUpgrade>(entity))
                {
                    return "it is part of another building; relocate the main building instead";
                }
                if (EntityManager.HasComponent<SpawnableBuildingData>(prefab) && !EntityManager.HasComponent<SignatureBuildingData>(prefab))
                {
                    return "zoned (growable) buildings cannot be relocated; only service, signature and other ploppable buildings can";
                }
                return null;
            }
            if (hasOwner)
            {
                return "it is part of another object";
            }
            if (EntityManager.HasComponent<Game.Objects.OutsideConnection>(entity))
            {
                return "outside connections cannot be relocated";
            }
            return null;
        }
    }
}
