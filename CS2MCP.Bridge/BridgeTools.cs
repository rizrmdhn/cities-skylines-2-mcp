using Game.Tools;
using Unity.Entities;

namespace CS2MCP
{
    /// <summary>
    /// Shared gate for the bridge's headless tools. Only one of them can be the
    /// game's active tool, so an operation queued while another bridge tool is
    /// mid-operation would displace it (the displaced request fails with
    /// "interrupted") and would later hand the game back an idle bridge tool as
    /// the "previous" tool. Every TryQueue* goes through AnyBusy, and Activate
    /// through PreviousTool, so neither can happen.
    /// </summary>
    internal static class BridgeTools
    {
        /// <summary>True while any bridge tool is mid-operation. Simulation thread only.</summary>
        public static bool AnyBusy(World world)
        {
            return world.GetOrCreateSystemManaged<BridgeToolSystem>().IsBusy
                || world.GetOrCreateSystemManaged<BridgeRoadToolSystem>().IsBusy
                || world.GetOrCreateSystemManaged<BridgeTransitToolSystem>().IsBusy
                || world.GetOrCreateSystemManaged<BridgeAreaToolSystem>().IsBusy;
        }

        public static bool IsBridgeTool(ToolBaseSystem tool)
        {
            return tool is BridgeToolSystem
                || tool is BridgeRoadToolSystem
                || tool is BridgeTransitToolSystem
                || tool is BridgeAreaToolSystem;
        }

        /// <summary>
        /// The tool to restore once a bridge operation finishes: the player's
        /// current tool, or null (= the default tool) when the active tool is
        /// itself a bridge tool.
        /// </summary>
        public static ToolBaseSystem PreviousTool(ToolSystem toolSystem)
        {
            ToolBaseSystem active = toolSystem.activeTool;
            return IsBridgeTool(active) ? null : active;
        }
    }
}
