using System;
using Colossal.Mathematics;
using Game;
using Game.City;
using Game.Common;
using Game.Net;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Unity.Collections;
using Unity.Entities;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine.Scripting;
using AgeMask = Game.Tools.AgeMask;
using Transform = Game.Objects.Transform;

namespace CS2MCP
{
    /// <summary>
    /// Headless placement tool. Activated programmatically for exactly three
    /// tool-update frames per operation:
    ///   1. CreateDefinitions — build definition entities (ported LineTool job),
    ///      applyMode=Clear lets the game generate preview Temp entities.
    ///   2. Apply — if validation passed (GetAllowApply), applyMode=Apply commits
    ///      the Temp entities to permanent ones; otherwise reject.
    ///   3. Finish — restore the previously active tool.
    /// </summary>
    public sealed partial class BridgeToolSystem : ObjectToolBaseSystem
    {
        private enum Stage
        {
            Idle,
            CreateDefinitions,
            Apply,
            Terraform,
            Finish,
        }

        private enum OperationKind
        {
            Object,
            Net,
            Demolish,
            Upgrade,
            Area,
            NodeUpgrade,
            Move,
            ServiceUpgrade,
            Terraform,
        }

        private Stage m_Stage = Stage.Idle;
        private OperationKind m_PendingKind;
        private Entity m_PendingPrefabEntity;
        private Entity m_PendingTarget;
        private PrefabBase m_PendingPrefab;
        private string m_PendingLabel;
        private float3 m_PendingPosition;
        private float3 m_PendingEnd;
        private float3 m_PendingMid;
        private bool m_PendingHasMid;
        private CompositionFlags m_PendingUpgradeFlags;
        private float3[] m_PendingAreaNodes;
        private float2 m_PendingElevations;
        private quaternion m_PendingRotation;
        private BridgeRequest m_PendingRequest;
        private ToolBaseSystem m_PreviousTool;
        private bool m_PendingDryRun;
        private Entity m_PendingOwner;
        private Transform m_PendingFrom;
        private EntityQuery m_TempQuery;
        private EntityQuery m_DefinitionQuery;
        private EntityQuery m_BrushPrefabQuery;
        private Entity m_TerraformBrush;
        private float m_TerraformSize;
        private float m_TerraformStrength;
        private float3 m_TerraformTarget;
        private int m_TerraformFramesLeft;
        private int m_TerraformFramesApplied;
        private int m_TerraformFramesBlocked;
        private const float kTerraformStep = 0.1f; // seconds of brush time per tool frame

        private CityConfigurationSystem m_CityConfigurationSystem;

        public override string toolID => "CS2MCP.Bridge";

        public bool IsBusy => m_Stage != Stage.Idle;

        [Preserve]
        protected override void OnCreate()
        {
            base.OnCreate();
            m_CityConfigurationSystem = base.World.GetOrCreateSystemManaged<CityConfigurationSystem>();
            m_TempQuery = GetEntityQuery(ComponentType.ReadOnly<Temp>(), ComponentType.Exclude<Deleted>());
            m_DefinitionQuery = GetDefinitionQuery();
            m_BrushPrefabQuery = GetBrushQuery();
        }

        public override PrefabBase GetPrefab()
        {
            return m_PendingPrefab;
        }

        public override bool TrySetPrefab(PrefabBase prefab)
        {
            // Never let the game UI select this tool via asset selection.
            return false;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueuePlacement(Entity prefabEntity, PrefabBase prefab, float3 position, quaternion rotation, BridgeRequest request, bool dryRun = false)
        {
            if (BridgeTools.AnyBusy(World))
            {
                return false;
            }
            m_PendingDryRun = dryRun;
            m_PendingKind = OperationKind.Object;
            m_PendingPrefabEntity = prefabEntity;
            m_PendingPrefab = prefab;
            m_PendingPosition = position;
            m_PendingRotation = rotation;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueueRoad(Entity prefabEntity, PrefabBase prefab, float3 start, float3 end, float3 mid, bool hasMid, float2 elevations, BridgeRequest request, bool dryRun = false)
        {
            if (BridgeTools.AnyBusy(World))
            {
                return false;
            }
            m_PendingDryRun = dryRun;
            m_PendingKind = OperationKind.Net;
            m_PendingPrefabEntity = prefabEntity;
            m_PendingPrefab = prefab;
            m_PendingPosition = start;
            m_PendingEnd = end;
            m_PendingMid = mid;
            m_PendingHasMid = hasMid;
            m_PendingElevations = elevations;
            m_PendingRotation = quaternion.identity;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueueUpgrade(Entity target, string label, CompositionFlags upgradeFlags, BridgeRequest request, bool dryRun = false)
        {
            if (BridgeTools.AnyBusy(World))
            {
                return false;
            }
            m_PendingDryRun = dryRun;
            m_PendingKind = OperationKind.Upgrade;
            m_PendingTarget = target;
            m_PendingLabel = label;
            m_PendingUpgradeFlags = upgradeFlags;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>
        /// Must be called on the simulation thread. Replaces a junction's upgrade
        /// flags (traffic lights, all-way stop...) with finalFlags, as the game's
        /// intersection tools do.
        /// </summary>
        public bool TryQueueNodeUpgrade(Entity node, string label, CompositionFlags finalFlags, BridgeRequest request, bool dryRun = false)
        {
            if (BridgeTools.AnyBusy(World))
            {
                return false;
            }
            m_PendingDryRun = dryRun;
            m_PendingKind = OperationKind.NodeUpgrade;
            m_PendingTarget = node;
            m_PendingLabel = label;
            m_PendingUpgradeFlags = finalFlags;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueueDemolish(Entity target, string label, BridgeRequest request, bool dryRun = false)
        {
            if (BridgeTools.AnyBusy(World))
            {
                return false;
            }
            m_PendingDryRun = dryRun;
            m_PendingKind = OperationKind.Demolish;
            m_PendingTarget = target;
            m_PendingLabel = label;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>Must be called on the simulation thread.</summary>
        public bool TryQueueArea(Entity prefabEntity, PrefabBase prefab, float3[] polygonNodes, BridgeRequest request, bool dryRun = false)
        {
            if (BridgeTools.AnyBusy(World))
            {
                return false;
            }
            m_PendingDryRun = dryRun;
            m_PendingKind = OperationKind.Area;
            m_PendingPrefabEntity = prefabEntity;
            m_PendingPrefab = prefab;
            m_PendingAreaNodes = polygonNodes;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>
        /// Must be called on the simulation thread. Relocates an existing object (service building,
        /// signature building, service upgrade, prop...) like the selected-info panel's Relocate
        /// button: the game's own ObjectToolBaseSystem definition job runs with the object as
        /// original, so the building keeps its identity, upgrades, workers and vehicles.
        /// </summary>
        public bool TryQueueMove(Entity target, string label, float3 position, quaternion rotation, bool dryRun, BridgeRequest request)
        {
            if (BridgeTools.AnyBusy(World))
            {
                return false;
            }
            m_PendingKind = OperationKind.Move;
            m_PendingOwner = Entity.Null;
            m_PendingTarget = target;
            m_PendingLabel = label;
            m_PendingPrefabEntity = EntityManager.GetComponentData<PrefabRef>(target).m_Prefab;
            m_PendingPrefab = null;
            m_PendingFrom = EntityManager.GetComponentData<Transform>(target);
            m_PendingPosition = position;
            m_PendingRotation = rotation;
            m_PendingDryRun = dryRun;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>
        /// Must be called on the simulation thread. Adds a service upgrade (extension wing, parking lot,
        /// extra garage...) to an existing building the way the upgrade menu does: the game's object
        /// definition job runs with the building as owner, so the upgrade is installed on it.
        /// </summary>
        public bool TryQueueServiceUpgrade(Entity owner, Entity prefabEntity, PrefabBase prefab, float3 position, quaternion rotation, bool dryRun, BridgeRequest request)
        {
            if (BridgeTools.AnyBusy(World))
            {
                return false;
            }
            m_PendingKind = OperationKind.ServiceUpgrade;
            m_PendingOwner = owner;
            m_PendingTarget = owner;
            m_PendingPrefabEntity = prefabEntity;
            m_PendingPrefab = prefab;
            m_PendingLabel = prefab != null ? prefab.name : null;
            m_PendingPosition = position;
            m_PendingRotation = rotation;
            m_PendingDryRun = dryRun;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        /// <summary>
        /// Must be called on the simulation thread. Runs a landscaping brush (TerrainToolSystem's
        /// definition: CreationDefinition with the brush prefab + BrushDefinition with the
        /// terraforming prefab) at a point for the given brush time, one brush definition per tool
        /// frame with applyMode=Apply, as when the player holds the mouse button down.
        /// </summary>
        public bool TryQueueTerraform(Entity terraformPrefab, PrefabBase prefab, float3 center, float size, float strength,
            float3 target, float seconds, bool dryRun, BridgeRequest request, out string error)
        {
            error = null;
            if (BridgeTools.AnyBusy(World))
            {
                error = "another build operation is in progress, retry shortly";
                return false;
            }
            BrushPrefab brush = FindDefaultBrush(m_BrushPrefabQuery);
            if (brush == null)
            {
                error = "no terrain brush prefab found";
                return false;
            }
            m_PendingKind = OperationKind.Terraform;
            m_PendingPrefabEntity = terraformPrefab;
            m_PendingPrefab = prefab;
            m_PendingLabel = prefab != null ? prefab.name : null;
            m_PendingPosition = center;
            m_TerraformBrush = m_PrefabSystem.GetEntity(brush);
            m_TerraformSize = size;
            m_TerraformStrength = strength;
            m_TerraformTarget = target;
            m_TerraformFramesLeft = math.max(1, (int)math.round(seconds / kTerraformStep));
            m_TerraformFramesApplied = 0;
            m_TerraformFramesBlocked = 0;
            m_PendingDryRun = dryRun;
            m_PendingRequest = request;
            Activate();
            return true;
        }

        private void Activate()
        {
            m_Stage = Stage.CreateDefinitions;
            m_PreviousTool = BridgeTools.PreviousTool(m_ToolSystem);
            m_ToolSystem.activeTool = this;
        }

        [Preserve]
        protected override JobHandle OnUpdate(JobHandle inputDeps)
        {
            JobHandle result = inputDeps;
            try
            {
                switch (m_Stage)
                {
                    case Stage.CreateDefinitions:
                        applyMode = ApplyMode.Clear;
                        switch (m_PendingKind)
                        {
                            case OperationKind.Object:
                                CreatePlacementDefinitions();
                                break;
                            case OperationKind.Net:
                                CreateRoadDefinitions();
                                break;
                            case OperationKind.Demolish:
                                CreateModifyDefinitions(CreationFlags.Delete, default);
                                break;
                            case OperationKind.Upgrade:
                                CreateModifyDefinitions(CreationFlags.Upgrade, m_PendingUpgradeFlags);
                                break;
                            case OperationKind.Area:
                                CreateAreaDefinitions();
                                break;
                            case OperationKind.NodeUpgrade:
                                CreateNodeUpgradeDefinition();
                                break;
                            case OperationKind.Move:
                            case OperationKind.ServiceUpgrade:
                                result = CreateNativeObjectDefinitions(inputDeps);
                                break;
                            case OperationKind.Terraform:
                                CreateBrushDefinition();
                                break;
                        }
                        m_Stage = m_PendingKind == OperationKind.Terraform && !m_PendingDryRun ? Stage.Terraform : Stage.Apply;
                        break;

                    case Stage.Terraform:
                        result = DestroyDefinitions(m_DefinitionQuery, m_ToolOutputBarrier, inputDeps);
                        if (m_TerraformFramesLeft > 0)
                        {
                            if (GetAllowApply())
                            {
                                applyMode = ApplyMode.Apply;
                                m_TerraformFramesApplied++;
                            }
                            else
                            {
                                applyMode = ApplyMode.Clear;
                                m_TerraformFramesBlocked++;
                            }
                            m_TerraformFramesLeft--;
                            CreateBrushDefinition();
                        }
                        else
                        {
                            applyMode = ApplyMode.Clear;
                            CompleteTerraform();
                            m_Stage = Stage.Finish;
                        }
                        break;

                    case Stage.Apply when m_PendingKind == OperationKind.Move:
                        ApplyMove();
                        m_Stage = Stage.Finish;
                        break;

                    case Stage.Apply when m_PendingDryRun:
                    {
                        bool valid = GetAllowApply() && !m_TempQuery.IsEmptyIgnoreFilter;
                        applyMode = ApplyMode.Clear;
                        int cost = PreviewCost();
                        CompletePending(BridgeResponse.Json(new
                        {
                            dryRun = true,
                            valid,
                            operation = m_PendingKind.ToString(),
                            prefab = m_PendingPrefab != null ? m_PendingPrefab.name : m_PendingLabel,
                            cost = math.max(cost, 0),
                            refund = math.max(-cost, 0),
                            reason = valid ? null : "blocked by game validation (overlap, water, steep terrain, no money, protected entity...)",
                            note = "nothing was changed; repeat without dryRun to apply",
                        }));
                        m_Stage = Stage.Finish;
                        break;
                    }

                    case Stage.Apply when m_PendingKind == OperationKind.ServiceUpgrade:
                    {
                        bool valid = GetAllowApply() && !m_TempQuery.IsEmptyIgnoreFilter;
                        int cost = PreviewCost();
                        if (valid)
                        {
                            applyMode = ApplyMode.Apply;
                            CompletePending(BridgeResponse.Json(new
                            {
                                installed = true,
                                upgrade = m_PendingLabel,
                                building = new { index = m_PendingOwner.Index, version = m_PendingOwner.Version },
                                position = new { x = m_PendingPosition.x, z = m_PendingPosition.z },
                                cost = math.max(cost, 0),
                                note = "installed via the game's upgrade pipeline; check cs2_building_upgrades",
                            }));
                        }
                        else
                        {
                            applyMode = ApplyMode.Clear;
                            CompletePending(BridgeResponse.Error(409,
                                "upgrade blocked by game validation (overlap, too far from the building, not enough money, already built...); " +
                                "try another position or rotation (dryRun=true to probe)"));
                        }
                        m_Stage = Stage.Finish;
                        break;
                    }

                    case Stage.Apply:
                        // The apply systems only commit Temp entities: with no preview there is
                        // nothing to apply, so this must not report success (the dry run agrees).
                        if (GetAllowApply() && !m_TempQuery.IsEmptyIgnoreFilter)
                        {
                            applyMode = ApplyMode.Apply;
                            CompletePending(BuildSuccessResponse());
                        }
                        else if (m_TempQuery.IsEmptyIgnoreFilter)
                        {
                            applyMode = ApplyMode.Clear;
                            CompletePending(BridgeResponse.Error(409,
                                "the game produced no preview for this operation (invalid target or position); nothing was changed"));
                        }
                        else
                        {
                            applyMode = ApplyMode.Clear;
                            CompletePending(BridgeResponse.Error(409,
                                "operation blocked by game validation (overlap, water, steep terrain, protected entity...); " +
                                "try a different position or target"));
                        }
                        m_Stage = Stage.Finish;
                        break;

                    case Stage.Finish:
                        applyMode = ApplyMode.None;
                        Deactivate();
                        break;

                    default:
                        applyMode = ApplyMode.None;
                        break;
                }
            }
            catch (Exception e)
            {
                Mod.Log.Warn($"BridgeToolSystem error in stage {m_Stage}: {e}");
                CompletePending(BridgeResponse.Error(500, $"placement failed: {e.GetType().Name}: {e.Message}"));
                applyMode = ApplyMode.None;
                Deactivate();
            }
            return result;
        }

        /// <summary>
        /// Runs the game's native object definition job (the one ObjectToolSystem uses in Move and
        /// Upgrade mode): the moved object as original, or the upgraded building as owner, and a
        /// single control point at the new transform.
        /// </summary>
        private JobHandle CreateNativeObjectDefinitions(JobHandle inputDeps)
        {
            var controlPoints = new NativeList<ControlPoint>(1, Allocator.TempJob);
            controlPoints.Add(new ControlPoint
            {
                m_Position = m_PendingPosition,
                m_HitPosition = m_PendingPosition,
                m_Rotation = m_PendingRotation,
                m_HitDirection = new float3(0f, 1f, 0f),
            });
            JobHandle handle = CreateDefinitions(
                objectPrefab: m_PendingPrefabEntity,
                transformPrefab: Entity.Null,
                brushPrefab: Entity.Null,
                owner: m_PendingOwner,
                original: m_PendingKind == OperationKind.Move ? m_PendingTarget : Entity.Null,
                laneEditor: Entity.Null,
                theme: m_CityConfigurationSystem.defaultTheme,
                controlPoints: controlPoints,
                attachmentPrefab: default,
                editorMode: m_ToolSystem.actionMode.IsEditor(),
                lefthandTraffic: m_CityConfigurationSystem.leftHandTraffic,
                removing: false,
                stamping: false,
                brushSize: 0f,
                brushAngle: 0f,
                brushStrength: 0f,
                distance: 0f,
                deltaTime: 0f,
                randomSeed: RandomSeed.Next(),
                snap: Snap.Upright,
                ageMask: AgeMask.Mature,
                decorationMode: false,
                overrides: default,
                inputDeps: inputDeps);
            controlPoints.Dispose(handle);
            return handle;
        }

        /// <summary>
        /// Mirrors ObjectToolSystem.GetAllowApply in Move mode: the original must not end up deleted,
        /// a preview must exist, and no validation error may trace back to the moved object.
        /// Unlike the game, ToolSystem.ignoreErrors is not honoured.
        /// </summary>
        private void ApplyMove()
        {
            bool originalDeleted = m_OriginalDeletedSystem.GetOriginalDeletedResult(0);
            bool hasPreview = !m_TempQuery.IsEmptyIgnoreFilter;
            bool blocked = HasMovedObjectError(m_PendingTarget);
            bool valid = !originalDeleted && hasPreview && !blocked;

            if (valid && !m_PendingDryRun)
            {
                applyMode = ApplyMode.Apply;
                m_TerrainSystem.OnBuildingMoved(m_PendingTarget);
            }
            else
            {
                applyMode = ApplyMode.Clear;
            }

            float3 fromForward = math.mul(m_PendingFrom.m_Rotation, new float3(0f, 0f, 1f));
            float3 toForward = math.mul(m_PendingRotation, new float3(0f, 0f, 1f));
            var from = new
            {
                x = m_PendingFrom.m_Position.x,
                z = m_PendingFrom.m_Position.z,
                rotation = math.round(math.degrees(math.atan2(fromForward.x, fromForward.z))),
            };
            var to = new
            {
                x = m_PendingPosition.x,
                z = m_PendingPosition.z,
                rotation = math.round(math.degrees(math.atan2(toForward.x, toForward.z))),
            };
            var entity = new { index = m_PendingTarget.Index, version = m_PendingTarget.Version };

            if (!valid)
            {
                string reason = !hasPreview
                    ? "the game produced no preview for this move"
                    : originalDeleted
                        ? "the move would delete the original building"
                        : "the new spot is blocked by game validation (overlap, water, steep terrain, no road access, outside owned tiles...)";
                if (m_PendingDryRun)
                {
                    CompletePending(BridgeResponse.Json(new { dryRun = true, valid = false, prefab = m_PendingLabel, entity, from, to, reason }));
                }
                else
                {
                    CompletePending(BridgeResponse.Error(409, $"relocation refused: {reason}; try another position or rotation (dryRun=true to probe)"));
                }
                return;
            }

            int moveCost = PreviewCost();
            CompletePending(BridgeResponse.Json(new
            {
                cost = math.max(moveCost, 0),
                refund = math.max(-moveCost, 0),
                moved = !m_PendingDryRun,
                dryRun = m_PendingDryRun,
                valid = true,
                prefab = m_PendingLabel,
                entity,
                from,
                to,
                note = m_PendingDryRun
                    ? "the game accepts this move; call again without dryRun to relocate"
                    : "relocated via the game's Relocate pipeline: same entity id, upgrades, workers and vehicles kept; verify via cs2_buildings_near or cs2_screenshot",
            }));
        }

        /// <summary>TerrainToolSystem.CreateDefinitionsJob for a brush held still at one point.</summary>
        private void CreateBrushDefinition()
        {
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity e = commandBuffer.CreateEntity();
            commandBuffer.AddComponent(e, new CreationDefinition { m_Prefab = m_TerraformBrush });
            commandBuffer.AddComponent(e, new BrushDefinition
            {
                m_Tool = m_PendingPrefabEntity,
                m_Line = new Line3.Segment(m_PendingPosition, m_PendingPosition),
                m_Size = m_TerraformSize,
                m_Angle = 0f,
                m_Strength = m_TerraformStrength,
                m_Time = kTerraformStep,
                m_Target = m_TerraformTarget,
                m_Start = m_PendingPosition,
            });
            commandBuffer.AddComponent(e, default(Updated));
        }

        private void CompleteTerraform()
        {
            if (m_TerraformFramesApplied == 0)
            {
                CompletePending(BridgeResponse.Error(409,
                    "landscaping blocked by game validation (outside owned tiles, protected area...); nothing was changed"));
                return;
            }
            CompletePending(BridgeResponse.Json(new
            {
                terraformed = true,
                tool = m_PendingLabel,
                center = new { x = m_PendingPosition.x, z = m_PendingPosition.z },
                size = m_TerraformSize,
                strength = m_TerraformStrength,
                brushSeconds = m_TerraformFramesApplied * kTerraformStep,
                blockedFrames = m_TerraformFramesBlocked,
                note = "applied with the game's landscaping brush; the height map refreshes over the next frames, " +
                       "check with cs2_terrain or cs2_screenshot and repeat for a stronger effect",
            }));
        }

        /// <summary>
        /// Net cost of the current preview, summed exactly like Game.UI.Tooltip.TempCostTooltipSystem
        /// (positive = cost, negative = refund).
        /// </summary>
        private int PreviewCost()
        {
            const TempFlags counted = TempFlags.Create | TempFlags.Delete | TempFlags.Modify | TempFlags.Replace | TempFlags.Upgrade | TempFlags.RemoveCost;
            int total = 0;
            using (NativeArray<Temp> temps = m_TempQuery.ToComponentDataArray<Temp>(Allocator.Temp))
            {
                foreach (Temp temp in temps)
                {
                    if ((temp.m_Flags & counted) != 0 && (temp.m_Flags & TempFlags.Cancel) == 0)
                    {
                        total += temp.m_Cost;
                    }
                }
            }
            return total;
        }

        /// <summary>Mirrors ObjectToolSystem.HasMovedObjectError: an Error whose Temp/Owner chain leads to the moved object.</summary>
        private bool HasMovedObjectError(Entity moving)
        {
            if (m_ErrorQuery.IsEmptyIgnoreFilter)
            {
                return false;
            }
            using (NativeArray<Entity> errors = m_ErrorQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity error in errors)
                {
                    Entity entity = error;
                    for (int depth = 0; depth < 32; depth++)
                    {
                        if (entity == moving)
                        {
                            return true;
                        }
                        if (EntityManager.HasComponent<Temp>(entity))
                        {
                            Entity original = EntityManager.GetComponentData<Temp>(entity).m_Original;
                            if (original != Entity.Null)
                            {
                                entity = original;
                                continue;
                            }
                        }
                        Entity owner = EntityManager.HasComponent<Owner>(entity)
                            ? EntityManager.GetComponentData<Owner>(entity).m_Owner
                            : Entity.Null;
                        if (owner == Entity.Null)
                        {
                            break;
                        }
                        entity = owner;
                    }
                }
            }
            return false;
        }

        private BridgeResponse BuildSuccessResponse()
        {
            switch (m_PendingKind)
            {
                case OperationKind.Demolish:
                    return BridgeResponse.Json(new
                    {
                        demolished = true,
                        prefab = m_PendingLabel,
                        entity = new { index = m_PendingTarget.Index, version = m_PendingTarget.Version },
                        note = "deleted via the game's bulldoze pipeline (nodes/blocks/lanes cleaned up by the game)",
                    });
                case OperationKind.Upgrade:
                    return BridgeResponse.Json(new
                    {
                        upgraded = true,
                        prefab = m_PendingLabel,
                        entity = new { index = m_PendingTarget.Index, version = m_PendingTarget.Version },
                        note = "upgrade applied via the tool pipeline; the segment is recreated with the new composition",
                    });
                case OperationKind.NodeUpgrade:
                    return BridgeResponse.Json(new
                    {
                        upgraded = true,
                        junction = new { index = m_PendingTarget.Index, version = m_PendingTarget.Version },
                        mode = m_PendingLabel,
                        note = "junction upgrade applied via the tool pipeline",
                    });
                case OperationKind.Net:
                    return BridgeResponse.Json(new
                    {
                        placed = true,
                        prefab = m_PendingPrefab != null ? m_PendingPrefab.name : null,
                        start = new { x = m_PendingPosition.x, z = m_PendingPosition.z },
                        end = new { x = m_PendingEnd.x, z = m_PendingEnd.z },
                        note = "committed this frame; verify via /city/roads or /screenshot",
                    });
                case OperationKind.Area:
                    return BridgeResponse.Json(new
                    {
                        created = true,
                        prefab = m_PendingPrefab != null ? m_PendingPrefab.name : null,
                        nodes = m_PendingAreaNodes != null ? m_PendingAreaNodes.Length : 0,
                        note = "area committed this frame; list districts via /districts",
                    });
                default:
                    return BridgeResponse.Json(new
                    {
                        placed = true,
                        prefab = m_PendingPrefab != null ? m_PendingPrefab.name : null,
                        position = new
                        {
                            x = m_PendingPosition.x,
                            y = m_PendingPosition.y,
                            z = m_PendingPosition.z,
                        },
                        note = "committed this frame; verify via /city/buildings or /screenshot",
                    });
            }
        }

        [Preserve]
        protected override void OnStopRunning()
        {
            if (m_Stage != Stage.Idle && m_ToolSystem.activeTool != this)
            {
                // Another tool (the player's, or another bridge tool) took over mid-operation. Without this the
                // tool stayed busy forever and every build request answered "another build operation is in
                // progress" until the game restarted.
                bool mayHaveApplied = m_Stage == Stage.Finish || m_Stage == Stage.Terraform;
                CompletePending(BridgeResponse.Error(409,
                    $"{m_PendingKind} ({m_PendingLabel}) interrupted because another tool became active" +
                    (mayHaveApplied ? "; it may be partly applied, check the result before retrying" : "; nothing was applied, retry")));
                m_PreviousTool = null;
                Deactivate();
            }
            base.OnStopRunning();
        }

        private void CompletePending(BridgeResponse response)
        {
            m_PendingRequest?.Complete(response);
            m_PendingRequest = null;
        }

        private void Deactivate()
        {
            m_Stage = Stage.Idle;
            m_PendingRequest = null;
            m_PendingPrefab = null;
            m_PendingPrefabEntity = Entity.Null;
            m_PendingOwner = Entity.Null;
            m_PendingDryRun = false;
            m_TerraformFramesLeft = 0;
            if (m_ToolSystem.activeTool == this)
            {
                m_ToolSystem.activeTool = m_PreviousTool != null ? m_PreviousTool : m_DefaultToolSystem;
            }
            m_PreviousTool = null;
        }

        /// <summary>
        /// Creates a modify definition for the pending target, faithfully
        /// mirroring BulldozeToolSystem.AddEntity (CreationDefinition with
        /// m_Original + flags plus a NetCourse/ObjectDefinition describing the
        /// original). Used for Delete (bulldoze) and Upgrade (road upgrades:
        /// grass/trees/lighting...). The game's generate/apply systems handle
        /// all related cleanup/recreation — nodes, zone blocks, lanes — which a
        /// raw component edit would skip (and skipping corrupts state).
        /// </summary>
        private void CreateModifyDefinitions(CreationFlags flags, CompositionFlags upgrades)
        {
            Entity target = m_PendingTarget;
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
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

            if (EntityManager.HasComponent<Game.Net.Edge>(target))
            {
                Game.Net.Edge edge = EntityManager.GetComponentData<Game.Net.Edge>(target);
                NetCourse course = default;
                course.m_Curve = EntityManager.GetComponentData<Game.Net.Curve>(target).m_Bezier;
                course.m_Length = MathUtils.Length(course.m_Curve);
                course.m_FixedIndex = EntityManager.HasComponent<Game.Net.Fixed>(target)
                    ? EntityManager.GetComponentData<Game.Net.Fixed>(target).m_Index
                    : -1;
                course.m_StartPosition.m_Entity = edge.m_Start;
                course.m_StartPosition.m_Position = course.m_Curve.a;
                course.m_StartPosition.m_Rotation = NetUtils.GetNodeRotation(MathUtils.StartTangent(course.m_Curve));
                course.m_StartPosition.m_CourseDelta = 0f;
                course.m_EndPosition.m_Entity = edge.m_End;
                course.m_EndPosition.m_Position = course.m_Curve.d;
                course.m_EndPosition.m_Rotation = NetUtils.GetNodeRotation(MathUtils.EndTangent(course.m_Curve));
                course.m_EndPosition.m_CourseDelta = 1f;
                commandBuffer.AddComponent(e, course);
            }
            else if (EntityManager.HasComponent<Transform>(target))
            {
                Transform transform = EntityManager.GetComponentData<Transform>(target);
                var objectDefinition = new ObjectDefinition
                {
                    m_Position = transform.m_Position,
                    m_Rotation = transform.m_Rotation,
                    m_Probability = 100,
                    m_PrefabSubIndex = -1,
                    m_LocalPosition = transform.m_Position,
                    m_LocalRotation = transform.m_Rotation,
                };
                if (EntityManager.HasComponent<Game.Objects.Elevation>(target))
                {
                    Game.Objects.Elevation elevation = EntityManager.GetComponentData<Game.Objects.Elevation>(target);
                    objectDefinition.m_Elevation = elevation.m_Elevation;
                    objectDefinition.m_ParentMesh = Game.Objects.ObjectUtils.GetSubParentMesh(elevation.m_Flags);
                }
                else
                {
                    objectDefinition.m_ParentMesh = -1;
                }
                commandBuffer.AddComponent(e, objectDefinition);
            }
            else if (EntityManager.HasBuffer<Game.Areas.Node>(target))
            {
                DynamicBuffer<Game.Areas.Node> nodes = EntityManager.GetBuffer<Game.Areas.Node>(target, isReadOnly: true);
                commandBuffer.AddBuffer<Game.Areas.Node>(e).CopyFrom(nodes.AsNativeArray());
            }

            commandBuffer.AddComponent(e, definition);
        }

        /// <summary>
        /// Junction upgrade definition, mirroring NetToolSystem.CreateDefinitionsJob
        /// .CreateUpgrade for a node control point: CreationDefinition on the node
        /// (SubElevation | Align, plus Upgrade | Parent when flags change), the new
        /// Upgraded flags and a zero-length NetCourse at the node.
        /// </summary>
        private void CreateNodeUpgradeDefinition()
        {
            Entity node = m_PendingTarget;
            CompositionFlags oldFlags = EntityManager.HasComponent<Game.Net.Upgraded>(node)
                ? EntityManager.GetComponentData<Game.Net.Upgraded>(node).m_Flags
                : default;
            CompositionFlags newFlags = m_PendingUpgradeFlags;

            var definition = new CreationDefinition
            {
                m_Original = node,
                m_Prefab = EntityManager.GetComponentData<PrefabRef>(node).m_Prefab,
                m_Flags = CreationFlags.SubElevation | CreationFlags.Align,
            };
            if (newFlags != oldFlags)
            {
                definition.m_Flags |= CreationFlags.Upgrade | CreationFlags.Parent;
            }

            float3 position = EntityManager.GetComponentData<Game.Net.Node>(node).m_Position;
            float elevation = EntityManager.HasComponent<Game.Net.Elevation>(node)
                ? math.cmin(EntityManager.GetComponentData<Game.Net.Elevation>(node).m_Elevation)
                : 0f;
            NetCourse course = default;
            course.m_Curve = new Bezier4x3(position, position, position, position);
            course.m_Length = 0f;
            course.m_FixedIndex = -1;
            course.m_StartPosition = NodeCoursePos(node, position, elevation, 0f, CoursePosFlags.IsFirst);
            course.m_EndPosition = NodeCoursePos(node, position, elevation, 1f, CoursePosFlags.IsLast);

            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity e = commandBuffer.CreateEntity();
            commandBuffer.AddComponent(e, definition);
            commandBuffer.AddComponent(e, new Game.Net.Upgraded { m_Flags = newFlags });
            commandBuffer.AddComponent(e, default(Updated));
            commandBuffer.AddComponent(e, course);
        }

        private static CoursePos NodeCoursePos(Entity node, float3 position, float elevation, float delta, CoursePosFlags flags)
        {
            return new CoursePos
            {
                m_Entity = node,
                m_Position = position,
                m_Rotation = NetUtils.GetNodeRotation(float3.zero),
                m_Elevation = new float2(elevation),
                m_CourseDelta = delta,
                m_SplitPosition = 0f,
                m_Flags = flags,
                m_ParentMesh = -1,
            };
        }

        /// <summary>
        /// Creates an area definition (district/surface): CreationDefinition +
        /// polygon node buffer; elevation float.MinValue snaps nodes to terrain
        /// (mirrors the game's area definition flow).
        /// </summary>
        private void CreateAreaDefinitions()
        {
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity e = commandBuffer.CreateEntity();
            Unity.Mathematics.Random random = RandomSeed.Next().GetRandom(0);
            commandBuffer.AddComponent(e, new CreationDefinition
            {
                m_Prefab = m_PendingPrefabEntity,
                m_RandomSeed = random.NextInt(),
            });
            commandBuffer.AddComponent(e, default(Updated));
            DynamicBuffer<Game.Areas.Node> nodes = commandBuffer.AddBuffer<Game.Areas.Node>(e);
            foreach (float3 position in m_PendingAreaNodes)
            {
                nodes.Add(new Game.Areas.Node(position, float.MinValue));
            }
        }

        /// <summary>
        /// Creates a standalone straight-road course definition from the pending
        /// start to end position, terrain-following (mirrors the standalone-net
        /// branch of the game's net definition flow).
        /// </summary>
        private void CreateRoadDefinitions()
        {
            TerrainHeightData terrainHeight = m_TerrainSystem.GetHeightData();

            Curve rawCurve = default;
            if (m_PendingHasMid)
            {
                // Quadratic bezier through the mid control point, elevated to cubic.
                float3 a = m_PendingPosition;
                float3 d = m_PendingEnd;
                float3 m = m_PendingMid;
                rawCurve.m_Bezier = new Bezier4x3(a, a + (m - a) * (2f / 3f), d + (m - d) * (2f / 3f), d);
            }
            else
            {
                rawCurve.m_Bezier = NetUtils.StraightCurve(m_PendingPosition, m_PendingEnd);
            }
            Bezier4x3 adjusted = NetUtils.AdjustPosition(
                rawCurve, fixedStart: false, linearMiddle: false, fixedEnd: false, ref terrainHeight).m_Bezier;

            float e1 = m_PendingElevations.x;
            float e2 = m_PendingElevations.y;
            if (e1 != 0f || e2 != 0f)
            {
                // Lift the terrain-following curve by linearly interpolated
                // elevation; the pipeline turns nonzero course elevations into
                // bridge/elevated segments with pillars.
                adjusted.a.y += e1;
                adjusted.b.y += math.lerp(e1, e2, 1f / 3f);
                adjusted.c.y += math.lerp(e1, e2, 2f / 3f);
                adjusted.d.y += e2;
            }

            NetCourse course = default;
            course.m_Curve = adjusted;
            course.m_Elevation = new float2(math.min(e1, e2), math.max(e1, e2));
            course.m_StartPosition.m_Position = course.m_Curve.a;
            course.m_StartPosition.m_Rotation = NetUtils.GetNodeRotation(MathUtils.StartTangent(course.m_Curve));
            course.m_StartPosition.m_CourseDelta = 0f;
            course.m_StartPosition.m_ParentMesh = -1;
            course.m_StartPosition.m_Elevation = e1;
            course.m_StartPosition.m_Flags = CoursePosFlags.IsFirst | CoursePosFlags.FreeHeight;
            course.m_EndPosition.m_Position = course.m_Curve.d;
            course.m_EndPosition.m_Rotation = NetUtils.GetNodeRotation(MathUtils.EndTangent(course.m_Curve));
            course.m_EndPosition.m_CourseDelta = 1f;
            course.m_EndPosition.m_ParentMesh = -1;
            course.m_EndPosition.m_Elevation = e2;
            course.m_EndPosition.m_Flags = CoursePosFlags.IsLast | CoursePosFlags.FreeHeight;
            course.m_Length = MathUtils.Length(course.m_Curve);
            course.m_FixedIndex = -1;

            Unity.Mathematics.Random random = RandomSeed.Next().GetRandom(0);
            EntityCommandBuffer commandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            Entity entity = commandBuffer.CreateEntity();
            commandBuffer.AddComponent(entity, new CreationDefinition
            {
                m_Prefab = m_PendingPrefabEntity,
                m_RandomSeed = random.NextInt(),
            });
            commandBuffer.AddComponent(entity, default(Updated));
            commandBuffer.AddComponent(entity, course);
        }

        /// <summary>
        /// Fills and synchronously executes the ported LineTool definition job
        /// for a single object at the pending position/rotation.
        /// </summary>
        private void CreatePlacementDefinitions()
        {
            CreateDefinitions definitions = default;
            definitions.m_RandomizationEnabled = false;
            definitions.m_FixedRandomSeed = 0;
            definitions.m_EditorMode = m_ToolSystem.actionMode.IsEditor();
            definitions.m_LefthandTraffic = m_CityConfigurationSystem.leftHandTraffic;
            definitions.m_ObjectPrefab = m_PendingPrefabEntity;
            definitions.m_Theme = m_CityConfigurationSystem.defaultTheme;
            definitions.m_RandomSeed = RandomSeed.Next();
            definitions.m_AgeMask = AgeMask.Mature;
            definitions.m_ControlPoint = new ControlPoint
            {
                m_Position = m_PendingPosition,
                m_Rotation = m_PendingRotation,
            };
            definitions.m_AttachmentPrefab = default;
            definitions.m_OwnerData = GetComponentLookup<Owner>(true);
            definitions.m_TransformData = GetComponentLookup<Transform>(true);
            definitions.m_AttachedData = GetComponentLookup<Game.Objects.Attached>(true);
            definitions.m_LocalTransformCacheData = GetComponentLookup<LocalTransformCache>(true);
            definitions.m_ElevationData = GetComponentLookup<Game.Objects.Elevation>(true);
            definitions.m_BuildingData = GetComponentLookup<Game.Buildings.Building>(true);
            definitions.m_LotData = GetComponentLookup<Game.Buildings.Lot>(true);
            definitions.m_EdgeData = GetComponentLookup<Game.Net.Edge>(true);
            definitions.m_NodeData = GetComponentLookup<Game.Net.Node>(true);
            definitions.m_CurveData = GetComponentLookup<Game.Net.Curve>(true);
            definitions.m_NetElevationData = GetComponentLookup<Game.Net.Elevation>(true);
            definitions.m_OrphanData = GetComponentLookup<Game.Net.Orphan>(true);
            definitions.m_UpgradedData = GetComponentLookup<Game.Net.Upgraded>(true);
            definitions.m_CompositionData = GetComponentLookup<Game.Net.Composition>(true);
            definitions.m_AreaClearData = GetComponentLookup<Game.Areas.Clear>(true);
            definitions.m_AreaSpaceData = GetComponentLookup<Game.Areas.Space>(true);
            definitions.m_AreaLotData = GetComponentLookup<Game.Areas.Lot>(true);
            definitions.m_EditorContainerData = GetComponentLookup<Game.Tools.EditorContainer>(true);
            definitions.m_PrefabRefData = GetComponentLookup<PrefabRef>(true);
            definitions.m_PrefabNetObjectData = GetComponentLookup<NetObjectData>(true);
            definitions.m_PrefabBuildingData = GetComponentLookup<BuildingData>(true);
            definitions.m_PrefabAssetStampData = GetComponentLookup<AssetStampData>(true);
            definitions.m_PrefabBuildingExtensionData = GetComponentLookup<BuildingExtensionData>(true);
            definitions.m_PrefabSpawnableObjectData = GetComponentLookup<SpawnableObjectData>(true);
            definitions.m_PrefabObjectGeometryData = GetComponentLookup<ObjectGeometryData>(true);
            definitions.m_PrefabPlaceableObjectData = GetComponentLookup<PlaceableObjectData>(true);
            definitions.m_PrefabAreaGeometryData = GetComponentLookup<AreaGeometryData>(true);
            definitions.m_PrefabBuildingTerraformData = GetComponentLookup<BuildingTerraformData>(true);
            definitions.m_PrefabCreatureSpawnData = GetComponentLookup<CreatureSpawnData>(true);
            definitions.m_PlaceholderBuildingData = GetComponentLookup<PlaceholderBuildingData>(true);
            definitions.m_PrefabNetGeometryData = GetComponentLookup<NetGeometryData>(true);
            definitions.m_PrefabCompositionData = GetComponentLookup<NetCompositionData>(true);
            definitions.m_SubObjects = GetBufferLookup<Game.Objects.SubObject>(true);
            definitions.m_CachedNodes = GetBufferLookup<LocalNodeCache>(true);
            definitions.m_InstalledUpgrades = GetBufferLookup<Game.Buildings.InstalledUpgrade>(true);
            definitions.m_SubNets = GetBufferLookup<Game.Net.SubNet>(true);
            definitions.m_ConnectedEdges = GetBufferLookup<Game.Net.ConnectedEdge>(true);
            definitions.m_SubAreas = GetBufferLookup<Game.Areas.SubArea>(true);
            definitions.m_AreaNodes = GetBufferLookup<Game.Areas.Node>(true);
            definitions.m_AreaTriangles = GetBufferLookup<Game.Areas.Triangle>(true);
            definitions.m_PrefabSubObjects = GetBufferLookup<Game.Prefabs.SubObject>(true);
            definitions.m_PrefabSubNets = GetBufferLookup<Game.Prefabs.SubNet>(true);
            definitions.m_PrefabSubLanes = GetBufferLookup<Game.Prefabs.SubLane>(true);
            definitions.m_PrefabSubAreas = GetBufferLookup<Game.Prefabs.SubArea>(true);
            definitions.m_PrefabSubAreaNodes = GetBufferLookup<SubAreaNode>(true);
            definitions.m_PrefabPlaceholderElements = GetBufferLookup<PlaceholderObjectElement>(true);
            definitions.m_PrefabRequirementElements = GetBufferLookup<ObjectRequirementElement>(true);
            definitions.m_PrefabServiceUpgradeBuilding = GetBufferLookup<ServiceUpgradeBuilding>(true);
            definitions.m_WaterSurfaceData = m_WaterSystem.GetSurfaceData(out _);
            definitions.m_TerrainHeightData = m_TerrainSystem.GetHeightData();
            definitions.m_CommandBuffer = m_ToolOutputBarrier.CreateCommandBuffer();
            definitions.Execute();
        }
    }
}
