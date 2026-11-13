using System;
using System.Collections.Generic;
using Game.Net;
using Game.Prefabs;
using Game.Simulation;
using Game.UI;
using Game.Zones;
using Unity.Collections;
using Unity.Entities;
using Unity.Jobs;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>
    /// /city/survey: one compact snapshot of everything around a point that matters before building
    /// there (roads, junctions, buildings and what the game would auto-demolish, zoning, terrain and
    /// water, land value / pollution / noise, map tile ownership). Replaces chaining
    /// list_roads + buildings_near + zoning + terrain + gridmap. Read-only.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private const int kSurveyMaxRoads = 60;
        private const int kSurveyMaxJunctions = 40;
        private const int kSurveyMaxBuildings = 80;

        private BridgeResponse CitySurvey(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            if (!request.TryGetFloat("x", out float x) || !request.TryGetFloat("z", out float z))
            {
                return BridgeResponse.Error(400, "provide ?x=&z= (optionally radius 25-500, default 150, and include=roads,buildings,zones,terrain,environment,tiles)");
            }
            float radius = request.TryGetFloat("radius", out float rawRadius) ? math.clamp(rawRadius, 25f, 500f) : 150f;
            var sections = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (request.Query.TryGetValue("include", out string include) && !string.IsNullOrWhiteSpace(include))
            {
                foreach (string part in include.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string name = part.Trim();
                    if (name != "roads" && name != "buildings" && name != "zones" && name != "terrain"
                        && name != "environment" && name != "tiles")
                    {
                        return BridgeResponse.Error(400, $"unknown include '{name}'; use roads,buildings,zones,terrain,environment,tiles");
                    }
                    sections.Add(name);
                }
            }
            else
            {
                foreach (string name in new[] { "roads", "buildings", "zones", "terrain", "environment", "tiles" })
                {
                    sections.Add(name);
                }
            }

            float2 center = new float2(x, z);
            var summary = new List<string>();
            var result = new Dictionary<string, object>
            {
                ["area"] = new { x, z, radius },
            };

            if (sections.Contains("roads"))
            {
                result["roads"] = SurveyRoads(center, radius, summary);
            }
            if (sections.Contains("buildings"))
            {
                result["buildings"] = SurveyBuildings(center, radius, summary);
            }
            if (sections.Contains("zones"))
            {
                result["zones"] = SurveyZones(center, radius, summary);
            }
            if (sections.Contains("terrain"))
            {
                result["terrain"] = SurveyTerrain(center, radius, summary);
            }
            if (sections.Contains("environment"))
            {
                result["environment"] = SurveyEnvironment(center, radius, summary);
            }
            if (sections.Contains("tiles"))
            {
                result["tiles"] = SurveyTiles(center, radius, summary);
            }
            result["summary"] = summary;
            result["note"] = "lists are capped (see truncated); narrow radius or use cs2_buildings_near / cs2_list_roads for more. " +
                             "positions are world x/z meters; compass: +z = north, +x = east.";
            return BridgeResponse.Json(result);
        }

        // ---- roads ---------------------------------------------------------------------------------

        private object SurveyRoads(float2 center, float radius, List<string> summary)
        {
            NameSystem names = World.GetOrCreateSystemManaged<NameSystem>();
            var found = new List<(float Distance, Entity Edge)>();
            var nodes = new HashSet<Entity>();
            using (NativeArray<Entity> edges = TrafficRoadQuery.ToEntityArray(Allocator.Temp))
            using (NativeArray<Curve> curves = TrafficRoadQuery.ToComponentDataArray<Curve>(Allocator.Temp))
            {
                for (int i = 0; i < edges.Length; i++)
                {
                    if (EntityManager.HasComponent<Game.Common.Owner>(edges[i]))
                    {
                        continue;
                    }
                    Colossal.Mathematics.Bezier4x3 b = curves[i].m_Bezier;
                    float2 mid = Colossal.Mathematics.MathUtils.Position(b, 0.5f).xz;
                    float distance = math.distance(mid, center);
                    if (distance > radius)
                    {
                        continue;
                    }
                    found.Add((distance, edges[i]));
                    Edge edge = EntityManager.GetComponentData<Edge>(edges[i]);
                    nodes.Add(edge.m_Start);
                    nodes.Add(edge.m_End);
                }
            }
            found.Sort((a, b) => a.Distance.CompareTo(b.Distance));

            var roads = new List<object>();
            int highways = 0;
            for (int i = 0; i < found.Count; i++)
            {
                Entity edgeEntity = found[i].Edge;
                bool highway = IsHighwayRoad(edgeEntity);
                if (highway)
                {
                    highways++;
                }
                if (roads.Count >= kSurveyMaxRoads)
                {
                    continue;
                }
                Colossal.Mathematics.Bezier4x3 b = EntityManager.GetComponentData<Curve>(edgeEntity).m_Bezier;
                CountCarLanes(edgeEntity, out int forward, out int backward, out _, out _);
                RoadFlowPeriods(edgeEntity, out float flow, out float worstFlow, out _, out _);
                roads.Add(new
                {
                    entity = EntityRef(edgeEntity),
                    prefab = PrefabNameOf(edgeEntity),
                    street = StreetNameOf(names, edgeEntity),
                    start = new { x = math.round(b.a.x), z = math.round(b.a.z) },
                    end = new { x = math.round(b.d.x), z = math.round(b.d.z) },
                    lanesForward = forward,
                    lanesBackward = backward,
                    highway,
                    flowPercent = math.round(flow),
                    worstPeriodFlowPercent = math.round(worstFlow),
                });
            }

            var junctionList = new List<(float Distance, Entity Node)>();
            foreach (Entity node in nodes)
            {
                if (node == Entity.Null || !EntityManager.Exists(node) || !EntityManager.HasComponent<Node>(node))
                {
                    continue;
                }
                float3 position = EntityManager.GetComponentData<Node>(node).m_Position;
                float distance = math.distance(position.xz, center);
                if (distance <= radius && CountRoadLegs(node) >= 3)
                {
                    junctionList.Add((distance, node));
                }
            }
            junctionList.Sort((a, b) => a.Distance.CompareTo(b.Distance));
            var junctions = new List<object>();
            for (int i = 0; i < junctionList.Count && i < kSurveyMaxJunctions; i++)
            {
                Entity node = junctionList[i].Node;
                float3 position = EntityManager.GetComponentData<Node>(node).m_Position;
                junctions.Add(new
                {
                    node = EntityRef(node),
                    position = new { x = math.round(position.x), z = math.round(position.z) },
                    legs = CountRoadLegs(node),
                    control = JunctionControl(node),
                });
            }

            summary.Add(found.Count == 0
                ? "no roads in range"
                : $"{found.Count} road segments, {junctionList.Count} junctions" + (highways > 0 ? $", {highways} highway segments" : ""));
            return new
            {
                total = found.Count,
                truncated = math.max(0, found.Count - roads.Count),
                segments = roads,
                junctionsTotal = junctionList.Count,
                junctionsTruncated = math.max(0, junctionList.Count - junctions.Count),
                junctions,
                note = "lanesForward = driving lanes from start to end, lanesBackward = end to start; flowPercent 100 = free flow; junctions = nodes with 3+ road legs",
            };
        }

        // ---- buildings -----------------------------------------------------------------------------

        private object SurveyBuildings(float2 center, float radius, List<string> summary)
        {
            var found = new List<(float Distance, Entity Entity)>();
            using (NativeArray<Entity> buildings = PlacedBuildingQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity building in buildings)
                {
                    float distance = math.distance(EntityManager.GetComponentData<Game.Objects.Transform>(building).m_Position.xz, center);
                    if (distance <= radius)
                    {
                        found.Add((distance, building));
                    }
                }
            }
            found.Sort((a, b) => a.Distance.CompareTo(b.Distance));

            var items = new List<object>();
            int replaceable = 0;
            int burning = 0;
            int abandoned = 0;
            int condemned = 0;
            var kinds = new Dictionary<string, int>();
            for (int i = 0; i < found.Count; i++)
            {
                Entity building = found[i].Entity;
                Entity prefabEntity = EntityManager.GetComponentData<PrefabRef>(building).m_Prefab;
                bool growable = EntityManager.HasComponent<SpawnableBuildingData>(prefabEntity);
                bool signature = EntityManager.HasComponent<SignatureBuildingData>(prefabEntity);
                bool isReplaceable = growable && !signature;
                bool onFire = EntityManager.HasComponent<Game.Events.OnFire>(building);
                bool isAbandoned = EntityManager.HasComponent<Game.Buildings.Abandoned>(building);
                bool isCondemned = EntityManager.HasComponent<Game.Buildings.Condemned>(building);
                string kind = EntityManager.HasComponent<Game.Buildings.ResidentialProperty>(building) ? "residential"
                    : EntityManager.HasComponent<Game.Buildings.CommercialProperty>(building) ? "commercial"
                    : EntityManager.HasComponent<Game.Buildings.OfficeProperty>(building) ? "office"
                    : EntityManager.HasComponent<Game.Buildings.IndustrialProperty>(building) ? "industrial"
                    : EntityManager.HasComponent<Game.Buildings.Park>(building) ? "park"
                    : EntityManager.HasComponent<ServiceObjectData>(prefabEntity) ? "service"
                    : "other";
                kinds[kind] = kinds.TryGetValue(kind, out int count) ? count + 1 : 1;
                if (isReplaceable) replaceable++;
                if (onFire) burning++;
                if (isAbandoned) abandoned++;
                if (isCondemned) condemned++;
                if (items.Count >= kSurveyMaxBuildings)
                {
                    continue;
                }
                Game.Objects.Transform transform = EntityManager.GetComponentData<Game.Objects.Transform>(building);
                int2 lot = EntityManager.HasComponent<BuildingData>(prefabEntity)
                    ? EntityManager.GetComponentData<BuildingData>(prefabEntity).m_LotSize
                    : default;
                float3 forward = math.mul(transform.m_Rotation, new float3(0f, 0f, 1f));
                items.Add(new
                {
                    entity = EntityRef(building),
                    prefab = PrefabNameOf(building),
                    kind,
                    origin = growable ? "zonedGrowable" : "ploppable",
                    replaceable = isReplaceable,
                    position = new { x = math.round(transform.m_Position.x), z = math.round(transform.m_Position.z) },
                    distance = math.round(found[i].Distance),
                    lotMeters = new { width = lot.x * 8, depth = lot.y * 8 },
                    facingDegrees = math.round(BearingDegrees(forward.xz)),
                    onFire = onFire ? true : (bool?)null,
                    abandoned = isAbandoned ? true : (bool?)null,
                    condemned = isCondemned ? true : (bool?)null,
                });
            }

            if (replaceable > 0)
            {
                summary.Add($"{replaceable} zoned growable buildings here would be auto-demolished if a new building/road overlaps them (cs2_demolish is not needed for those)");
            }
            if (found.Count - replaceable > 0)
            {
                summary.Add($"{found.Count - replaceable} buildings are ploppable/signature: building over them requires cs2_demolish first");
            }
            if (burning + abandoned + condemned > 0)
            {
                summary.Add($"problem buildings: {burning} on fire, {abandoned} abandoned, {condemned} condemned");
            }
            if (found.Count == 0)
            {
                summary.Add("no buildings in range");
            }
            return new
            {
                total = found.Count,
                truncated = math.max(0, found.Count - items.Count),
                replaceableCount = replaceable,
                byKind = kinds,
                items,
                note = "nearest first; replaceable = zoned growable (SpawnableBuildingData, not signature) that the game auto-demolishes when a placement overlaps it; " +
                       "facingDegrees = compass bearing of the front (road side); lot = footprint",
            };
        }

        // ---- zones ---------------------------------------------------------------------------------

        private object SurveyZones(float2 center, float radius, List<string> summary)
        {
            var zoneNames = new Dictionary<ushort, string>();
            PrefabSystem prefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            using (NativeArray<Entity> zonePrefabs = ZonePrefabQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity entity in zonePrefabs)
                {
                    PrefabBase prefab = prefabSystem.GetPrefab<PrefabBase>(entity);
                    if (prefab != null)
                    {
                        zoneNames[EntityManager.GetComponentData<ZoneData>(entity).m_ZoneType.m_Index] = prefab.name;
                    }
                }
            }

            var byZone = new Dictionary<string, int[]>();
            int zonable = 0;
            int zoned = 0;
            int occupiedTotal = 0;
            using (NativeArray<Entity> blocks = ZoneBlockQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity blockEntity in blocks)
                {
                    Block block = EntityManager.GetComponentData<Block>(blockEntity);
                    float blockExtent = kCellSize * (math.cmax(block.m_Size) + 1) * 0.71f;
                    if (math.distance(block.m_Position.xz, center) > radius + blockExtent)
                    {
                        continue;
                    }
                    DynamicBuffer<Cell> cells = EntityManager.GetBuffer<Cell>(blockEntity, isReadOnly: true);
                    for (int i = 0; i < cells.Length; i++)
                    {
                        Cell cell = cells[i];
                        if ((cell.m_State & CellFlags.Visible) == 0)
                        {
                            continue;
                        }
                        int2 cellIndex = new int2(i % block.m_Size.x, i / block.m_Size.x);
                        if (math.distance(ZoneUtils.GetCellPosition(block, cellIndex).xz, center) > radius)
                        {
                            continue;
                        }
                        zonable++;
                        if (cell.m_Zone.Equals(ZoneType.None))
                        {
                            continue;
                        }
                        zoned++;
                        string name = zoneNames.TryGetValue(cell.m_Zone.m_Index, out string zoneName) ? zoneName : $"<index {cell.m_Zone.m_Index}>";
                        if (!byZone.TryGetValue(name, out int[] counts))
                        {
                            counts = new int[2];
                            byZone[name] = counts;
                        }
                        counts[0]++;
                        if ((cell.m_State & CellFlags.Occupied) != 0)
                        {
                            counts[1]++;
                            occupiedTotal++;
                        }
                    }
                }
            }

            var perZone = new Dictionary<string, object>();
            foreach (KeyValuePair<string, int[]> pair in byZone)
            {
                perZone[pair.Key] = new { cells = pair.Value[0], occupied = pair.Value[1], empty = pair.Value[0] - pair.Value[1] };
            }
            if (zoned > 0)
            {
                summary.Add($"{zoned} zoned cells ({zoned - occupiedTotal} empty, {occupiedTotal} occupied) in {byZone.Count} zone types");
            }
            else
            {
                summary.Add(zonable > 0 ? $"{zonable} zonable cells, none zoned yet" : "no zone blocks (no road frontage) in range");
            }
            return new
            {
                zonableCells = zonable,
                zonedCells = zoned,
                occupiedCells = occupiedTotal,
                emptyCells = zoned - occupiedTotal,
                byZone = perZone,
            };
        }

        // ---- terrain -------------------------------------------------------------------------------

        private object SurveyTerrain(float2 center, float radius, List<string> summary)
        {
            const int n = 21; // samples per side across the square around the center
            TerrainSystem terrainSystem = World.GetOrCreateSystemManaged<TerrainSystem>();
            TerrainHeightData heightData = terrainSystem.GetHeightData();
            WaterSystem waterSystem = World.GetOrCreateSystemManaged<WaterSystem>();
            WaterSurfaceData<SurfaceWater> surface = waterSystem.GetSurfaceData(out JobHandle deps);
            deps.Complete();

            float step = radius * 2f / (n - 1);
            var heights = new float[n, n];
            var inside = new bool[n, n];
            float min = float.MaxValue, max = float.MinValue, sum = 0f;
            int count = 0;
            int waterCells = 0;
            float nearestWater = float.MaxValue;
            float2 nearestWaterPoint = default;
            float maxDepth = 0f;
            for (int row = 0; row < n; row++)
            {
                for (int col = 0; col < n; col++)
                {
                    float2 p = center + new float2(-radius + col * step, -radius + row * step);
                    float distance = math.distance(p, center);
                    if (distance > radius)
                    {
                        continue;
                    }
                    var p3 = new float3(p.x, 0f, p.y);
                    float h = TerrainUtils.SampleHeight(ref heightData, p3);
                    heights[row, col] = h;
                    inside[row, col] = true;
                    min = math.min(min, h);
                    max = math.max(max, h);
                    sum += h;
                    count++;
                    float depth = WaterUtils.SampleDepth(ref surface, p3);
                    if (depth > 0.05f)
                    {
                        waterCells++;
                        maxDepth = math.max(maxDepth, depth);
                        if (distance < nearestWater)
                        {
                            nearestWater = distance;
                            nearestWaterPoint = p;
                        }
                    }
                }
            }

            float maxSlope = 0f; // rise over run, as a percentage
            for (int row = 0; row < n; row++)
            {
                for (int col = 0; col < n; col++)
                {
                    if (!inside[row, col])
                    {
                        continue;
                    }
                    if (col + 1 < n && inside[row, col + 1])
                    {
                        maxSlope = math.max(maxSlope, math.abs(heights[row, col + 1] - heights[row, col]) / step * 100f);
                    }
                    if (row + 1 < n && inside[row + 1, col])
                    {
                        maxSlope = math.max(maxSlope, math.abs(heights[row + 1, col] - heights[row, col]) / step * 100f);
                    }
                }
            }

            object water = null;
            if (waterCells > 0)
            {
                float2 delta = nearestWaterPoint - center;
                water = new
                {
                    present = true,
                    coveragePercent = math.round(waterCells * 100f / math.max(1, count)),
                    maxDepth = math.round(maxDepth * 10f) / 10f,
                    nearest = new
                    {
                        x = math.round(nearestWaterPoint.x),
                        z = math.round(nearestWaterPoint.y),
                        distance = math.round(nearestWater),
                        direction = Compass(delta),
                    },
                };
                summary.Add(nearestWater < step
                    ? $"water within the area ({math.round(waterCells * 100f / math.max(1, count))}% of samples), nearest {Compass(delta)}"
                    : $"water {math.round(nearestWater)} m {Compass(delta)}");
            }
            else
            {
                water = new { present = false };
            }
            if (maxSlope >= 25f)
            {
                summary.Add($"steep terrain (up to ~{math.round(maxSlope)}% slope, {math.round(max - min)} m relief)");
            }
            return new
            {
                minHeight = math.round(min * 10f) / 10f,
                maxHeight = math.round(max * 10f) / 10f,
                avgHeight = math.round(sum / math.max(1, count) * 10f) / 10f,
                maxSlopePercent = math.round(maxSlope),
                sampleSpacing = math.round(step),
                water,
                note = "slope is estimated from a ~21x21 sample grid, so it understates short steep spots on large radii",
            };
        }

        private static string Compass(float2 delta)
        {
            if (math.lengthsq(delta) < 0.01f)
            {
                return "here";
            }
            string[] names = { "north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest" };
            int index = (int)math.round(BearingDegrees(delta) / 45f) % 8;
            return names[index];
        }

        // ---- environment ---------------------------------------------------------------------------

        private object SurveyEnvironment(float2 center, float radius, List<string> summary)
        {
            JobHandle deps;
            NativeArray<LandValueCell> landValue = World.GetOrCreateSystemManaged<LandValueSystem>().GetMap(readOnly: true, out deps);
            deps.Complete();
            NativeArray<GroundPollution> ground = World.GetOrCreateSystemManaged<GroundPollutionSystem>().GetMap(readOnly: true, out deps);
            deps.Complete();
            NativeArray<AirPollution> air = World.GetOrCreateSystemManaged<AirPollutionSystem>().GetMap(readOnly: true, out deps);
            deps.Complete();
            NativeArray<NoisePollution> noise = World.GetOrCreateSystemManaged<NoisePollutionSystem>().GetMap(readOnly: true, out deps);
            deps.Complete();

            Stats land = SampleCellRange(landValue, center, radius, c => c.m_LandValue);
            Stats groundStats = SampleCellRange(ground, center, radius, c => c.m_Pollution);
            Stats airStats = SampleCellRange(air, center, radius, c => c.m_Pollution);
            Stats noiseStats = SampleCellRange(noise, center, radius, c => c.m_Pollution);

            if (noiseStats.Avg >= 50f || noiseStats.Max >= 150f)
            {
                summary.Add($"high noise (avg {math.round(noiseStats.Avg)}, max {math.round(noiseStats.Max)})");
            }
            if (airStats.Avg >= 50f || airStats.Max >= 150f)
            {
                summary.Add($"high air pollution (avg {math.round(airStats.Avg)}, max {math.round(airStats.Max)})");
            }
            if (groundStats.Avg >= 50f || groundStats.Max >= 150f)
            {
                summary.Add($"high ground pollution (avg {math.round(groundStats.Avg)}, max {math.round(groundStats.Max)})");
            }
            summary.Add($"land value avg {math.round(land.Avg)} (max {math.round(land.Max)})");
            return new
            {
                landValue = new { avg = math.round(land.Avg), max = math.round(land.Max) },
                groundPollution = new { avg = math.round(groundStats.Avg), max = math.round(groundStats.Max) },
                airPollution = new { avg = math.round(airStats.Avg), max = math.round(airStats.Max) },
                noisePollution = new { avg = math.round(noiseStats.Avg), max = math.round(noiseStats.Max) },
                note = "raw cell-map units, sampled only from the cells inside the radius (same scale as cs2_gridmap); compare with cs2_gridmap or other spots",
            };
        }

        private struct Stats
        {
            public float Avg;
            public float Max;
        }

        /// <summary>Average and maximum of a square cell map over the cells whose centers lie inside the circle.</summary>
        private static Stats SampleCellRange<T>(NativeArray<T> map, float2 center, float radius, Func<T, float> selector) where T : struct
        {
            int size = (int)math.round(math.sqrt(map.Length));
            if (size <= 0)
            {
                return default;
            }
            float cell = kWorldHalfSize * 2f / size;
            int colMin = math.clamp((int)math.floor((center.x - radius + kWorldHalfSize) / cell), 0, size - 1);
            int colMax = math.clamp((int)math.floor((center.x + radius + kWorldHalfSize) / cell), 0, size - 1);
            int rowMin = math.clamp((int)math.floor((center.y - radius + kWorldHalfSize) / cell), 0, size - 1);
            int rowMax = math.clamp((int)math.floor((center.y + radius + kWorldHalfSize) / cell), 0, size - 1);
            float sum = 0f;
            float max = float.MinValue;
            int count = 0;
            for (int row = rowMin; row <= rowMax; row++)
            {
                float cz = -kWorldHalfSize + (row + 0.5f) * cell;
                for (int col = colMin; col <= colMax; col++)
                {
                    float cx = -kWorldHalfSize + (col + 0.5f) * cell;
                    if (math.distancesq(new float2(cx, cz), center) > radius * radius)
                    {
                        continue;
                    }
                    float v = selector(map[row * size + col]);
                    sum += v;
                    max = math.max(max, v);
                    count++;
                }
            }
            if (count == 0)
            {
                // Radius smaller than a cell: use the cell containing the center.
                int col = math.clamp((int)math.floor((center.x + kWorldHalfSize) / cell), 0, size - 1);
                int row = math.clamp((int)math.floor((center.y + kWorldHalfSize) / cell), 0, size - 1);
                float v = selector(map[row * size + col]);
                return new Stats { Avg = v, Max = v };
            }
            return new Stats { Avg = sum / count, Max = max };
        }

        // ---- map tiles -----------------------------------------------------------------------------

        private object SurveyTiles(float2 center, float radius, List<string> summary)
        {
            var owned = new List<(float2 Min, float2 Max)>();
            using (NativeArray<Entity> tiles = MapTileAreaQuery.ToEntityArray(Allocator.Temp))
            {
                foreach (Entity tile in tiles)
                {
                    if (EntityManager.HasComponent<Game.Common.Native>(tile))
                    {
                        continue;
                    }
                    Game.Areas.Geometry geometry = EntityManager.GetComponentData<Game.Areas.Geometry>(tile);
                    owned.Add((geometry.m_Bounds.min.xz, geometry.m_Bounds.max.xz));
                }
            }

            bool Owns(float2 p)
            {
                foreach ((float2 Min, float2 Max) b in owned)
                {
                    if (p.x >= b.Min.x && p.x <= b.Max.x && p.y >= b.Min.y && p.y <= b.Max.y)
                    {
                        return true;
                    }
                }
                return false;
            }

            bool centerOwned = Owns(center);
            // 41 samples around the circle plus an inner grid, enough to catch a tile edge crossing the area.
            int total = 0;
            int ownedCount = 0;
            const int grid = 9;
            for (int row = 0; row < grid; row++)
            {
                for (int col = 0; col < grid; col++)
                {
                    float2 p = center + new float2(-radius + col * radius * 2f / (grid - 1), -radius + row * radius * 2f / (grid - 1));
                    if (math.distance(p, center) > radius)
                    {
                        continue;
                    }
                    total++;
                    if (Owns(p))
                    {
                        ownedCount++;
                    }
                }
            }
            for (int i = 0; i < 32; i++)
            {
                float angle = i * math.PI * 2f / 32f;
                float2 p = center + new float2(math.cos(angle), math.sin(angle)) * radius;
                total++;
                if (Owns(p))
                {
                    ownedCount++;
                }
            }
            bool fullyOwned = ownedCount == total;
            if (!centerOwned)
            {
                summary.Add("center is NOT on an owned map tile (cannot build there; buy it with cs2_buy_map_tiles)");
            }
            else if (!fullyOwned)
            {
                summary.Add($"area is only partly inside owned map tiles (~{math.round(ownedCount * 100f / total)}% of samples owned)");
            }
            return new
            {
                centerOwned,
                fullyOwned,
                ownedPercent = math.round(ownedCount * 100f / math.max(1, total)),
                note = "sampled on a grid and the circle edge; false means part of the radius is outside tiles you own",
            };
        }
    }
}
