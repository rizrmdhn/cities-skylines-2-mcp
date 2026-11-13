# CS2MCP — Cities: Skylines II 的 MCP 服务器

[English](README.md) | **简体中文**

让 Claude 等 MCP 客户端**完全操作**正在运行的《城市：天际线 2》：读取城市数据、控制相机与截图、建设道路建筑、划区、管理财政政策、控制模拟时间。

## 架构

```
Claude Code / Claude Desktop（任意 MCP 客户端）
      │  MCP (stdio)
      ▼
cs2-mcp  (mcp-server/，Node.js 进程)
      │  HTTP，仅本机 127.0.0.1:8642
      ▼
CS2MCP 桥接 Mod  (CS2MCP.Bridge/，游戏进程内)
      │  ECS 查询与写入均在模拟主线程执行
      ▼
Cities: Skylines II
```

- **游戏内 Mod**（C#）：在游戏进程里用 `TcpListener` 起一个仅监听 127.0.0.1 的极简 HTTP 服务。请求由监听线程排队，在注册于 `SystemUpdatePhase.UIUpdate` 的 ECS System 中于模拟主线程执行（暂停时也可用）。建设操作通过自定义 `ToolBaseSystem` 走游戏原生的定义/校验/提交管线，拆除走推土机管线——不做任何绕过游戏校验的直接实体修改。
- **MCP Server**（TypeScript）：把 MCP 工具调用翻译为对桥接 Mod 的 HTTP 请求，stdio 传输。

## 环境要求

- Windows + Steam 版《城市：天际线 2》
- .NET SDK 8.0+（编译 Mod）
- Node.js 18+（运行 MCP server），Web 伴侣需要 22.12+

## 构建与安装

```powershell
# 1. 编译游戏内 Mod（构建后自动部署到游戏的本地 Mods 目录）
dotnet build CS2MCP.Bridge\CS2MCP.Bridge.csproj

# 2. 安装并构建 MCP server 与 Web 伴侣（在仓库根目录执行）
npm run setup
npm run build
```

根目录脚本（在仓库根目录执行 `npm run <名称>`）：

| 脚本 | 作用 |
|---|---|
| `setup` | 在 `mcp-server/`、`web/` 和 `desktop/` 中执行 `npm install` |
| `build` / `build:mcp` / `build:web` / `build:desktop` | 构建 MCP 与 Web，或单独构建其中一个组件 |
| `mcp:register` / `mcp:unregister` | 以用户级作用域把 `cs2` 注册到 Claude Code（所有项目可用），或将其移除 |
| `web` | 构建并启动 [Web 伴侣](#web-伴侣)，地址 http://127.0.0.1:8643 |
| `web:start` / `web:dev` | 不重新构建直接启动 / 以热更新模式运行于 http://127.0.0.1:5173 |
| `web:shortcut` / `web:shortcut:remove` | 在桌面创建 **CS2MCP Companion** 快捷方式（Windows），或将其删除 |
| `web:open` / `web:restart` / `web:stop` | 快捷方式所做的事（需要时在后台启动并打开浏览器）/ 重启 / 停止后台服务器 |
| `desktop:start` / `desktop:build` | 启动原生伴侣 / 构建 Electron 应用（同时构建 Web 界面） |
| `desktop:pack` / `desktop:dist` | 创建未安装的 Windows 应用 / Windows 安装包、便携 ZIP 和更新元数据 |
| `test` | 对 Web 伴侣做类型检查并运行测试 |

Mod 会部署到 `%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Mods\CS2MCP\`，游戏启动时自动加载，无需发布到 Paradox Mods。想临时禁用：把该文件夹改名为 `.CS2MCP`。

### 游戏路径配置

编译 Mod 需要引用游戏目录下的程序集。查找顺序（先命中先用）：

1. 命令行参数：`dotnet build -p:GamePath="X:\...\Cities Skylines II"`
2. 环境变量 **`CS2_PATH`**
3. 环境变量 `CSII_INSTALLATIONPATH`（官方 Modding 工具链设置）
4. 常见 Steam 库位置自动探测（`C:\Program Files (x86)\Steam`、各盘符 `Steam` / `SteamLibrary`）

找不到游戏时构建会报出明确错误。设置环境变量示例：

```powershell
setx CS2_PATH "D:\Steam\steamapps\common\Cities Skylines II"
```

### 运行时环境变量（支持 .env）

MCP server 通过 [dotenv](https://github.com/motdotla/dotenv) 读取 `mcp-server/.env`（参考 `.env.example`），无论从哪个目录启动都一样；工作目录中的 `.env` 只补充它未设置的变量。Web 伴侣先读 `web/.env`，再读同一个 `mcp-server/.env`，因此一个文件即可同时配置两者。

| 变量 | 作用域 | 默认值 | 说明 |
|---|---|---|---|
| `CS2_BRIDGE_URL` | MCP server、Web 伴侣 | `http://127.0.0.1:8642` | 桥接 Mod 的地址 |
| `CS2MCP_PORT` | 游戏进程 | `8642` | 桥接 Mod 的监听端口（改它需同步改 `CS2_BRIDGE_URL`） |
| `CS2MCP_WEB_PORT` | Web 伴侣 | `8643` | Web 伴侣的端口 |
| `CS2MCP_TOKEN` | 游戏进程、MCP server **与** Web 伴侣 | *（未设置）* | 可选共享密钥，以 `X-CS2MCP-Token` 请求头发送；给游戏进程设置后，除 `/ping` 外所有路由都要求携带。此外无论是否设置，带 `Origin` 头或 `Host` 非回环地址的请求一律拒绝，改变状态的路由必须用 POST |
| `CS2_PATH` | 构建期 | 自动探测 | 游戏安装目录 |

## 在 Claude 中使用

**Claude Code**：要在所有项目中使用 `cs2`，在仓库根目录以用户级作用域注册一次：

```powershell
npm run mcp:register      # 先构建 MCP server，再执行：claude mcp add --scope user cs2 -- node <仓库路径>\mcp-server\dist\index.js
npm run mcp:unregister    # 移除注册
```

在本仓库内，[.mcp.json](.mcp.json) 也会以项目级作用域注册 `cs2`（首次会询问是否信任），贡献者无需额外注册。

**Claude Desktop**（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "cs2": {
      "command": "node",
      "args": ["<仓库路径>\\mcp-server\\dist\\index.js"]
    }
  }
}
```

启动游戏、读取存档，然后问 Claude："看看我的城市财政状况"、"在河边划一片住宅区"、"修一条路把工业区接上高速"。

## Web 伴侣

一个只读页面，可以放在游戏和对话窗口旁边：

- **仪表盘**：连接状态（桥接是否可达、游戏是否在加载、AI 请求是否关闭、只读模式、版本不一致）、城市概况、各项城市服务的状态（交通、电力、供水、污水、垃圾与回收、医疗、消防救援、警察、避难所、教育、邮政、公园、福利、通信）及各领域的警告图标、按幸福感与健康拆分的幸福度因素、城市中所有警告类型，以及分区需求。
- **AI 活动**：经由桥接做出的每一项改动及其花费、结果与参数，以及相对 AI 花费上限的使用情况。
- **地图**：以热力图显示整张地图的一个数据图层（地价、污染、地下水），放大后显示道路与车流（按 2 公里图块加载并缓存 5 分钟；经由桥接的改动会刷新它们）、游戏镜头位置，以及 AI 改动的位置。点击一个点，或拖出一个区域或一条线，即可得到世界坐标和可直接粘贴给 AI 的提示词。图层、位置与选择都保存在 URL 中。

```powershell
npm run web:shortcut   # 只需一次：构建并在桌面创建 "CS2MCP Companion" 快捷方式
```

游戏时双击该快捷方式：若伴侣尚未运行，会在后台启动（不显示控制台窗口），并在浏览器中打开 http://127.0.0.1:8643。关闭标签页后服务器继续运行，下次点击即刻打开；用 `npm run web:stop` 停止它。修改代码后先执行 `npm run build:web`，再执行 `npm run web:restart`（旧版本的服务器也会被快捷方式自动重启）。日志位于 `web/.runtime/companion.log`。若想在终端中运行：`npm run web`。

浏览器从不直接访问桥接 Mod。伴侣服务器只监听 `127.0.0.1`，只转发固定列表中的只读 GET 路由，拒绝其他 Host、跨站请求和其他 HTTP 方法，并在服务器端附加 `CS2MCP_TOKEN`，令牌不会到达浏览器。它独立于 MCP server 运行，因此可以同时运行任意多个 MCP 客户端。

## 原生桌面伴侣

Windows 桌面应用通过 Electron 承载现有 React 伴侣，并提供系统托盘、置顶迷你浮窗、通知、趋势历史、已保存的城市会话、游戏检测、Windows 启动项、自动更新和首次启动设置向导。它可以打包 MCP server 并为受支持的 AI 客户端完成注册，因此桌面使用流程无需另行安装 Node.js。

```powershell
npm run desktop:dist   # 在 desktop/release/ 生成 Windows 安装包和便携 ZIP
```

安装程序按当前用户安装，无需管理员权限。卸载后设置和历史记录仍保留在 `%APPDATA%\CS2MCP Companion`。开发、设置、打包、更新与发布说明见 [desktop/README.md](desktop/README.md)。Web 伴侣仍可通过上面的命令独立使用。

## 工具总览（92 个）

**状态与画面**

| 工具 | 说明 |
|---|---|
| `cs2_ping` | 桥存活、Mod 版本、游戏模式（读档中也能响应） |
| `cs2_game_state` | 模式、城市名、暂停/速度、游戏内日期时间 |
| `cs2_city_overview` | 人口、幸福度、健康度、资金、XP、日期 |
| `cs2_screenshot` | 当前画面 PNG（帧末采集，默认缩至 1280 宽） |
| `cs2_get_camera` / `cs2_set_camera` | 相机读写（观察点/角度/距离），配合截图 = AI 自主取景 |

**城市数据**

| 工具 | 说明 |
|---|---|
| `cs2_demand` | RCI 需求 + 需求因子（内部 0-255 刻度，暂停时不刷新） |
| `cs2_budget` | 收支明细：14 项收入 / 15 项支出来源 |
| `cs2_city_services` | 电力、水务、垃圾状态 |
| `cs2_infoview` | 即时重新计算的游戏信息视图面板数据：教育（各学段在读/适龄/容量）、医疗（病人、墓地）、垃圾（填埋场、处理）、警察（拘留所、监狱、犯罪）、避难所、电力、供水、邮政、通信等 |
| `cs2_happiness` | 城市信息面板的幸福度因素（税、污染、服务、无家可归……）及其对健康/幸福的影响，最差优先 |
| `cs2_economy` | 经济 > 生产面板的各资源数据（产量、含服务维护与最终消费的消耗、平衡、进出口、库存、产能、最大缺口），以及企业统计（岗位填充、盈利） |
| `cs2_resources` | 自然资源地图（肥力、矿石、石油、鱼类、森林）及总量和最富集区域，用于选址专业化工业 |
| `cs2_progression` | 经验、已达里程碑、下一里程碑进度和奖励、发展点数 |
| `cs2_dev_tree` / `cs2_dev_tree_purchase` | 发展树节点（价格、为何暂不能购买）/ 像发展树面板一样购买节点 |
| `cs2_service_districts` / `cs2_set_service_districts` | 服务建筑的服务地区（全市或限定地区）、各服务未被覆盖的地区、每个地区未覆盖它的服务建筑；可修改建筑的服务地区 |
| `cs2_coverage` | 分区建筑的公共服务覆盖（医疗、消防、警察、公园、邮政、教育、避难所、福利、通信）：覆盖不足的建筑/居民、按信息视图色阶分级、服务建筑数量，以及适合新建服务建筑的最大覆盖缺口 |
| `cs2_labor` | 就业、失业率、按教育等级的岗位供需、年龄结构 |
| `cs2_statistics` | 60+ 种统计项历史曲线（每游戏日 32 采样） |
| `cs2_terrain` | 全图高度 + 水体栅格 |
| `cs2_gridmap` | 地价/地面污染/空气污染/噪音/地下水等 6 层原生栅格（可按 x/z/radius 裁剪） |
| `cs2_survey` | 建造前一次性勘察区域：道路与路口、建筑（含哪些分区建筑会被自动替换）、区划、地形/水体、地价/污染/噪音、地块归属 |
| `cs2_zoning` | 区划现状汇总（占用/空置） |
| `cs2_notifications` | 全城警告图标（缺电缺水/弃置等）+ 目标实体 |
| `cs2_traffic` | 全城交通流量、最堵道路（流量百分比、车流量、每日四个时段）与交通瓶颈，数字取自游戏本身 |
| `cs2_traffic_diagnose` | 诊断某条道路或路口为何拥堵：路口布局与车道、车辆类型及其等待原因、过境与本地交通及目的地聚集、根据车辆路径统计的转向流量、平行道路，以及附带修复工具的交通工程结论 |
| `cs2_vehicles` | 行驶中车辆按类型与目的地统计、停下的车在等什么、堵住车流的队首车辆及死锁环 |
| `cs2_road_graph` | 区域内路段及其路口、方向、流量与红绿灯（可选包含所有网络，含车站轨道） |
| `cs2_inspect` | 单实体详情（住户/雇员/状态标志） |

**建设**

| 工具 | 说明 |
|---|---|
| `cs2_find_prefabs` | 按名称搜索建筑/道路/网络/树木预设 |
| `cs2_place_building` | 放置建筑/树木（地形高度自动采样、旋转可调、原生校验） |
| `cs2_build_road` | 任意网络段：直线 / `cx,cz` 曲线 / `e1,e2` 高程（高架桥、匝道） |
| `cs2_upgrade_road` | 道路升级：草地/树/宽人行道/隔音屏/停车位/路灯/中央绿化 |
| `cs2_set_junction_control` | 把路口设为红绿灯、无灯、全向停车或游戏默认（即路口工具的节点升级） |
| `cs2_replace_road` | 原地更换已有路段的道路类型（道路工具的替换模式）：拓宽高速、改为单行道 |
| `cs2_replace_net` | 同上，适用于任意网络类型，包括火车、有轨电车和地铁轨道（最多 30 段，全部成功或全部不变） |
| `cs2_specialized_area` | 专业化工业（农业、林业、矿石、石油、渔业）：列出、放置带采集建筑的中心、重绘采集区域 |
| `cs2_connect_road` | 修建两端吸附到已有路口或切分已有路段的道路/轨道（同道路工具的吸附），可抬高或下沉 |
| `cs2_build_interchange` | 一次调用规划并修建整座立交：`diamond`（菱形）、`parclo`（部分苜蓿叶）用于高速接普通道路，`cloverleaf`（全苜蓿叶）、`trumpet`（喇叭形）用于高速接高速；匝道半径按 AASHTO 最小半径公式计算，坡度不超过 8%，失败时自动回滚（详见英文 README 的 Interchanges 一节） |
| `cs2_batch` | 在游戏内按顺序执行最多 96 个建造操作（放置、修路、连接、升级、分区、拆除），一次返回每一步的结果 |
| `cs2_history` | 本次读档以来通过桥接所做的全部改动（参数、结果、国库变化）、建造花费及玩家设置的 AI 花费上限 |
| `cs2_prefab_info` | 建筑的占地、尺寸、放置规则与造价，或网络的宽度与层级 |
| `cs2_place_shoreline` | 在水岸放置港口、水泵等临水建筑，按游戏放置工具的方式吸附 |
| `cs2_place_roadside` | 把车站、车库或服务建筑紧贴路段放置并朝向道路 |
| `cs2_buildings_near` | 某点周围的建筑（类型、占地、朝向），用于找空位或确定要清理的对象 |
| `cs2_zone_area` / `cs2_list_zones` | 划区与区划类型（`None` 清除） |
| `cs2_demolish` | 拆除建筑/路段/树木/地区（推土机管线） |
| `cs2_building_connections` | 车站、车库或港口尚未连接的轨道/道路/步道/航道端点及其朝外方向 |
| `cs2_building_upgrades` / `cs2_place_upgrade` | 服务建筑的升级菜单（价格、锁定、是否已建、放置方式）/ 通过游戏升级管线安装升级 |
| `cs2_terraform` | 地形笔刷：在某点抬高、降低、整平（到指定高度）或平滑，由游戏校验 |
| `cs2_rename` | 重命名建筑、地区、街道或公交线路（空名称恢复默认） |
| `cs2_move_building` | 不拆除即可把服务/标志性建筑、服务升级、公园或道具移到新位置/朝向（游戏自带的搬迁管线：实体、升级、员工和车辆保留；由游戏校验，`dryRun` 可试探） |
| `cs2_list_buildings` / `cs2_list_roads` / `cs2_list_objects` | 实体清单（ID、坐标） |

**财政与政策**

| 工具 | 说明 |
|---|---|
| `cs2_get_taxes` / `cs2_set_tax` | 四大区类税率（钳制在游戏允许范围） |
| `cs2_resource_tax` | 各产出资源的工业税率：读取全部或设置单项 |
| `cs2_policies` / `cs2_set_policy` | 城市政策（含本地化名称） |
| `cs2_service_budgets` / `cs2_set_service_budget` | 服务预算滑条 50-150% |
| `cs2_get_fees` / `cs2_set_fee` | 水电/医疗/教育等服务收费 |
| `cs2_get_loan` / `cs2_set_loan` | 贷款借还 |
| `cs2_list_districts` / `cs2_create_district` | 地区列表 / 多边形画地区 |
| `cs2_district_policies` / `cs2_set_district_policy` | 地区政策 |
| `cs2_tiles_info` | 地块持有/维护费信息 |
| `cs2_list_map_tiles` / `cs2_buy_map_tiles` | 列出地块（归属、自然资源、剩余许可数）/ 通过游戏自身购买逻辑买地（价格、许可与资金由游戏校验） |

**公共交通**

| 工具 | 说明 |
|---|---|
| `cs2_list_transit_stops` | 站点的类型、名称、位置、所属车站、所依附道路及经停线路；`airplane` 列出机场登机口（客运或货运）与地图的航空外部连接 |
| `cs2_place_transit_stop` | 通过物件工具管线放置路边公交/有轨电车站（由游戏依附、吸附并校验） |
| `cs2_create_transit_line` | 经由有序站点（站点 ID、车站建筑或吸附到站点的坐标）通过路线工具管线建线；等待游戏寻路完成，不可达的路段会被拒绝 |
| `cs2_create_route` | 飞机、轮船或渡轮客运线路，或飞机、火车、轮船的货运路线（登机口、港口/渡轮码头、货运站、外部连接） |
| `cs2_list_transit_lines` | 线路及交通面板上的数字（站数、车辆数、车上乘客、使用率、长度、时刻），可选每站候车人数 |
| `cs2_delete_transit_line` | 与游戏自带删除按钮完全一致地删除线路 |
| `cs2_line_policies` / `cs2_set_line_policy` | 线路政策（票价、车辆数等），按线路面板的方式设置 |
| `cs2_line_vehicles` / `cs2_set_line_vehicles` | 线路可用车型及载客量，并像线路面板的车辆选择那样指定新车所用车型 |

**时间与元操作**

| 工具 | 说明 |
|---|---|
| `cs2_set_simulation` | 暂停/调速（0-8） |
| `cs2_run_simulation` | 定时快进：跑 N 游戏小时后自动暂停（默认自动关闭里程碑等阻断式弹窗） |
| `cs2_popups` | 阻断式弹窗状态：待显示的里程碑/地标弹窗、强制暂停原因 |
| `cs2_dismiss_popups` | 关闭里程碑/地标解锁弹窗（解除强制暂停） |
| `cs2_set_popups` | 关闭游戏的阻断式弹窗选项，或让 Mod 自动关闭弹窗 |
| `cs2_wait_simulation` | 等待（最多 55 秒）定时快进暂停，然后返回状态和城市概览 |
| `cs2_tool_status` | 桥接工具的阶段和看门狗重新激活次数，用于排查“另一个建造操作正在进行” |
| `cs2_save_game` | 触发存档（建议 AI 大规模操作前调用） |

## 排障

- **`cs2_ping` 连不上**：Mod 未加载。查 `%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Logs\CS2MCP.log`（正常应有 `bridge listening on ...`）；无此文件则查同目录 `Player.log`。
- **409 no city loaded**：还在主菜单，先读档。
- **模拟一直暂停 / `cs2_run_simulation` 没反应**：有里程碑或地标解锁弹窗打开，弹窗存在时游戏每帧强制速度为 0。`cs2_game_state` 会返回 `forcedPause: "popup"`；用 `cs2_dismiss_popups` 关闭，或用 `cs2_set_popups blocking=false` 关掉此类弹窗。
- **锁定状态显示异常**：读档后先短暂解除暂停一次（相关接口在未跑过模拟时会返回 `stalenessWarning`）。
- **端口冲突**：给游戏进程设 `CS2MCP_PORT`，并同步修改 `.env` 中的 `CS2_BRIDGE_URL`。

## 已知限制 / 路线图

- 地形改造尚未实现
- 公共交通：可放置路边公交/有轨电车站；火车/地铁站是车站建筑（用 `cs2_place_building` 放置），须用轨道连通。只有存在同类型车库且模拟在运行时，线路才会有车辆
- 匝道只能接在路段端点（节点），尚不支持路中段平滑汇入
- 截图为游戏当前渲染画面：道路类工具面板开启时游戏会以白色轮廓模式渲染

## 免责与致谢

- 本项目为非官方社区 Mod，与 Colossal Order / Paradox Interactive 无关。
- `CS2MCP.Bridge/CreateDefinitions.cs` 移植自 [LineTool-CS2](https://github.com/algernon-A/LineTool-CS2)（Apache-2.0，© algernon），其中含有源自游戏反编译代码的部分，适用 Paradox 用户协议。
- 感谢 CS2 modding 社区的先行者们：LineTool、InfoLoom、Traffic、unity-mcp 等项目的公开代码是本项目的重要参考。

## License

[Apache-2.0](LICENSE)
