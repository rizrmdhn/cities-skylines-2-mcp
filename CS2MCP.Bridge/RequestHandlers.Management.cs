using System;
using System.Collections.Generic;
using Game.City;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// Management endpoints: loans (borrow/repay) and service fees
    /// (electricity/water/education... pricing), plus a generic standalone
    /// object listing (trees etc.) so placed decorations can be found and
    /// demolished again.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private EntityQuery m_StandaloneObjectQuery;
        private bool m_StandaloneObjectQueryCreated;

        private EntityQuery StandaloneObjectQuery
        {
            get
            {
                if (!m_StandaloneObjectQueryCreated)
                {
                    m_StandaloneObjectQuery = EntityManager.CreateEntityQuery(new EntityQueryDesc
                    {
                        All = new[]
                        {
                            ComponentType.ReadOnly<Game.Objects.Static>(),
                            ComponentType.ReadOnly<Game.Objects.Transform>(),
                            ComponentType.ReadOnly<PrefabRef>(),
                        },
                        Any = new[]
                        {
                            ComponentType.ReadOnly<Game.Objects.Tree>(),
                            ComponentType.ReadOnly<Game.Objects.Plant>(),
                        },
                        None = new[]
                        {
                            ComponentType.ReadOnly<Game.Tools.Temp>(),
                            ComponentType.ReadOnly<Game.Common.Deleted>(),
                            ComponentType.ReadOnly<Game.Common.Owner>(),
                        },
                    });
                    m_StandaloneObjectQueryCreated = true;
                }
                return m_StandaloneObjectQuery;
            }
        }

        private BridgeResponse GetLoan()
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            LoanSystem loans = World.GetOrCreateSystemManaged<LoanSystem>();
            LoanInfo current = loans.CurrentLoan;
            return BridgeResponse.Json(new
            {
                currentLoan = new
                {
                    amount = current.m_Amount,
                    dailyInterestRate = current.m_DailyInterestRate,
                    dailyPayment = current.m_DailyPayment,
                },
                creditworthiness = loans.Creditworthiness,
                note = "set the loan principal with /city/loan/set?amount=N (0 repays fully, max = creditworthiness)",
            });
        }

        private BridgeResponse SetLoan(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.TryGetInt("amount", out int amount))
            {
                return BridgeResponse.Error(400, "provide ?amount=<int> (new loan principal; 0 repays fully)");
            }
            LoanSystem loans = World.GetOrCreateSystemManaged<LoanSystem>();
            int applied = math.clamp(amount, 0, loans.Creditworthiness);
            LoanInfo offer = loans.RequestLoanOffer(applied);
            loans.ChangeLoan(applied);
            LoanInfo current = loans.CurrentLoan;
            return BridgeResponse.Json(new
            {
                requestedAmount = amount,
                appliedAmount = applied,
                offer = new { offer.m_Amount, offer.m_DailyInterestRate, offer.m_DailyPayment },
                currentLoan = new { current.m_Amount, current.m_DailyInterestRate, current.m_DailyPayment },
            });
        }

        private BridgeResponse GetFees()
        {
            if (!TryGetCity(out Entity city, out BridgeResponse error))
            {
                return error;
            }
            ServiceFeeSystem feeSystem = World.GetOrCreateSystemManaged<ServiceFeeSystem>();
            DynamicBuffer<ServiceFee> fees = EntityManager.GetBuffer<ServiceFee>(city, isReadOnly: true);
            var result = new Dictionary<string, object>();
            foreach (PlayerResource resource in Enum.GetValues(typeof(PlayerResource)))
            {
                if ((int)resource < 0)
                {
                    continue;
                }
                if (ServiceFeeSystem.TryGetFee(resource, fees, out float fee))
                {
                    // GetServiceFees is the fee money collected (internal / export / import), not a range;
                    // the slider range comes from the fee parameters (0..m_Max).
                    int3 collected = feeSystem.GetServiceFees(resource);
                    bool hasRange = TryGetFeeParameters(resource, out FeeParameters parameters);
                    result[resource.ToString()] = new
                    {
                        fee,
                        estimatedMonthlyIncome = feeSystem.GetServiceFeeIncomeEstimate(resource, fee),
                        sliderRange = hasRange ? new { min = 0f, max = parameters.m_Max, defaultValue = parameters.m_Default } : null,
                        adjustable = hasRange && parameters.m_Adjustable,
                        collected = new { @internal = collected.x, export = collected.y, import = collected.z },
                    };
                }
            }
            return BridgeResponse.Json(new
            {
                note = "set with /city/fees/set?resource=<name>&fee=<float>; fees affect service income and citizen happiness",
                fees = result,
            });
        }

        private BridgeResponse SetFee(BridgeRequest request)
        {
            if (!TryGetCity(out Entity city, out BridgeResponse error))
            {
                return error;
            }
            if (!request.Query.TryGetValue("resource", out string resourceName)
                || !Enum.TryParse(resourceName, ignoreCase: true, out PlayerResource resource))
            {
                return BridgeResponse.Error(400,
                    $"provide ?resource=<{string.Join("|", Enum.GetNames(typeof(PlayerResource)))}>");
            }
            if (!request.TryGetFloat("fee", out float fee))
            {
                return BridgeResponse.Error(400, "provide ?fee=<float>");
            }
            DynamicBuffer<ServiceFee> fees = EntityManager.GetBuffer<ServiceFee>(city);
            if (!ServiceFeeSystem.TryGetFee(resource, fees, out float previous))
            {
                return BridgeResponse.Error(400, $"resource '{resource}' has no adjustable fee in this city");
            }
            // Keep the fee inside the range the Economy panel's slider allows (0..max).
            bool hasRange = TryGetFeeParameters(resource, out FeeParameters parameters);
            if (hasRange && !parameters.m_Adjustable)
            {
                return BridgeResponse.Error(409, $"the fee for '{resource}' is not adjustable in this game");
            }
            float applied = hasRange && parameters.m_Max > 0f ? math.clamp(fee, 0f, parameters.m_Max) : math.max(fee, 0f);
            ServiceFeeSystem.SetFee(resource, fees, applied);
            return BridgeResponse.Json(new
            {
                resource = resource.ToString(),
                previousFee = previous,
                requestedFee = fee,
                newFee = applied,
                sliderRange = hasRange ? new { min = 0f, max = parameters.m_Max } : null,
                clamped = applied != fee,
            });
        }

        private EntityQuery m_FeeParameterQuery;
        private bool m_FeeParameterQueryCreated;

        /// <summary>Default, maximum and adjustability of a service fee, as the Economy panel's slider uses them.</summary>
        private bool TryGetFeeParameters(PlayerResource resource, out FeeParameters parameters)
        {
            parameters = default;
            if (!m_FeeParameterQueryCreated)
            {
                m_FeeParameterQuery = EntityManager.CreateEntityQuery(ComponentType.ReadOnly<ServiceFeeParameterData>());
                m_FeeParameterQueryCreated = true;
            }
            if (m_FeeParameterQuery.IsEmptyIgnoreFilter)
            {
                return false;
            }
            try
            {
                parameters = m_FeeParameterQuery.GetSingleton<ServiceFeeParameterData>().GetFeeParameters(resource);
                return parameters.m_Max > 0f || parameters.m_Default > 0f;
            }
            catch
            {
                return false;
            }
        }

        private BridgeResponse ListObjects(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            request.Query.TryGetValue("query", out string search);
            int limit = request.TryGetInt("limit", out int rawLimit) ? math.clamp(rawLimit, 1, 500) : 100;
            bool hasCenter = request.TryGetFloat("x", out float x) & request.TryGetFloat("z", out float z);
            float radius = request.TryGetFloat("radius", out float rawRadius) ? math.max(rawRadius, 1f) : 250f;
            float2 center = new float2(x, z);

            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            var results = new List<object>();
            int total = 0;
            using (NativeArray<Entity> entities = StandaloneObjectQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in entities)
                {
                    Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(entity);
                    if (hasCenter && math.distance(transform.m_Position.xz, center) > radius)
                    {
                        continue;
                    }
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(EntityManager.GetComponentData<PrefabRef>(entity).m_Prefab);
                    string name = prefab != null ? prefab.name : "<unknown>";
                    if (!string.IsNullOrEmpty(search) && name.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }
                    total++;
                    if (results.Count < limit)
                    {
                        results.Add(new
                        {
                            entity = new { index = entity.Index, version = entity.Version },
                            prefab = name,
                            position = new { x = transform.m_Position.x, y = transform.m_Position.y, z = transform.m_Position.z },
                        });
                    }
                }
            }
            return BridgeResponse.Json(new
            {
                totalMatches = total,
                returned = results.Count,
                note = "standalone trees/plants; use entity index+version with /build/demolish",
                objects = results,
            });
        }
    }
}
