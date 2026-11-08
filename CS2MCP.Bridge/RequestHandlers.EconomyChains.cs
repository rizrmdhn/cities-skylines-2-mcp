using System;
using System.Collections.Generic;
using Game.Economy;
using Game.Prefabs;
using Game.Simulation;
using Unity.Collections;
using Unity.Entities;
using Unity.Jobs;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// The city economy beyond RCI demand: per-resource production, consumption, capacity, storage
    /// and import/export (the production panel's sources: CityProductionStatisticSystem,
    /// CityProductionCapacityCalculationSystem, CountCityStoredResourceSystem) and a company census.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private EntityQuery m_CompanyQuery;
        private bool m_CompanyQueryCreated;

        private EntityQuery CompanyQuery
        {
            get
            {
                if (!m_CompanyQueryCreated)
                {
                    m_CompanyQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
                    {
                        All = new[]
                        {
                            ComponentType.ReadOnly<Game.Companies.CompanyData>(),
                            ComponentType.ReadOnly<PrefabRef>(),
                        },
                        None = new[]
                        {
                            ComponentType.ReadOnly<Game.Common.Deleted>(),
                            ComponentType.ReadOnly<Game.Tools.Temp>(),
                        },
                    });
                    m_CompanyQueryCreated = true;
                }
                return m_CompanyQuery;
            }
        }

        private sealed class CompanyStats
        {
            public int Count;
            public int Workers;
            public int Jobs;
            public long ProfitabilitySum;
            public int WithProfitability;
            public int WithoutProperty;
        }

        private BridgeResponse GetEconomy(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            bool includeAll = request.TryGetBool("all", out bool rawAll) && rawAll;

            CityProductionStatisticSystem statistics = World.GetOrCreateSystemManaged<CityProductionStatisticSystem>();
            CityProductionCapacityCalculationSystem capacity = World.GetOrCreateSystemManaged<CityProductionCapacityCalculationSystem>();
            CountCityStoredResourceSystem storedSystem = World.GetOrCreateSystemManaged<CountCityStoredResourceSystem>();
            NativeArray<int2> consumptionProduction = statistics.GetConsumptionProductions();
            NativeArray<CityProductionStatisticSystem.CityResourceUsage> usages = statistics.GetCityResourceUsages();
            NativeArray<int> stored = storedSystem.GetCityStoredResources();

            var resources = new List<(int Net, object Item)>();
            ResourceIterator iterator = ResourceIterator.GetIterator();
            while (iterator.Next())
            {
                Resource resource = iterator.resource;
                int index = EconomyUtils.GetResourceIndex(resource);
                if (index < 0 || index >= consumptionProduction.Length)
                {
                    continue;
                }
                int consumption = consumptionProduction[index].x;
                int production = consumptionProduction[index].y;
                int productionCapacity = capacity.GetProductionCapacity(resource);
                int storedAmount = index < stored.Length ? stored[index] : 0;
                CityProductionStatisticSystem.CityResourceUsage usage = index < usages.Length ? usages[index] : default;
                bool active = consumption != 0 || production != 0 || productionCapacity != 0 || storedAmount != 0 || usage.m_ImportExport != 0;
                if (!active && !includeAll)
                {
                    continue;
                }
                int net = production - consumption;
                resources.Add((net, new
                {
                    resource = resource.ToString(),
                    production,
                    consumption,
                    net,
                    productionCapacity,
                    stored = storedAmount,
                    importExport = usage.m_ImportExport,
                    consumers = new
                    {
                        citizens = usage.m_Citizens,
                        retail = usage.m_Retail,
                        commercial = usage.m_Commercial,
                        industrial = usage.m_Industrial,
                        office = usage.m_Office,
                        serviceUpkeep = usage.m_ServiceUpkeep,
                        heating = usage.m_Heating,
                        buildingLevelUp = usage.m_LevelUp,
                    },
                }));
            }
            // Biggest shortfalls first: those are what the city imports or lacks.
            resources.Sort((a, b) => a.Net.CompareTo(b.Net));
            var resourceItems = new List<object>();
            foreach (var entry in resources)
            {
                resourceItems.Add(entry.Item);
            }

            var companies = new Dictionary<string, CompanyStats>();
            using (NativeArray<Entity> entities = CompanyQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity company in entities)
                {
                    string kind = EntityManager.HasComponent<Game.Companies.StorageCompany>(company) ? "storage"
                        : EntityManager.HasComponent<Game.Companies.ExtractorCompany>(company) ? "extractor"
                        : EntityManager.HasComponent<Game.Companies.OfficeCompany>(company) ? "office"
                        : EntityManager.HasComponent<Game.Companies.CommercialCompany>(company) ? "commercial"
                        : EntityManager.HasComponent<Game.Companies.ProcessingCompany>(company)
                          || EntityManager.HasComponent<Game.Companies.IndustrialCompany>(company) ? "industrial"
                        : null;
                    if (kind == null)
                    {
                        continue;
                    }
                    if (!companies.TryGetValue(kind, out CompanyStats stats))
                    {
                        stats = new CompanyStats();
                        companies[kind] = stats;
                    }
                    stats.Count++;
                    if (EntityManager.HasBuffer<Game.Companies.Employee>(company))
                    {
                        stats.Workers += EntityManager.GetBuffer<Game.Companies.Employee>(company, isReadOnly: true).Length;
                    }
                    if (EntityManager.HasComponent<Game.Companies.WorkProvider>(company))
                    {
                        stats.Jobs += EntityManager.GetComponentData<Game.Companies.WorkProvider>(company).m_MaxWorkers;
                    }
                    if (EntityManager.HasComponent<Game.Companies.Profitability>(company))
                    {
                        stats.ProfitabilitySum += EntityManager.GetComponentData<Game.Companies.Profitability>(company).m_Profitability;
                        stats.WithProfitability++;
                    }
                    if (!EntityManager.HasComponent<Game.Buildings.PropertyRenter>(company))
                    {
                        stats.WithoutProperty++;
                    }
                }
            }
            var companyItems = new Dictionary<string, object>();
            foreach (KeyValuePair<string, CompanyStats> pair in companies)
            {
                CompanyStats stats = pair.Value;
                companyItems[pair.Key] = new
                {
                    count = stats.Count,
                    workers = stats.Workers,
                    jobs = stats.Jobs,
                    jobFillPercent = stats.Jobs > 0 ? Math.Round(100.0 * stats.Workers / stats.Jobs, 1) : 0.0,
                    averageProfitability = stats.WithProfitability > 0 ? Math.Round((double)stats.ProfitabilitySum / stats.WithProfitability, 1) : 0.0,
                    lookingForProperty = stats.WithoutProperty,
                };
            }

            return BridgeResponse.Json(new
            {
                resources = resourceItems,
                companies = companyItems,
                note = "resources: the production panel's numbers, biggest shortfall (production - consumption) first; " +
                       "productionCapacity = what local companies could produce; importExport as the game reports it. " +
                       "companies: averageProfitability is the game's 0-255 Profitability value; lookingForProperty = " +
                       "companies without a building yet. Values update while the simulation runs. all=true lists idle resources too.",
            });
        }
    }
}
