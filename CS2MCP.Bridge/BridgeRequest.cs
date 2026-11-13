using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;

namespace CS2MCP
{
    /// <summary>
    /// A parsed HTTP request handed from a listener thread to the simulation
    /// thread. The listener thread blocks on WaitForResponse until the
    /// simulation thread calls Complete.
    /// </summary>
    public sealed class BridgeRequest
    {
        public string Method;
        public string Path;
        public Dictionary<string, string> Query = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public string Body;
        public string Host;
        public string Origin;
        public string Token;

        /// <summary>Client-chosen id of a state-changing request (X-CS2MCP-Request-Id): a retry with the same id gets the first run's result.</summary>
        public string RequestId;

        /// <summary>How long the client is prepared to wait (X-CS2MCP-Timeout-Ms); 0 = server default.</summary>
        public int TimeoutMs;

        private const int StateQueued = 0;
        private const int StateStarted = 1;
        private const int StateAbandoned = 2;
        private int m_State;

        private readonly TaskCompletionSource<BridgeResponse> m_Completion =
            new TaskCompletionSource<BridgeResponse>(TaskCreationOptions.RunContinuationsAsynchronously);

        public bool TryGetInt(string key, out int value)
        {
            value = 0;
            return Query.TryGetValue(key, out string raw)
                && int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
        }

        public bool TryGetFloat(string key, out float value)
        {
            value = 0f;
            return Query.TryGetValue(key, out string raw)
                && float.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        }

        public bool TryGetBool(string key, out bool value)
        {
            value = false;
            return Query.TryGetValue(key, out string raw) && bool.TryParse(raw, out value);
        }

        /// <summary>
        /// Simulation thread: claim the request for execution. False when the listener already
        /// gave up on it (answered the client with a timeout), in which case it must not run.
        /// </summary>
        public bool TryStart()
        {
            return Interlocked.CompareExchange(ref m_State, StateStarted, StateQueued) == StateQueued;
        }

        /// <summary>
        /// Listener thread, after a timeout: withdraw a request the simulation thread has not
        /// picked up yet. False when it is already running (its effect can no longer be prevented).
        /// </summary>
        public bool TryAbandon()
        {
            return Interlocked.CompareExchange(ref m_State, StateAbandoned, StateQueued) == StateQueued;
        }

        public bool IsAbandoned => Volatile.Read(ref m_State) == StateAbandoned;

        public bool IsCompleted => m_Completion.Task.IsCompleted;

        /// <summary>The response once completed, else null.</summary>
        public BridgeResponse Response => m_Completion.Task.IsCompleted ? m_Completion.Task.Result : null;

        public bool IsDryRun => TryGetBool("dryRun", out bool dryRun) && dryRun;

        public void Complete(BridgeResponse response)
        {
            m_Completion.TrySetResult(response);
        }

        /// <summary>Returns null on timeout.</summary>
        public BridgeResponse WaitForResponse(int timeoutMs)
        {
            return m_Completion.Task.Wait(timeoutMs) ? m_Completion.Task.Result : null;
        }
    }

    public sealed class BridgeResponse
    {
        public int Status = 200;
        public string ContentType = "application/json; charset=utf-8";
        public byte[] Body = Array.Empty<byte>();

        public static BridgeResponse Json(object payload, int status = 200)
        {
            return new BridgeResponse
            {
                Status = status,
                Body = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(payload, Formatting.None)),
            };
        }

        public static BridgeResponse Error(int status, string message)
        {
            return Json(new { error = message }, status);
        }

        /// <summary>An error carrying structured data (blockedBy, replacePlan...) next to the message.</summary>
        public static BridgeResponse ErrorWith(int status, string message, IDictionary<string, object> extra)
        {
            var payload = new Dictionary<string, object> { ["error"] = message };
            foreach (KeyValuePair<string, object> pair in extra)
            {
                payload[pair.Key] = pair.Value;
            }
            return Json(payload, status);
        }

        public static BridgeResponse Png(byte[] png)
        {
            return new BridgeResponse { ContentType = "image/png", Body = png };
        }
    }
}
