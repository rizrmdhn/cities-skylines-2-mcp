using System;
using System.Collections.Generic;
using Colossal.Mathematics;
using Game.Net;
using Game.Prefabs;
using Game.Simulation;
using Unity.Collections;
using Unity.Entities;
using Unity.Jobs;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Service coverage readback: how well zoned buildings are reached by healthcare, fire, police,
    /// parks, post, education, emergency shelter, welfare and telecom, where the gaps are, and which
    /// buildings provide each service.
    ///
    /// Road-based services read the same per-edge Game.Net.ServiceCoverage buffer the simulation uses
    /// (NetUtils.GetServiceCoverage at the building's road edge and curve position, as
    /// CitizenHappinessSystem does). Levels are normalized with the service infoview's own colour range
    /// (InfoviewCoverageData.m_Range). Telecom samples TelecomCoverageSystem's cell map and is judged
    /// against CitizenHappinessParameterData.m_TelecomBaseline, below which the game applies a penalty.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private const int kTelecomIndex = (int)CoverageService.Count; // pseudo-service after the road-based ones

        private EntityQuery m_InfoviewCoverageQuery;
        private bool m_InfoviewCoverageQueryCreated;
        private EntityQuery m_HappinessParameterQuery;
        private bool m_HappinessParameterQueryCreated;

        private EntityQuery InfoviewCoverageQuery
        {
            get
            {
                if (!m_InfoviewCoverageQueryCreated)
                {
                    m_InfoviewCoverageQuery = EntityManager.CreateEntityQuery(ComponentType.ReadOnly<InfoviewCoverageData>());
                    m_InfoviewCoverageQueryCreated = true;
                }
                return m_InfoviewCoverageQuery;
            }
        }

        private EntityQuery HappinessParameterQuery
        {
            get
            {
                if (!m_HappinessParameterQueryCreated)
                {
                    m_HappinessParameterQuery = EntityManager.CreateEntityQuery(ComponentType.ReadOnly<CitizenHappinessParameterData>());
                    m_HappinessParameterQueryCreated = true;
                }
                return m_HappinessParameterQuery;
            }
        }

        private static string CoverageServiceName(int index)
        {
            switch (index)
            {
                case (int)CoverageService.Healthcare: return "healthcare";
                case (int)CoverageService.FireRescue: return "fireRescue";
                case (int)CoverageService.Police: return "police";
                case (int)CoverageService.Park: return "park";
                case (int)CoverageService.PostService: return "post";
                case (int)CoverageService.Education: return "education";
                case (int)CoverageService.EmergencyShelter: return "emergencyShelter";
                case (int)CoverageService.Welfare: return "welfare";
                case kTelecomIndex: return "telecom";
                default: return "service" + index;
            }
        }

        private sealed class CoverageAccumulator
        {
            public int Buildings;
            public int Residents;
            public int Underserved;
            public int UnderservedResidents;
            public double LevelSum;
            public double RawSum;
            public readonly int[] Buckets = new int[4]; // none, low, medium, high
            public readonly Dictionary<string, int[]> ByKind = new Dictionary<string, int[]>(); // kind -> [buildings, underserved]
            public readonly Dictionary<long, GapCell> Gaps = new Dictionary<long, GapCell>();
        }

        private sealed class GapCell
        {
            public int Buildings;
            public int Residents;
            public double X;
            public double Z;
            public double LevelSum;
        }

        private BridgeResponse GetCoverage(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            int serviceCount = kTelecomIndex + 1;
            var allNames = new List<string>();
            for (int i = 0; i < serviceCount; i++)
            {
                allNames.Add(CoverageServiceName(i));
            }

            bool[] selected = new bool[serviceCount];
            if (request.Query.TryGetValue("service", out string serviceParam) && !string.IsNullOrWhiteSpace(serviceParam))
            {
                foreach (string raw in serviceParam.Split(new[] { ',', ' ' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    int index = allNames.FindIndex(n => string.Equals(n, raw.Trim(), StringComparison.OrdinalIgnoreCase));
                    if (index < 0)
                    {
                        return BridgeResponse.Error(400, $"unknown service '{raw}'; use any of: {string.Join(", ", allNames)}");
                    }
                    selected[index] = true;
                }
            }
            else
            {
                for (int i = 0; i < serviceCount; i++)
                {
                    selected[i] = true;
                }
            }

            bool hasCenter = request.TryGetFloat("x", out float cx) & request.TryGetFloat("z", out float cz);
            float radius = hasCenter && request.TryGetFloat("radius", out float rawRadius) ? math.max(rawRadius, 8f) : float.MaxValue;
            float2 center = new float2(cx, cz);
            float minLevel = request.TryGetFloat("minLevel", out float rawMinLevel) ? math.clamp(rawMinLevel, 0f, 1f) : 0.34f;
            float gapCellSize = request.TryGetFloat("cellSize", out float rawCell) ? math.clamp(rawCell, 64f, 2048f) : 256f;
            int gapLimit = request.TryGetInt("gaps", out int rawGaps) ? math.clamp(rawGaps, 0, 50) : 8;
            bool listProviders = request.TryGetBool("providers", out bool rawProviders) && rawProviders;
            int providerLimit = request.TryGetInt("limit", out int rawLimit) ? math.clamp(rawLimit, 1, 200) : 30;

            // Infoview colour ranges per road-based service: the scale the player sees in the coverage infoview.
            var ranges = new Bounds1?[(int)CoverageService.Count];
            using (NativeArray<InfoviewCoverageData> infomodes = InfoviewCoverageQuery.ToComponentDataArray<InfoviewCoverageData>(Allocator.Temp))
            {
                foreach (InfoviewCoverageData infomode in infomodes)
                {
                    int index = (int)infomode.m_Service;
                    if (index >= 0 && index < ranges.Length && ranges[index] == null && infomode.m_Range.max > infomode.m_Range.min)
                    {
                        ranges[index] = infomode.m_Range;
                    }
                }
            }

            float telecomBaseline = 0.5f;
            float neutralEducation = float.NaN;
            bool hasHappinessParameters = false;
            using (NativeArray<CitizenHappinessParameterData> parameters = HappinessParameterQuery.ToComponentDataArray<CitizenHappinessParameterData>(Allocator.Temp))
            {
                if (parameters.Length > 0)
                {
                    telecomBaseline = parameters[0].m_TelecomBaseline;
                    neutralEducation = parameters[0].m_NeutralEducation;
                    hasHappinessParameters = true;
                }
            }

            CellMapData<TelecomCoverage> telecom = default;
            bool hasTelecom = false;
            if (selected[kTelecomIndex])
            {
                telecom = World.GetOrCreateSystemManaged<TelecomCoverageSystem>().GetData(readOnly: true, out JobHandle deps);
                deps.Complete();
                hasTelecom = telecom.m_Buffer.IsCreated && telecom.m_Buffer.Length > 0;
            }

            var stats = new CoverageAccumulator[serviceCount];
            for (int i = 0; i < serviceCount; i++)
            {
                stats[i] = new CoverageAccumulator();
            }

            int consideredBuildings = 0;
            int noRoadBuildings = 0;
            var providers = new List<object>[serviceCount];
            var providerCounts = new int[serviceCount];
            // Operating districts of the providers: a provider with no district list serves the entire city.
            bool areaLimited = hasCenter && radius < float.MaxValue;
            var providerEntireCity = new bool[serviceCount];
            var providerServedDistricts = new HashSet<Entity>[serviceCount];

            using (NativeArray<Entity> buildings = PlacedBuildingQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in buildings)
                {
                    Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(entity);
                    if (hasCenter && math.distance(transform.m_Position.xz, center) > radius)
                    {
                        continue;
                    }

                    // Service providers: building prefabs carrying CoverageData (upgrade extensions skipped).
                    Entity prefabEntity = EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab;
                    if (EntityManager.HasComponent<CoverageData>(prefabEntity) && !EntityManager.HasComponent<Game.Common.Owner>(entity))
                    {
                        CoverageData data = EntityManager.GetComponentData<CoverageData>(prefabEntity);
                        int index = (int)data.m_Service;
                        if (index >= 0 && index < (int)CoverageService.Count && selected[index])
                        {
                            providerCounts[index]++;
                            if (!EntityManager.HasBuffer<Game.Areas.ServiceDistrict>(entity)
                                || EntityManager.GetBuffer<Game.Areas.ServiceDistrict>(entity, isReadOnly: true).Length == 0)
                            {
                                providerEntireCity[index] = true;
                            }
                            else
                            {
                                providerServedDistricts[index] = providerServedDistricts[index] ?? new HashSet<Entity>();
                                DynamicBuffer<Game.Areas.ServiceDistrict> served = EntityManager.GetBuffer<Game.Areas.ServiceDistrict>(entity, isReadOnly: true);
                                for (int d = 0; d < served.Length; d++)
                                {
                                    providerServedDistricts[index].Add(served[d].m_District);
                                }
                            }
                            if (listProviders)
                            {
                                providers[index] = providers[index] ?? new List<object>();
                                if (providers[index].Count < providerLimit)
                                {
                                    float range = data.m_Range;
                                    float capacity = data.m_Capacity;
                                    if (EntityManager.HasComponent<Game.Buildings.ModifiedServiceCoverage>(entity))
                                    {
                                        var modified = EntityManager.GetComponentData<Game.Buildings.ModifiedServiceCoverage>(entity);
                                        range = modified.m_Range;
                                        capacity = modified.m_Capacity;
                                    }
                                    providers[index].Add(new
                                    {
                                        entity = new { index = entity.Index, version = entity.Version },
                                        prefab = PrefabNameOf(entity),
                                        position = new { x = math.round(transform.m_Position.x), z = math.round(transform.m_Position.z) },
                                        range = math.round(range),
                                        capacity = math.round(capacity),
                                        operatingDistricts = EntityManager.HasBuffer<Game.Areas.ServiceDistrict>(entity)
                                            && EntityManager.GetBuffer<Game.Areas.ServiceDistrict>(entity, isReadOnly: true).Length > 0
                                            ? "restricted" : "entireCity",
                                    });
                                }
                            }
                        }
                    }

                    string kind = EntityManager.HasComponent<Game.Buildings.ResidentialProperty>(entity) ? "residential"
                        : EntityManager.HasComponent<Game.Buildings.CommercialProperty>(entity) ? "commercial"
                        : EntityManager.HasComponent<Game.Buildings.OfficeProperty>(entity) ? "office"
                        : EntityManager.HasComponent<Game.Buildings.IndustrialProperty>(entity) ? "industrial"
                        : null;
                    if (kind == null || EntityManager.HasComponent<Game.Buildings.Abandoned>(entity))
                    {
                        continue; // only lived/worked-in zoned buildings are judged
                    }
                    consideredBuildings++;

                    int residents = kind == "residential" ? CountResidents(entity) : 0;
                    Game.Buildings.Building building = EntityManager.GetComponentData<Game.Buildings.Building>(entity);
                    bool hasCoverageBuffer = building.m_RoadEdge != Entity.Null
                        && EntityManager.Exists(building.m_RoadEdge)
                        && EntityManager.HasBuffer<Game.Net.ServiceCoverage>(building.m_RoadEdge);
                    if (!hasCoverageBuffer)
                    {
                        noRoadBuildings++;
                    }
                    DynamicBuffer<Game.Net.ServiceCoverage> coverage = hasCoverageBuffer
                        ? EntityManager.GetBuffer<Game.Net.ServiceCoverage>(building.m_RoadEdge, isReadOnly: true)
                        : default;

                    for (int s = 0; s < serviceCount; s++)
                    {
                        if (!selected[s])
                        {
                            continue;
                        }
                        float raw;
                        float level;
                        bool underserved;
                        if (s == kTelecomIndex)
                        {
                            if (!hasTelecom)
                            {
                                continue;
                            }
                            raw = TelecomCoverage.SampleNetworkQuality(telecom, transform.m_Position);
                            level = math.saturate(raw);
                            underserved = raw < telecomBaseline;
                        }
                        else
                        {
                            raw = hasCoverageBuffer ? NetUtils.GetServiceCoverage(coverage, (CoverageService)s, building.m_CurvePosition) : 0f;
                            Bounds1 range = ranges[s] ?? new Bounds1(0f, 1f);
                            level = math.saturate((raw - range.min) / (range.max - range.min));
                            underserved = level < minLevel;
                        }

                        CoverageAccumulator acc = stats[s];
                        acc.Buildings++;
                        acc.Residents += residents;
                        acc.LevelSum += level;
                        acc.RawSum += raw;
                        acc.Buckets[level <= 0f ? 0 : level < 0.34f ? 1 : level < 0.67f ? 2 : 3]++;
                        if (!acc.ByKind.TryGetValue(kind, out int[] byKind))
                        {
                            byKind = new int[2];
                            acc.ByKind[kind] = byKind;
                        }
                        byKind[0]++;
                        if (!underserved)
                        {
                            continue;
                        }
                        byKind[1]++;
                        acc.Underserved++;
                        acc.UnderservedResidents += residents;

                        int gx = (int)math.floor(transform.m_Position.x / gapCellSize);
                        int gz = (int)math.floor(transform.m_Position.z / gapCellSize);
                        long key = ((long)gx << 32) ^ (uint)gz;
                        if (!acc.Gaps.TryGetValue(key, out GapCell cell))
                        {
                            cell = new GapCell();
                            acc.Gaps[key] = cell;
                        }
                        cell.Buildings++;
                        cell.Residents += residents;
                        cell.X += transform.m_Position.x;
                        cell.Z += transform.m_Position.z;
                        cell.LevelSum += level;
                    }
                }
            }

            var districtList = new List<Entity>();
            using (NativeArray<Entity> districtEntities = DistrictQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity district in districtEntities)
                {
                    districtList.Add(district);
                }
            }
            Game.UI.NameSystem districtNames = World.GetOrCreateSystemManaged<Game.UI.NameSystem>();

            var services = new Dictionary<string, object>();
            for (int s = 0; s < serviceCount; s++)
            {
                if (!selected[s])
                {
                    continue;
                }
                CoverageAccumulator acc = stats[s];
                if (s == kTelecomIndex && !hasTelecom)
                {
                    services[CoverageServiceName(s)] = new { available = false, note = "telecom coverage map not available" };
                    continue;
                }

                var gapList = new List<GapCell>(acc.Gaps.Values);
                gapList.Sort((a, b) => b.Residents != a.Residents ? b.Residents.CompareTo(a.Residents) : b.Buildings.CompareTo(a.Buildings));
                var gaps = new List<object>();
                for (int i = 0; i < gapList.Count && i < gapLimit; i++)
                {
                    GapCell cell = gapList[i];
                    gaps.Add(new
                    {
                        x = math.round((float)(cell.X / cell.Buildings)),
                        z = math.round((float)(cell.Z / cell.Buildings)),
                        underservedBuildings = cell.Buildings,
                        residents = cell.Residents,
                        averageLevel = Round2(cell.LevelSum / cell.Buildings),
                    });
                }

                var byKind = new Dictionary<string, object>();
                foreach (KeyValuePair<string, int[]> pair in acc.ByKind)
                {
                    byKind[pair.Key] = new { buildings = pair.Value[0], underserved = pair.Value[1] };
                }

                object scale;
                if (s == kTelecomIndex)
                {
                    scale = new { source = "networkQuality 0-1", underservedBelow = Round2(telecomBaseline), baselineFrom = hasHappinessParameters ? "CitizenHappinessParameterData" : "default" };
                }
                else
                {
                    Bounds1? range = ranges[s];
                    scale = new
                    {
                        source = range.HasValue ? "infoview" : "fallback 0-1 (no infoview range found)",
                        rawMin = range.HasValue ? Round2(range.Value.min) : 0.0,
                        rawMax = range.HasValue ? Round2(range.Value.max) : 1.0,
                        underservedBelowLevel = Round2(minLevel),
                        happinessNeutral = s == (int)CoverageService.Education && !float.IsNaN(neutralEducation) ? (double?)Round2(neutralEducation) : null,
                    };
                }

                services[CoverageServiceName(s)] = new
                {
                    buildings = acc.Buildings,
                    residents = acc.Residents,
                    underservedBuildings = acc.Underserved,
                    underservedPercent = acc.Buildings > 0 ? Round2(100.0 * acc.Underserved / acc.Buildings) : 0.0,
                    underservedResidents = acc.UnderservedResidents,
                    averageLevel = acc.Buildings > 0 ? Round2(acc.LevelSum / acc.Buildings) : 0.0,
                    averageRaw = acc.Buildings > 0 ? Round2(acc.RawSum / acc.Buildings) : 0.0,
                    levels = new { none = acc.Buckets[0], low = acc.Buckets[1], medium = acc.Buckets[2], high = acc.Buckets[3] },
                    byKind,
                    providers = s == kTelecomIndex ? (int?)null : providerCounts[s],
                    providerList = s == kTelecomIndex ? null : providers[s],
                    unservedDistricts = s == kTelecomIndex ? null : UnservedDistricts(
                        areaLimited, providerCounts[s], providerEntireCity[s], providerServedDistricts[s], districtList, districtNames),
                    worstGaps = gaps,
                    scale,
                };
            }

            return BridgeResponse.Json(new
            {
                area = hasCenter && radius < float.MaxValue ? (object)new { x = cx, z = cz, radius } : "whole city",
                zonedBuildings = consideredBuildings,
                buildingsWithoutRoadCoverage = noRoadBuildings,
                gapCellSize,
                services,
                note = "level 0-1 = the service's coverage at the building's road on the infoview colour scale " +
                       "(none = 0, low < 0.34, medium < 0.67, high >= 0.67). worstGaps cluster underserved zoned buildings into " +
                       "gapCellSize-meter cells, most residents first: good spots for a new service building. Coverage is " +
                       "recomputed by the simulation over time, so re-check after running it. Abandoned buildings are excluded.",
            });
        }

        /// <summary>
        /// Districts that none of a service's providers reaches (their operating-district lists leave it
        /// out). Null when it cannot be judged: the area is limited, there are no providers, or a provider
        /// serves the entire city. See /city/service-districts for the per-building detail.
        /// </summary>
        private List<object> UnservedDistricts(bool areaLimited, int providerCount, bool anyEntireCity,
            HashSet<Entity> served, List<Entity> districts, Game.UI.NameSystem names)
        {
            if (areaLimited || providerCount == 0 || anyEntireCity)
            {
                return null;
            }
            var unserved = new List<object>();
            foreach (Entity district in districts)
            {
                if (served == null || !served.Contains(district))
                {
                    unserved.Add(new { entity = EntityRef(district), name = LabelOf(names, district) });
                }
            }
            return unserved;
        }

        private int CountResidents(Entity building)
        {
            if (!EntityManager.HasBuffer<Game.Buildings.Renter>(building))
            {
                return 0;
            }
            int residents = 0;
            DynamicBuffer<Game.Buildings.Renter> renters = EntityManager.GetBuffer<Game.Buildings.Renter>(building, isReadOnly: true);
            for (int i = 0; i < renters.Length; i++)
            {
                Entity renter = renters[i].m_Renter;
                if (EntityManager.HasBuffer<Game.Citizens.HouseholdCitizen>(renter))
                {
                    residents += EntityManager.GetBuffer<Game.Citizens.HouseholdCitizen>(renter, isReadOnly: true).Length;
                }
            }
            return residents;
        }

        private static double Round2(double value)
        {
            return Math.Round(value, 2);
        }
    }
}
