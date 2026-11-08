using System.Reflection;
using Colossal.IO.AssetDatabase;
using Colossal.Logging;
using Game;
using Game.Modding;
using Game.SceneFlow;

namespace CS2MCP
{
    public sealed class Mod : IMod
    {
        public const string Name = "CS2MCP";

        /// <summary>Single source of truth: &lt;Version&gt; in CS2MCP.Bridge.csproj.</summary>
        public static readonly string Version =
            typeof(Mod).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? typeof(Mod).Assembly.GetName().Version.ToString(3);

        public static readonly ILog Log = LogManager.GetLogger(Name).SetShowsErrorsInUI(false);

        private Setting m_Setting;

        public void OnLoad(UpdateSystem updateSystem)
        {
            Log.Info($"{Name} {Version} loading, registering bridge systems");

            try
            {
                m_Setting = new Setting(this);
                m_Setting.RegisterInOptionsUI();
                GameManager.instance.localizationManager.AddSource("en-US", new SettingLocaleEN(m_Setting));
                AssetDatabase.global.LoadSettings(Name, m_Setting, new Setting(this));
                Log.Info($"options: bridge {(BridgeOptions.Enabled ? "enabled" : "disabled")}, read-only {BridgeOptions.ReadOnly}");
            }
            catch (System.Exception e)
            {
                // The bridge must still work if the options page cannot be registered.
                Log.Warn($"options page not available: {e.Message}");
            }

            updateSystem.UpdateAt<BridgeSystem>(SystemUpdatePhase.UIUpdate);
            updateSystem.UpdateAt<BridgeToolSystem>(SystemUpdatePhase.ToolUpdate);
            updateSystem.UpdateAt<BridgeTransitToolSystem>(SystemUpdatePhase.ToolUpdate);
            updateSystem.UpdateAt<BridgeTransitRenameSystem>(SystemUpdatePhase.UIUpdate);
            updateSystem.UpdateAt<BridgeMapTileRefreshSystem>(SystemUpdatePhase.ToolUpdate);
            updateSystem.UpdateAt<BridgeRoadToolSystem>(SystemUpdatePhase.ToolUpdate);
        }

        public void OnDispose()
        {
            Log.Info($"{Name} disposing");
            BridgeSystem.Instance?.StopServer();
            if (m_Setting != null)
            {
                m_Setting.UnregisterInOptionsUI();
                m_Setting = null;
            }
        }
    }
}
