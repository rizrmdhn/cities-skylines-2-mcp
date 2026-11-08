using Game.UI;
using Unity.Entities;

namespace CS2MCP
{
    /// <summary>
    /// Renaming buildings, districts, roads and transit lines with NameSystem.SetCustomName, the call
    /// the game's rename fields use. An empty name restores the game's default name. Road segments
    /// are renamed through their aggregate (the whole named street), as the road panel does.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private BridgeResponse RenameEntity(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            Entity entity;
            if (request.Query.TryGetValue("entity", out string raw) && !string.IsNullOrEmpty(raw))
            {
                if (!TryParseEntityRef(raw, out entity))
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
                return BridgeResponse.Error(400, "provide ?index=&version= (or entity=<index>:<version>) and name=");
            }
            if (!EntityManager.Exists(entity))
            {
                return BridgeResponse.Error(404, $"entity {entity.Index}:{entity.Version} does not exist (stale id?)");
            }
            if (!request.Query.TryGetValue("name", out string name))
            {
                return BridgeResponse.Error(400, "provide ?name= (empty to restore the default name)");
            }
            name = name.Trim();
            if (name.Length > 64)
            {
                return BridgeResponse.Error(400, "name is too long (max 64 characters)");
            }

            string kind;
            Entity target = entity;
            if (EntityManager.HasComponent<Game.Buildings.Building>(entity))
            {
                kind = "building";
            }
            else if (EntityManager.HasComponent<Game.Areas.District>(entity))
            {
                kind = "district";
            }
            else if (EntityManager.HasComponent<Game.Routes.TransportLine>(entity))
            {
                kind = "transit line";
            }
            else if (EntityManager.HasComponent<Game.Net.Aggregated>(entity))
            {
                target = EntityManager.GetComponentData<Game.Net.Aggregated>(entity).m_Aggregate;
                if (target == Entity.Null || !EntityManager.Exists(target))
                {
                    return BridgeResponse.Error(409, "this road segment is not part of a named street");
                }
                kind = "street";
            }
            else if (EntityManager.HasComponent<Game.Net.Aggregate>(entity))
            {
                kind = "street";
            }
            else
            {
                return BridgeResponse.Error(400, "only buildings, districts, streets (any of their road segments) and transit lines can be renamed");
            }
            if (EntityManager.HasComponent<Game.Common.Deleted>(target))
            {
                return BridgeResponse.Error(409, "entity is being deleted");
            }

            NameSystem names = World.GetOrCreateSystemManaged<NameSystem>();
            string previous = names.GetRenderedLabelName(target);
            World.GetOrCreateSystemManaged<BridgeTransitRenameSystem>().Enqueue(target, name, request, warning =>
            {
                if (warning != null)
                {
                    return BridgeResponse.Error(500, $"renaming failed: {warning}");
                }
                return BridgeResponse.Json(new
                {
                    renamed = true,
                    kind,
                    entity = new { index = target.Index, version = target.Version },
                    previous,
                    name = string.IsNullOrEmpty(name) ? null : name,
                    note = string.IsNullOrEmpty(name) ? "custom name removed; the game's default name is shown again" : "renamed like the game's rename field",
                });
            });
            return null;
        }
    }
}
