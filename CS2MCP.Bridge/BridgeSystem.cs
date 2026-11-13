using System;
using System.Collections.Concurrent;
using Colossal.Serialization.Entities;
using Game;
using Game.Simulation;
using UnityEngine.Scripting;

namespace CS2MCP
{
    /// <summary>
    /// ECS system that owns the localhost bridge server. Requests arrive on
    /// listener threads, get queued here, and are executed in OnUpdate on the
    /// simulation main thread (the only place ECS access is safe).
    /// Registered at SystemUpdatePhase.UIUpdate so it keeps running while paused.
    /// </summary>
    public sealed partial class BridgeSystem : GameSystemBase
    {
        public const int DefaultPort = 8642;

        public static BridgeSystem Instance { get; private set; }

        private HttpBridgeServer m_Server;
        private RequestHandlers m_Handlers;
        private SimulationSystem m_SimulationSystem;
        private uint m_FrameIndexAtLoad;
        private readonly ConcurrentQueue<BridgeRequest> m_Pending = new ConcurrentQueue<BridgeRequest>();

        /// <summary>
        /// False until the simulation has advanced at least one frame after the
        /// current save finished loading. While false, unlock replay (Locked
        /// component removal, tax parameter unlocks...) may not have run yet,
        /// so lock states read from ECS can be stale.
        /// </summary>
        public bool SimulationHasTickedSinceLoad { get; private set; } = true;

        /// <summary>Frame at which the simulation auto-pauses (0 = disabled).</summary>
        public uint AutoPauseTargetFrame { get; private set; }

        public void SetAutoPause(uint targetFrame, bool dismissPopups = false)
        {
            AutoPauseTargetFrame = targetFrame;
            RunDismissesPopups = targetFrame != 0 && dismissPopups;
        }

        /// <summary>
        /// When true, blocking popups (milestone / signature unlock dialogs) are closed
        /// automatically whenever they appear, so they never hold the simulation paused.
        /// </summary>
        public bool AutoDismissPopups { get; set; }

        /// <summary>Dismiss blocking popups only while the current timed run is active.</summary>
        public bool RunDismissesPopups { get; private set; }

        private int m_PopupCheckCountdown;

        [Preserve]
        protected override void OnCreate()
        {
            base.OnCreate();
            Instance = this;
            m_Handlers = new RequestHandlers(this);
            m_SimulationSystem = base.World.GetOrCreateSystemManaged<SimulationSystem>();

            int port = DefaultPort;
            string envPort = Environment.GetEnvironmentVariable("CS2MCP_PORT");
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out int parsed) && parsed > 0 && parsed < 65536)
            {
                port = parsed;
            }

            m_Server = new HttpBridgeServer(port, m_Pending.Enqueue);
            try
            {
                m_Server.Start();
                Mod.Log.Info($"bridge listening on http://127.0.0.1:{port}");
            }
            catch (Exception e)
            {
                Mod.Log.Error(e, $"failed to start bridge server on port {port}");
                m_Server = null;
            }
        }

        [Preserve]
        protected override void OnGameLoadingComplete(Purpose purpose, GameMode mode)
        {
            base.OnGameLoadingComplete(purpose, mode);
            m_FrameIndexAtLoad = m_SimulationSystem.frameIndex;
            SimulationHasTickedSinceLoad = false;
            // A timed run belongs to the save it was started in: its target frame means
            // nothing in another save (it would pause at once, or far too late).
            SetAutoPause(0);
            ResetSessionForNewSave();
        }

        [Preserve]
        protected override void OnUpdate()
        {
            if (!SimulationHasTickedSinceLoad && m_SimulationSystem.frameIndex != m_FrameIndexAtLoad)
            {
                SimulationHasTickedSinceLoad = true;
            }
            if (AutoPauseTargetFrame != 0 && m_SimulationSystem.frameIndex >= AutoPauseTargetFrame)
            {
                m_SimulationSystem.selectedSpeed = 0f;
                AutoPauseTargetFrame = 0;
                RunDismissesPopups = false;
                Mod.Log.Info("timed run finished, simulation auto-paused");
            }
            if ((AutoDismissPopups || RunDismissesPopups) && --m_PopupCheckCountdown <= 0)
            {
                m_PopupCheckCountdown = 15;
                try
                {
                    int closed = m_Handlers.DismissBlockingPopups();
                    if (closed > 0)
                    {
                        Mod.Log.Info($"auto-dismissed {closed} blocking popup(s)");
                    }
                }
                catch (Exception e)
                {
                    Mod.Log.Warn($"auto-dismiss failed: {e.Message}");
                    AutoDismissPopups = false;
                    RunDismissesPopups = false;
                }
            }
            UpdateSpending();
            while (m_Pending.TryDequeue(out BridgeRequest request))
            {
                // The listener gave up on it (timeout) before we got here: running it now
                // would change the city after the client was told it did not happen.
                if (!request.TryStart())
                {
                    continue;
                }
                Execute(request, batchChild: false);
            }
            m_Handlers.UpdateDiagnoseJobs();
            UpdateTracked();
            UpdateBatch();
        }

        /// <summary>
        /// Runs one request through the guards (running batch, spending limit), the change log
        /// and its handler. A handler returning null completes the request itself later
        /// (screenshots at end-of-frame, build tools over the next tool frames, batches).
        /// </summary>
        private void Execute(BridgeRequest request, bool batchChild)
        {
            BridgeResponse response;
            bool changes = HttpBridgeServer.IsMutatingPath(request.Path) && !request.IsDryRun;
            bool spends = changes && IsSpendingPath(request.Path);
            if (spends && !batchChild && m_Batch != null)
            {
                response = BridgeResponse.Error(409, "a batch / interchange build is running; retry when it has finished");
            }
            else if (spends && SpendingLimitReached(out string limitMessage))
            {
                response = BridgeResponse.Error(403, limitMessage);
            }
            else
            {
                if (changes)
                {
                    Track(request, batchChild);
                }
                try
                {
                    response = m_Handlers.Handle(request);
                }
                catch (Exception e)
                {
                    Mod.Log.Warn($"error handling {request.Method} {request.Path}: {e}");
                    response = BridgeResponse.Error(500, $"{e.GetType().Name}: {e.Message}");
                }
            }
            if (response != null)
            {
                request.Complete(response);
            }
        }

        /// <summary>Read-only component lookup for request handlers (they run inside OnUpdate).</summary>
        public Unity.Entities.ComponentLookup<T> ReadOnlyLookup<T>() where T : unmanaged, Unity.Entities.IComponentData
        {
            return GetComponentLookup<T>(true);
        }

        public void StopServer()
        {
            m_Server?.Stop();
            m_Server = null;
        }

        [Preserve]
        protected override void OnDestroy()
        {
            StopServer();
            if (Instance == this)
            {
                Instance = null;
            }
            base.OnDestroy();
        }
    }
}
