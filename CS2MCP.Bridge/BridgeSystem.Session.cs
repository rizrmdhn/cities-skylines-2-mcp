using System;
using System.Collections.Generic;
using System.Text;
using Game;
using Game.City;
using Game.SceneFlow;
using Game.Simulation;

namespace CS2MCP
{
    /// <summary>
    /// Session bookkeeping for state-changing requests: a change log (what the AI
    /// changed, when, and what it cost) and the money spent through the bridge,
    /// which the optional spending limit (Options > CS2MCP, or CS2MCP_SPEND_LIMIT)
    /// is checked against.
    /// </summary>
    public sealed partial class BridgeSystem
    {
        private const int MaxHistory = 300;
        private const int SettleUpdates = 3;
        private const int TrackedTimeoutSeconds = 240;

        public sealed class HistoryEntry
        {
            public int id;
            public string timeUtc;
            public string gameTime;
            public string path;
            public Dictionary<string, string> query;
            public int status;
            public bool ok;
            public bool batchChild;
            /// <summary>Treasury change across the operation (negative = money spent).</summary>
            public int moneyDelta;
            public string result;
        }

        private sealed class Tracked
        {
            public BridgeRequest Request;
            public bool BatchChild;
            public bool Spends;
            public int MoneyBefore;
            public DateTime StartedUtc;
            public int Settled;
        }

        private readonly List<Tracked> m_Tracked = new List<Tracked>();
        private readonly List<HistoryEntry> m_History = new List<HistoryEntry>();
        private int m_NextHistoryId = 1;
        private long m_SessionSpent;
        private int m_LastMoney;
        private bool m_HasLastMoney;
        private int m_SpendWindow;

        /// <summary>Money that left the treasury during bridge build operations since the save was loaded (or the counter was reset).</summary>
        public long SessionSpent => m_SessionSpent;

        /// <summary>Requests that cost construction money; the spending limit applies to these.</summary>
        public static bool IsSpendingPath(string path)
        {
            return (path.StartsWith("/build/", StringComparison.Ordinal) && path != "/build/rename")
                || path == "/transit/stops/place"
                || path == "/transit/lines/create"
                || path == "/transit/routes/create"
                || path == "/city/tiles/buy";
        }

        public bool SpendingLimitReached(out string message)
        {
            message = null;
            long limit = BridgeOptions.SpendingLimit;
            if (limit <= 0 || m_SessionSpent < limit)
            {
                return false;
            }
            message = $"AI spending limit reached: {m_SessionSpent} spent of {limit} allowed this session. The player can raise " +
                      "the limit or reset the counter in the game's Options > CS2MCP page; dryRun requests still work";
            return true;
        }

        public void ResetSpending()
        {
            m_SessionSpent = 0;
        }

        public List<HistoryEntry> GetHistory(int limit)
        {
            int count = Math.Min(Math.Max(limit, 1), m_History.Count);
            // Newest first.
            var result = new List<HistoryEntry>(count);
            for (int i = m_History.Count - 1; i >= m_History.Count - count; i--)
            {
                result.Add(m_History[i]);
            }
            return result;
        }

        public int HistoryCount => m_History.Count;

        private void ResetSessionForNewSave()
        {
            m_SessionSpent = 0;
            m_HasLastMoney = false;
            m_SpendWindow = 0;
            m_Tracked.Clear();
            m_History.Clear();
            AbortBatch("the save was reloaded");
        }

        private bool TryGetMoney(out int money)
        {
            money = 0;
            GameManager manager = GameManager.instance;
            if (manager == null || manager.gameMode != GameMode.Game)
            {
                return false;
            }
            money = World.GetOrCreateSystemManaged<CitySystem>().moneyAmount;
            return true;
        }

        private void Track(BridgeRequest request, bool batchChild)
        {
            TryGetMoney(out int money);
            bool spends = IsSpendingPath(request.Path);
            m_Tracked.Add(new Tracked
            {
                Request = request,
                BatchChild = batchChild,
                Spends = spends,
                MoneyBefore = money,
                StartedUtc = DateTime.UtcNow,
            });
            if (spends)
            {
                m_SpendWindow = SettleUpdates;
            }
        }

        /// <summary>
        /// Treasury drops while a build operation is in flight (or has just finished: the
        /// game charges construction in the apply phase, after the tool answered) count as
        /// bridge spending. Running-simulation upkeep in those few frames is counted too,
        /// which errs on the side of the limit.
        /// </summary>
        private void UpdateSpending()
        {
            if (BridgeOptions.ConsumeSpendingReset())
            {
                ResetSpending();
            }
            if (!TryGetMoney(out int money))
            {
                m_HasLastMoney = false;
                return;
            }
            bool inFlight = false;
            foreach (Tracked tracked in m_Tracked)
            {
                if (tracked.Spends && !tracked.Request.IsCompleted)
                {
                    inFlight = true;
                    break;
                }
            }
            if (inFlight)
            {
                m_SpendWindow = SettleUpdates;
            }
            if (m_HasLastMoney && m_SpendWindow > 0 && money < m_LastMoney)
            {
                m_SessionSpent += m_LastMoney - money;
            }
            if (!inFlight && m_SpendWindow > 0)
            {
                m_SpendWindow--;
            }
            m_LastMoney = money;
            m_HasLastMoney = true;
        }

        private void UpdateTracked()
        {
            for (int i = m_Tracked.Count - 1; i >= 0; i--)
            {
                Tracked tracked = m_Tracked[i];
                if (!tracked.Request.IsCompleted)
                {
                    if ((DateTime.UtcNow - tracked.StartedUtc).TotalSeconds > TrackedTimeoutSeconds)
                    {
                        m_Tracked.RemoveAt(i);
                        AddHistory(tracked, 0, false, 0, "no result: the operation never completed");
                    }
                    continue;
                }
                // Give the game a few frames to charge the treasury before reading the cost.
                if (tracked.Settled++ < SettleUpdates)
                {
                    continue;
                }
                m_Tracked.RemoveAt(i);
                BridgeResponse response = tracked.Request.Response;
                TryGetMoney(out int money);
                AddHistory(tracked, response.Status, response.Status == 200, money - tracked.MoneyBefore, Summarize(response));
            }
        }

        private void AddHistory(Tracked tracked, int status, bool ok, int moneyDelta, string result)
        {
            var query = new Dictionary<string, string>();
            foreach (KeyValuePair<string, string> pair in tracked.Request.Query)
            {
                query[pair.Key] = pair.Value != null && pair.Value.Length > 160 ? pair.Value.Substring(0, 160) + "..." : pair.Value;
            }
            string gameTime = null;
            try
            {
                gameTime = World.GetOrCreateSystemManaged<TimeSystem>().GetCurrentDateTime().ToString("yyyy-MM-dd HH:mm");
            }
            catch
            {
                // no city loaded
            }
            m_History.Add(new HistoryEntry
            {
                id = m_NextHistoryId++,
                timeUtc = tracked.StartedUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                gameTime = gameTime,
                path = tracked.Request.Path,
                query = query,
                status = status,
                ok = ok,
                batchChild = tracked.BatchChild,
                moneyDelta = moneyDelta,
                result = result,
            });
            if (m_History.Count > MaxHistory)
            {
                m_History.RemoveRange(0, m_History.Count - MaxHistory);
            }
        }

        private static string Summarize(BridgeResponse response)
        {
            if (response.Body == null || response.Body.Length == 0 || !response.ContentType.StartsWith("application/json", StringComparison.Ordinal))
            {
                return null;
            }
            string text = Encoding.UTF8.GetString(response.Body);
            return text.Length > 400 ? text.Substring(0, 400) + "..." : text;
        }
    }
}
