using System;
using System.Collections.Generic;
using System.Text;
using Newtonsoft.Json.Linq;

namespace CS2MCP
{
    /// <summary>One step of a batch: a bridge endpoint and its query parameters.</summary>
    public sealed class BatchOperation
    {
        public string Path;
        public Dictionary<string, string> Query = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        /// <summary>Free text describing the step in results (e.g. "loop NB->WB, piece 2/6").</summary>
        public string Label;
    }

    public sealed class BatchResult
    {
        public BatchOperation Operation;
        public int Status;
        public JToken Body;
        /// <summary>Set when the step answered 200 but the job's own check rejected its result.</summary>
        public string ValidationError;
        public bool Ok => Status == 200 && ValidationError == null;

        public string Error => Ok ? null : ValidationError ?? (Body as JObject)?.Value<string>("error") ?? $"HTTP {Status}";
    }

    /// <summary>
    /// A list of operations run one after another on the simulation thread, each
    /// waiting for the previous one (and the build tools) to finish. On a failure
    /// the job stops, optionally runs rollback operations, and answers the parent
    /// request with every step's result.
    /// </summary>
    public sealed class BatchJob
    {
        public BridgeRequest Parent;
        public List<BatchOperation> Operations = new List<BatchOperation>();
        public bool StopOnError = true;

        /// <summary>Extra check of a step that answered 200: a message fails the step (null = fine).</summary>
        public Func<BatchResult, string> Validate;

        /// <summary>Operations that undo the completed steps after a failure (null = leave them).</summary>
        public Func<BatchJob, List<BatchOperation>> Rollback;

        /// <summary>Builds the parent's response (null = the generic batch summary).</summary>
        public Func<BatchJob, BridgeResponse> BuildResponse;

        public readonly List<BatchResult> Results = new List<BatchResult>();
        public readonly List<BatchResult> RollbackResults = new List<BatchResult>();
        public bool Failed;
        public bool RolledBack;
        public string AbortReason;

        internal List<BatchOperation> Queue;
        internal int Index;
        internal BridgeRequest Current;
        internal BatchOperation CurrentOperation;
        internal bool RollingBack;
        internal int Settle;
        internal DateTime CurrentStartedUtc;
    }

    public sealed partial class BridgeSystem
    {
        public const int MaxBatchOperations = 96;
        private const int BatchStepTimeoutSeconds = 60;
        // Frames to wait after a step (and the build tools going idle) before the next one,
        // so the entities the step created are there for the next step to snap to.
        private const int BatchSettleUpdates = 2;

        private BatchJob m_Batch;

        public bool BatchRunning => m_Batch != null;

        /// <summary>Simulation thread. False when another batch is running.</summary>
        public bool TryStartBatch(BatchJob job)
        {
            if (m_Batch != null)
            {
                return false;
            }
            job.Queue = job.Operations;
            job.Index = 0;
            job.Settle = 0;
            m_Batch = job;
            return true;
        }

        private void AbortBatch(string reason)
        {
            if (m_Batch == null)
            {
                return;
            }
            BatchJob job = m_Batch;
            m_Batch = null;
            job.Failed = true;
            job.AbortReason = reason;
            job.Parent.Complete(BridgeResponse.Error(409, $"batch aborted: {reason}; {job.Results.Count} of {job.Operations.Count} steps had run"));
        }

        private void UpdateBatch()
        {
            BatchJob job = m_Batch;
            if (job == null)
            {
                return;
            }

            if (job.Current != null)
            {
                if (!job.Current.IsCompleted)
                {
                    if ((DateTime.UtcNow - job.CurrentStartedUtc).TotalSeconds > BatchStepTimeoutSeconds)
                    {
                        RecordBatchResult(job, BridgeResponse.Error(504, "step did not finish within 60s"));
                    }
                    return;
                }
                RecordBatchResult(job, job.Current.Response);
            }

            // The tool that ran the last step still needs its Finish frame.
            if (BridgeTools.AnyBusy(World))
            {
                return;
            }
            if (job.Settle > 0)
            {
                job.Settle--;
                return;
            }

            if (job.Failed && !job.RollingBack && job.StopOnError)
            {
                List<BatchOperation> undo = job.Rollback?.Invoke(job);
                if (undo != null && undo.Count > 0)
                {
                    job.RollingBack = true;
                    job.Queue = undo;
                    job.Index = 0;
                }
                else
                {
                    FinishBatch(job);
                    return;
                }
            }

            if (job.Index >= job.Queue.Count)
            {
                job.RolledBack = job.RollingBack;
                FinishBatch(job);
                return;
            }

            BatchOperation operation = job.Queue[job.Index++];
            var child = new BridgeRequest { Method = "POST", Path = operation.Path };
            foreach (KeyValuePair<string, string> pair in operation.Query)
            {
                child.Query[pair.Key] = pair.Value;
            }
            child.TryStart();
            job.Current = child;
            job.CurrentOperation = operation;
            job.CurrentStartedUtc = DateTime.UtcNow;
            Execute(child, batchChild: true);
        }

        private void RecordBatchResult(BatchJob job, BridgeResponse response)
        {
            JToken body = null;
            if (response.Body != null && response.Body.Length > 0
                && response.ContentType.StartsWith("application/json", StringComparison.Ordinal))
            {
                try
                {
                    body = JToken.Parse(Encoding.UTF8.GetString(response.Body));
                }
                catch
                {
                    // keep null
                }
            }
            var result = new BatchResult { Operation = job.CurrentOperation, Status = response.Status, Body = body };
            if (job.RollingBack)
            {
                job.RollbackResults.Add(result);
            }
            else
            {
                if (result.Status == 200 && job.Validate != null)
                {
                    try
                    {
                        result.ValidationError = job.Validate(result);
                    }
                    catch (Exception e)
                    {
                        Mod.Log.Warn($"batch step check failed: {e}");
                    }
                }
                job.Results.Add(result);
                if (!result.Ok)
                {
                    job.Failed = true;
                }
            }
            job.Current = null;
            job.CurrentOperation = null;
            job.Settle = BatchSettleUpdates;
        }

        private void FinishBatch(BatchJob job)
        {
            m_Batch = null;
            BridgeResponse response;
            try
            {
                response = job.BuildResponse != null ? job.BuildResponse(job) : DefaultBatchResponse(job);
            }
            catch (Exception e)
            {
                Mod.Log.Warn($"batch response failed: {e}");
                response = BridgeResponse.Error(500, $"batch finished but its summary failed: {e.GetType().Name}: {e.Message}");
            }
            job.Parent.Complete(response);
        }

        public static List<object> DescribeBatchResults(List<BatchResult> results)
        {
            var list = new List<object>();
            for (int i = 0; i < results.Count; i++)
            {
                BatchResult result = results[i];
                list.Add(new
                {
                    step = i + 1,
                    path = result.Operation.Path,
                    label = result.Operation.Label,
                    ok = result.Ok,
                    status = result.Status,
                    error = result.Error,
                    result = result.Ok ? result.Body : null,
                });
            }
            return list;
        }

        private static BridgeResponse DefaultBatchResponse(BatchJob job)
        {
            int succeeded = 0;
            foreach (BatchResult result in job.Results)
            {
                if (result.Ok)
                {
                    succeeded++;
                }
            }
            return BridgeResponse.Json(new
            {
                ok = !job.Failed,
                total = job.Operations.Count,
                ran = job.Results.Count,
                succeeded,
                failed = job.Results.Count - succeeded,
                stoppedEarly = job.Failed && job.StopOnError && job.Results.Count < job.Operations.Count,
                results = DescribeBatchResults(job.Results),
                note = job.Failed
                    ? "a step failed" + (job.StopOnError ? "; the steps after it were not run" : "") +
                      ". Steps that succeeded stay built: fix the failing step and send only the remaining ones"
                    : "all steps applied in order",
            });
        }
    }
}
