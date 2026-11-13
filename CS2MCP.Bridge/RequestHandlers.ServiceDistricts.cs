using System;
using System.Collections.Generic;
using Game.City;
using Game.Prefabs;
using Game.UI;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Operating districts ("service districts") of service buildings. The building panel's district
    /// section edits Game.Areas.ServiceDistrict, a buffer of district entities on the main building (not
    /// on upgrade extensions). An empty buffer serves the entire city; otherwise only the listed
    /// districts are served, however much spare capacity the building has. District names come from
    /// NameSystem, as the panel shows them.
    ///
    /// Component layout checked against Game.dll: Game.Areas.ServiceDistrict { Entity m_District },
    /// Game.Prefabs.ServiceObjectData { Entity m_Service } -> ServiceData { CityService m_Service }.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private static readonly string[] kServiceCategories =
        {
            "garbage", "education", "healthcare", "police", "fire", "parks", "post", "communications",
            "transportation", "electricity", "water", "roads", "landscaping", "districts", "zones",
        };

        private sealed class ServiceDistrictRecord
        {
            public Entity Entity;
            public string Category;
            public CityService CityService;
            public bool Restricted;
            public readonly List<Entity> Districts = new List<Entity>();
            public readonly HashSet<Entity> DistrictSet = new HashSet<Entity>();
            public int StaleDistricts;
        }

        private static string ServiceCategoryOf(CityService service, bool isPostCoverage)
        {
            switch (service)
            {
                case CityService.GarbageManagement: return "garbage";
                case CityService.Education: return "education";
                case CityService.HealthcareAndDeathcare: return "healthcare";
                case CityService.PoliceAndAdministration: return "police";
                case CityService.FireAndRescue: return "fire";
                case CityService.ParksAndRecreation: return "parks";
                case CityService.Communications: return isPostCoverage ? "post" : "communications";
                case CityService.Transportation: return "transportation";
                case CityService.Electricity: return "electricity";
                case CityService.WaterAndSewage: return "water";
                case CityService.Roads: return "roads";
                case CityService.Landscaping: return "landscaping";
                case CityService.Districts: return "districts";
                case CityService.Zones: return "zones";
                default: return service.ToString().ToLowerInvariant();
            }
        }

        /// <summary>Category of a service building's prefab, or null when the prefab is not a city service.</summary>
        private bool TryGetServiceCategory(Entity building, out CityService service, out string category)
        {
            service = default;
            category = null;
            if (!EntityManager.HasComponent<PrefabRef>(building))
            {
                return false;
            }
            Entity prefab = EntityManager.GetComponentData<PrefabRef>(building).m_Prefab;
            if (!EntityManager.HasComponent<ServiceObjectData>(prefab))
            {
                return false;
            }
            Entity serviceEntity = EntityManager.GetComponentData<ServiceObjectData>(prefab).m_Service;
            if (serviceEntity == Entity.Null || !EntityManager.Exists(serviceEntity) || !EntityManager.HasComponent<ServiceData>(serviceEntity))
            {
                return false;
            }
            service = EntityManager.GetComponentData<ServiceData>(serviceEntity).m_Service;
            bool post = EntityManager.HasComponent<CoverageData>(prefab)
                && EntityManager.GetComponentData<CoverageData>(prefab).m_Service == Game.Net.CoverageService.PostService;
            category = ServiceCategoryOf(service, post);
            return true;
        }

        private bool IsDistrictEntity(Entity entity)
        {
            return entity != Entity.Null
                && EntityManager.Exists(entity)
                && EntityManager.HasComponent<Game.Areas.District>(entity)
                && !EntityManager.HasComponent<Game.Common.Deleted>(entity);
        }

        private ServiceDistrictRecord ReadServiceDistrictRecord(Entity building, CityService service, string category)
        {
            var record = new ServiceDistrictRecord { Entity = building, Category = category, CityService = service };
            DynamicBuffer<Game.Areas.ServiceDistrict> buffer = EntityManager.GetBuffer<Game.Areas.ServiceDistrict>(building, isReadOnly: true);
            record.Restricted = buffer.Length > 0;
            for (int i = 0; i < buffer.Length; i++)
            {
                Entity district = buffer[i].m_District;
                if (!IsDistrictEntity(district))
                {
                    record.StaleDistricts++;
                    continue;
                }
                if (record.DistrictSet.Add(district))
                {
                    record.Districts.Add(district);
                }
            }
            return record;
        }

        private object ServiceDistrictItem(ServiceDistrictRecord record, NameSystem names, Dictionary<Entity, string> districtNames)
        {
            Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(record.Entity);
            var districts = new List<object>();
            foreach (Entity district in record.Districts)
            {
                districts.Add(new { entity = EntityRef(district), name = DistrictNameOf(names, districtNames, district) });
            }
            return new
            {
                entity = EntityRef(record.Entity),
                prefab = PrefabNameOf(record.Entity),
                name = LabelOf(names, record.Entity),
                position = new { x = math.round(transform.m_Position.x), z = math.round(transform.m_Position.z) },
                service = record.Category,
                cityService = record.CityService.ToString(),
                mode = record.Restricted ? "restricted" : "entireCity",
                districts,
                staleDistricts = record.StaleDistricts > 0 ? (int?)record.StaleDistricts : null,
            };
        }

        private static string DistrictNameOf(NameSystem names, Dictionary<Entity, string> cache, Entity district)
        {
            if (!cache.TryGetValue(district, out string name))
            {
                name = LabelOf(names, district);
                cache[district] = name;
            }
            return name;
        }

        private BridgeResponse GetServiceDistricts(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            HashSet<string> wantedCategories = null;
            if (request.Query.TryGetValue("service", out string serviceParam) && !string.IsNullOrWhiteSpace(serviceParam))
            {
                wantedCategories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (string raw in serviceParam.Split(new[] { ',', ' ' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string token = raw.Trim();
                    string match = null;
                    foreach (string category in kServiceCategories)
                    {
                        if (string.Equals(category, token, StringComparison.OrdinalIgnoreCase))
                        {
                            match = category;
                            break;
                        }
                    }
                    if (match == null && Enum.TryParse(token, ignoreCase: true, out CityService parsed) && parsed != CityService.Count)
                    {
                        match = ServiceCategoryOf(parsed, false); // raw CityService name, e.g. GarbageManagement
                    }
                    if (match == null)
                    {
                        return BridgeResponse.Error(400, $"unknown service '{raw}'; use any of: {string.Join(", ", kServiceCategories)}");
                    }
                    wantedCategories.Add(match);
                }
            }

            Entity filterDistrict = Entity.Null;
            bool hasDistrictIndex = request.TryGetInt("districtIndex", out int districtIndex);
            bool hasDistrictVersion = request.TryGetInt("districtVersion", out int districtVersion);
            if (hasDistrictIndex != hasDistrictVersion)
            {
                return BridgeResponse.Error(400, "provide both ?districtIndex= and ?districtVersion= (district from /districts)");
            }
            if (hasDistrictIndex)
            {
                filterDistrict = new Entity { Index = districtIndex, Version = districtVersion };
                if (!IsDistrictEntity(filterDistrict))
                {
                    return BridgeResponse.Error(404, $"entity {districtIndex}:{districtVersion} is not an existing district");
                }
            }

            bool restrictedOnly = request.TryGetBool("restrictedOnly", out bool rawRestricted) && rawRestricted;
            bool byDistrict = request.TryGetBool("byDistrict", out bool rawByDistrict) && rawByDistrict;
            int limit = request.TryGetInt("limit", out int rawLimit) ? math.clamp(rawLimit, 1, 500) : 100;

            NameSystem names = World.GetOrCreateSystemManaged<NameSystem>();
            var districtNames = new Dictionary<Entity, string>();
            var allDistricts = new List<Entity>();
            using (NativeArray<Entity> districtEntities = DistrictQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity district in districtEntities)
                {
                    allDistricts.Add(district);
                }
            }

            // Every service building with a district list (main buildings only: upgrade extensions have an Owner).
            var byCategory = new Dictionary<string, List<ServiceDistrictRecord>>();
            using (NativeArray<Entity> buildings = PlacedBuildingQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity building in buildings)
                {
                    if (!EntityManager.HasBuffer<Game.Areas.ServiceDistrict>(building) || EntityManager.HasComponent<Game.Common.Owner>(building))
                    {
                        continue;
                    }
                    if (!TryGetServiceCategory(building, out CityService service, out string category))
                    {
                        continue;
                    }
                    if (wantedCategories != null && !wantedCategories.Contains(category))
                    {
                        continue;
                    }
                    if (!byCategory.TryGetValue(category, out List<ServiceDistrictRecord> list))
                    {
                        list = new List<ServiceDistrictRecord>();
                        byCategory[category] = list;
                    }
                    list.Add(ReadServiceDistrictRecord(building, service, category));
                }
            }

            var services = new Dictionary<string, object>();
            var districtReports = new Dictionary<Entity, Dictionary<string, object>>();
            int totalBuildings = 0;
            int totalRestricted = 0;
            var categoryNames = new List<string>(byCategory.Keys);
            categoryNames.Sort(StringComparer.Ordinal);
            foreach (string category in categoryNames)
            {
                List<ServiceDistrictRecord> records = byCategory[category];
                int restricted = 0;
                var entireCity = 0;
                foreach (ServiceDistrictRecord record in records)
                {
                    if (record.Restricted) restricted++; else entireCity++;
                }
                totalBuildings += records.Count;
                totalRestricted += restricted;

                // Listed buildings honour restrictedOnly and the district filter ("serves" = whole city or listed).
                var items = new List<object>();
                int matching = 0;
                foreach (ServiceDistrictRecord record in records)
                {
                    if (restrictedOnly && !record.Restricted)
                    {
                        continue;
                    }
                    if (filterDistrict != Entity.Null && record.Restricted && !record.DistrictSet.Contains(filterDistrict))
                    {
                        continue;
                    }
                    matching++;
                    if (items.Count < limit)
                    {
                        items.Add(ServiceDistrictItem(record, names, districtNames));
                    }
                }

                // Districts no provider of this service reaches: only possible when none serves the entire city.
                var unserved = new List<object>();
                var notCoveringByDistrict = new Dictionary<Entity, List<ServiceDistrictRecord>>();
                var coveringByDistrict = new Dictionary<Entity, int>();
                foreach (Entity district in allDistricts)
                {
                    int covering = 0;
                    var notCovering = new List<ServiceDistrictRecord>();
                    foreach (ServiceDistrictRecord record in records)
                    {
                        if (!record.Restricted || record.DistrictSet.Contains(district))
                        {
                            covering++;
                        }
                        else
                        {
                            notCovering.Add(record);
                        }
                    }
                    coveringByDistrict[district] = covering;
                    notCoveringByDistrict[district] = notCovering;
                    if (covering == 0 && records.Count > 0)
                    {
                        unserved.Add(new { entity = EntityRef(district), name = DistrictNameOf(names, districtNames, district) });
                    }
                }

                if (byDistrict)
                {
                    foreach (Entity district in allDistricts)
                    {
                        if (filterDistrict != Entity.Null && district != filterDistrict)
                        {
                            continue;
                        }
                        List<ServiceDistrictRecord> notCovering = notCoveringByDistrict[district];
                        if (notCovering.Count == 0)
                        {
                            continue; // every provider reaches this district: nothing to report
                        }
                        if (!districtReports.TryGetValue(district, out Dictionary<string, object> perService))
                        {
                            perService = new Dictionary<string, object>();
                            districtReports[district] = perService;
                        }
                        var missing = new List<object>();
                        foreach (ServiceDistrictRecord record in notCovering)
                        {
                            if (missing.Count >= 50)
                            {
                                break;
                            }
                            Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(record.Entity);
                            missing.Add(new
                            {
                                entity = EntityRef(record.Entity),
                                prefab = PrefabNameOf(record.Entity),
                                position = new { x = math.round(transform.m_Position.x), z = math.round(transform.m_Position.z) },
                            });
                        }
                        perService[category] = new
                        {
                            providers = records.Count,
                            covering = coveringByDistrict[district],
                            notCovering = notCovering.Count,
                            notCoveringBuildings = missing,
                        };
                    }
                }

                services[category] = new
                {
                    buildings = records.Count,
                    restricted,
                    entireCity,
                    matching,
                    listed = items.Count,
                    unservedDistricts = unserved,
                    items,
                };
            }

            object byDistrictReport = null;
            if (byDistrict)
            {
                var report = new List<object>();
                foreach (Entity district in allDistricts)
                {
                    if (!districtReports.TryGetValue(district, out Dictionary<string, object> perService))
                    {
                        continue;
                    }
                    report.Add(new
                    {
                        district = EntityRef(district),
                        name = DistrictNameOf(names, districtNames, district),
                        services = perService,
                    });
                }
                byDistrictReport = report;
            }

            var districtList = new List<object>();
            foreach (Entity district in allDistricts)
            {
                districtList.Add(new { entity = EntityRef(district), name = DistrictNameOf(names, districtNames, district) });
            }

            return BridgeResponse.Json(new
            {
                serviceBuildings = totalBuildings,
                restrictedBuildings = totalRestricted,
                districtFilter = filterDistrict == Entity.Null ? null : EntityRef(filterDistrict),
                districts = districtList,
                services,
                byDistrict = byDistrictReport,
                note = "mode entireCity = empty district list (serves everywhere); restricted = only the listed districts are served, " +
                       "whatever the spare capacity. unservedDistricts lists districts that no building of that service reaches " +
                       "(only possible when none of them is entireCity). With a district filter, entireCity buildings count as serving it; " +
                       "restrictedOnly keeps just the restricted ones. byDistrict=true adds, per district, the providers that do NOT reach it. " +
                       "service is the broad city-service category: tell landfill from recycling by prefab. Upgrade extensions are not listed.",
            });
        }

        private BridgeResponse SetServiceDistricts(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }

            Entity building;
            if (request.Query.TryGetValue("entity", out string rawEntity) && !string.IsNullOrEmpty(rawEntity))
            {
                if (!TryParseEntityRef(rawEntity, out building))
                {
                    return BridgeResponse.Error(400, "entity must be '<index>:<version>'");
                }
            }
            else if (request.TryGetInt("index", out int index) && request.TryGetInt("version", out int version))
            {
                building = new Entity { Index = index, Version = version };
            }
            else
            {
                return BridgeResponse.Error(400, "provide ?index=&version= (or entity=<index>:<version>) of a service building");
            }
            if (!EntityManager.Exists(building) || !EntityManager.HasComponent<Game.Buildings.Building>(building))
            {
                return BridgeResponse.Error(404, $"entity {building.Index}:{building.Version} is not an existing building");
            }
            if (EntityManager.HasComponent<Game.Common.Owner>(building))
            {
                return BridgeResponse.Error(400, "this is an upgrade extension; set the operating districts on its main building");
            }
            if (!EntityManager.HasBuffer<Game.Areas.ServiceDistrict>(building) || !TryGetServiceCategory(building, out CityService service, out string category))
            {
                return BridgeResponse.Error(400, "this building has no operating-district setting (not a district-restrictable service building)");
            }

            bool hasDistricts = request.Query.TryGetValue("districts", out string districtsRaw);
            bool hasAdd = request.Query.TryGetValue("add", out string addRaw) && !string.IsNullOrWhiteSpace(addRaw);
            bool hasRemove = request.Query.TryGetValue("remove", out string removeRaw) && !string.IsNullOrWhiteSpace(removeRaw);
            bool entireCity = request.Query.TryGetValue("mode", out string mode)
                && string.Equals(mode, "entireCity", StringComparison.OrdinalIgnoreCase);
            if (request.Query.TryGetValue("mode", out mode) && !entireCity && !string.Equals(mode, "restricted", StringComparison.OrdinalIgnoreCase))
            {
                return BridgeResponse.Error(400, "mode must be entireCity or restricted");
            }
            if (!hasDistricts && !hasAdd && !hasRemove && !entireCity)
            {
                return BridgeResponse.Error(400,
                    "provide ?districts=<i:v;i:v> (replace the list), ?add= / ?remove= (edit it), or ?mode=entireCity (clear it)");
            }
            if (entireCity && (hasAdd || hasRemove || (hasDistricts && !string.IsNullOrWhiteSpace(districtsRaw))))
            {
                return BridgeResponse.Error(400, "mode=entireCity clears the list; do not combine it with districts/add/remove");
            }

            if (!TryParseDistrictList(hasDistricts ? districtsRaw : null, out List<Entity> replacement, out string listError)
                || !TryParseDistrictList(hasAdd ? addRaw : null, out List<Entity> additions, out listError)
                || !TryParseDistrictList(hasRemove ? removeRaw : null, out List<Entity> removals, out listError))
            {
                return BridgeResponse.Error(400, listError);
            }

            DynamicBuffer<Game.Areas.ServiceDistrict> buffer = EntityManager.GetBuffer<Game.Areas.ServiceDistrict>(building);
            var result = new List<Entity>();
            if (!entireCity)
            {
                if (hasDistricts)
                {
                    result.AddRange(replacement);
                }
                else
                {
                    for (int i = 0; i < buffer.Length; i++)
                    {
                        if (IsDistrictEntity(buffer[i].m_District) && !result.Contains(buffer[i].m_District))
                        {
                            result.Add(buffer[i].m_District);
                        }
                    }
                }
                foreach (Entity district in additions)
                {
                    if (!result.Contains(district))
                    {
                        result.Add(district);
                    }
                }
                foreach (Entity district in removals)
                {
                    result.Remove(district);
                }
            }

            string previousMode = buffer.Length > 0 ? "restricted" : "entireCity";
            buffer.Clear();
            foreach (Entity district in result)
            {
                buffer.Add(new Game.Areas.ServiceDistrict { m_District = district });
            }
            if (!EntityManager.HasComponent<Game.Common.Updated>(building))
            {
                EntityManager.AddComponent<Game.Common.Updated>(building);
            }

            NameSystem names = World.GetOrCreateSystemManaged<NameSystem>();
            ServiceDistrictRecord record = ReadServiceDistrictRecord(building, service, category);
            return BridgeResponse.Json(new
            {
                changed = true,
                previousMode,
                building = ServiceDistrictItem(record, names, new Dictionary<Entity, string>()),
                note = result.Count == 0
                    ? "the building now serves the entire city"
                    : "the building now serves only the listed districts; read it back with /city/service-districts to confirm",
            });
        }

        private bool TryParseDistrictList(string raw, out List<Entity> districts, out string error)
        {
            districts = new List<Entity>();
            error = null;
            if (string.IsNullOrWhiteSpace(raw))
            {
                return true;
            }
            foreach (string item in raw.Split(new[] { ';', ',' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (!TryParseEntityRef(item.Trim(), out Entity district))
                {
                    error = $"cannot parse district '{item}'; expected '<index>:<version>' items joined by ';'";
                    return false;
                }
                if (!IsDistrictEntity(district))
                {
                    error = $"entity {district.Index}:{district.Version} is not an existing district (see /districts)";
                    return false;
                }
                if (!districts.Contains(district))
                {
                    districts.Add(district);
                }
            }
            return true;
        }
    }
}
