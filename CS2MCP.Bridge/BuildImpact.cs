using System;
using System.Collections.Generic;
using System.Text;
using Colossal.Mathematics;
using Game.Common;
using Game.Notifications;
using Game.Prefabs;
using Game.Tools;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;
using Transform = Game.Objects.Transform;

namespace CS2MCP
{
    /// <summary>One entity a build preview would delete, hide or is blocked by.</summary>
    internal sealed class ImpactEntry
    {
        public Entity Entity;
        public string Prefab;
        public string Kind;
        public float X;
        public float Z;
        public bool HasPosition;
        public readonly List<string> ErrorTypes = new List<string>();
        /// <summary>Why a blocker may not be demolished by replace=true (null = it may).</summary>
        public string NotReplaceable;

        public object ToJson()
        {
            return new
            {
                entity = Entity != Entity.Null ? new { index = Entity.Index, version = Entity.Version } : null,
                prefab = Prefab,
                kind = Kind,
                position = HasPosition ? new { x = X, z = Z } : null,
                error = ErrorTypes.Count > 0 ? string.Join(",", ErrorTypes) : null,
            };
        }

        public object ToJson(string how)
        {
            return new
            {
                entity = Entity != Entity.Null ? new { index = Entity.Index, version = Entity.Version } : null,
                prefab = Prefab,
                kind = Kind,
                position = HasPosition ? new { x = X, z = Z } : null,
                how,
            };
        }

        public string Describe()
        {
            var text = new StringBuilder();
            text.Append(Kind);
            if (!string.IsNullOrEmpty(Prefab))
            {
                text.Append(" '").Append(Prefab).Append('\'');
            }
            if (Entity != Entity.Null)
            {
                text.Append(" (").Append(Entity.Index).Append(':').Append(Entity.Version).Append(')');
            }
            if (HasPosition)
            {
                text.Append(" at (").Append(math.round(X)).Append(", ").Append(math.round(Z)).Append(')');
            }
            if (ErrorTypes.Count > 0)
            {
                text.Append(" [").Append(string.Join(",", ErrorTypes)).Append(']');
            }
            return text.ToString();
        }
    }

    /// <summary>
    /// What a validated build preview does to the existing world, read from the validation
    /// results the game leaves on entities (Game.Tools.ValidationSystem.ProcessError):
    ///   Warning  on a permanent entity = overlapped overridable+deletable building, deleted on apply
    ///            (ToolApplySystem adds Deleted); this is how zoned growables get replaced.
    ///   Error    on the temp preview and on the permanent entity it collides with; blocks the apply.
    ///   Override on overlapped trees/props: hidden on apply, not deleted.
    /// The Error component does not store the error type. ValidationSystem also adds a notification
    /// icon (Owner = temp entity, Target = permanent entity, prefab = ToolErrorData(type)); that is
    /// where the types are read from. Must run on the simulation thread after validation ran.
    /// </summary>
    internal sealed class BuildImpact
    {
        public readonly List<ImpactEntry> WillDemolish = new List<ImpactEntry>();
        public readonly List<ImpactEntry> BlockedBy = new List<ImpactEntry>();
        public int Hidden;
        /// <summary>Errors whose type or cause could not be read from the icons.</summary>
        public int Unresolved;

        private struct IconInfo
        {
            public Entity Owner;
            public Entity Target;
            public string Type;
            public IconPriority Priority;
            public float3 Location;
        }

        public bool HasBlockers => BlockedBy.Count > 0 || Unresolved > 0;

        public static BuildImpact Collect(EntityManager em, PrefabSystem prefabSystem)
        {
            var impact = new BuildImpact();

            var icons = new List<IconInfo>();
            EntityQuery iconQuery = em.CreateEntityQuery(
                ComponentType.ReadOnly<Icon>(), ComponentType.ReadOnly<Owner>(), ComponentType.ReadOnly<PrefabRef>(),
                ComponentType.Exclude<Deleted>());
            using (NativeArray<Entity> iconEntities = iconQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity icon in iconEntities)
                {
                    Entity owner = em.GetComponentData<Owner>(icon).m_Owner;
                    if (!em.Exists(owner) || !em.HasComponent<Temp>(owner))
                    {
                        continue;
                    }
                    Entity prefab = em.GetComponentData<PrefabRef>(icon).m_Prefab;
                    if (!em.HasComponent<ToolErrorData>(prefab))
                    {
                        continue;
                    }
                    icons.Add(new IconInfo
                    {
                        Owner = owner,
                        Target = em.HasComponent<Target>(icon) ? em.GetComponentData<Target>(icon).m_Target : Entity.Null,
                        Type = em.GetComponentData<ToolErrorData>(prefab).m_Error.ToString(),
                        Priority = em.GetComponentData<Icon>(icon).m_Priority,
                        Location = em.GetComponentData<Icon>(icon).m_Location,
                    });
                }
            }

            // Overlapped overridable buildings: deleted when the preview is applied.
            EntityQuery warningQuery = em.CreateEntityQuery(
                ComponentType.ReadOnly<Warning>(), ComponentType.Exclude<Temp>(), ComponentType.Exclude<Deleted>());
            using (NativeArray<Entity> warned = warningQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in warned)
                {
                    impact.WillDemolish.Add(Describe(em, prefabSystem, entity, float3.zero));
                }
            }

            EntityQuery overrideQuery = em.CreateEntityQuery(ComponentType.ReadOnly<Override>(), ComponentType.Exclude<Deleted>());
            impact.Hidden = overrideQuery.CalculateEntityCount();

            EntityQuery errorQuery = em.CreateEntityQuery(ComponentType.ReadOnly<Error>(), ComponentType.Exclude<Deleted>());
            var byEntity = new Dictionary<Entity, ImpactEntry>();
            var previewKeys = new HashSet<string>();
            using (NativeArray<Entity> errors = errorQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in errors)
                {
                    if (em.HasComponent<Temp>(entity))
                    {
                        // A preview entity with an error: what it collides with, or the bare error.
                        bool explained = false;
                        foreach (IconInfo icon in icons)
                        {
                            if (icon.Owner != entity || icon.Priority < IconPriority.Error)
                            {
                                continue;
                            }
                            explained = true;
                            if (icon.Target != Entity.Null && em.Exists(icon.Target) && !em.HasComponent<Temp>(icon.Target))
                            {
                                AddBlocker(em, prefabSystem, impact, byEntity, icon.Target, icon.Type, icon.Location);
                            }
                            else
                            {
                                string key = icon.Type + "@" + (int)math.round(icon.Location.x) + "," + (int)math.round(icon.Location.z);
                                if (previewKeys.Add(key))
                                {
                                    var entry = new ImpactEntry { Kind = "preview", Entity = Entity.Null };
                                    entry.ErrorTypes.Add(icon.Type);
                                    SetPosition(entry, icon.Location);
                                    impact.BlockedBy.Add(entry);
                                }
                            }
                        }
                        if (!explained)
                        {
                            impact.Unresolved++;
                        }
                        continue;
                    }

                    string type = null;
                    foreach (IconInfo icon in icons)
                    {
                        if (icon.Target == entity && icon.Priority >= IconPriority.Error)
                        {
                            type = icon.Type;
                            AddBlocker(em, prefabSystem, impact, byEntity, entity, type, icon.Location);
                        }
                    }
                    if (type == null)
                    {
                        AddBlocker(em, prefabSystem, impact, byEntity, entity, null, float3.zero);
                        impact.Unresolved++;
                    }
                }
            }

            foreach (ImpactEntry entry in impact.BlockedBy)
            {
                if (entry.Entity != Entity.Null)
                {
                    entry.NotReplaceable = ReplaceBlocker(em, entry);
                }
                else
                {
                    entry.NotReplaceable = "the preview itself is invalid here (" + string.Join(",", entry.ErrorTypes) + ")";
                }
            }
            return impact;
        }

        /// <summary>
        /// True when every blocker is an overlap with a building that replace=true may demolish and
        /// nothing else is wrong with the preview.
        /// </summary>
        public bool CanReplace
        {
            get
            {
                if (BlockedBy.Count == 0 || Unresolved > 0)
                {
                    return false;
                }
                foreach (ImpactEntry entry in BlockedBy)
                {
                    if (entry.NotReplaceable != null)
                    {
                        return false;
                    }
                }
                return true;
            }
        }

        public List<Entity> ReplaceTargets()
        {
            var targets = new List<Entity>();
            foreach (ImpactEntry entry in BlockedBy)
            {
                if (entry.Entity != Entity.Null && !targets.Contains(entry.Entity))
                {
                    targets.Add(entry.Entity);
                }
            }
            return targets;
        }

        public object WillDemolishJson() => WillDemolish.ConvertAll(e => e.ToJson());

        public object BlockedByJson() => BlockedBy.ConvertAll(e => e.ToJson());

        /// <summary>
        /// replacePlan for a refused/probed build: what replace=true would demolish and, when it
        /// cannot, why not and what the agent has to do by hand.
        /// </summary>
        public object ReplacePlanJson(bool performed = false)
        {
            var demolish = new List<object>();
            var refuse = new List<object>();
            foreach (ImpactEntry entry in BlockedBy)
            {
                if (entry.NotReplaceable == null)
                {
                    demolish.Add(entry.ToJson());
                }
                else
                {
                    refuse.Add(new { blocker = entry.ToJson(), reason = entry.NotReplaceable });
                }
            }
            bool possible = CanReplace;
            return new
            {
                possible,
                wouldDemolish = demolish,
                cannotReplace = refuse,
                unresolvedErrors = Unresolved,
                note = performed ? "these blockers were demolished by replace=true"
                    : possible
                        ? "replace=true demolishes exactly these buildings (through the bulldoze pipeline) and then builds"
                        : "replace=true will NOT demolish anything here: something other than a plain overlap with a demolishable building " +
                          "is wrong. cs2_demolish the listed buildings yourself (dryRun first) and retry, or pick another spot",
            };
        }

        /// <summary>Short human sentence for a 409.</summary>
        public string Summary()
        {
            var parts = new List<string>();
            for (int i = 0; i < BlockedBy.Count && i < 5; i++)
            {
                parts.Add(BlockedBy[i].Describe());
            }
            string text = string.Join("; ", parts);
            if (BlockedBy.Count > 5)
            {
                text += $"; +{BlockedBy.Count - 5} more";
            }
            if (Unresolved > 0)
            {
                text += (text.Length > 0 ? "; " : "") + $"{Unresolved} validation error(s) of unknown type";
            }
            return text;
        }

        /// <summary>The standard 409 for a build the game's validation refuses, with blockedBy attached.</summary>
        public BridgeResponse RejectionResponse(string what, bool noPreview = false)
        {
            string message = HasBlockers
                ? $"{what} blocked by: {Summary()}. Nothing was changed"
                : $"{what} refused by game validation (no specific blocker could be read" + (noPreview ? "; no preview was produced" : "") + "). Nothing was changed";
            var extra = new Dictionary<string, object>
            {
                ["blockedBy"] = BlockedByJson(),
                ["willDemolish"] = WillDemolishJson(),
                ["hidden"] = Hidden,
                ["replacePlan"] = ReplacePlanJson(),
                ["note"] = "service, signature and player-placed buildings, burning buildings, water and steep terrain block; " +
                           "zoned growables are demolished automatically and trees/props are hidden. " +
                           "Move the build, cs2_demolish the blockers, or pass replace=true where supported",
            };
            return BridgeResponse.ErrorWith(409, message, extra);
        }

        private static void AddBlocker(EntityManager em, PrefabSystem prefabSystem, BuildImpact impact,
            Dictionary<Entity, ImpactEntry> byEntity, Entity entity, string type, float3 location)
        {
            if (!byEntity.TryGetValue(entity, out ImpactEntry entry))
            {
                entry = Describe(em, prefabSystem, entity, location);
                byEntity[entity] = entry;
                impact.BlockedBy.Add(entry);
            }
            if (type != null && !entry.ErrorTypes.Contains(type))
            {
                entry.ErrorTypes.Add(type);
            }
        }

        private static string ReplaceBlocker(EntityManager em, ImpactEntry entry)
        {
            Entity entity = entry.Entity;
            if (!em.Exists(entity) || !em.HasComponent<Game.Buildings.Building>(entity))
            {
                return "not a building (" + entry.Kind + ")";
            }
            if (em.HasComponent<Native>(entity))
            {
                return "native map building";
            }
            if (em.HasComponent<Game.Net.OutsideConnection>(entity))
            {
                return "outside connection";
            }
            if (em.HasComponent<Game.Events.OnFire>(entity))
            {
                return "building is on fire";
            }
            if (em.HasComponent<Owner>(entity))
            {
                return "sub-building/upgrade of another building; demolish the main building instead";
            }
            foreach (string type in entry.ErrorTypes)
            {
                if (type != "OverlapExisting")
                {
                    return "error " + type;
                }
            }
            if (entry.ErrorTypes.Count == 0)
            {
                return "error type unknown";
            }
            return null;
        }

        private static ImpactEntry Describe(EntityManager em, PrefabSystem prefabSystem, Entity entity, float3 fallback)
        {
            var entry = new ImpactEntry { Entity = entity };
            Entity prefabEntity = em.HasComponent<PrefabRef>(entity) ? em.GetComponentData<PrefabRef>(entity).m_Prefab : Entity.Null;
            if (prefabEntity != Entity.Null)
            {
                PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(prefabEntity);
                entry.Prefab = prefab != null ? prefab.name : null;
            }

            if (em.HasComponent<Game.Buildings.Building>(entity))
            {
                bool spawnable = prefabEntity != Entity.Null && em.HasComponent<SpawnableBuildingData>(prefabEntity);
                bool signature = prefabEntity != Entity.Null && em.HasComponent<SignatureBuildingData>(prefabEntity);
                entry.Kind = em.HasComponent<Game.Net.OutsideConnection>(entity) ? "outside-connection"
                    : em.HasComponent<Native>(entity) ? (signature ? "signature" : spawnable ? "zoned" : "native")
                    : signature ? "signature"
                    : spawnable ? "zoned"
                    : em.HasComponent<Owner>(entity) ? "upgrade"
                    : prefabEntity != Entity.Null && em.HasComponent<ServiceObjectData>(prefabEntity) ? "service"
                    : "other";
                if (em.HasComponent<Game.Events.OnFire>(entity))
                {
                    entry.Kind += " (on fire)";
                }
            }
            else if (em.HasComponent<Game.Net.Edge>(entity) || em.HasComponent<Game.Net.Node>(entity))
            {
                entry.Kind = "road";
            }
            else if (em.HasComponent<Game.Objects.Tree>(entity) || em.HasComponent<Game.Objects.Plant>(entity))
            {
                entry.Kind = "tree";
            }
            else
            {
                entry.Kind = "other";
            }

            if (em.HasComponent<Transform>(entity))
            {
                float3 position = em.GetComponentData<Transform>(entity).m_Position;
                entry.X = position.x;
                entry.Z = position.z;
                entry.HasPosition = true;
            }
            else if (em.HasComponent<Game.Net.Curve>(entity))
            {
                float3 position = MathUtils.Position(em.GetComponentData<Game.Net.Curve>(entity).m_Bezier, 0.5f);
                entry.X = position.x;
                entry.Z = position.z;
                entry.HasPosition = true;
            }
            else
            {
                SetPosition(entry, fallback);
            }
            return entry;
        }

        private static void SetPosition(ImpactEntry entry, float3 position)
        {
            if (math.all(math.isfinite(position)) && !(position.x == 0f && position.z == 0f))
            {
                entry.X = position.x;
                entry.Z = position.z;
                entry.HasPosition = true;
            }
        }

        /// <summary>
        /// Adds a bulldoze definition for target, mirroring BulldozeToolSystem.AddEntity
        /// (CreationDefinition with m_Original + flags plus a NetCourse / ObjectDefinition / area nodes
        /// describing the original). The game's generate/apply systems do all related cleanup.
        /// </summary>
        public static void AddModifyDefinition(EntityManager em, EntityCommandBuffer commandBuffer, Entity target, CreationFlags flags, CompositionFlags upgrades)
        {
            Entity e = commandBuffer.CreateEntity();
            var definition = new CreationDefinition
            {
                m_Original = target,
                m_Flags = flags,
            };
            commandBuffer.AddComponent(e, default(Updated));
            if (upgrades != default(CompositionFlags))
            {
                commandBuffer.AddComponent(e, new Game.Net.Upgraded { m_Flags = upgrades });
            }

            if (em.HasComponent<Game.Net.Edge>(target))
            {
                Game.Net.Edge edge = em.GetComponentData<Game.Net.Edge>(target);
                NetCourse course = default;
                course.m_Curve = em.GetComponentData<Game.Net.Curve>(target).m_Bezier;
                course.m_Length = MathUtils.Length(course.m_Curve);
                course.m_FixedIndex = em.HasComponent<Game.Net.Fixed>(target)
                    ? em.GetComponentData<Game.Net.Fixed>(target).m_Index
                    : -1;
                course.m_StartPosition.m_Entity = edge.m_Start;
                course.m_StartPosition.m_Position = course.m_Curve.a;
                course.m_StartPosition.m_Rotation = Game.Net.NetUtils.GetNodeRotation(MathUtils.StartTangent(course.m_Curve));
                course.m_StartPosition.m_CourseDelta = 0f;
                course.m_EndPosition.m_Entity = edge.m_End;
                course.m_EndPosition.m_Position = course.m_Curve.d;
                course.m_EndPosition.m_Rotation = Game.Net.NetUtils.GetNodeRotation(MathUtils.EndTangent(course.m_Curve));
                course.m_EndPosition.m_CourseDelta = 1f;
                commandBuffer.AddComponent(e, course);
            }
            else if (em.HasComponent<Transform>(target))
            {
                Transform transform = em.GetComponentData<Transform>(target);
                var objectDefinition = new ObjectDefinition
                {
                    m_Position = transform.m_Position,
                    m_Rotation = transform.m_Rotation,
                    m_Probability = 100,
                    m_PrefabSubIndex = -1,
                    m_LocalPosition = transform.m_Position,
                    m_LocalRotation = transform.m_Rotation,
                };
                if (em.HasComponent<Game.Objects.Elevation>(target))
                {
                    Game.Objects.Elevation elevation = em.GetComponentData<Game.Objects.Elevation>(target);
                    objectDefinition.m_Elevation = elevation.m_Elevation;
                    objectDefinition.m_ParentMesh = Game.Objects.ObjectUtils.GetSubParentMesh(elevation.m_Flags);
                }
                else
                {
                    objectDefinition.m_ParentMesh = -1;
                }
                commandBuffer.AddComponent(e, objectDefinition);
            }
            else if (em.HasBuffer<Game.Areas.Node>(target))
            {
                DynamicBuffer<Game.Areas.Node> nodes = em.GetBuffer<Game.Areas.Node>(target, isReadOnly: true);
                commandBuffer.AddBuffer<Game.Areas.Node>(e).CopyFrom(nodes.AsNativeArray());
            }

            commandBuffer.AddComponent(e, definition);
        }
    }
}
