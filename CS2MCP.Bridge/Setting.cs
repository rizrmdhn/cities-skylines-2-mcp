using System;
using System.Collections.Generic;
using Colossal;
using Colossal.IO.AssetDatabase;
using Game.Modding;
using Game.Settings;

namespace CS2MCP
{
    /// <summary>
    /// Flags read by the HTTP listener threads, so they live outside the settings object and are
    /// volatile. CS2MCP_READONLY=1 in the game's environment forces read-only regardless of options.
    /// </summary>
    public static class BridgeOptions
    {
        private static volatile bool s_Enabled = true;
        private static volatile bool s_ReadOnly;

        public static readonly bool ReadOnlyForcedByEnvironment = IsTruthy(Environment.GetEnvironmentVariable("CS2MCP_READONLY"));

        public static bool Enabled
        {
            get => s_Enabled;
            set => s_Enabled = value;
        }

        public static bool ReadOnly
        {
            get => s_ReadOnly || ReadOnlyForcedByEnvironment;
            set => s_ReadOnly = value;
        }

        private static bool IsTruthy(string value)
        {
            return !string.IsNullOrEmpty(value)
                && (value == "1" || value.Equals("true", StringComparison.OrdinalIgnoreCase) || value.Equals("yes", StringComparison.OrdinalIgnoreCase));
        }
    }

    /// <summary>The mod's page in the game's Options menu.</summary>
    [FileLocation(nameof(CS2MCP))]
    [SettingsUIGroupOrder(kBridgeGroup)]
    [SettingsUIShowGroupName(kBridgeGroup)]
    public sealed class Setting : ModSetting
    {
        public const string kSection = "Main";
        public const string kBridgeGroup = "Bridge";

        private bool m_Enabled = true;
        private bool m_ReadOnly;

        public Setting(IMod mod) : base(mod)
        {
        }

        [SettingsUISection(kSection, kBridgeGroup)]
        public bool BridgeEnabled
        {
            get => m_Enabled;
            set
            {
                m_Enabled = value;
                BridgeOptions.Enabled = value;
            }
        }

        [SettingsUISection(kSection, kBridgeGroup)]
        public bool ReadOnlyMode
        {
            get => m_ReadOnly;
            set
            {
                m_ReadOnly = value;
                BridgeOptions.ReadOnly = value;
            }
        }

        public override void SetDefaults()
        {
            BridgeEnabled = true;
            ReadOnlyMode = false;
        }
    }

    /// <summary>English labels for the options page.</summary>
    public sealed class SettingLocaleEN : IDictionarySource
    {
        private readonly Setting m_Setting;

        public SettingLocaleEN(Setting setting)
        {
            m_Setting = setting;
        }

        public IEnumerable<KeyValuePair<string, string>> ReadEntries(IList<IDictionaryEntryError> errors, Dictionary<string, int> indexCounts)
        {
            return new Dictionary<string, string>
            {
                { m_Setting.GetSettingsLocaleID(), "CS2MCP (AI bridge)" },
                { m_Setting.GetOptionTabLocaleID(Setting.kSection), "Main" },
                { m_Setting.GetOptionGroupLocaleID(Setting.kBridgeGroup), "Bridge" },
                { m_Setting.GetOptionLabelLocaleID(nameof(Setting.BridgeEnabled)), "Accept AI requests" },
                {
                    m_Setting.GetOptionDescLocaleID(nameof(Setting.BridgeEnabled)),
                    "When off, the local bridge answers every request except the ping with 'disabled', so no AI client can read or change the city."
                },
                { m_Setting.GetOptionLabelLocaleID(nameof(Setting.ReadOnlyMode)), "Read-only mode" },
                {
                    m_Setting.GetOptionDescLocaleID(nameof(Setting.ReadOnlyMode)),
                    "When on, AI clients can read city data, the camera and screenshots, but every request that changes the game " +
                    "(building, demolishing, zoning, money, policies, simulation speed, saving) is refused. " +
                    "Setting CS2MCP_READONLY=1 for the game process forces this on."
                },
            };
        }

        public void Unload()
        {
        }
    }
}
