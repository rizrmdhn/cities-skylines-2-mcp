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
    /// The city economy beyond RCI demand: the production panel per resource (ProductionPanel in
    /// RequestHandlers.Production.cs, ported from upstream PR #4) and a company census.
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
            object production = ProductionPanel(request);

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
                production,
                companies = companyItems,
                note = "production: the Economy > Production panel's numbers per resource (see production.note), biggest " +
                       "deficits in production.topDeficits. companies: averageProfitability is the game's 0-255 Profitability " +
                       "value; lookingForProperty = companies without a building yet. Values update while the simulation runs. " +
                       "all=true lists idle resources too; resource=<name> shows one.",
            });
        }
    }
}
