using System;
using System.Collections.Generic;
using System.Globalization;
using Newtonsoft.Json.Linq;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// POST /build/batch runs a list of state-changing operations one after another
    /// (each waits for the previous one and for the build tools to finish), so a
    /// client does not need one round trip per road segment and never collides with
    /// its own earlier request. GET /history is the change log of everything the
    /// bridge changed this session, with the money each change cost.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private BridgeResponse RunBatch(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (string.IsNullOrEmpty(request.Body))
            {
                return BridgeResponse.Error(400,
                    "POST a JSON body: {\"operations\":[{\"path\":\"/build/road/connect\",\"query\":{\"prefab\":\"...\",\"x1\":0,...}}],\"stopOnError\":true}");
            }

            JObject body;
            try
            {
                body = JObject.Parse(request.Body);
            }
            catch (Exception e)
            {
                return BridgeResponse.Error(400, $"body is not valid JSON: {e.Message}");
            }
            if (!(body["operations"] is JArray operations) || operations.Count == 0)
            {
                return BridgeResponse.Error(400, "\"operations\" must be a non-empty array");
            }
            if (operations.Count > BridgeSystem.MaxBatchOperations)
            {
                return BridgeResponse.Error(400, $"too many operations ({operations.Count}); at most {BridgeSystem.MaxBatchOperations} per batch");
            }

            bool dryRun = IsDryRun(request) || (body.Value<bool?>("dryRun") ?? false);
            var job = new BatchJob
            {
                Parent = request,
                StopOnError = body.Value<bool?>("stopOnError") ?? true,
            };
            for (int i = 0; i < operations.Count; i++)
            {
                if (!(operations[i] is JObject item))
                {
                    return BridgeResponse.Error(400, $"operation #{i + 1} is not an object");
                }
                string path = item.Value<string>("path");
                if (string.IsNullOrEmpty(path) || !HttpBridgeServer.IsMutatingPath(path))
                {
                    return BridgeResponse.Error(400, $"operation #{i + 1}: \"path\" must be a state-changing bridge route (e.g. /build/road/connect), got '{path}'");
                }
                if (path == "/build/batch" || path == "/build/interchange")
                {
                    return BridgeResponse.Error(400, $"operation #{i + 1}: {path} cannot be nested in a batch");
                }
                var operation = new BatchOperation { Path = path, Label = item.Value<string>("label") };
                if (item["query"] is JObject query)
                {
                    foreach (JProperty property in query.Properties())
                    {
                        if (property.Value.Type == JTokenType.Null)
                        {
                            continue;
                        }
                        operation.Query[property.Name] = QueryValue(property.Value);
                    }
                }
                if (dryRun)
                {
                    operation.Query["dryRun"] = "true";
                }
                job.Operations.Add(operation);
            }

            if (BridgeTools.AnyBusy(World) || !m_System.TryStartBatch(job))
            {
                return BridgeResponse.Error(409, "another build operation or batch is in progress, retry shortly");
            }
            // Completed by BridgeSystem once every step has run.
            return null;
        }

        /// <summary>Query-string form of a JSON value: invariant numbers, lowercase booleans.</summary>
        private static string QueryValue(JToken value)
        {
            switch (value.Type)
            {
                case JTokenType.Boolean:
                    return value.Value<bool>() ? "true" : "false";
                case JTokenType.Integer:
                    return value.Value<long>().ToString(CultureInfo.InvariantCulture);
                case JTokenType.Float:
                    return value.Value<double>().ToString("R", CultureInfo.InvariantCulture);
                default:
                    return value.ToString();
            }
        }

        private BridgeResponse GetHistory(BridgeRequest request)
        {
            int limit = request.TryGetInt("limit", out int rawLimit) ? math.clamp(rawLimit, 1, 300) : 50;
            List<BridgeSystem.HistoryEntry> entries = m_System.GetHistory(limit);
            long spendingLimit = BridgeOptions.SpendingLimit;
            return BridgeResponse.Json(new
            {
                sessionSpent = m_System.SessionSpent,
                spendingLimit = spendingLimit > 0 ? (long?)spendingLimit : null,
                spendingLimitRemaining = spendingLimit > 0 ? (long?)Math.Max(0, spendingLimit - m_System.SessionSpent) : null,
                spendingLimitSource = BridgeOptions.SpendingLimitFromEnvironment > 0 ? "CS2MCP_SPEND_LIMIT" : "game options",
                batchRunning = m_System.BatchRunning,
                total = m_System.HistoryCount,
                returned = entries.Count,
                note = "newest first; every state-changing request since the save was loaded (dry runs are not logged). " +
                       "moneyDelta is the treasury change across the operation (negative = spent). There is no generic undo: " +
                       "remove a build with cs2_demolish using the ids in its result.",
                entries,
            });
        }
    }
}
