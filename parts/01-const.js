    // ==================== 0. 常量 ====================

    const DEFAULT_SETTINGS = {
        version: 1,
        // 打开后 debug 级日志才会被收集（默认关，避免刷屏）
        debug: false,
        // 模型 API 配置档。三种 mode：
        //   main   = 跟随酒馆主连接（generateRaw 不带 api 参数）
        //   direct = 扩展自己直连 OpenAI 兼容接口，自带 base URL / 密钥 / 模型
        apiProfiles: [
            { id: 'main', name: '跟随酒馆主连接', mode: 'main' },
        ],
        activeProfileId: 'main',
        ui: {
            floatingEnabled: true,
            floatingPos: { anchor: { x: 4, y: 40 }, dock: 'left' },
            // 吸附提示只弹一次（2026-11-02）：跟着设置走，换设备不用再看第二遍
            dockHintShown: false,
        },
        tracker: {
            mode: 'auto',
            // 自动模式下，每积累多少层楼（玩家楼 + AI 楼）触发一次自动盘点；0 = 关闭
            autoEveryFloors: 10,
        },
        retention: { completed: 20, abandoned: 3 },
        // 待选上限（2026-11-10 危晓定）：单事件与链各算各的，默认都是 5。
        // 改这里的同时要改 MAX_DRAFTS_DEFAULT / MAX_CHAIN_DRAFTS_DEFAULT 的注释，两处语义一致。
        draftCapSingle: 5,
        draftCapChain: 5,
        preset: {
            // 自定义难度档位。空数组 = 用内置默认档（日常琐事/小麻烦/正经事件/重大危机/生死关头）
            difficultyLevels: [],
            // 自定义事件主类型 / 次类型。空数组 = 用内置默认（含 NSFW）
            mainTypes: [],
            subTypes: [],
            // 事件参数的预存手写取值（2026-11-04）：key 是偏好项的键，值是一行一条的说法。
            // 和生成页「＋ 自定义…」不是一回事：那里是当场打一次，这里存下来以后反复可选
            customOptions: {},
            // M7（2026-11-07）：自定义类型用哪套骨架。
            // 形如 { "盗墓": "探险探索", "审问": "谈判交涉" }——键是用户自己起的类型名，
            // 值是一个内置主类型名。没配映射的自定义类型一律套「其他」通用骨架。
            //
            // 为什么存映射而不是让用户在生成页直接选内置类型：
            // 用户想要的是「我的类型叫盗墓」，但希望它按探险的字段来生成。
            // 直接选探险就丢了「盗墓」这个名字，写进大纲的 event_type 也就成了探险。
            customSkeletonMap: {},
        },
        memory: {
            source: 'auto',
            // 15 这个数写在这里，但真正的口径在 clampFloors/FLOORS_DEFAULT 那对常量和函数上，
            // 界面、切换折算、读楼三处都走它，避免各写一个默认值对不上
            recentFloors: 15,
            // 转述模式（2026-11-04）：开着时最近楼层只读 AI 楼，不读用户楼。
            // 有些卡里玩家的输入只是给 AI 的指令，AI 楼会把用户楼的内容转述一遍，
            // 两份都读就是同一件事读了两遍，既浪费 token 又让模型以为发生了两次。
            narrationMode: false,
            jiyaoOverviewMax: 60,
            jiyaoRecentRows: 30,
        },
        // M16 事件链（2026-11-09）
        chain: {
            // 逐条生成模式：false = 自动（默认），true = 每条等你点一下再继续。
            // 默认给自动——三四个节点逐个点击太繁琐；真跑偏了从下游也看得出来，
            // 想稳一点的自己去设置里打开。
            manual: false,
        },
        worldbook: {
            // 是否把角色世界书的常驻条目（蓝灯）拼进生成上下文
            enabled: true,
            // 字数上限，超出按 order 顺序截断；0 = 不限
            maxChars: 30000,
            // 事件条目写进世界书时的 order（2026-11-04 危晓定，默认 200）。
            // 这一个数同时决定两件事：世界书列表里排第几、↑Char 那一组里谁先写进提示词。
            // 写死 100 时事件条目夹在一堆蓝灯设定中间，既不好找也不够靠前；调到 200 让它优先。
            // 已有的旧条目要等下一次盘点写回才会跟着变，扩展不会主动改历史条目的设置。
            entryOrder: 200,
        },
        request: {
            // 直连接口最长等多久（毫秒）。超时就报错并放开 busy，不会一直转圈
            timeoutMs: 180000,
        },
    };

    const TRACKER_MODES = {
        auto: '自动',
        semi: '半自动',
        manual: '手动',
    };

    const MEMORY_SOURCES = {
        auto: '自动选择（推荐）',
        'shujuku-jiyao': 'shujuku 纪要',
        'recent-floors': '仅最近楼层',
    };

    const SHUJUKU_EXPORT_PREFIX = 'TavernDB-ACU-CustomExport-';

    // 事件条目写进世界书的 order（2026-11-04 危晓定）。默认值与上下限：
    // 200 是危晓点的数，比原来写死的 100 靠前；上限 9999 与酒馆自己排序能认的范围一致。
    const DEFAULT_ENTRY_ORDER = 200;
    const MAX_ENTRY_ORDER = 9999;

    // ---------- 大纲骨架（单一真源，2026-11-04 A1）----------
    // 以前骨架写死在 buildOutlinePrompt 里，顶层键清单是另一句手写的话，checkOutlineQuality
    // 的必查集合又是第三份手抄——三处各自漂移，结果是清单漏 2 个键、校验只查 5 个。
    // 2026-11-05 M2 之后的分工：示例只有这一份，键清单与校验各从对应的常量派生——
    // 外层看 OUTLINE_OUTER_KEYS，内层看 OUTLINE_INNER_KEYS_BY_TYPE[主类型]，
    // 示例本身只负责「让模型看到一条填满的样板」，不再被拿来数键。
    // 两条完整示例，不是半填的模板（2026-11-04 A2，危晓定：A 档第 2 条）。
    // 理由见 2026-11-04 复核那份：原骨架 51 行里 36 行带尖括号，模型在「照抄模板」和
    // 「替换内容」之间摇摆，最常见的是把 <事件名>、[<可选，误导项填节点编号>] 原样留在输出里。
    // 给一条填好的完整示例，图的不是省字，是让每个值都显得「这次必须重写」。
    // 第二条只差一处：第一个节点是误导项，带 refute_by。「refute_by 是可选的」这件事
    // 用示例表达，不用尖括号描述——这是原来最容易照抄的一行。
    // 两条都是纯单行标量，没有块标量（| 或 >）与内联列表，这两样是 YAML 解析失败的头号来源。
    const OUTLINE_SKELETON = [
        'event_name: 石桥镇失踪案',
        'event_brief: 镇上第二个女孩在同一个雨夜消失，玩家要在钟声停下前找出把人带走的东西。',
        'event_type:',
        '  primary: 案件推理',
        '  secondary:',
        '    - 悬疑',
        '    - 失踪',
        'time_pressure:',
        '  countdown: 当晚的第二次钟声之前',
        '  duration: 约两个时辰',
        '  timeout_result: 第三个女孩被带走',
        '  delay_cost: 洗衣妇会被支走，钟声这条线索断掉',
        'danger:',
        '  lethality: 低',
        '  failure: 被当成外人赶出镇子',
        '  tolerance: 一次',
        '  threat_source: 镇长的家仆与夜里的看守',
        'forbidden:',
        '  - 不得提前说出矿难',
        '  - 不得让镇长直接交出真相',
        'structure:',
        '  core_truth: 表面是连环拐带，实际是镇长用女孩替换矿难遇难者名册；真正的动机是他自己要掩盖那场矿难。',
        '  nodes:',
        '    - id: 1',
        '      type: 物证',
        '      trigger: 玩家走进失踪女孩的卧室',
        '      info: 床单上有向外拖拽的压痕，说明她不是自己走的。',
        '    - id: 2',
        '      type: 证言',
        '      trigger: 玩家询问巷口的洗衣妇',
        '      info: 她说那晚听见钟声响了两次，比平时多一次。',
        '    - id: 3',
        '      type: 环境',
        '      trigger: 玩家查看卧室后窗与院墙',
        '      info: 后窗插销是从内侧拔开的，院墙上没有攀爬痕迹——人是自己出去的，或者是被熟人叫出去的。',
        '    - id: 4',
        '      type: 时间线',
        '      trigger: 玩家去祠堂看更簿',
        '      info: 更簿上第二声钟后面没有记录，那一声不是更夫敲的。',
        '    - id: 5',
        '      type: 关系',
        '      trigger: 玩家查两个失踪女孩的交集',
        '      info: 两人都在同一家织坊做工，工头是镇长的小舅子。',
        '    - id: 6',
        '      type: 物证',
        '      trigger: 玩家进织坊后间的库房',
        '      info: 库房角落堆着矿难那年封存的旧名册，其中有几页被裁掉又用新纸补上，笔迹不同。',
        '  min_nodes_for_deduction:',
        '    - 2',
        '    - 4',
        '    - 6',
        '  suspects:',
        '    - name: 镇长',
        '      motive: 掩盖矿难中遇难者的真实数目',
        '      alibi: 当晚他在祠堂主持守夜，有十几个人能作证',
        '      lie: 他说那晚只听见一次钟声',
        '  characters:',
        '    helpers:',
        '      - name: 周向文',
        '        identity: 镇上的老更夫',
        '        motive: 他认得那口多余的钟声',
        '        cost: 要玩家先替他打一壶酒',
        '    obstructers:',
        '      - name: 镇长',
        '        identity: 主持失踪调查的人',
        '        reason: 他会把调查引向山上的狼',
        '        resolvable_by: 拿名册上的替换痕迹当面问他',
        '    informants:',
        '      - name: 洗衣妇',
        '        info_known: 钟声在那一夜响过两次，第二次没有更夫在场',
        '    behind_scenes:',
        '      - name: 矿场东家',
        '        reveal: forbidden',
        '        exposure_path: 名册、钟声、镇长三处对不上时才浮出来',
        '  paths:',
        '    - step: 1',
        '      node: 1',
        '      route: 玩家进卧室看压痕，决定去向洗衣妇打听',
        '      must: 必经',
        '      risk: 低',
        '      fail: 被镇长撞见，后面问名册要多绕一圈',
        '    - step: 2',
        '      node: 2',
        '      route: 从洗衣妇口中问出第二次钟声，再去祠堂查更簿',
        '      must: 必经',
        '      risk: 中',
        '      fail: 问得太直白，洗衣妇被镇长家仆盯上，之后不敢再开口',
        '    - step: 3',
        '      node: 4',
        '      route: 拿更簿上缺记录的那一声钟，对上织坊这条线',
        '      must: 必经',
        '      risk: 中',
        '      fail: 只当是更夫偷懒，线断在钟声上',
        '    - step: 4',
        '      node: 6',
        '      route: 进织坊库房找到被替换过的旧名册，回头当面对质',
        '      must: 必经',
        '      risk: 高',
        '      fail: 被工头堵在库房里，名册当场被烧',
    ].join('\n');

    // 第二条示例：与第一条只差「节点 1 变成误导项」这一件事——多一个 refute_by 指向能推翻它的节点 4。
    // 用来示范「refute_by 什么时候写、怎么写」，把可选语义放进示例里而不是说明里。
    //
    // 节点 1 的 info 措辞也跟第一条不同，这是有意为之、不是笔误：
    //   第一条：床单上的压痕「说明她不是自己走的」——铁证，直接坐实。
    //   第二条：「看着像是被人硬拖走的」——只是看着像，后面会被节点 4 推翻。
    // 误导项如果写成铁证口吻，模型会学成「先给结论再给反证」，那就不是误导而是自我否定了。
    const OUTLINE_SKELETON_MISLEAD = [
        'event_name: 石桥镇失踪案',
        'event_brief: 镇上第二个女孩在同一个雨夜消失，玩家要在钟声停下前找出把人带走的东西。',
        'event_type:',
        '  primary: 案件推理',
        '  secondary:',
        '    - 悬疑',
        '    - 失踪',
        'time_pressure:',
        '  countdown: 当晚的第二次钟声之前',
        '  duration: 约两个时辰',
        '  timeout_result: 第三个女孩被带走',
        '  delay_cost: 洗衣妇会被支走，钟声这条线索断掉',
        'danger:',
        '  lethality: 低',
        '  failure: 被当成外人赶出镇子',
        '  tolerance: 一次',
        '  threat_source: 镇长的家仆与夜里的看守',
        'forbidden:',
        '  - 不得提前说出矿难',
        '  - 不得让镇长直接交出真相',
        'structure:',
        '  core_truth: 表面是连环拐带，实际是镇长用女孩替换矿难遇难者名册；真正的动机是他自己要掩盖那场矿难。',
        '  nodes:',
        '    - id: 1',
        '      type: 物证',
        '      trigger: 玩家走进失踪女孩的卧室',
        '      info: 床单上有向外拖拽的压痕，看着像是被人硬拖走的。',
        '      refute_by:',
        '        - 4',
        '    - id: 2',
        '      type: 证言',
        '      trigger: 玩家询问巷口的洗衣妇',
        '      info: 她说那晚听见钟声响了两次，比平时多一次。',
        '    - id: 3',
        '      type: 环境',
        '      trigger: 玩家查看卧室后窗与院墙',
        '      info: 后窗插销是从内侧拔开的，院墙上没有攀爬痕迹。',
        '    - id: 4',
        '      type: 时间线',
        '      trigger: 玩家去祠堂看更簿',
        '      info: 更簿上第二声钟后面没有记录，那一声不是更夫敲的；而拖痕的方向其实通向院门，不是墙外。',
        '    - id: 5',
        '      type: 关系',
        '      trigger: 玩家查两个失踪女孩的交集',
        '      info: 两人都在同一家织坊做工，工头是镇长的小舅子。',
        '    - id: 6',
        '      type: 物证',
        '      trigger: 玩家进织坊后间的库房',
        '      info: 库房角落堆着矿难那年封存的旧名册，其中有几页被裁掉又用新纸补上，笔迹不同。',
        '  min_nodes_for_deduction:',
        '    - 2',
        '    - 4',
        '    - 6',
        '  suspects:',
        '    - name: 镇长',
        '      motive: 掩盖矿难中遇难者的真实数目',
        '      alibi: 当晚他在祠堂主持守夜，有十几个人能作证',
        '      lie: 他说那晚只听见一次钟声',
        '  characters:',
        '    helpers:',
        '      - name: 周向文',
        '        identity: 镇上的老更夫',
        '        motive: 他认得那口多余的钟声',
        '        cost: 要玩家先替他打一壶酒',
        '    obstructers:',
        '      - name: 镇长',
        '        identity: 主持失踪调查的人',
        '        reason: 他会把调查引向山上的狼',
        '        resolvable_by: 拿名册上的替换痕迹当面问他',
        '    informants:',
        '      - name: 洗衣妇',
        '        info_known: 钟声在那一夜响过两次，第二次没有更夫在场',
        '    behind_scenes:',
        '      - name: 矿场东家',
        '        reveal: forbidden',
        '        exposure_path: 名册、钟声、镇长三处对不上时才浮出来',
        '  paths:',
        '    - step: 1',
        '      node: 1',
        '      route: 玩家进卧室看压痕，决定去向洗衣妇打听',
        '      must: 必经',
        '      risk: 低',
        '      fail: 被镇长撞见，后面问名册要多绕一圈',
        '    - step: 2',
        '      node: 2',
        '      route: 从洗衣妇口中问出第二次钟声，再去祠堂查更簿',
        '      must: 必经',
        '      risk: 中',
        '      fail: 问得太直白，洗衣妇被镇长家仆盯上，之后不敢再开口',
        '    - step: 3',
        '      node: 4',
        '      route: 拿更簿上缺记录的那一声钟，对上织坊这条线',
        '      must: 必经',
        '      risk: 中',
        '      fail: 只当是更夫偷懒，线断在钟声上',
        '    - step: 4',
        '      node: 6',
        '      route: 进织坊库房找到被替换过的旧名册，回头当面对质',
        '      must: 必经',
        '      risk: 高',
        '      fail: 被工头堵在库房里，名册当场被烧',
    ].join('\n');

    // 2026-11-05 M2：原来的 OUTLINE_TOP_KEYS（从骨架原文数一级键）已删除。
    // 它当初存在是为了解决「清单、骨架、校验三处各写一份」，现在职责拆开了：
    // 外层键由 OUTLINE_OUTER_KEYS 固定列出，内层键由 OUTLINE_INNER_KEYS_BY_TYPE 按主类型给，
    // 两者都不再从示例文本里数——示例改成 structure 嵌套之后，数出来的只会是七个外层键，
    // 拿去当校验清单等于不查内层了。留着它只会让后来人以为它还在管事。

    // ---------- 战斗骨架示例（2026-11-05 M3，定稿 1C / 1M）----------
    // 两条示例的分工与案件那两条一样：第一条常态（遭遇战，只写三个必填内层键），
    // 第二条示范可选字段——援军会来、有撤退条件、有事先准备（preparation）。
    //
    // 第一条为什么是遭遇战而不是攻防战：如果第一条就带 preparation，模型会以为
    // 「每场战斗都要先准备」，遇到没准备阶段的伏击也硬凑一份物资清单。
    // 把 preparation 只放在第二条，可选语义就由示例本身说清楚了，不用另写一段解释。
    //
    // 数值口径：enemy_forces 的 level 用相对强弱（精锐/常备/乌合），不写具体血量与伤害，
    // 那是战斗系统的事，大纲只管「对面是谁、多少、什么路数、还愿不愿意打」。
    const OUTLINE_SKELETON_COMBAT = [
        'event_name: 断桥伏击',
        'event_brief: 车队必须在入夜前过桥，而桥头两侧的林子里已经有人先到了，玩家要在队尾被截断前打穿去路。',
        'event_type:',
        '  primary: 战斗冲突',
        '  secondary:',
        '    - 遭遇',
        '    - 护送',
        'time_pressure:',
        '  countdown: 天色完全黑下来之前',
        '  duration: 约半个时辰',
        '  timeout_result: 对方借夜色合围，车队首尾不能相顾',
        '  delay_cost: 队尾的驮马会被惊散，补给丢一半',
        'danger:',
        '  lethality: 中',
        '  failure: 车队被迫退回原路，当天的行程作废',
        '  tolerance: 两次',
        '  threat_source: 桥头两侧林子里的弓手与堵在桥心的持矛人',
        'forbidden:',
        '  - 不得让玩家一击打穿整条封锁线',
        '  - 不得让护送目标自行脱险',
        'structure:',
        '  enemy_forces:',
        '    - name: 桥头持矛人',
        '      strength: 约二十人',
        '      level: 常备',
        '      tactic: 结阵堵住桥心，逼车队停在无遮无挡的桥面上',
        '      morale: 领钱办事，头目倒下就不愿再顶',
        '    - name: 林中弓手',
        '      strength: 五六人',
        '      level: 乌合',
        '      tactic: 只射队尾驮马与举灯的人，逼车队把灯熄掉',
        '      morale: 怕被近身，一旦有人摸进林子就散',
        '  objectives:',
        '    - name: 打穿桥心',
        '      type: 突破',
        '      condition: 持矛人阵型被撕开一道能过车的口子',
        '      fail: 车队被困在桥面，弓手可以从容点名',
        '    - name: 保住队尾',
        '      type: 守住',
        '      condition: 驮马与车夫一个不少地过桥',
        '      fail: 补给丢一半，后面两天的行程要改',
        '  terrain:',
        '    cover: 桥两侧的石栏只能挡蹲姿，车板能挡弓矢但挡不住近身',
        '    elevation: 林子比桥面高出一人，弓手占高，玩家往上冲要多吃一轮箭',
        '    chokepoint: 桥面只容一辆车并行，谁挤在桥心谁挨打',
        '    note: 河水不深但急，落水的人爬不上岸，跌下去等于退出战斗',
    ].join('\n');

    // ---- 二期 M9（2026-11-09）：谈判交涉 ----
    // 骨架要点：每一方都必须有「可让步」与「不可让步」两栏，否则模型会把谈判写成
    // 单方面下通牒；rounds 的 break_point 是这一轮谈崩的条件，不是整体超时。
    const OUTLINE_SKELETON_NEGOTIATE = [
        'event_name: 盐引的第三次议价',
        'event_brief: 盐商卡住了城里的盐路，衙门要他在秋汛前放货，双方各有一张不能亮的底牌。',
        'event_type:',
        '  primary: 谈判交涉',
        '  secondary:',
        '    - 利益冲突',
        '    - 时限压力',
        'time_pressure:',
        '  countdown: 秋汛开闸之前',
        '  duration: 断续谈三五日，每轮半日',
        '  timeout_result: 盐路拖到汛后，城中盐价翻倍，衙门被迫高价收盐',
        '  delay_cost: 每拖一轮，盐商在城外的存盐就多卖出一批，筹码变薄',
        'danger:',
        '  lethality: 低',
        '  failure: 衙门签下高于市价的常年契约，往后三年都要照这个价买',
        '  tolerance: 两轮谈崩',
        '  threat_source: 盐商背后的行会与人情，衙门内部的催逼',
        'forbidden:',
        '  - 不得让盐商无条件答应放货',
        '  - 不得提前点破盐商手里其实已经压不住行会的底牌',
        'structure:',
        '  parties:',
        '    - name: 衙门',
        '      demand: 秋汛前放三成存盐，按平价挂出',
        '      bottom_line: 至少要放出两成，且不得高于平价一成',
        '      can_concede: 可以开放下一季的盐引额度，也可以减免两处关卡的过税',
        '      cannot_concede: 不能在汛期放开盐价，这是要写进告示的',
        '    - name: 盐商',
        '      demand: 衙门先撤了三道关卡的查私，再把盐价由他自定',
        '      bottom_line: 查私可以谈，盐价必须自己说了算',
        '      can_concede: 能放一成存盐应个急，也愿意按平价卖给衙门自用',
        '      cannot_concede: 不能让衙门插手定价，一旦插手行会那边会断他货源',
        '  leverage:',
        '    - item: 盐商城外还有三仓存盐未报',
        '      source: 码头账房漏出来的一句话',
        '      credibility: 软',
        '      holder: 衙门',
        '    - item: 行会已经准备换人，盐商自己也知道',
        '      source: 另一家盐号的人在酒桌上说漏了',
        '      credibility: 存疑',
        '      holder: 衙门',
        '    - item: 衙门的盐仓只够半月',
        '      source: 仓吏嘴上不说，但每日领盐的签子少了一半',
        '      credibility: 硬',
        '      holder: 盐商',
        '  rounds:',
        '    - round: 1',
        '      topic: 先谈查私，盐商试探衙门到底急到什么程度',
        '      break_point: 衙门当场搬出查封三仓的话，盐商就会翻脸离席',
        '      cooldown: 散场一日，各自回去问人',
        '    - round: 2',
        '      topic: 摊牌盐价，衙门拿出平价告示的草稿',
        '      break_point: 衙门把草稿直接贴出去，等于逼盐商当众认输',
        '      cooldown: 半日，靠中间人来回递话',
        '    - round: 3',
        '      topic: 用下一季盐引换这一季放货',
        '      break_point: 衙门既要放货又不肯让出盐引额度',
        '      cooldown: 无，当场签或者当场散',
        '  agreement:',
        '    condition: 盐商放两成存盐按平价挂出，衙门撤两道查私并许下一季盐引',
        '    draft_effect: 城中盐价压回原价，盐商保住定价权，衙门在告示上不至于难看',
        '    winner: 衙门拿到了盐，盐商拿到了明年的口子',
        '    loser: 行会里另外两家盐号，明年的额度被削',
    ].join('\n');

    // 第二条：有中间人说合的谈判。与第一条的差别是多出 intermediaries 与更长的冷却。
    const OUTLINE_SKELETON_NEGOTIATE_MED = [
        'event_name: 两家镖局的和解酒',
        'event_brief: 两家镖局为一条商道打了半年，死了三个人，再打下去州县要出面封路，两边都输。',
        'event_type:',
        '  primary: 谈判交涉',
        '  secondary:',
        '    - 恩怨',
        '    - 调停',
        'time_pressure:',
        '  countdown: 三天后商道上第一批货就要到',
        '  duration: 一顿酒的时间',
        '  timeout_result: 州县出面封路，两家这一季都走不成货',
        '  delay_cost: 每拖一天，商道上就有客户改投别家',
        'danger:',
        '  lethality: 中',
        '  failure: 酒桌上有人动手，事情从生意变成血案',
        '  tolerance: 一次',
        '  threat_source: 两边都死过人，各自都有不肯放下的那一个',
        'forbidden:',
        '  - 不得让任何一方白死三个人还不吭声',
        '  - 不得让中间人一句话就化解半年恩怨',
        'structure:',
        '  parties:',
        '    - name: 东号',
        '      demand: 商道归东号走，西号只许走货不许设点',
        '      bottom_line: 至少要让西号把去年那个点撤掉',
        '      can_concede: 可以让出两成货给西号，也可以赔那三个人的安家银',
        '      cannot_concede: 不能让西号在商道上设常驻的点',
        '    - name: 西号',
        '      demand: 设点，并且东号的人当众给死者磕头',
        '      bottom_line: 点可以不设，但必须有人认这个错',
        '      can_concede: 可以让出商道中段，也可以不追究安家银',
        '      cannot_concede: 不能让那三个人的死就这么算了',
        '  leverage:',
        '    - item: 西号今年接的那批官货不能误期',
        '      source: 押运的旗子上写着官字号',
        '      credibility: 硬',
        '      holder: 东号',
        '    - item: 东号的老镖头已经不想再打了',
        '      source: 他儿子在酒桌上先叹的气',
        '      credibility: 软',
        '      holder: 西号',
        '  intermediaries:',
        '    - name: 保长',
        '      stance: 不想商道被封，两头都劝',
        '      can_do: 能把两边约到一张桌上，也能担保赔银不赖账',
        '    - name: 老账房',
        '      stance: 与两家都有旧账往来，说话有人听',
        '      can_do: 能算出到底谁多占了商道，也肯当众报这个数',
        '  rounds:',
        '    - round: 1',
        '      topic: 先谈商道怎么分，把死人的事往后搁',
        '      break_point: 西号当场提出要人磕头，东号就会翻脸',
        '      cooldown: 一旬，保长两头递话',
        '    - round: 2',
        '      topic: 谈那三个人的安家银与名分',
        '      break_point: 东号拿钱出来却不肯认错',
        '      cooldown: 三日，老账房把两家的旧账翻了一遍',
        '    - round: 3',
        '      topic: 签商道分界，把名分写进字据',
        '      break_point: 字据上写不清谁对谁错，两边都不肯画押',
        '      cooldown: 无',
        '  agreement:',
        '    condition: 东西号以商道中段为界，东号赔安家银，西号不设点；字据里写一句「各有不是」',
        '    draft_effect: 商道重开，两边都算输了半分，也都算保住了面子',
        '    winner: 保长与老账房，商道没被封',
        '    loser: 那三个死了的人，名字没进字据',
    ].join('\n');

    // 第二条：有准备阶段的攻防战。与第一条的差别就是多出 preparation 与 reinforcements、retreat。
    // preparation 的五个子项对应定稿 §5 的「物资/陷阱/情报/盟友/出发时间」。
    const OUTLINE_SKELETON_COMBAT_PREP = [
        'event_name: 守村之夜',
        'event_brief: 山匪在夜里会来，村子只有一条进路，玩家要用一个下午把这条进路变成能守住的样子。',
        'event_type:',
        '  primary: 战斗冲突',
        '  secondary:',
        '    - 守城',
        '    - 生存',
        'time_pressure:',
        '  countdown: 入夜之前必须布置完毕',
        '  duration: 布置大半个下午，接战一整夜',
        '  timeout_result: 天亮才动手，匪众会从两侧坡地绕过来',
        '  delay_cost: 少设一道陷阱，第一波就要拿人去填',
        'danger:',
        '  lethality: 高',
        '  failure: 村口被破，匪众进村抢粮放火',
        '  tolerance: 一次',
        '  threat_source: 山匪与他们的头目',
        'forbidden:',
        '  - 不得让玩家独自守完整夜',
        '  - 不得提前说明匪首的真实身份',
        'structure:',
        '  enemy_forces:',
        '    - name: 山匪主力',
        '      strength: 约四十人',
        '      level: 常备',
        '      tactic: 先派小股试探，再趁乱冲进村口',
        '      morale: 抢不到东西就会散，粮到手就会恋战',
        '    - name: 匪首',
        '      strength: 一人',
        '      level: 精锐',
        '      tactic: 躲在主力后面看哪段防线最弱',
        '      morale: 只为财，一旦自己受伤就退',
        '  objectives:',
        '    - name: 守住村口',
        '      type: 守住',
        '      condition: 天亮之前匪众没能进村',
        '      fail: 村口一破，后面就只能在巷子里打',
        '  terrain:',
        '    cover: 村口的石墙只到腰高，站着守会中箭，要蹲',
        '    elevation: 两侧坡地略高于村口，是匪众最想拿的位置',
        '    chokepoint: 进村只有一条土路，路窄到三人并行',
        '    note: 土路雨后泥泞，跑起来会打滑，撤的时候容易被人追上',
        '  preparation:',
        '    supplies: 火油四罐、麻绳两捆、门板三块、伤药一小包',
        '    traps: 土路两侧挖浅坑插削尖的木桩，坡地边缘埋绊绳',
        '    intel: 从回来的猎户那里问到人数与来路，知道他们走的是西坡',
        '    allies: 村里能拿弓的六个人，青壮十二人，都不经打但肯听指挥',
        '    depart_time: 正午前必须开始布置，入夜后不再出去设置',
        '  reinforcements:',
        '    - wave: 第一波',
        '      arrive: 入夜后不久',
        '      size: 十来人，试探村口哪段最松',
        '    - wave: 第二波',
        '      arrive: 约三更',
        '      size: 主力全上，匪首跟在后面',
        '  retreat:',
        '    condition: 村口已破且青壮死伤过半',
        '    cost: 放弃村外的粮仓，带不走的粮全部烧掉',
        '  casualty:',
        '    note: 青壮若折损过半，这个村子下个月就交不上粮',
    ].join('\n');

    // ---- 二期 M10（2026-11-09）：生存危机 ----
    // 骨架要点：resources 是封闭五项清单；每一波威胁都要有间隔，
    // 没有间隔清单就退化成「一直有危险」这种没有节奏的描述。
    const OUTLINE_SKELETON_SURVIVE = [
        'event_name: 断粮的第七夜',
        'event_brief: 雪封住了山口，粮只剩六天，柴还够三夜，而狼群已经摸到营地外圈。',
        'event_type:',
        '  primary: 生存危机',
        '  secondary:',
        '    - 资源枯竭',
        '    - 恶劣环境',
        'time_pressure:',
        '  countdown: 柴烧完之前',
        '  duration: 三夜到四夜',
        '  timeout_result: 最后一夜柴尽，营火灭掉后狼群直接压进来',
        '  delay_cost: 每多拖一夜，出去找柴的人手就少一个，营地守不住',
        'danger:',
        '  lethality: 高',
        '  failure: 营地被冲散，粮与药丢在半路',
        '  tolerance: 一次',
        '  threat_source: 狼群、严寒本身，还有雪压塌的棚子',
        'forbidden:',
        '  - 不得让粮柴凭空出现',
        '  - 不得让狼群在有火有人的情况下直接冲进营地',
        'structure:',
        '  resources:',
        '    water: 雪能化，但要烧柴，化雪的柴比喝的水还贵',
        '    food: 剩六天口粮，若再分给六个外来的人只够四天',
        '    medicine: 有一小包止血的草粉，冻伤没药，只能靠烤火',
        '    fire: 柴还够三夜，若省着烧只够点灯不够取暖',
        '    stamina: 已经有人手生冻疮，再出去找人只能派最壮的两个',
        '  environment:',
        '    weather: 雪会转成冻雨，冻雨之后柴全是湿的，点不着',
        '    terrain: 营地在一处凹地，挡风但积水，出去只有一条陡坡',
        '    visibility: 白天能看见半里，夜里只有火光能照到的地方是清楚的',
        '  threats:',
        '    - wave: 1',
        '      kind: 狼群试探营地的边缘',
        '      intensity: 轻',
        '      interval: 头一夜，每隔一个多时辰绕一圈',
        '    - wave: 2',
        '      kind: 雪压塌西侧的棚子，压伤一个人',
        '      intensity: 中',
        '      interval: 第二夜后半段，雪积到最厚的时候',
        '    - wave: 3',
        '      kind: 狼群成群压上来',
        '      intensity: 致命',
        '      interval: 第三夜柴尽之后',
        '  shelters:',
        '    - name: 凹地东侧的石窝',
        '      gain: 三面是石头，挡风，也挡得住狼的第一次扑击',
        '      cost: 石窝离水源最远，取雪要绕出去，而且只有一个出入口，被堵住就出不来',
        '    - name: 塌了一半的旧猎棚',
        '      gain: 有现成的梁木能拆来烧，能多撑一夜',
        '      cost: 拆了梁棚子就塌，再没有能躲的地方',
        '  time_window:',
        '    start: 第一夜天黑之后',
        '    end: 第四天早上雪停',
        '    duration: 三个夜晚',
        '    note: 这个窗口里风雪不会停，出门一定要有人结伴，单独出去的人回不来',
    ].join('\n');

    // 第二条：威胁更多、压力更长的版本。
    const OUTLINE_SKELETON_SURVIVE_LONG = [
        'event_name: 渡口的最后一条船',
        'event_brief: 洪水把渡口围成孤岛，水位每天还在涨，船只剩一条，而岸上还有二十几个人。',
        'event_type:',
        '  primary: 生存危机',
        '  secondary:',
        '    - 洪水',
        '    - 道德困境',
        'time_pressure:',
        '  countdown: 水位淹过栈桥之前',
        '  duration: 大约两天',
        '  timeout_result: 栈桥被淹，船靠不上岸，剩下的人只能往高处退',
        '  delay_cost: 每多等半天，水就再涨一尺，能站的地方少一块',
        'danger:',
        '  lethality: 高',
        '  failure: 船上的人走了，岸上的人被水困在高处等救援',
        '  tolerance: 两次',
        '  threat_source: 上涨的水、泡胀的栈桥，还有岸上抢船的人',
        'forbidden:',
        '  - 不得让船一次装下所有人',
        '  - 不得让水位停止上涨',
        'structure:',
        '  resources:',
        '    water: 洪水遍地，但都是脏水，喝之前必须煮',
        '    food: 剩两天的干粮，够五六个人，不够二十几个',
        '    medicine: 有人受了伤，只有一点酒能消毒',
        '    fire: 柴被泡湿了，只有棚子拆下来的干木还能烧',
        '    stamina: 守了一夜，人已经撑不住，再熬一夜要出事',
        '  environment:',
        '    weather: 雨断断续续，没有放晴的意思',
        '    terrain: 栈桥是唯一的上船点，两侧都是水，水底下是看不见的旧桩',
        '    visibility: 水汽重，五十步外看不清，船看不见岸上有人在招手',
        '  threats:',
        '    - wave: 1',
        '      kind: 栈桥的桩子被水冲得松动',
        '      intensity: 中',
        '      interval: 每隔半日检查一次，撑不到两天',
        '    - wave: 2',
        '      kind: 岸上的人开始抢船上位置',
        '      intensity: 重',
        '      interval: 每次船靠近岸边时',
        '    - wave: 3',
        '      kind: 夜里的水位暴涨，高处也不安全了',
        '      intensity: 致命',
        '      interval: 第二夜涨得最快',
        '    - wave: 4',
        '      kind: 最后一条船若沉了，就没有第二条了',
        '      intensity: 致命',
        '      interval: 整件事只有这一次机会',
        '  shelters:',
        '    - name: 渡口的栈桥棚',
        '      gain: 离船最近，船一靠上来就能上',
        '      cost: 棚子在栈桥上，水一淹最先倒，站上去的人最危险',
        '    - name: 坡上的祠堂',
        '      gain: 地基高，短时间内淹不到，能容下所有人',
        '      cost: 离船两百步，船靠岸时来不及跑下来，而且祠堂里挤不下这么多人不乱',
        '  time_window:',
        '    start: 第一天天亮',
        '    end: 第三天早上水退或者栈桥断',
        '    duration: 两天一夜',
        '    note: 水位每天涨一尺，栈桥还能撑多久没人算得准，只能靠人盯着',
    ].join('\n');

    // ---- 二期 M11（2026-11-09）：探险探索 ----
    // 骨架要点：sites 编号、route 用它引用、discoveries 至少一个。
    // route 写的是「从哪到哪怎么走」，sites 写的是「那里有什么」——
    // 两件事分开，才不会把路线描述混进地点描述里。
    const OUTLINE_SKELETON_EXPLORE = [
        'event_name: 废井下的第三层',
        'event_brief: 井底锁着一道石门，村里人说下面埋着旧粮仓，可下过的人没一个愿意再说第二遍。',
        'event_type:',
        '  primary: 探险探索',
        '  secondary:',
        '    - 地下探路',
        '    - 机关破解',
        'time_pressure:',
        '  countdown: 井绳撑不住之前',
        '  duration: 下去半天，来回约四个时辰',
        '  timeout_result: 井绳被水泡朽，上来只能走另一条塌了一半的旧道',
        '  delay_cost: 每多耽搁一刻，井水就涨一寸，最下面那层会先淹掉',
        'danger:',
        '  lethality: 中',
        '  failure: 人被卡在第二三层之间，东西拿到了却上不来',
        '  tolerance: 一次',
        '  threat_source: 涨水、朽掉的木架、以及石门后的东西',
        'forbidden:',
        '  - 不得让玩家跳过第一层直接找到粮仓',
        '  - 不得出现井以外的地点',
        'structure:',
        '  sites:',
        '    - id: 1',
        '      name: 井口与井绳这一段竖井',
        '      mechanism: 井壁上每隔一丈凿着一个脚窝，湿的时候滑，得踩着绳结借力',
        '      guard: 井绳已经泡了半个月，上人下去还撑得住，回来拖着东西就难说',
        '      supplies: 井口边有一圈旧麻绳，能再搓一根短的备用',
        '    - id: 2',
        '      name: 第二层的横洞',
        '      mechanism: 洞口被一块半塌的石板压着，撬开会让上面的土跟着落',
        '      guard: 洞里存着水，水深到腰，底下是烂泥，踩错会陷',
        '      supplies: 洞壁上有前人钉的木楔，能拆下来当撬棍',
        '    - id: 3',
        '      name: 石门后的旧粮仓',
        '      mechanism: 门上有一道卡榫，从外面推不开，要在侧面用棍子顶',
        '      guard: 门缝里灌着风，说明后面有别的出口，可那条道要涉水',
        '      supplies: 半仓的陈粮，还有几只没烂的陶罐',
        '  routes:',
        '    - site: 1',
        '      path: 顺着井绳下，中途在脚窝上歇两次，到第二层要放开绳子跳到横洞边',
        '      required_pass: true',
        '      risk: 井绳在第二次歇脚后明显变松',
        '      fail_result: 绳子断了就直接落到第二层的水里，人没事，带的东西全沉',
        '    - site: 2',
        '      path: 涉水过横洞，撬开石板进到里侧',
        '      required_pass: true',
        '      risk: 撬石板会让上面的土塌下来，把人堵在洞里',
        '      fail_result: 洞口被土堵死，只能退回水里，等水退再试',
        '    - site: 3',
        '      path: 卡榫顶开后进门，粮仓比外面高，进去要爬一道石阶',
        '      required_pass: false',
        '      risk: 门后的那条涉水道比来时深，涨水时走不通',
        '      fail_result: 拿了粮却出不去，只能等水退，或者在门后等到有人来找',
        '  hazards:',
        '    - kind: 井水上涨',
        '      trigger: 在下面待满三个时辰以上',
        '      result: 第二层横洞被淹，来时的路要涉更深的水',
        '    - kind: 土方塌落',
        '      trigger: 撬第二层那块半塌的石板时用力过猛',
        '      result: 洞口被堵，人和粮困在里侧',
        '    - kind: 朽木架',
        '      trigger: 把全部重量压在那根前人留的木楔上',
        '      result: 木楔断，人摔进烂泥，爬出来要费大半个时辰',
        '  discoveries:',
        '    - name: 粮仓墙上刻着的一排名字，最末一个是被村里说成「出远门」的那人',
        '      trigger: 进到粮仓里，把门后那面墙上的浮土抹开',
        '    - name: 门后确实有一条通向外面的水路，尽头是村后那条干渠',
        '      trigger: 在粮仓里待够一阵，感觉到风吹进来的方向',
        '  exit:',
        '    撤到井口、人站到地面上就算出去了；拿到粮没上来不算。',
    ].join('\n');

    // 第二条：路线有分岔、有必经也有可绕的版本。
    const OUTLINE_SKELETON_EXPLORE_BRANCH = [
        'event_name: 破庙里那口不响的钟',
        'event_brief: 破庙的钟三年前就哑了，但每月初一还是有人来上香，庙里到底供着什么，进过中殿的人说法各不相同。',
        'event_type:',
        '  primary: 探险探索',
        '  secondary:',
        '    - 废弃建筑',
        '    - 供物之谜',
        'time_pressure:',
        '  countdown: 天亮之前',
        '  duration: 一夜',
        '  timeout_result: 天亮时庙里会来人上香，撞见生人在中殿就再也问不出东西',
        '  delay_cost: 夜里多待一个时辰，庙里的气味就重一分，人开始犯困',
        'danger:',
        '  lethality: 低',
        '  failure: 被赶来上香的人撞见，往后庙里的人都会盯着你',
        '  tolerance: 两次',
        '  threat_source: 庙里的气味、中殿的机关、以及来上香的人',
        'forbidden:',
        '  - 不得让玩家在没进中殿的情况下知道供的是什么',
        '  - 不得出现庙以外的地点',
        'structure:',
        '  sites:',
        '    - id: 1',
        '      name: 山门与侧院',
        '      mechanism: 山门虚掩，侧院堆着没收的香灰，能看出最近有人清过',
        '      guard: 侧院有两条狗，认得常来的人，生人进院会叫',
        '      supplies: 侧院墙角有几支没用过的香，还有半截蜡烛',
        '    - id: 2',
        '      name: 前殿',
        '      mechanism: 前殿供的是寻常的城隍，看不出异常，但蒲团磨损的位置偏左',
        '      guard: 谁都能进，只是前殿正对中殿的门，进去就被人看见',
        '      supplies: 供桌上有些干果，能拿走',
        '    - id: 3',
        '      name: 中殿',
        '      mechanism: 中殿的钟下面压着一块能推动的石板，推之前要把钟先挂回梁上',
        '      guard: 殿里点着长明灯，一推石板灯就会灭，外面看得见',
        '      supplies: 石板下面的东西才是重点，别的都平常',
        '    - id: 4',
        '      name: 后院那口井',
        '      mechanism: 井口封着木盖，盖下面不是水，是一条能往下的斜道',
        '      guard: 斜道窄，只能一人侧身过，退不回来',
        '      supplies: 井壁上挂着一串旧钥匙',
        '  routes:',
        '    - site: 1',
        '      path: 绕到侧院翻矮墙进去，避开山门正对的大路',
        '      required_pass: true',
        '      risk: 狗叫会把人引出来',
        '      fail_result: 被人撞见，只能先走，今夜就进不去中殿了',
        '    - site: 2',
        '      path: 侧院进前殿，绕过蒲团直接到中殿门口',
        '      required_pass: true',
        '      risk: 前殿正对中殿，站在门口就会被外面看见',
        '      fail_result: 被赶来的上香人堵在前殿，只能装作自己来问事',
        '    - site: 3',
        '      path: 进中殿，把钟挂回梁上，再推石板',
        '      required_pass: true',
        '      risk: 推石板时长明灯会灭，庙里立刻暗下来',
        '      fail_result: 石板纹丝不动，只能退回去想别的办法',
        '    - site: 4',
        '      path: 从中殿后门出去，到后院，从井口下斜道',
        '      required_pass: false',
        '      risk: 斜道太窄，进去之后一时退不回来',
        '      fail_result: 卡在斜道里，得等外面的人把绳子放下来',
        '  hazards:',
        '    - kind: 狗',
        '      trigger: 进侧院时走得太快或碰响东西',
        '      result: 狗叫，引来看庙的人',
        '    - kind: 长明灯熄灭',
        '      trigger: 推动中殿那块石板',
        '      result: 庙里立刻黑下来，外面的上香人会注意到殿里没光',
        '    - kind: 困倦',
        '      trigger: 在后院井边停留超过两个时辰',
        '      result: 人会不自觉犯困，反应变慢',
        '  discoveries:',
        '    - name: 钟下面压着的不是供物，是一块刻着人名与日期的名册',
        '      trigger: 进中殿、把钟挂回梁上、推开石板',
        '    - name: 三年前钟哑的那一夜，名册上最后一行正是那天的日子',
        '      trigger: 拿到名册，看清最后一行',
        '    - name: 后院井里的斜道通到山下的干渠，这是名册上的人怎么走的',
        '      trigger: 从井口下斜道，走到底',
        '  exit:',
        '    从山门或者斜道回到地面算出去；只进到前殿不算。',
    ].join('\n');

    // ---- 二期 M12（2026-11-09）：社交博弈 ----
    // 骨架要点：factions 每方都必须有 leverage（把柄）。
    // 没有把柄的社交只剩客套话，博弈就无从谈起。
    const OUTLINE_SKELETON_SOCIAL = [
        'event_name: 祠堂里的分家',
        'event_brief: 老太爷的丧事刚办完，三房人在祠堂里分家，谁多拿一分，谁就得在族谱上让一步。',
        'event_type:',
        '  primary: 社交博弈',
        '  secondary:',
        '    - 家族争斗',
        '    - 场合施压',
        'time_pressure:',
        '  countdown: 天亮前要在族谱上按下手印',
        '  duration: 一整夜',
        '  timeout_result: 天亮还没谈拢，族长按旧例平分，三房都拿不到想要的',
        '  delay_cost: 每拖一个时辰，祠堂外看热闹的族人就多一层，谁退让谁就丢脸',
        'danger:',
        '  lethality: 低',
        '  failure: 被另外两房联手压掉，只能拿最薄的那一份',
        '  tolerance: 两次',
        '  threat_source: 另两房的联手、族长手里的旧账、以及族人的闲话',
        'forbidden:',
        '  - 不得让任何一方无条件退让',
        '  - 不得提前说明老太爷留下的那封没拆的信里写了什么',
        'structure:',
        '  factions:',
        '    - id: 1',
        '      name: 大房',
        '      stance: 要田，不要铺子；怕的是二房拿账本把田抵掉',
        '      demand: 按长房多分三成的老规矩来',
        '      pressure: 老太爷最后三个月的药钱全是大房垫的，账在族长那里',
        '    - id: 2',
        '      name: 二房',
        '      stance: 要铺子，田可以少拿；怕的是大房翻出当年过继的事',
        '      demand: 铺子归二房，田按人头分',
        '      pressure: 镇上那间铺子的地契一直押在二房手上，没交回公中',
        '    - id: 3',
        '      name: 三房',
        '      stance: 只想要个能立住的东西，不想被当枪使',
        '      demand: 不管怎么分，祠堂东边那间小屋要归三房',
        '      pressure: 三房知道二房过继那件事的实情，但没说过',
        '  occasions:',
        '    - id: 1',
        '      name: 祠堂分家的第一轮',
        '      when_where: 入夜后，祠堂正厅，三房与族长在场，族人在外头听',
        '      stake: 定下田归谁、铺子归谁',
        '    - id: 2',
        '      name: 族长私下叫大房说话',
        '      when_where: 第一轮散后，祠堂后间，只有族长与大房',
        '      stake: 那本药钱账要不要当众拿出来',
        '    - id: 3',
        '      name: 三房被两边同时拉拢',
        '      when_where: 第二轮之前，祠堂东边小屋门口',
        '      stake: 三房帮谁说话，谁就多一票',
        '  favours:',
        '    - who: 族长欠大房一个人情——当年大房替族长挡过一桩官司',
        '      what: 这份人情还能兑现一次，但兑现之后族长就不欠了',
        '    - who: 二房欠三房一次，三房替二房瞒过一件事',
        '      what: 三房随时能把它翻出来，翻出来二房就少一张牌',
        '  rumours:',
        '    - source: 大房的人在厨房里说的，说二房的铺子早就亏空了',
        '      spread: 传到外头听热闹的族人耳里，半信半疑，但二房开口就有人笑',
        '    - source: 三房没说过，但二房猜三房会说',
        '      spread: 只在二房心里，可它让二房不敢把三房逼太紧',
        '  reputation:',
        '    gain: 当众把话说到明处、肯吃亏一步，族人会觉得这房是讲理的',
        '    lose: 翻旧账翻得太狠，族人嘴上不说，心里会记着往后离你远点',
    ].join('\n');

    // 第二条：场合更多、靠传言推进的版本。
    const OUTLINE_SKELETON_SOCIAL_GOSSIP = [
        'event_name: 三场酒席',
        'event_brief: 镇上首富做寿，连摆三日酒席，三拨人各有各的账要在这三场酒席上算清。',
        'event_type:',
        '  primary: 社交博弈',
        '  secondary:',
        '    - 宴会',
        '    - 传言',
        'time_pressure:',
        '  countdown: 第三日撤席之前',
        '  duration: 三天',
        '  timeout_result: 三日一过，各回各家，有些账就再也算不清了',
        '  delay_cost: 每错过一场酒席，就少一次当面说话的机会，往后只能托人传话',
        'danger:',
        '  lethality: 低',
        '  failure: 三场酒席都没能站住，往后镇上说话没人听',
        '  tolerance: 一次',
        '  threat_source: 传言、酒后的失言、以及首富本人的态度',
        'forbidden:',
        '  - 不得让传言一夜之间传遍全镇',
        '  - 不得让首富公开偏袒任何一方',
        'structure:',
        '  factions:',
        '    - id: 1',
        '      name: 首富的长子',
        '      stance: 要名分，怕的是弟弟先拿到印',
        '      demand: 请首富当众把管事的印交给他',
        '      pressure: 他手上有父亲年轻时的一张欠据，从没拿出来过',
        '    - id: 2',
        '      name: 次子',
        '      stance: 要实权，名分可以慢慢来',
        '      demand: 先管铺子的进出账，别的以后再说',
        '      pressure: 铺子里的老账房只听他的，父亲也知道',
        '    - id: 3',
        '      name: 首富的老妾',
        '      stance: 谁给她留后路，她就帮谁说话',
        '      demand: 要一处自己的房产，写在自己名下',
        '      pressure: 她知道长子欠据的事，也知道次子与老账房之间那点交情从哪来',
        '  occasions:',
        '    - id: 1',
        '      name: 第一日正席',
        '      when_where: 首富家门口搭的棚子里，全镇有头脸的都到',
        '      stake: 谁坐首席旁边那个位子',
        '    - id: 2',
        '      name: 第二日夜宴',
        '      when_where: 内院，只留亲近的几桌',
        '      stake: 首富愿不愿意当众提管事的印',
        '    - id: 3',
        '      name: 第三日撤席前',
        '      when_where: 后园，人散得差不多了',
        '      stake: 这三天到底算谁赢了',
        '  favours:',
        '    - who: 次子欠老账房一次，当年替他瞒过一笔亏空',
        '      what: 老账房随时能翻回来，一翻次子在铺子的根基就动',
        '    - who: 长子答应过老妾一处宅子，但一直没兑现',
        '      what: 老妾可以逼他现在兑现，也可以把这件答应过的事说给别人听',
        '  rumours:',
        '    - source: 次子身边的伙计，在酒桌上说长子那张欠据是假的',
        '      spread: 第一日散席时传了半条街，第二日就有人当面问',
        '    - source: 老妾身边的老妈子，说首富其实早有安排',
        '      spread: 只在厨下传，谁听了都往自己那边想',
        '  reputation:',
        '    gain: 酒桌上替人挡一杯、替人接一句，镇上会传你厚道',
        '    lose: 当众戳人短处，往后请客没人愿意与你同桌',
    ].join('\n');

    // ---- 二期 M13（2026-11-09）：日常杂务 ----
    // 骨架要点：steps 一到三步就够，deliverable.accept 要能当场判定。
    // 这类型的价值在「办成一件小事」，写成大冒险就串味了。
    const OUTLINE_SKELETON_CHORE = [
        'event_name: 替西头赵家送一坛酱',
        'event_brief: 赵家老太太要的那坛酱，腌了整整一夏，今天是开坛的日子，赶在晌午前送到就算完事。',
        'event_type:',
        '  primary: 日常杂务',
        '  secondary:',
        '    - 跑腿',
        '    - 街坊往来',
        'contract:',
        '  giver: 巷口的酱园老板',
        '  reward: 工钱二十文，另外管一顿晌午饭',
        'time_pressure:',
        '  countdown: 晌午之前',
        '  duration: 一个上午',
        '  timeout_result: 误了开坛，赵家老太太不高兴，酱园老板往后不找你跑这趟',
        '  delay_cost: 日头一高，坛口的泥封会裂，酱见了风就发酸',
        'danger:',
        '  lethality: 无',
        '  failure: 坛子摔了，赔钱，还要挨一顿数落',
        '  tolerance: 两次',
        '  threat_source: 街上的车马、台阶、以及坛子本身不牢',
        'forbidden:',
        '  - 不得让这件小事演变成打斗或追逃',
        '  - 不得引出主线阴谋',
        'structure:',
        '  steps:',
        '    - step: 1',
        '      what: 到酱园领坛子，听清是哪一坛、路上怎么端',
        '      where: 巷口酱园',
        '      deadline: 巳时之前',
        '    - step: 2',
        '      what: 端过三条街，中间要过一次石桥，桥上有台阶',
        '      where: 从酱园到西头赵家',
        '      deadline: 午时之前',
        '  deliverable:',
        '    what: 一整坛没磕碰的酱，泥封完好，交到赵家老太太手上',
        '    accept: 老太太当场掀开泥封闻一下，说一句「还是这一坛」就算验收',
        '  complications:',
        '    - what: 石桥上正好有辆板车横着掉头，把路堵住半刻钟',
        '      how: 绕桥下的浅滩走，但水会溅上来，得把坛子抱高',
        '    - what: 半路上有个孩子在追猫，直冲过来',
        '      how: 拿手里的布巾挡一下，人没事，坛子晃了两晃',
        '  moral: 无',
    ].join('\n');

    // 第二条：交付物更考验收标准、变数更多的版本。
    const OUTLINE_SKELETON_CHORE_CHECK = [
        'event_name: 把借出去的三样东西要回来',
        'event_brief: 月底要清点，三样借出去的东西得一样不少地要回来，可借的人各有各的说法。',
        'event_type:',
        '  primary: 日常杂务',
        '  secondary:',
        '    - 讨要',
        '    - 街坊面子',
        'contract:',
        '  giver: 当铺的管事',
        '  reward: 当月的例钱，外加一句往后有事可以来找他',
        'time_pressure:',
        '  countdown: 铺子打烊之前',
        '  duration: 一个下午',
        '  timeout_result: 清点不过去，管事自己担责，往后交办的事就轮不到你',
        '  delay_cost: 天越晚人能跑的越少，最后只能第二天跑一趟',
        'danger:',
        '  lethality: 无',
        '  failure: 东西要不全，得自己贴钱补',
        '  tolerance: 一次',
        '  threat_source: 借东西的人找借口、路上耽误',
        'forbidden:',
        '  - 不得动手，也不得用威胁的办法讨',
        '  - 不得把这事牵连到主线剧情',
        'structure:',
        '  steps:',
        '    - step: 1',
        '      what: 先跑近的两家，把好要的东西要到手',
        '      where: 铺子东边两条巷子',
        '      deadline: 未时之前',
        '    - step: 2',
        '      what: 再去远的第三家，那家最难说话',
        '      where: 城西的豆腐坊',
        '      deadline: 酉时之前',
        '    - step: 3',
        '      what: 把要回来的东西送回铺子，让管事当面点清',
        '      where: 当铺柜台',
        '      deadline: 打烊之前',
        '  deliverable:',
        '    what: 三样东西——一只铜壶、一把尺、一本账册，一样都不能少',
        '    accept: 管事把三样东西一一摆到柜台上，对上当初借出的名目就算验收',
        '  complications:',
        '    - what: 第一家说东西借给亲戚了，两手空空',
        '      how: 请他把亲戚的住址写下来，回头多跑一趟',
        '    - what: 豆腐坊那只铜壶被拿去当了炉盖，壶底烧出一圈黑',
        '      how: 如实跟管事说，看他认不认这只壶还算不算「原样」',
        '    - what: 账册被孩子拿去撕了做风筝',
        '      how: 从孩子手里把风筝要回来，撕掉的那几页还能不能对上',
        '  moral:',
        '    豆腐坊那家确实拿不出钱赎壶，硬要回来他们就得断一顿饭。可以让管事自己定，也可以自己贴几个钱把壶先赎回来——贴了钱没人知道，但管事往后会更信你。',
    ].join('\n');

    // ---- 二期 M14（2026-11-09）：禁忌秘辛 ----
    // 骨架要点：taboo 一句话说清是什么；knowers 的沉默原因要从给定枚举里选。
    // 这类型的推进就是「一个一个问到知情者」，所以进度来源用 knowers。
    const OUTLINE_SKELETON_TABOO = [
        'event_name: 那年沉船的名字',
        'event_brief: 镇上所有人都不提那年沉的那条船，连死者的名字都从碑上磨掉了，只有三两个人知道为什么。',
        'event_type:',
        '  primary: 禁忌秘辛',
        '  secondary:',
        '    - 陈年旧事',
        '    - 集体沉默',
        'time_pressure:',
        '  countdown: 镇上要重修那块碑之前',
        '  duration: 五六天',
        '  timeout_result: 碑一重刻，磨掉的名字就再也找不回来了',
        '  delay_cost: 每多问一个人，风声就多走一分，沉默的人会先把嘴闭上',
        'danger:',
        '  lethality: 低',
        '  failure: 问到一半被人警告，往后没人再肯跟你说实话',
        '  tolerance: 两次',
        '  threat_source: 镇上的共识、几个知情者的回避、以及被磨掉名字这件事本身',
        'forbidden:',
        '  - 不得在问到第三个知情者之前透露沉船的真相',
        '  - 不得让知情者主动开口',
        'structure:',
        '  taboo:',
        '    不得提那年沉的那条船叫什么名字，也不得问为什么碑上的名字被磨掉了。',
        '  knowers:',
        '    - name: 渡口的老船工',
        '      silence: 恐惧',
        '      detail: 那晚他在船上，回来之后就不肯再上夜船，一提就手抖',
        '    - name: 镇上的棺材铺老板',
        '      silence: 利益',
        '      detail: 那批棺材是他一手办的，钱从哪来的他没说过，说了生意就完了',
        '    - name: 碑匠',
        '      silence: 承诺',
        '      detail: 磨名字的时候他答应过不说；那人给他磕过头',
        '    - name: 镇长的老母亲',
        '      silence: 无知之罪',
        '      detail: 当年她第一个说「那就别让人再提」，她以为自己是在护着镇子',
        '  cost:',
        '    问到的人当晚就会找上门；问到老船工，他会从此不再与你说话；问到碑匠，镇上第二天就会有人来问你在打听什么。',
        '  cover_up:',
        '    - method: 碑上的名字被磨平，重刻时换成了「无名者」三个字',
        '      trace: 磨过的石面比别处浅一层，凑近看还能认出笔画残留的凹痕',
        '    - method: 镇上统一口径，说那年的船是遇了风，没什么可说的',
        '      trace: 几个人说的细节对不上——有人说是夜里，有人说是天快亮',
        '  breaking:',
        '    在碑前当着镇民的面把磨掉的字念出来，或者让两个知情者在同一场合同时被问到。',
        '  consequences:',
        '    那条船的真实身份会被翻出来——船上装的是当年镇里私贩的盐，沉船是有人凿的，而签字的那批人里，现在还有三个在镇上做买卖。',
    ].join('\n');

    // 第二条：知情者更少、代价更重的版本。
    const OUTLINE_SKELETON_TABOO_HEAVY = [
        'event_name: 后宅那道锁着的门',
        'event_brief: 老爷的书房后头有一道门，锁了十几年，府里没人敢提门后是什么，连打扫都绕着走。',
        'event_type:',
        '  primary: 禁忌秘辛',
        '  secondary:',
        '    - 高门秘事',
        '    - 逐层揭开',
        'time_pressure:',
        '  countdown: 老爷下月回乡之前',
        '  duration: 半个月',
        '  timeout_result: 老爷一回来，府里所有人都会闭嘴，这扇门往后不会再开',
        '  delay_cost: 每问一次，府里就多一双眼睛盯着你，问到第三次就会有人去禀报',
        'danger:',
        '  lethality: 中',
        '  failure: 被当成多事的下人赶出府，问到的也全作废',
        '  tolerance: 一次',
        '  threat_source: 府里的规矩、管事的耳目、以及门后那样东西本身',
        'forbidden:',
        '  - 不得让任何人主动说出门后是什么',
        '  - 不得在府里公开谈论这道门',
        'structure:',
        '  taboo:',
        '    不得打听书房后面那道门，也不得问为什么夫人一年只出来两次。',
        '  knowers:',
        '    - name: 后宅的管事妈妈',
        '      silence: 自保',
        '      detail: 她管着后宅的钥匙，出事第一个问的是她',
        '    - name: 老爷的贴身长随',
        '      silence: 利益',
        '      detail: 他每年拿一份额外的月钱，就是为这件事封口',
        '    - name: 夫人身边的丫头',
        '      silence: 羞耻',
        '      detail: 她知道夫人不愿让人看见的样子，说出来等于把夫人剥开给人看',
        '  cost:',
        '    问到管事的当晚你的差事就会被调开；问到长随，他会把你的名字写进一份送往乡下的信里；问到那个丫头，她会哭，然后什么都不肯再说。',
        '  cover_up:',
        '    - method: 说那道门是旧物库，钥匙早就丢了',
        '      trace: 锁孔里干干净净，最近还有人上过油',
        '    - method: 府里的人统一说夫人身子不好，不能见风',
        '      trace: 夫人院里的炭火却按两个人的份量领',
        '  breaking:',
        '    拿到钥匙开门，或者在老爷回乡那天当着族人的面问出这句话。',
        '  consequences:',
        '    门后是老爷早年的另一个家——这才是夫人一年只出来两次的缘由。事情一闹开，族里会有人来分产，夫人再没有退路，而把这件事说出去的人往后在府里也留不住。',
    ].join('\n');

    // ---------- M14.5 NSFW 专属骨架（2026-11-09 危晓拍板）----------
    //
    // 这是唯一真正吃参数的骨架，也是「骨架从常量改成生成器」这个改造的由来。
    // 两个参数都存在 event_type 下，只在主类型为 NSFW 时读：
    //   nsfw_phases   阶段数，三档 3 / 4 / 5，默认 4
    //   nsfw_consent  要不要「同意与边界」那一块，默认开
    //
    // 阶段的正文不能预生成——每段写什么取决于这一场本身，
    // 生成器只负责把「几段、每段该填哪四项」这个骨架搭出来。
    // 所以下面的阶段部分是「按段数展开的填写指引」，不是填好的样例。

    /** 阶段数收敛到 3/4/5，其他值一律回落默认 4 */
    function nsfwPhaseCount(args) {
        const n = Number(args && args.nsfw_phases);
        return (n === 3 || n === 4 || n === 5) ? n : 4;
    }

    /** 同意与边界块开不开，默认开 */
    function nsfwConsentOn(args) {
        return !(args && args.nsfw_consent === false);
    }

    /**
     * 拼一套 NSFW 骨架。
     * withConsent=false 时整块同意与边界不进骨架，配套的规则与字段也一并不写，
     * 避免「骨架里没这块、rules 里还要求它」这种自相矛盾。
     */
    function buildNsfwSkeleton(args) {
        const n = nsfwPhaseCount(args);
        const consent = nsfwConsentOn(args);

        const phases = [];
        const stageNames = ['起', '承', '转', '合', '余'];
        for (let i = 1; i <= n; i++) {
            const tag = stageNames[i - 1] || ('第' + i + '段');
            phases.push(
                '    - stage: ' + i,
                '      name: ' + tag + '——这一段的名字，三五个字',
                '      progress: 关系推进到哪一步。这里写的是程度，不是动作清单',
                '      scene: 在哪、什么时候、什么环境',
                '      state: 双方各自的状态——情绪、顾虑、还有没有话说',
                '      end_mark: 什么标志说明这一段结束了，可以进下一段',
            );
        }

        const lines = [
            'event_name: 雨夜留宿',
            'event_brief: 一场骤雨把人困在了一处，原本要说清的话没说成，谁都走不了。',
            'event_type:',
            '  primary: NSFW',
            '  secondary:',
            '    - 关系推进',
            'time_pressure:',
            '  countdown: 天亮之前',
            '  duration: 一夜',
            '  timeout_result: 天亮之后各走各的，这一夜谁也不提',
            '  delay_cost: 每拖一段，话说得越少，能说清的机会就越少',
            'danger:',
            '  lethality: 无',
            '  failure: 话没说开，关系停在原地，甚至退一步',
            '  tolerance: 一次',
            '  threat_source: 各自没说出口的顾虑、以及天亮这件事本身',
            'forbidden:',
            '  - 不得跳过阶段直接进入下一阶段',
            '  - 不得让任何一方无故改变主意',
            'structure:',
            '  participants:',
            '    - name: 甲的名字',
            '      wants: 这一夜他/她想要什么——要具体，不能是「想要对方」',
            '      hesitates: 犹豫什么、顾虑什么',
            '      line: 底线在哪，什么情况下会喊停',
            '    - name: 乙的名字',
            '      wants: 同上',
            '      hesitates: 同上',
            '      line: 同上',
            '  phases:',
            ...phases,
            '  pacing:',
            '    go: 什么信号出现说明可以往前推一步',
            '    stop: 什么信号出现必须停下来——这一项不能空',
            '    slow: 什么时候该把节奏放慢、多留一会儿',
        ];

        if (consent) {
            lines.push(
                '  consent:',
                '    can: 这一场里双方都能接受的范围，写具体',
                '    cannot: 明确不做的部分，写具体',
                '    confirm: 怎么确认对方是愿意的——要能当场看出来，不能靠默认',
            );
        }

        lines.push(
            '  aftermath:',
            '    这一段结束后留下什么：关系变了多少、还有什么话没说完、下一次再见要怎么开口',
        );

        // ---- 第二条示例：说明另一档段数怎么写 ----
        const altN = (n === 5) ? 3 : (n + 1);
        const altPhases = [];
        for (let i = 1; i <= altN; i++) {
            altPhases.push(
                '    - stage: ' + i,
                '      name: 第' + i + '段',
                '      progress: 关系推进到哪一步',
                '      scene: 在哪、什么环境',
                '      state: 双方各自的状态',
                '      end_mark: 这一段的结束标志',
            );
        }
        const alt = [
            'event_name: 旧友重逢的那晚',
            'event_brief: 多年没见的人碰上了，酒过三巡，有些话开始往外走。',
            'event_type:',
            '  primary: NSFW',
            '  secondary:',
            '    - 关系推进',
            'time_pressure:',
            '  countdown: 酒醒之前',
            '  duration: 半夜',
            '  timeout_result: 酒醒之后装作什么都没发生',
            '  delay_cost: 越往后拖，越可能有人先起身走了',
            'danger:',
            '  lethality: 无',
            '  failure: 一方退开，往后连见面都别扭',
            '  tolerance: 一次',
            '  threat_source: 酒意、旧事、以及「明天还要见面」这件事',
            'forbidden:',
            '  - 不得让酒成为唯一理由',
            'structure:',
            '  participants:',
            '    - name: 甲',
            '      wants: 想要一个交代',
            '      hesitates: 怕问出口就再也做不成朋友',
            '      line: 涉及旧事的那一句不能提',
            '  phases:',
            ...altPhases,
            '  pacing:',
            '    go: 对方主动靠近、或者先提起旧事',
            '    stop: 对方回避、转移话题、起身',
            '    slow: 说到旧事的时候',
            '  aftermath:',
            '    第二天见面怎么打招呼',
        ];
        if (consent) {
            alt.splice(alt.length, 0,
                '  consent:',
                '    can: 写具体',
                '    cannot: 写具体',
                '    confirm: 写具体',
            );
        }

        return {
            main: lines.join('\n'),
            alt: alt.join('\n'),
            mainLabel: 'NSFW',
            altTitle: '【段数怎么写】上面第一条是 ' + n + ' 段。这一段数由事件参数决定，',
            altTitle2: '下面这条是 ' + altN + ' 段的写法，只给看结构差别，实际按你选的段数写：',
            altDiff: '两条示例的差别：第一条 ' + n + ' 段，第二条 ' + altN + ' 段；其余字段完全相同。',
            altHow: '段数按事件参数来，不要自己加减。每段都要有 progress 与 end_mark，缺一段推进就不成立。',
            altNote: '（NSFW 的进度来源是 phases——这类型的推进单位就是「走到第几段」。'
                + (consent ? '同意与边界已开启，必须写 consent 三子项。' : '这次关掉了同意与边界，不必写 consent。') + '）',
        };
    }

    // ---------- 外层键（2026-11-05 一期 M1）----------
    // 八套骨架改造的第一步：一个事件 = 公共外层 + 按主类型换的内层（定稿 1A「A2」）。
    // 外层是所有类型共用的那几个键，解析层只认外层；内层按主类型换，原样存进事件条目。
    //
    // 为什么要单独列出来，而不是继续从 OUTLINE_SKELETON 里数键：
    // 现在骨架只有案件一套，数出来的十一个键全是案件形状（core_truth / nodes / min_nodes…）。
    // 分类型之后这些键属于「案件推理的内层」，不再是所有类型都该有的东西——
    // 战斗事件没有 core_truth，拿它当必查就是逼模型硬凑。
    //
    // 这份清单就是定稿 §4 的外层字段表，改它等于改契约，改之前先看定稿。
    const OUTLINE_OUTER_KEYS = [
        'event_name',      // 事件名
        'event_brief',     // 一两句话说清目标与处境
        'event_type',      // primary 一个，secondary 最多三个
        'contract',        // 可选：委托关系，不占结构包名额
        'time_pressure',   // 事件级统一时间压力
        'danger',          // 事件级风险基调
        'forbidden',       // 模型不得提前透露的内容
        'structure',       // 内层，按主类型换
    ];

    // 外层里真正必填的键（contract 是可选，不在此列）。
    // 定稿 §9：「外层硬校验。缺了判失败并重试」。
    const OUTLINE_OUTER_REQUIRED = [
        'event_name', 'event_brief', 'event_type',
        'time_pressure', 'danger', 'forbidden', 'structure',
    ];

    // ---------- 内层骨架：从 OUTLINE_SPEC_BY_TYPE 派生 ----------
    // M6.1（2026-11-06）：这张表原来手写一份必填/可选清单，与 OUTLINE_SPEC_BY_TYPE 重复。
    // 同一条规则写两遍就是漂移的开始（改了一处忘了另一处），所以改成派生。
    // 这里保留这个名字与形状（{required:[], optional:[], progress}），
    // 是为了不动 innerKeysOf / progressSpecOf 等既有调用方。
    //
    // 用惰性求值（首次访问时才算），因为 spec 表定义在本文件更后面；
    // 直接 IIFE 会撞上 const 的暂时性死区。
    let __innerKeysCache = null;
    function innerKeysTable() {
        if (__innerKeysCache) return __innerKeysCache;
        const out = {};
        for (const [type, spec] of Object.entries(OUTLINE_SPEC_BY_TYPE)) {
            out[type] = {
                required: Object.keys(spec.required || {}),
                optional: Object.keys(spec.optional || {}),
                progress: spec.progress || null,
            };
            // 列表元素里的可选子键也要暴露给校验层（如 nodes[].refute_by）
            const extra = [];
            for (const meta of Object.values(spec.required || {})) {
                if (meta && meta.item) {
                    for (const [k, m] of Object.entries(meta.item)) {
                        if (m && m.optional) extra.push(k);
                    }
                }
            }
            for (const k of extra) {
                if (!out[type].optional.includes(k)) out[type].optional.push(k);
            }
        }
        __innerKeysCache = out;
        return out;
    }
    // 兼容既有代码里 OUTLINE_INNER_KEYS_BY_TYPE[x] 的读法（测试也直接读它）
    const OUTLINE_INNER_KEYS_BY_TYPE = new Proxy({}, {
        get(_, k) { return innerKeysTable()[k]; },
        has(_, k) { return k in innerKeysTable(); },
        ownKeys() { return Reflect.ownKeys(innerKeysTable()); },
        getOwnPropertyDescriptor(_, k) {
            const t = innerKeysTable();
            return k in t ? { value: t[k], enumerable: true, configurable: true } : undefined;
        },
    });

    /**
     * M6.2（2026-11-07）：kind 的登记表——扩展点只有这一处。
     *
     * 为什么要这张表：M6.1 的 spec 里写了 kind，但代码从来没读过它
     * （校验按字段实际内容判断，渲染也各写各的）。于是 kind 只是注释，
     * 往后加一种新形态也没人知道该实现什么，写错了也不会报。
     *
     * 现在每个 kind 必须在下面登记，写明它要不要子键、允许哪些可选属性。
     * 新增 kind 的动作变成「在这里加一行 + 实现它」，加完跑 check 会告诉你有没有漏。
     *
     * 每项的字段：
     *   label     中文名，报错和日志里用
     *   isEmpty   (值) => 布尔，判断这个形态下什么算空；
     *             校验统一问它，不必每个消费方各写一遍 Array.isArray
     *   attrs     这个 kind 认哪些可选属性（写错了报「属性不适用」）
     *
     * 所有形态通用的两个属性（不列进 attrs）：
     *   optional  true 表示可以整块不写
     *   note      写给人看的一句说明
     *
     * 新形态怎么加（分期文档 §M6.2 列的六种，随类型落地时补，不在这里预先实现）：
     *   ① 在 KIND_SPECS 加一项；② 若需要新属性，写进 attrs；
     *   ③ 在 validateFieldMeta 里补该形态的取值检查；④ 补一条测试。
     * 只加 ① 不改 ②③：check-source 目前只报「spec 用了未登记的 kind」，
     * 「登记了但没校验」这一条检查尚未实现（2026-11-09 评审 P2-4 指出注释大于实现）。
     */
    const KIND_SPECS = {
        text: {
            label: '文本',
            attrs: ['when', 'not_when'],
            isEmpty: v => typeof v !== 'string' || !v.trim(),
        },
        list: {
            label: '列表',
            // min/max 是建议条目数，只用于提示词与规格说明，不参与校验（2026-11-07 危晓裁定）。
            // 手写一个 3 节点的精简案件不该被判错，那只是没按建议量级来。
            attrs: ['when', 'not_when', 'min', 'max', 'refable', 'item'],
            isEmpty: v => !Array.isArray(v) || !v.length,
        },
        map: {
            label: '键值块',
            // M6.4/M6.5（2026-11-07）：sub 是子键元数据（逐个子键声明 kind 与是否必需），
            // 让 map 这一块也能被校验与提示词消费，而不是只写一串字段名。
            attrs: ['when', 'not_when', 'keys', 'sub'],
            isEmpty: v => !v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length,
        },
        int: {
            label: '整数',
            attrs: ['when', 'not_when', 'min', 'max', 'seq', 'ref'],
            isEmpty: v => v == null || v === '' || !Number.isFinite(Number(v)),
        },
        'int[]': {
            label: '整数数组',
            attrs: ['when', 'not_when', 'ref'],
            isEmpty: v => !Array.isArray(v) || !v.length,
        },
        enum: {
            label: '枚举',
            attrs: ['when', 'not_when', 'values', 'allowCustom'],
            isEmpty: v => typeof v !== 'string' || !v.trim(),
        },
        bool: {
            label: '真假',
            attrs: ['when', 'not_when'],
            isEmpty: v => typeof v !== 'boolean',
        },
        freeform: {
            label: '自由结构',
            attrs: ['when', 'not_when'],
            isEmpty: v => v == null || v === '',
        },
    };

    /**
     * M6.2：校验一份 spec 的元数据本身写得对不对。
     * 这一条盯的是「写 spec 的人」，不是「写大纲的模型」——
     * 目的是让扩展 kind 时漏写、写错属性的情况当场现形，而不是等到某个类型上线才发现。
     */
    function validateSpecMeta(spec, typeName, path) {
        const problems = [];
        const walk = (meta, where) => {
            if (!meta || typeof meta !== 'object') {
                problems.push(`${where} 不是对象`);
                return;
            }
            const k = meta.kind;
            if (!k) {
                problems.push(`${where} 没有 kind`);
                return;
            }
            const def = KIND_SPECS[k];
            if (!def) {
                problems.push(`${where} 的 kind「${k}」没有在 KIND_SPECS 登记`);
                return;
            }
            // 用了该 kind 不认识的属性 → 多半是笔误或抄错形态
            // note 是所有形态通用的说明文字（写给人看），不算某个 kind 的专属属性
            for (const key of Object.keys(meta)) {
                if (key === 'kind' || key === 'optional' || key === 'note') continue;
                if (!def.attrs.includes(key)) {
                    problems.push(`${where} 的 kind「${k}」不认识属性「${key}」`);
                }
            }
            if (k === 'enum' && (!Array.isArray(meta.values) || !meta.values.length) && !meta.allowCustom) {
                problems.push(`${where} 是枚举但没给 values，也没允许自定义`);
            }
            if ((k === 'list' || k === 'map') && meta.item) {
                for (const [ik, im] of Object.entries(meta.item)) walk(im, `${where}.item.${ik}`);
            }
            // M6.4/M6.5：map 的子键元数据也要自检，否则 sub 里写错 kind 没人发现
            if (k === 'map' && meta.sub && typeof meta.sub === 'object') {
                for (const [sk, sdef] of Object.entries(meta.sub)) {
                    if (!sdef || typeof sdef !== 'object') {
                        problems.push(`${where}.sub.${sk} 不是对象`);
                        continue;
                    }
                    if (!sdef.kind) {
                        problems.push(`${where}.sub.${sk} 没有 kind`);
                    } else if (!KIND_SPECS[sdef.kind]) {
                        problems.push(`${where}.sub.${sk} 的 kind「${sdef.kind}」没有在 KIND_SPECS 登记`);
                    }
                }
                // sub 声明的子键必须在 keys 里，否则「声明了却不允许写」
                if (Array.isArray(meta.keys) && meta.keys.length) {
                    const notListed = Object.keys(meta.sub).filter(sk => !meta.keys.includes(sk));
                    if (notListed.length) {
                        problems.push(`${where} 的 sub 里有 keys 未列出的子键：${notListed.join('、')}`);
                    }
                }
            }
            if (k === 'list' && meta.min != null && meta.max != null && meta.min > meta.max) {
                problems.push(`${where} 的 min(${meta.min}) 大于 max(${meta.max})`);
            }
        };
        for (const grp of ['required', 'optional']) {
            for (const [f, meta] of Object.entries(spec[grp] || {})) {
                walk(meta, `${path}${grp}.${f}`);
            }
        }
        return problems;
    }

    /**
     * M6.2：按 kind 判断「这个字段算不算空」。
     * 以前每个消费方各自写 Array.isArray / typeof 判断，同一件事写四五遍。
     * 现在统一问这里，加新形态时只改 KIND_SPECS 一处。
     */
    function isEmptyByKind(meta, value) {
        const def = meta && KIND_SPECS[meta.kind];
        if (!def) return value == null || value === '';
        return def.isEmpty(value);
    }

    /**
     * M6.2：按 kind 检查取值是否合法（超出「空」的那部分）。
     * 返回问题描述数组；空值不在这里报（空值由必需性校验负责）。
     *
     * 2026-11-07 危晓裁定：min/max 是建议值，不是硬性限制。
     * 定稿里「案件 5-8 个节点」是给模型生成时看的量级，不是校验规则——
     * 用户手写一个 3 个节点的精简案子不该被判错。
     * 所以这里只查「取值本身合不合法」（枚举越界、整数超范围），不查列表条目数。
     */
    function kindValueProblems(meta, value, where) {
        const out = [];
        if (!meta || (!value && value !== 0)) return out;
        const k = meta.kind;
        if (k === 'enum') {
            const vs = Array.isArray(meta.values) ? meta.values : [];
            if (typeof value === 'string' && value.trim() && !vs.includes(value) && !meta.allowCustom) {
                out.push(`${where} 的值「${value}」不在允许取值（${vs.join('、')}）里`);
            }
        } else if (k === 'int') {
            const n = Number(value);
            if (value !== '' && value != null && Number.isFinite(n)) {
                if (meta.min != null && n < meta.min) out.push(`${where} 小于下限 ${meta.min}`);
                if (meta.max != null && n > meta.max) out.push(`${where} 大于上限 ${meta.max}`);
            }
        }
        // list 的 min/max 不查：那是建议条目数，见上面的裁定。
        return out;
    }

    /**
     * M6.4 / M6.5（2026-11-07）：map 的子键元数据。
     *
     * `keys` 过去只是一串字段名，写了没人读——和之前的 kind 一样是注释性质。
     * 现在给 map 加一个可选 `sub`，逐个子键声明类型与是否必需，于是：
     *   · 提示词能据此告诉模型「这一块该有哪几个子键、各是什么」
     *   · 校验能据此查「写了这个子键但值是空的」「缺了必需的子键」
     * 分段文档 M6.4/M6.5 要的就是这个「把形态留出来」的动作，不新增 kind。
     *
     * 语义约定：
     *   sub.<名>.kind    同 KIND_SPECS 的 kind
     *   sub.<名>.required  true 表示这个子键必须有；缺省允许省略
     *   sub.<名>.note     写给人和模型看的一句说明
     *   keys             保留为「子键名清单」，未写 sub 时退化为「只校验有没有多余子键」
     */

    /** M6.4：map 子键检查。返回问题描述数组。 */
    function mapKeyProblems(meta, value, where) {
        const out = [];
        if (!meta || meta.kind !== 'map') return out;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
        const declared = Array.isArray(meta.keys) ? meta.keys : [];
        const subs = meta.sub && typeof meta.sub === 'object' ? meta.sub : null;

        if (declared.length) {
            const extra = Object.keys(value).filter(k => !declared.includes(k));
            if (extra.length) {
                out.push(`${where} 里有这一块没有的子键：${extra.join('、')}`
                    + `（该有的是 ${declared.join('、')}）`);
            }
        }
        if (subs) {
            for (const [sk, sdef] of Object.entries(subs)) {
                const sv = value[sk];
                const missing = sv == null || (typeof sv === 'string' && !sv.trim());
                if (sdef && sdef.required && missing) {
                    out.push(`${where} 缺子键 ${sk}`);
                }
                // 子键写了但形态不对（比如该是数组却给了字符串）
                if (!missing && sdef && sdef.kind) {
                    for (const p of kindValueProblems({ kind: sdef.kind, ...sdef }, sv, `${where}.${sk}`)) {
                        out.push(p);
                    }
                }
            }
        }
        return out;
    }

    /**
     * M6.4（2026-11-07）：时间窗口的形态——用 map 子键，不新增「区间」kind。
     *
     * 用在：生存的 time_window、灾难的 rescue_window。
     * start/end/duration 允许文本，不强制数值——剧情里的时间是「入夜后第一声钟」，
     * 硬要数值就得让模型编一个，反而更假。
     *
     * 为什么不能复用外层 time_pressure：那是事件级的一句话（倒计时一句话、超时后果），
     * 描述的是「整件事有多急」；这里要的是内层一个可看、可核的窗口，
     * 两者粒度不同，合并会把外层的简洁也毁掉。
     *
     * 真正落地在 M10（生存）与 M18（灾难）。
     * 2026-11-09：本常量必须定义在 OUTLINE_SPEC_BY_TYPE 之前——spec 表要用它，
     * 定义在后面会撞上 const 的暂时性死区，语法检查能过但运行时报未定义。
     */
    const MAP_FORM_TIME_WINDOW = {
        kind: 'map',
        keys: ['start', 'end', 'duration', 'note'],
        sub: {
            start: { kind: 'text', note: '窗口从什么时候开始（文本即可）' },
            end: { kind: 'text', note: '窗口到什么时候结束（文本即可）' },
            duration: { kind: 'text', note: '持续多久；与 start/end 至少给一个，可不精确' },
            note: { kind: 'text', note: '这个窗口里会发生什么、有什么限制' },
        },
    };

    /**
     * M6.1（2026-11-06）：每类骨架的字段规格。
     *
     * 这张表是「规则回到规格」的落点。定稿 §9 要求外层硬校验、内层软校验，
     * §5 只平铺了字段名，没给类型、必填性与子键——那些原先散在四处手写代码里：
     *   buildOutlinePrompt 里手写的字段说明、
     *   checkOutlineQualityFor 里 if (mainType === '战斗冲突') 这类分支、
     *   renderOutlineText 与 buildEntryContent 里各写一遍的渲染清单。
     * 同一条规则写两遍就是漂移的开始，所以收进这里，四处从同一份派生。
     *
     * 字段元数据的约定（M6.2：kind 的取值与允许属性统一登记在 KIND_SPECS）：
     *   kind        text / list / map / int / int[] / enum / bool / freeform
     *   optional    true 表示可以整块不写；缺省为必填
     *   item        列表元素的子键（list 专用）
     *   keys        map 的子键（map 专用）
     *   values      封闭枚举的取值（enum 专用）
     *   allowCustom enum 允许封闭值之外的自定义补充（开放枚举）
     *   ref         跨字段引用，形如 'nodes.id'；校验据它查引用是否存在（M6.3）
     *   when/not_when  什么时候该写、什么时候不该写——替代第二份长示例
     *   seq         true 表示该字段从 1 连续编号
     *   progress    追踪器读哪个字段（M5 已在用，这里统一进来）
     *
     * refable（M6.3 通则）：声明 refable:true 的列表，元素必须有 id 从 1 连续编号；
     * 任何 ref 只能指向 refable 的列表。以后新增类型时「要不要加 id」不再逐类拍板。
     */
    const OUTLINE_SPEC_BY_TYPE = {
        '案件推理': {
            progress: { field: 'nodes', legacy: true },
            required: {
                core_truth: { kind: 'text', when: '本次有真相可藏时写' },
                nodes: {
                    kind: 'list', min: 5, max: 8, refable: true,
                    item: {
                        id: { kind: 'int', seq: true },
                        type: { kind: 'enum', values: ['物证', '证言', '环境', '时间线', '关系'] },
                        trigger: { kind: 'text' },
                        info: { kind: 'text' },
                        refute_by: {
                            kind: 'int[]', optional: true, ref: 'nodes.id',
                            when: '本条是误导项时写，列出能推翻它的节点',
                            not_when: '本条为真、被引用节点只是证实它时不写',
                        },
                    },
                },
                min_nodes_for_deduction: { kind: 'int[]', ref: 'nodes.id' },
                suspects: {
                    kind: 'list',
                    item: {
                        name: { kind: 'text' },
                        motive: { kind: 'text' },
                        alibi: { kind: 'text' },
                        lie: { kind: 'text' },
                    },
                },
                characters: { kind: 'map' },
                paths: {
                    kind: 'list',
                    item: { node: { kind: 'int', ref: 'nodes.id' }, desc: { kind: 'text' } },
                },
            },
            rules: [
                'nodes.id 从 1 连续编号',
                'paths.node、min_nodes_for_deduction、refute_by 只能引用已列出的 nodes.id',
                '嫌疑人的动机、不在场、谎言三项各自不能为空字符串',
            ],
        },

        '战斗冲突': {
            progress: { field: 'objectives' },
            // 渲染顺序（2026-11-09 二期）：不写的话 required 先于 optional，
            // 「事先准备」会被挤到最后。战前准备 → 交战要素 → 战后结果，按叙事时序读更顺。
            order: ['enemy_forces', 'objectives', 'terrain', 'preparation',
                'reinforcements', 'retreat', 'casualty'],
            required: {
                enemy_forces: {
                    kind: 'list',
                    item: {
                        name: { kind: 'text' },
                        strength: { kind: 'text' },
                        level: { kind: 'text' },
                        tactic: { kind: 'text' },
                        morale: { kind: 'text' },
                    },
                    // 2026-11-06 真机：模型找不到第三个敌人时，会把地形塞进来凑数，
                    // 三个文本字段填「不适用」。那些该写进 terrain。
                    not_when: '地形、天气、陷阱不是会主动对抗的东西，不要放进来',
                },
                objectives: {
                    kind: 'list',
                    item: {
                        name: { kind: 'text' },
                        type: { kind: 'enum', values: ['守住', '突破', '护送', '拖延', '歼灭'] },
                        condition: { kind: 'text' },
                        fail: { kind: 'text', when: '必须写，模型要据此判断「已失败」而不是「未达成」' },
                    },
                },
                terrain: {
                    kind: 'map',
                    keys: ['cover', 'elevation', 'chokepoint', 'note'],
                },
            },
            optional: {
                // 2026-11-09：原先写 kind:'text'，但骨架示例教模型写成
                // `- wave / arrive / size` 的对象数组，spec 与真实形状对不上
                // （评审 P2-2）。渲染也不认这个声明，援军一度输出 [object Object]。
                // 现在按 list + item 声明，渲染与校验都从这里取。
                reinforcements: {
                    kind: 'list',
                    item: {
                        wave: { kind: 'text' },
                        arrive: { kind: 'text' },
                        size: { kind: 'text' },
                    },
                },
                retreat: {
                    kind: 'map',
                    keys: ['condition', 'cost', 'route'],
                },
                casualty: { kind: 'map', keys: ['note', 'expect'] },
                preparation: {
                    // M3：只有事先准备过的战斗才有。写成必填会逼模型给每场遭遇战硬凑物资清单。
                    kind: 'map',
                    keys: ['supplies', 'traps', 'intel', 'allies', 'depart_time'],
                    when: '这场战斗有准备阶段时才写',
                    not_when: '遭遇战、突袭、伏击没有准备阶段，整块不写',
                },
            },
            // 类型级的规则说明（不属于某个字段的约束写在这里）。
            // 2026-11-07 M6.2：这几条原来错写在 preparation 字段内部，
            // validateSpecMeta 一查就报「map 不认识 rules」——规则说明不是字段属性。
            rules: [
                'preparation 写了就得五项齐全，要么都写要么整块不写',
                'enemy_forces 只放会主动对抗的东西，地形与天气写进 terrain',
            ],
        },

        // ---- 二期 M9（2026-11-09）：谈判交涉 ----
        // 进度来源用 rounds：谈判的推进单位就是「谈到第几轮」，
        // 与案件的节点、战斗的目标同构。
        '谈判交涉': {
            progress: { field: 'rounds' },
            order: ['parties', 'leverage', 'intermediaries', 'rounds', 'agreement'],
            required: {
                parties: {
                    kind: 'list', min: 2,
                    item: {
                        name: { kind: 'text' },
                        demand: { kind: 'text' },
                        bottom_line: { kind: 'text' },
                        can_concede: { kind: 'text' },
                        cannot_concede: { kind: 'text' },
                    },
                },
                leverage: {
                    kind: 'list',
                    item: {
                        item: { kind: 'text' },
                        source: { kind: 'text' },
                        credibility: { kind: 'enum', values: ['硬', '软', '存疑'] },
                        holder: { kind: 'text' },
                    },
                },
                rounds: {
                    kind: 'list', min: 1, max: 5, refable: true,
                    item: {
                        round: { kind: 'int', seq: true },
                        topic: { kind: 'text' },
                        break_point: { kind: 'text', when: '这一轮谈崩的条件' },
                        cooldown: { kind: 'text' },
                    },
                },
                agreement: {
                    kind: 'map',
                    keys: ['condition', 'draft_effect', 'winner', 'loser'],
                },
            },
            optional: {
                intermediaries: {
                    kind: 'list',
                    item: {
                        name: { kind: 'text' },
                        stance: { kind: 'text' },
                        can_do: { kind: 'text' },
                    },
                    when: '有第三方在两边说话时才写',
                    not_when: '只有两方直接对谈时整块不写',
                },
            },
            rules: [
                'parties 至少两方，一方不叫谈判',
                'parties 每方四项都要写，can_concede 与 cannot_concede 不能同时为空',
                'rounds.round 从 1 连续编号',
                'break_point 是「这一轮谈崩」的条件，不是事件整体超时后果；后者写在外层 time_pressure',
                'agreement 里至少一方要让利，全是得利的一方不叫谈判',
                '不得让某一方无条件接受全部要求；不得提前揭示对方底线',
            ],
        },

        // ---- 二期 M10（2026-11-09）：生存危机 ----
        // 进度来源用 threats：生存的推进单位是「熬过第几波」。
        // resources 的五项是封闭清单（水/食/药/火/体力），不让模型自加——
        // 一旦允许自加，「资源」就会变成第二个 goal，失去可比性。
        '生存危机': {
            progress: { field: 'threats' },
            order: ['resources', 'environment', 'threats', 'shelters', 'time_window'],
            required: {
                resources: {
                    kind: 'map',
                    keys: ['water', 'food', 'medicine', 'fire', 'stamina'],
                    sub: {
                        water: { kind: 'text', required: true, note: '水从哪来、还剩多少' },
                        food: { kind: 'text', required: true, note: '食物从哪来、够几天' },
                        medicine: { kind: 'text', note: '药品有无、能处理什么伤' },
                        fire: { kind: 'text', note: '生火手段与燃料' },
                        stamina: { kind: 'text', note: '体力状况，还能撑多久' },
                    },
                },
                environment: {
                    kind: 'map',
                    keys: ['weather', 'terrain', 'visibility'],
                    sub: {
                        weather: { kind: 'text', required: true, note: '天气，以及它会怎么变' },
                        terrain: { kind: 'text', required: true, note: '地形，哪里能走哪里不能' },
                        visibility: { kind: 'text', note: '能见度，白天与夜里的差别' },
                    },
                },
                threats: {
                    kind: 'list', min: 1, refable: true,
                    item: {
                        wave: { kind: 'int', seq: true },
                        kind: { kind: 'text', note: '这一波是什么威胁：寒冷、野兽、追兵、塌方' },
                        intensity: { kind: 'enum', values: ['轻', '中', '重', '致命'] },
                        interval: { kind: 'text', note: '间隔可写自然语言，如「每隔两小时」' },
                    },
                },
                // 2026-11-09：这里原先直接引用 MAP_FORM_TIME_WINDOW 常量。
                // 问题不在源码（常量已定义在 spec 表之前），而在于测试沙箱
                // 是各自从源码里「抽一段」拼出来的，谁抽 spec 谁就得记得一起抽那个常量，
                // 漏一处就报未定义——二期补十几次，每次都踩。
                // 改成内联字面量后，spec 表自成一体，抽取它不需要任何前置依赖。
                // 形态本身仍以 MAP_FORM_TIME_WINDOW 为准（M6.4 定的），改那边记得同步这里。
                time_window: {
                    kind: 'map',
                    keys: ['start', 'end', 'duration', 'note'],
                    sub: {
                        start: { kind: 'text', note: '窗口从什么时候开始（文本即可）' },
                        end: { kind: 'text', note: '窗口到什么时候结束（文本即可）' },
                        duration: { kind: 'text', note: '持续多久；与 start/end 至少给一个，可不精确' },
                        note: { kind: 'text', note: '这个窗口里会发生什么、有什么限制' },
                    },
                },
            },
            optional: {
                shelters: {
                    kind: 'list',
                    item: {
                        name: { kind: 'text' },
                        gain: { kind: 'text', note: '能挡什么、能得到什么' },
                        cost: { kind: 'text', note: '躲进去要付什么代价' },
                    },
                    when: '附近有可躲避的地方时才写',
                    not_when: '空旷地带没有遮蔽物时整块不写',
                },
            },
            rules: [
                'resources 五项是封闭清单，不得自加第六项',
                '不得让资源凭空出现：每一项都要写清从哪来',
                'threats.wave 从 1 连续编号',
                '每一波威胁都要有 interval，否则无法判断节奏',
                'shelters 每一项都要有代价，只有好处没有代价的避难所是假的',
                '不得让威胁在有光、有声的条件下完全不被察觉',
            ],
        },

        // ---- 二期 M11（2026-11-09）：探险探索 ----
        // 进度来源用 sites：探险的推进单位是「探到第几个地点」。
        // route 是这类型的骨架中线——它把地点连成一条可走的路径，
        // 没有 route 的探险就退化成一串各自独立的房间。
        '探险探索': {
            progress: { field: 'sites' },
            order: ['sites', 'routes', 'hazards', 'discoveries', 'exit'],
            required: {
                sites: {
                    kind: 'list', min: 1, refable: true,
                    item: {
                        id: { kind: 'int', seq: true },
                        name: { kind: 'text', note: '这处地方叫什么、长什么样' },
                        mechanism: { kind: 'text', note: '有什么机关、怎么运作、怎么破' },
                        guard: { kind: 'text', note: '有什么东西守着，或有什么限制让人过不去' },
                        supplies: { kind: 'text', note: '这里能找到什么补给' },
                    },
                },
                routes: {
                    // 2026-11-09 修：原来这里是 kind: 'list' 却带了 ref: 'sites.id'，
                    // list 的白名单里没有 ref，自检报「不认识属性」，这条也一直没生效。
                    // list 表达「元素引用某字段」用的是 refable，具体引用写在 item 里
                    // （下面的 site 已经写了 ref: 'sites.id'），所以这里只留 refable。
                    kind: 'list', min: 1, refable: true,
                    item: {
                        site: { kind: 'int', ref: 'sites.id', note: '指向 sites 的编号' },
                        path: { kind: 'text', note: '怎么走、路上遇到什么' },
                        required_pass: { kind: 'bool', note: '是不是必经；不是就可以绕开' },
                        risk: { kind: 'text', note: '这一段的危险' },
                        fail_result: { kind: 'text', note: '这一段走不成会怎样' },
                    },
                },
                discoveries: {
                    kind: 'list', min: 1,
                    item: {
                        name: { kind: 'text', note: '发现了什么' },
                        trigger: { kind: 'text', note: '什么条件下才会发现' },
                    },
                    when: '任何探险都至少有一个发现——发现是这类型的核心回报',
                },
            },
            optional: {
                hazards: {
                    kind: 'list',
                    item: {
                        kind: { kind: 'text', note: '什么危险：塌方、毒气、机关、守卫' },
                        trigger: { kind: 'text', note: '什么条件下会触发' },
                        result: { kind: 'text', note: '触发后发生什么' },
                    },
                    when: '这段路上有会伤人的东西时才写',
                },
                exit: {
                    kind: 'text',
                    note: '什么算「出去了」——撤离条件，与时间无关',
                    when: '有明确撤离条件时才写',
                },
            },
            rules: [
                'sites.id 从 1 连续编号',
                'route 只能引用 sites 里存在的编号，不得指向不存在的地点',
                'sites 至少一处、discoveries 至少一个',
                'hazards 要能在现场被发现，不能只在事后才知道',
                '是否必经（required_pass）要写清楚，全必经等于没有路线选择',
                'exit 说「什么算出去了」，不是「多久内出去」——后者属于外层 time_pressure',
                '不得让玩家不探索就拿到发现；不得出现大纲外的新地点',
            ],
        },

        // ---- 二期 M12（2026-11-09）：社交博弈 ----
        // 进度来源用 occasions：社交的推进单位是「第几个场合」。
        // 把柄（leverage）是这类型的核心，没有把柄就只剩客套话。
        '社交博弈': {
            progress: { field: 'occasions' },
            order: ['factions', 'occasions', 'favours', 'rumours', 'reputation'],
            required: {
                factions: {
                    kind: 'list', min: 2, refable: true,
                    item: {
                        id: { kind: 'int', seq: true },
                        name: { kind: 'text' },
                        stance: { kind: 'text', note: '这一方要什么、怕什么' },
                        demand: { kind: 'text', note: '它在台面上提的要求' },
                        pressure: { kind: 'text', note: '它的把柄——被谁捏着、或捏着谁的' },
                    },
                },
                occasions: {
                    kind: 'list', min: 1, refable: true,
                    item: {
                        id: { kind: 'int', seq: true },
                        name: { kind: 'text', note: '宴会、庭审、葬礼、祠堂议事' },
                        when_where: { kind: 'text', note: '什么时候、在哪、谁能到场' },
                        stake: { kind: 'text', note: '这一场要定下什么' },
                    },
                },
            },
            optional: {
                favours: {
                    kind: 'list',
                    item: {
                        who: { kind: 'text', note: '谁欠谁' },
                        what: { kind: 'text', note: '欠什么、还能不能兑现' },
                    },
                    when: '场上有旧账可翻时才写',
                },
                rumours: {
                    kind: 'list',
                    item: {
                        source: { kind: 'text', note: '从谁那里传出来的' },
                        spread: { kind: 'text', note: '传到什么程度、谁信' },
                    },
                    when: '有传言在场上走时才写',
                },
                reputation: {
                    kind: 'map',
                    keys: ['gain', 'lose'],
                    sub: {
                        gain: { kind: 'text', note: '做什么会让人觉得你好' },
                        lose: { kind: 'text', note: '做什么会让人看轻你' },
                    },
                    when: '观感会随行为变化时才写',
                },
            },
            rules: [
                'factions 至少两方，一方不叫博弈',
                'factions 每方都要有 leverage——没有把柄的博弈只是客套',
                'occasions.id 从 1 连续编号',
                'favours 要是能被兑现或赖掉的，不能只是背景设定',
                'rumours 的源若指向某方，用 factions 的编号',
                '不得让 NPC 无理由地相信玩家；不得让某方同时拥有人格魅力与绝对武力',
            ],
        },

        // ---- 二期 M13（2026-11-09）：日常杂务 ----
        // 进度来源用 steps：杂务的推进单位就是「第几步做完」。
        // 这类型的价值在「低结构、低风险」，所以步骤上限压到 3，
        // 一旦超过就说明作者把这件小事写成大冒险了。
        '日常杂务': {
            progress: { field: 'steps' },
            order: ['steps', 'deliverable', 'complications', 'moral'],
            required: {
                steps: {
                    kind: 'list', min: 1, max: 3, refable: true,
                    item: {
                        step: { kind: 'int', seq: true },
                        what: { kind: 'text', note: '这一步做什么' },
                        where: { kind: 'text', note: '在哪做' },
                        deadline: { kind: 'text', note: '什么时候前要做完' },
                    },
                },
                deliverable: {
                    kind: 'map',
                    keys: ['what', 'accept'],
                    sub: {
                        what: { kind: 'text', required: true, note: '要交出去的东西' },
                        accept: { kind: 'text', required: true, note: '怎么算验收通过——要能当场判定' },
                    },
                },
            },
            optional: {
                complications: {
                    kind: 'list',
                    item: {
                        what: { kind: 'text', note: '出了什么岔子' },
                        how: { kind: 'text', note: '怎么收拾、要花多少工夫' },
                    },
                    when: '会出小岔子时才写；不写就说明这事顺顺当当',
                },
                moral: {
                    kind: 'text',
                    note: '有没有需要选择的地方；没有照实写「无」，不要硬造',
                },
            },
            rules: [
                'steps 一到三步，超过三步说明这件事已经不是杂务了',
                'deliverable.accept 要能当场判定，不能靠事后追认',
                'complications 要有生活气息，不能是致命威胁',
                'moral 没有就写「无」，不要硬造道德困境',
                '委托关系写在外层 contract，不要塞进 structure',
                '不得把这类事件升级成生死危机；不得牵扯进主线阴谋',
            ],
        },

        // ---- 二期 M14（2026-11-09）：禁忌秘辛 ----
        // 进度来源用 knowers：这类型的推进单位是「问到第几个知情者」。
        // taboo 一句话就要说清「什么不能说」，含糊的禁忌等于没有禁忌。
        '禁忌秘辛': {
            progress: { field: 'knowers' },
            order: ['taboo', 'knowers', 'cost', 'cover_up', 'breaking', 'consequences'],
            required: {
                taboo: {
                    kind: 'text',
                    // 2026-11-09 修：原来这里是 min_len: 4，但 text 这个 kind 的白名单里没有 min_len，
                    // 自检会报「不认识属性」，等于这条约束从来没生效过。
                    // text 本身也做不了长度校验，所以把「别写成一两个字」的要求并进 note 说清楚。
                    note: '一句话说清「什么不能说、不能做什么」；写具体，别只写一两个字',
                },
                knowers: {
                    kind: 'list', min: 1, refable: true,
                    item: {
                        name: { kind: 'text', note: '谁知情' },
                        silence: {
                            kind: 'enum',
                            values: ['恐惧', '利益', '承诺', '无知之罪', '羞耻', '自保'],
                            note: '沉默原因要站得住，不能只是「他不肯说」',
                        },
                        detail: { kind: 'text', note: '这个原因具体是怎么回事' },
                    },
                },
                cost: {
                    kind: 'text',
                    note: '触碰禁忌要付出什么；应当是即时的、可感知的',
                },
            },
            optional: {
                cover_up: {
                    kind: 'list',
                    item: {
                        method: { kind: 'text', note: '掩盖手段' },
                        trace: { kind: 'text', note: '留下什么痕迹——没痕迹玩家就查不下去' },
                    },
                    when: '有人在主动掩盖时才写',
                },
                breaking: {
                    kind: 'text',
                    note: '在什么条件下禁忌会被破',
                },
                consequences: {
                    kind: 'text',
                    note: '破禁之后爆发什么；分量要与禁忌本身相称',
                },
            },
            rules: [
                'taboo 必须具体，不能写「有些事不能说」这种空话',
                'knowers.silence 从给定的几个原因里选，不写「他不肯说」',
                'cost 要即时可感知，不写「以后会倒霉」',
                'cover_up 必须留下痕迹，否则玩家查不下去',
                'consequences 的分量要与 taboo 相称——小禁忌不该天崩地裂',
                '不得提前揭示禁忌内容；不得让知情者无缘无故主动开口',
            ],
        },

        // ---- 二期 M14.5（2026-11-09）：NSFW 专属骨架 ----
        // 危晓定：主类型 NSFW 做专属骨架，专做成人内容，靠阶段与进展推进。
        // 与其余七类最大的不同是它吃事件参数（阶段数、同意开关），
        // spec 本身只描述结构，具体段数与 consent 有无由生成器按参数决定。
        //
        // 进度来源用 phases：这类型的推进单位就是「走到第几段」。
        // pacing 是这类型的骨架中线——不写「什么时候必须停」的内容没有可读性。
        NSFW: {
            progress: { field: 'phases' },
            order: ['participants', 'phases', 'pacing', 'consent', 'aftermath'],
            required: {
                participants: {
                    kind: 'list', min: 2,
                    item: {
                        name: { kind: 'text' },
                        wants: { kind: 'text', note: '这一夜他/她想要什么，要具体' },
                        hesitates: { kind: 'text', note: '犹豫与顾虑' },
                        line: { kind: 'text', note: '底线在哪，什么情况下会喊停' },
                    },
                },
                phases: {
                    kind: 'list', min: 3, max: 5, refable: true,
                    item: {
                        stage: { kind: 'int', seq: true },
                        name: { kind: 'text', note: '这一段的名字' },
                        progress: { kind: 'text', note: '关系推进到哪一步——是程度，不是动作清单' },
                        scene: { kind: 'text', note: '在哪、什么时候、什么环境' },
                        state: { kind: 'text', note: '双方各自的状态' },
                        end_mark: { kind: 'text', note: '什么标志说明这一段结束了' },
                    },
                },
                pacing: {
                    kind: 'map',
                    keys: ['go', 'stop', 'slow'],
                    sub: {
                        go: { kind: 'text', required: true, note: '什么信号说明可以往前推' },
                        stop: { kind: 'text', required: true, note: '什么信号出现必须停——不能空' },
                        slow: { kind: 'text', note: '什么时候该放慢' },
                    },
                },
            },
            optional: {
                consent: {
                    kind: 'map',
                    keys: ['can', 'cannot', 'confirm'],
                    sub: {
                        can: { kind: 'text', required: true, note: '双方都能接受的范围' },
                        cannot: { kind: 'text', required: true, note: '明确不做的部分' },
                        confirm: { kind: 'text', required: true, note: '怎么确认对方愿意——要能当场看出来' },
                    },
                    when: '事件参数里「同意与边界」打开时才写；关掉则整块不出现',
                },
                aftermath: {
                    kind: 'text',
                    note: '这一段结束后留下什么',
                    when: '有明确后效时才写',
                },
            },
            rules: [
                'parties 至少两方，每方都要有 line（底线），没有底线就写不出「什么时候停」',
                'phases 三到五段，段数由事件参数决定，不要自己加减',
                '每段都要有 progress 与 end_mark，缺一段推进就不成立',
                'pacing.stop 不能空——不写什么时候停，内容就没有可读性',
                '同意与边界开启时 consent 三个子项都要写；关掉时整块不出现',
                '不得跳过阶段直接进入下一阶段；不得让任何一方无故改变主意',
            ],
        },
    };


    /**
     * M6.5（2026-11-07）：经营周期的半结构化账目。
     *
     * 不全自由文本（等于放弃这类型的核心机制——它的价值就在「算得清」），
     * 也不全数值化（剧情里的收支常常是「每月三袋盐」这种量词，强迫填数字会编）。
     * 折中：一条账 = { item, amount, unit, note }，amount 可空。
     * 这样三笔账（产出/维护/现金流）能被程序读出来做「收入减支出是否为负」，
     * 同时保留叙事弹性。
     *
     * 不新增 kind，用 map 的 item 列表表达。真正落地在 M20（经营周期）。
     */
    const MAP_FORM_LEDGER = {
        kind: 'list',
        item: {
            item: { kind: 'text', note: '这一条是什么（材料/人手/税费/缺口）' },
            amount: { kind: 'text', optional: true, note: '数量；说不清就留空，不要编' },
            unit: { kind: 'text', optional: true, note: '单位（袋/人/枚/文）' },
            note: { kind: 'text', optional: true, note: '补充说明' },
        },
    };

    // ---------- M16 事件链（2026-11-09）----------
    //
    // 一个主类型囊括不了一个完整事件。真实剧情常见：先探险找到入口、再打一场、
    // 最后谈判收尾，三种类型要三套不同的骨架。塞进同一个条目里，模型得在一次
    // 输出中切换三次思维方式，出错率会明显上升，出错时也不好定位是哪一段坏了。
    //
    // 所以按定稿 §11：一条链 = 多个独立事件条目 + 触发条件。
    //   每个条目仍是完整事件，自己选主类型、次类型、结构包，走现成的生成与校验。
    //   链层只放 chain_id / chain_name / 入口 / 节点与触发 / 链级压力与基调。
    //   链层不设主类型，也不挂结构包——链是容器，不是事件。
    //
    // 不选「单条目画阶段图」的理由（定稿 17.x 已记）：模型输出图结构的错误率高，
    // 校验与渲染成本也最高。

    /** 链节点数的可选项。上限 5：再长世界书条目会膨胀，模型在长链里也更容易跑偏 */
    const CHAIN_NODE_CHOICES = [2, 3, 4, 5];
    /** 默认节点数 */
    const CHAIN_NODE_DEFAULT = 3;

    /** 把设置里的链节点数收进合法范围。脏值一律回默认，别把 NaN 传下去 */
    function chainNodeCountOf(v) {
        const n = parseInt(v, 10);
        return CHAIN_NODE_CHOICES.includes(n) ? n : CHAIN_NODE_DEFAULT;
    }

    /**
     * 校验一张链骨架。返回问题清单，空数组表示没问题。
     *
     * 按定稿 §11 的四条：next_event 存在、无环、至少一个出口、入口可达。
     * 骨架阶段就把能查的查掉，别等三条都生成完了才发现接不上。
     */
    function checkChainSkeleton(chain) {
        const out = [];
        if (!chain || typeof chain !== 'object') return ['链骨架是空的'];

        const nodes = Array.isArray(chain.nodes) ? chain.nodes : [];
        if (!nodes.length) {
            out.push('链里没有节点');
            return out;
        }

        // 节点编号：允许模型给 1,2,3，也允许它漏。漏了就按顺序补，
        // 但不改模型给的值——补完仍要检查重号。
        const seen = new Set();
        const idxs = [];
        nodes.forEach((n, i) => {
            const idx = (n && n.idx != null) ? parseInt(n.idx, 10) : (i + 1);
            if (!Number.isFinite(idx)) {
                out.push(`第 ${i + 1} 个节点没有可用的编号`);
                return;
            }
            if (seen.has(idx)) out.push(`节点编号重复：${idx}`);
            seen.add(idx);
            idxs.push(idx);
        });
        if (out.length) return out;

        const sorted = idxs.slice().sort((a, b) => a - b);
        const entry = chain.entry == null ? sorted[0] : parseInt(chain.entry, 10);
        if (!seen.has(entry)) out.push(`入口节点 ${entry} 不存在`);

        const triggers = Array.isArray(chain.triggers) ? chain.triggers : [];
        if (!triggers.length) {
            out.push('链里没有任何触发条件，节点之间接不起来');
            return out;
        }

        // 每个触发都要落在已存在的节点上
        const outs = new Set();
        const ins = new Set();
        for (const t of triggers) {
            if (!t || typeof t !== 'object') continue;
            const from = parseInt(t.from, 10);
            const to = parseInt(t.to, 10);
            if (!seen.has(from)) out.push(`触发条件指向了不存在的源节点：${t.from}`);
            if (!seen.has(to)) out.push(`触发条件指向了不存在的目标节点：${t.to}`);
            if (String(t.condition || '').trim() === '') out.push(`${t.from} → ${t.to} 缺触发条件`);
            if (seen.has(from) && seen.has(to)) { outs.add(from); ins.add(to); }
        }
        if (out.length) return out;

        // 至少一个出口：某个节点没有任何出边
        const exits = idxs.filter(i => !outs.has(i));
        if (!exits.length) out.push('整条链没有出口，所有节点都指向别处');

        // 入口可达：从入口沿出边走，要能走到每一个节点
        const adj = {};
        for (const t of triggers) {
            const from = parseInt(t.from, 10), to = parseInt(t.to, 10);
            (adj[from] = adj[from] || []).push(to);
        }
        const reach = new Set([entry]);
        const queue = [entry];
        while (queue.length) {
            const cur = queue.shift();
            for (const nxt of (adj[cur] || [])) {
                if (!reach.has(nxt)) { reach.add(nxt); queue.push(nxt); }
            }
        }
        const unreachable = idxs.filter(i => !reach.has(i));
        if (unreachable.length) out.push(`从入口 ${entry} 走不到：节点 ${unreachable.join('、')}`);

        // 有环：拓扑排序走不尽就是有环
        const indeg = {};
        for (const i of idxs) indeg[i] = 0;
        for (const t of triggers) {
            const to = parseInt(t.to, 10);
            if (Number.isFinite(to)) indeg[to] = (indeg[to] || 0) + 1;
        }
        const q2 = idxs.filter(i => !indeg[i]);
        let visited = 0;
        const adjs = {};
        for (const t of triggers) {
            const from = parseInt(t.from, 10), to = parseInt(t.to, 10);
            (adjs[from] = adjs[from] || []).push(to);
        }
        while (q2.length) {
            const cur = q2.shift();
            visited++;
            for (const nxt of (adjs[cur] || [])) {
                indeg[nxt]--;
                if (!indeg[nxt]) q2.push(nxt);
            }
        }
        if (visited < idxs.length) out.push('链里有环，走不到头');

        return out;
    }

    /** 取某节点在链里的位置（第几个，从 1 数），找不到返回 0 */
    function chainPosOf(chain, idx) {
        const nodes = (chain && Array.isArray(chain.nodes)) ? chain.nodes : [];
        const target = parseInt(idx, 10);
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const v = (n && n.idx != null) ? parseInt(n.idx, 10) : (i + 1);
            if (v === target) return i + 1;
        }
        return 0;
    }

    /** 链的总节点数 */
    function chainSizeOf(chain) {
        const nodes = (chain && Array.isArray(chain.nodes)) ? chain.nodes : [];
        return nodes.length;
    }

    /** 某个节点的出边 */
    function chainNextOf(chain, idx) {
        const triggers = (chain && Array.isArray(chain.triggers)) ? chain.triggers : [];
        const from = parseInt(idx, 10);
        return triggers
            .filter(t => t && parseInt(t.from, 10) === from)
            .map(t => ({ condition: String(t.condition || '').trim(), to: parseInt(t.to, 10) }));
    }

    // ---------- M15 结构包（2026-11-09，定稿 §3.3 / §7.1 / §7.2）----------
    //
    // 结构包是「不换骨架、只追加字段」的东西：主类型决定骨架与内层字段，
    // 包在此基础上多给 3-5 个字段，写在 structure.packs.<包名> 下面，与主类型字段不同命名空间。
    //
    // 三条硬规矩（定稿 §3.3）：
    //   ① 最多挂 1 个。多个候选中按 OUTLINE_PACK_ORDER 取第一个与主类型兼容的，
    //      不做循环搜索、不叠加——这是 1Q-a 的简化实现。
    //   ② 待选面板要显示「实际挂载：X；作为标签：Y、Z」，让人看清哪个生效了。
    //   ③ 包与次类型是两套东西：「潜行渗透」是包，「潜入」是次类型，名字相近但不是一回事。
    //
    // 与 NSFW 的关系（2026-11-09 危晓裁定）：定稿原文说 NSFW「直接复用亲密关系当骨架」，
    // 但那是在 M14.5 之前写的。M14.5 已经给 NSFW 做了自己的骨架
    // （participants/phases/pacing/consent/aftermath），两者字段不同，同时套会打架。
    // 所以 NSFW 不在任何包的兼容矩阵里——它不挂包。

    /** 包的取用顺序（定稿 §7.2：多个候选时按顺序取第一个兼容的） */
    const OUTLINE_PACK_ORDER = ['亲密关系', '仪式规则', '潜行渗透', '交易竞价'];

    /**
     * 四个包的字段定义。
     * plain=true 的子项是纯文本；其余按 kind 走渲染。
     * 每个包 3-5 个字段，与定稿 §7.1 逐条对应。
     */
    const OUTLINE_PACK_BY_NAME = {
        亲密关系: {
            desc: '把关系的底子写清楚：现在有多信、底线在哪、以前发生过什么、什么情况下会升级、崩了怎么收。',
            fields: {
                trust: { kind: 'text', note: '当前信任到什么程度' },
                boundaries: { kind: 'text', note: '关系上的底线，越过去就变味' },
                history: { kind: 'text', note: '之前有什么旧账' },
                escalation: { kind: 'text', note: '什么情况下会升级' },
                fallout: { kind: 'text', note: '崩了怎么收场' },
            },
            // 兼容矩阵（定稿 §7.2 原样）。NSFW 已按 M14.5 裁定移出。
            types: ['社交博弈', '日常杂务'],
        },
        仪式规则: {
            desc: '把事情按流程拆开：谁主祭、谁见证、哪一步不能乱、违规有什么后果、旁观的人怎么反应。',
            fields: {
                procedure: { kind: 'text', note: '流程、顺序、每一步多久' },
                roles: { kind: 'list', item: { role: { kind: 'text' }, who: { kind: 'text' } },
                    note: '主祭、见证、参与者' },
                taboos: { kind: 'list', item: { taboo: { kind: 'text' }, result: { kind: 'text' } },
                    note: '禁忌与违反后果' },
                score: { kind: 'text', note: '怎么判定做得好不好' },
                audience: { kind: 'text', note: '旁观者反应' },
            },
            types: ['社交博弈', '禁忌秘辛'],
        },
        潜行渗透: {
            desc: '把「怎么不被发现」写具体：警戒几级、谁在巡、装得像不像、暴露多少、钻进去多深。',
            fields: {
                alert: { kind: 'text', note: '警戒等级与升级条件' },
                patrol: { kind: 'text', note: '巡逻路线与周期' },
                disguise: { kind: 'text', note: '伪装成什么、身份可信度' },
                exposure: { kind: 'text', note: '暴露度怎么涨、怎么降' },
                infiltration: { kind: 'text', note: '渗透深度与分界' },
            },
            types: ['探险探索', '战斗冲突', '社交博弈'],
        },
        交易竞价: {
            desc: '把买卖的条件摆上台面：市面上值多少、谁在争、东西真假、怎么交货、哪里会翻车。',
            fields: {
                market: { kind: 'text', note: '价格与稀缺度' },
                bidders: { kind: 'list', item: { name: { kind: 'text' }, budget: { kind: 'text' }, motive: { kind: 'text' } },
                    note: '竞价者、预算、动机' },
                lots: { kind: 'list', item: { name: { kind: 'text' }, real: { kind: 'text' }, value: { kind: 'text' } },
                    note: '标的、真伪、价值' },
                terms: { kind: 'text', note: '交付与担保' },
                risk: { kind: 'text', note: '假货、黑吃黑、违约' },
            },
            types: ['谈判交涉', '日常杂务'],
        },
    };

    /**
     * 按主类型挑一个要挂的包（定稿 §3.3 第 2 条）。
     *
     * 只取第一个兼容的，不叠加、不循环搜索。没兼容的返回 null。
     * 「其他」与没骨架的类型不挂——它们连自己的字段都没定义清楚，
     * 再叠一层包更说不清该写什么。
     *
     * 2026-11-09 补：第二个参数是用户在界面上的选择（prefs.__packPicked）。
     * 有选择且确实兼容时以选择为准，否则按顺序取第一个。
     * 这样界面选什么、prompt 就挂什么，两边不会各说各话。
     */
    function pickPackFor(mainType, picked) {
        const t = resolveSkeletonType(String(mainType || '').trim());
        if (!t || t === '其他') return null;
        const compat = OUTLINE_PACK_ORDER.filter(n => {
            const pack = OUTLINE_PACK_BY_NAME[n];
            return pack && Array.isArray(pack.types) && pack.types.includes(t);
        });
        if (!compat.length) return null;
        // 用户选的那个必须真在兼容列表里，否则忽略（防止旧存档里留了个不兼容的选择）
        // 2026-11-09 危晓定：默认不挂，想挂自己选。
        // 以前是「没选就取第一个」，等于强制挂上一个，用户没法让事件干净地不挂包。
        // 仍要校验它真在兼容列表里：旧存档里可能留着换类型后不再兼容的选择。
        if (picked && compat.includes(picked)) return picked;
        return null;
    }

    /**
     * 列出与主类型兼容的全部包名，按取用顺序。
     * 面板要显示「实际挂载：X；作为标签：Y、Z」——第一个是挂上的，其余当标签看，
     * 所以这里要把全部兼容的都给出来，不只给第一个。
     */
    function compatiblePacksOf(mainType) {
        const t = resolveSkeletonType(String(mainType || '').trim());
        if (!t || t === '其他') return [];
        return OUTLINE_PACK_ORDER.filter(n => {
            const pack = OUTLINE_PACK_BY_NAME[n];
            return pack && Array.isArray(pack.types) && pack.types.includes(t);
        });
    }

    /**
     * M6.1：「其他」兜底主类型的通用骨架（定稿 1L、1U）。
     * 十四类都不贴的事件用它。字段按定稿 §5，变数与失败代价必填，避免写成流水账。
     *
     * 2026-11-06 危晓裁定：原定稿七字段里的 stages 与外层阶段数组撞了同一个概念，
     * 「其他」不再自带阶段字段，直接复用外层的 structure.phases。
     * 这样「其他」与其他类型共用同一套阶段机制，进度也走同一条路。
     */
    const OUTLINE_SPEC_OTHER = {
        // 进度按外层阶段数组走（structure.phases，与 phases 校验同一套）
        progress: { field: 'phases' },
        required: {
            goal: { kind: 'text' },
            obstacles: { kind: 'text' },
            resources: { kind: 'text' },
            variables: { kind: 'text' },
            failure_cost: { kind: 'text' },
            stakeholders: { kind: 'list', item: { name: { kind: 'text' } } },
        },
        rules: [
            'variables、failure_cost 两项必填，不允许留空',
            '分段写在外层的 structure.phases 里，最多 3 段，超过说明事件太大，应拆成事件链',
        ],
    };

    /**
     * M6.2：spec 表的自检。模块加载时跑一次，把「spec 本身写错」当场现形——
     * 未登记的 kind、不适用的属性、空的枚举、min>max 都会在这里报出来。
     *
     * 为什么要在加载时跑：这些错误是「写 spec 的人」犯的，不是模型犯的。
     * 等到某个类型上线、用户生成出奇怪大纲时才发现，根本追不回来。
     * 报法用 warn 不抛异常——spec 写错不该让整个扩展起不来，
     * 但必须留痕，并且 check-source 里那条 kind 登记检查会直接失败拦住提交。
     */
    function selfCheckSpecMeta() {
        const problems = [];
        for (const [type, spec] of Object.entries(OUTLINE_SPEC_BY_TYPE)) {
            for (const p of validateSpecMeta(spec, type, type + '.')) problems.push(p);
        }
        for (const p of validateSpecMeta(OUTLINE_SPEC_OTHER, '其他', '其他.')) problems.push(p);
        if (problems.length) {
            try { warn('[事件大纲] spec 表自检不通过：' + problems.join('；')); } catch (e) { /* 日志没就绪也不影响 */ }
        }
        return problems;
    }

    /**
     * 0C（2026-11-07）：生成提示词的第 1–5 项按主类型给。
     *
     * 原先这五项是硬编码的案件流程：「核心真相」「信息节点 5-8 条」「助力者/阻碍者/知情者」
     * 「推进路径」。选了战斗或探险，模型照样被要求写核心真相与信息节点——
     * 真机上战斗事件被迫硬凑一个核心真相出来，就是这个原因。
     *
     * 现在按类型分开：有骨架的类型给专属字段说明；没骨架的七类给定稿 §3 列出的字段清单
     * （虽然还没有专属示例，至少模型知道该写哪些键，而不是照案件的样子硬套）。
     * 内容来源：docs-repo 的《事件骨架字段与约束规格》§3.1–§3.8 与定稿 §5。
     *
     * 返回 { items: [...], note: 可选补充说明 }
     */
    const OUTLINE_TYPE_ITEMS = {
        '案件推理': [
            '1. 事件类型与核心真相：判断本事件属于哪类（案件/谈判/探险/危机/社交博弈/其他），写出核心真相或隐情（仅记录，后续不得直接透露）',
            '2. 信息节点清单：按发现顺序列 5-8 条，每条含编号（从 1 开始）、类型（物证/证言/环境/时间线/关系）、触发关键词、指向的信息或后果',
            '   节点字段名固定用：id（编号，数字）、type（类型）、trigger（触发关键词或触发条件）、info（指向的信息或后果）、refute_by（可选，这条是误导时填可推翻它的节点编号数组）',
            '   注意 refute_by 的用法很容易搞反：它标记的是「这条信息本身有问题，会被哪个节点拆穿」，',
            '   不是「这条和哪个节点有关」。判断标准是：如果被引用的那个节点出现后，本条信息的结论就要被否定或大改，才写 refute_by；',
            '   如果被引用节点只是证实、补充、或从另一角度印证本条，那就不写 refute_by，它们之间是普通的前后线索关系。',
            '   一条正确的推理线索不写 refute_by。整份大纲可以一个 refute_by 都没有（没有误导项时不写）。',
            '   另外单独输出「推进所需最少信息节点编号」：只列出推理必需的最少节点编号',
            '3. 参与角色：按立场分类——',
            '   a. 助力者：每个助力者的动机须各不相同（利益一致/情感羁绊/交易/被迫/其他），并标明是否有条件或代价。同阵营且利益一致者可以无条件；交易或被迫者须写明代价。按实际情况判断，不要为所有助力者统一附加条件',
            '   b. 阻碍者：会阻止玩家推进，其阻碍理由须合理且可被化解',
            '   c. 知情者/关键人物：掌握核心信息，不会无理由主动交出；其信息只能经由信息节点清单中的条目逐步获得',
            '   d. 幕后方（如有）：标记 reveal: forbidden，暴露路径只能经由信息节点清单逐步指向',
            '4. 推进路径：从开局到结局的分步逻辑链，注明哪些节点是必经、哪些可跳过；并按"危险程度"标注每个高风险节点的失败后果（如受伤/被俘/死亡/失去关键信息）',
            '5. 禁止事项：不得新增清单外信息节点、不得提前揭示核心真相、不得让角色知道其不应知道的信息',
        ],
        '战斗冲突': [
            '1. 敌方编制 enemy_forces：每一项写 name（名称）、strength（兵力）、level（等级）、tactic（战术）、morale（士气）。没有敌人就不叫战斗，这一项必须有',
            '2. 战斗目标 objectives：每一项写 name（名称）、type（守住/突破/护送/拖延/歼灭）、condition（达成条件）、fail（失败后果）。',
            '   condition 要写成可判断的客观状态（「玩家站住脚且没被撞倒」），不要写「表现良好」这种主观话；',
            '   fail 必须写，模型要据此判断「已失败」而不是「未达成」',
            '3. 地形 terrain：写 cover（掩体）、elevation（高低差）、chokepoint（狭窄处）、note（备注）。哪怕是一片平地也要写一句，地形影响走位与掩体',
            '   注意：天气、地形、路况都写进 terrain，不要把它们塞进 enemy_forces——那里只放会主动对抗的东西',
            '4. 事先准备 preparation（有准备阶段时才写）：五项 supplies（物资）、traps（陷阱）、intel（情报）、allies（盟友）、depart_time（出发时间），要么五项都写，要么整块不写',
            '5. 可选三块：reinforcements（援军，写波次与到达时间）、retreat（撤退，写条件与代价）、casualty（伤亡与俘虏）。没有就不写，不要为凑数硬编',
            '   禁止事项：不要让角色知道其不应知道的信息；不要让敌人做出与其战术、士气不符的行为',
        ],
        '谈判交涉': [
            '1. 各方立场 parties：每一方写（诉求/底线/可让步/不可让步）四件事。至少两方，否则不叫谈判',
            '2. 筹码 leverage：每个筹码写（筹码/来源/可信度）三件事。可信度决定对方买不买账',
            '3. 中间人 intermediaries：写姓名、立场、能做什么。没有中间人就整块不写',
            '4. 轮次 rounds：每一轮写（轮次/破裂点/冷却）三件事，轮次从 1 连续编号。',
            '   破裂点是「这一轮谈崩」的条件，不是事件整体的超时后果——后者写在外层 time_pressure.timeout_result',
            '5. 协议 agreement：写（达成条件/草签后果）两件事。至少一方要让利，全是得利的一方不叫谈判',
            '   禁止事项：不得让某一方无条件接受全部要求；不得提前揭示对方的底线',
        ],
        '探险探索': [
            '1. 地点 sites：每个地点写（地点/机关/守卫/补给）四件事，并给每处编 id（从 1 连续），后面 route 要用编号引用',
            '2. 路线 route：写（节点编号/路线描述/是否必经/风险/失败后果）。只能引用 sites 里存在的编号',
            '3. 危险 hazards：每种危险写（种类/触发条件/后果）三件事。危险要能在现场被发现，不能只在事后才知道',
            '4. 发现 discoveries：每个发现写（发现物/触发条件）两件事。发现是这类型的核心回报，不能一个都没有',
            '5. 出口 exit：写撤离条件。这是「什么算出去了」，与外层 time_pressure 的「多久内」不是一回事',
            '   禁止事项：不得让玩家不探索就拿到发现；不得出现大纲外的新地点',
        ],
        '生存危机': [
            '1. 资源 resources：写五项——water（水）、food（食）、medicine（药）、fire（火）、stamina（体力）。这五项是封闭清单，不要自加',
            '2. 环境 environment：写 weather（天气）、terrain（地形）、visibility（能见度）三件事',
            '3. 威胁 threats：每一波写（波次/强度/间隔）三件事。间隔可以写「每隔两小时」这种自然语言，不必是纯数字',
            '4. 避难所 shelters：每个避难所写名称与可获得的东西。避难所要有代价（比如能挡风但会被发现）',
            '5. 时间窗口 time_window：写 start（从什么时候开始）、end（到什么时候结束）、duration（持续多久）、note（这个窗口里会发生什么）。',
            '   允许用自然语言（「入夜后第一声钟」），不要求填数字',
            '   禁止事项：不得让资源凭空出现；不得让威胁在有光、有声的条件下完全不被察觉',
        ],
        '社交博弈': [
            '1. 阵营 factions：每一方写（立场/诉求/把柄）三件事，并给每方编 id（从 1 连续）。把柄是这类型的核心，没有把柄就没有博弈',
            '2. 场合 occasions：写宴会/庭审/葬礼这类具体场合。场合决定了谁能出场、能说什么话',
            '3. 人情 favours：写谁欠谁、欠什么。人情要是能被兑现或被赖掉的，不能只是背景设定',
            '4. 传言 rumours：每条写（源/扩散）。源如果要指向某个阵营，用 factions 里的编号',
            '5. 声望 reputation：写观感如何变化——做什么会升、做什么会降',
            '   禁止事项：不得让 NPC 无理由地相信玩家；不得让某个阵营同时拥有人格魅力与绝对武力',
        ],
        '日常杂务': [
            '1. 步骤 task：每一步写（步骤/地点/时限）三件事。这类是低结构、低风险，步骤控制在 1-3 步，不要写成大冒险',
            '2. 交付 deliverable：写交付物与验收标准两件事。验收要能当场判定，不能靠事后追认',
            '3. 变数 complications：写可能出岔子的小事。变数应该有幽默感或生活气息，不是致命威胁',
            '4. 道德岔口 moral：写有没有需要选择的地方。没有也照实写「无」，不要硬造',
            '5. 委托关系写在外层 contract（谁委托、代价是什么），不要塞进 structure',
            '   禁止事项：不要把这类事件升级成生死危机；不要让杂务牵扯进主线阴谋',
        ],
        '禁忌秘辛': [
            '1. 禁忌 taboo：一句话说清「什么不能说、不能做」。必须是具体的，不能是「有些事不能说」这种空话',
            '2. 知情者 knowers：每个知情者写（知情者/沉默原因）两件事。沉默原因要站得住（恐惧、利益、承诺、无知之罪），不能只是「他不肯说」',
            '3. 代价 cost：触碰禁忌要付出什么。代价应该是即时的、可感知的，不是「以后会倒霉」',
            '4. 掩盖 cover_up：写掩盖手段。手段要留下痕迹，玩家才有得查',
            '5. 破禁 breaking 与后果 consequences：写破禁条件与爆发后果两件事。后果要与禁忌本身的重量相称',
            '   禁止事项：不得提前揭示禁忌内容；不得让知情者无缘无故主动开口',
        ],
        'NSFW': [
            '1. 边界 boundaries：写清本次的尺度与红线。边界必须在生成时就定下来，不能在剧情里临时放宽',
            '2. 意愿 consent：写清各方的意愿状态。任何一方的不自愿都不能被叙述成自愿',
            '3. 场景 scenes：写场景与推进顺序。每一场要有明确的开始与结束，不做无休止的流水账',
            '4. 退出 exit：写任意一方中止的条件。中止必须被尊重，不能写成「欲拒还迎」',
            '5. 禁止事项：不得越过第 1 项写下的边界；不得把不自愿描写成自愿；不得在未成年角色上使用本类型',
        ],
        '其他': [
            '1. 目标 goal：这个事件最终要达成什么。一句话说清，不要写成流程说明',
            '2. 障碍 obstacles：列出会挡路的因素。每一条都要具体到「谁、因为什么、怎么挡」',
            '3. 资源 resources：玩家手上有什么可用的东西。包括物品、信息、人脉',
            '4. 变数 variables：列出会让局面变化的东西（倒计时、好感、某人的状态），每条写名称、类型、影响',
            '5. 失败代价 failure_cost 与相关方 stakeholders：失败要付出什么；牵涉到谁、各自想要什么',
            '   禁止事项：不得照搬案件的信息节点或战斗的战斗目标；这个事件如果要分阶段，写在外层 structure.phases 里（最多 3 段）',
        ],
    };

    /**
     * M7（2026-11-07）：把用户自定义的类型名解析成「它该用哪个内置主类型的骨架」。
     *
     * 自定义类型（不在 EVENT_MAIN_TYPES 里的名字）有两种情况：
     *   1. 在设置里配了映射 → 用映射指向的那个内置类型的骨架与 spec；
     *   2. 没配映射 → 一律套「其他」的通用骨架（文档 M7「不变」第一条）。
     *
     * 内置类型永远原样返回，不查映射——哪怕用户手贱把「战斗冲突」映射成「案件推理」，
     * 内置类型也不该被改掉。这是把映射的影响面限制在自定义类型上的关键。
     *
     * 映射值必须是真内置类型，指向不存在或指向用户的另一个自定义类型都按「没配」处理，
     * 不做链式解析——链式解析会引入环，且用户看不出自己到底套上了哪套。
     */
    function resolveSkeletonType(mainType) {
        const t = String(mainType || '').trim();
        if (!t) return '';
        // 内置类型（含「其他」）不参与映射
        if (EVENT_MAIN_TYPES.includes(t)) return t;
        let map = {};
        try {
            const s = getSettings();
            map = (s && s.preset && s.preset.customSkeletonMap) || {};
        } catch (e) {
            map = {};
        }
        const target = String(map[t] || '').trim();
        // 「其他」映射到「其他」等于没映射，但结果一样，直接放过
        if (target && EVENT_MAIN_TYPES.includes(target)) return target;
        // 没配、配错、指向另一个自定义类型：一律套「其他」
        return '其他';
    }

    /** M7：这个类型是不是自定义的（不在内置列表里） */
    function isCustomMainType(mainType) {
        const t = String(mainType || '').trim();
        return !!t && !EVENT_MAIN_TYPES.includes(t);
    }

    /** M6.1：按主类型取 spec；「其他」走通用骨架，未知类型返回 null */
    function specOfType(mainType) {
        const t = String(mainType || '').trim();
        if (!t) return null;
        // M7：自定义类型先解析成它映射到的内置类型，再取 spec。
        // 没配映射的自定义类型会解析成「其他」，于是自动拿到通用骨架。
        const resolved = resolveSkeletonType(t);
        if (resolved === '其他') return OUTLINE_SPEC_OTHER;
        return OUTLINE_SPEC_BY_TYPE[resolved] || null;
    }

    /** M6.3：收集一份 spec 里所有声明了 refable 的列表名 → 它们的 id 前缀 */
    function refableNamesOf(spec) {
        if (!spec) return [];
        const out = [];
        for (const grp of ['required', 'optional']) {
            const fields = spec[grp] || {};
            for (const [k, meta] of Object.entries(fields)) {
                if (meta && meta.refable) out.push(k);
            }
        }
        return out;
    }

    /**
     * M6.6（2026-11-06）：跨层撞键校验——structure 顶层只能放两类键：
     *   ① 外层键本身（不该出现，structure 里再放一遍 event_name 是重复）
     *   ② 本主类型的 spec 里声明过的内层字段
     * 别的东西一律算越界，报出来。pack 字段必须写在 structure.packs.<pack> 下面，
     * 阶段字段写在 structure.phases[] 里面——这两处都是 spec 之外的结构，不算顶层。
     *
     * 为什么要有这条：现在四个消费函数各自按需读字段，模型自造一个键也不报错，
     * 于是「写对了但没人读」和「写错了但看着像对」分不出来。
     * 有了这条，spec 之外的键会当场现形。
     *
     * 只报警告不判失败：容错读取还在（渲染层读不出就跳过），这一条是给日志和面板看的。
     */
    function crossLayerKeyWarnings(outline, mainType) {
        const out = [];
        const o = outline || {};
        const structRaw = o.structure;
        if (!structRaw || typeof structRaw !== 'object' || Array.isArray(structRaw)) return out;

        // 「其他」用通用骨架的字段清单；没骨架的类型不查（还没定义什么算对）
        const spec = specOfType(mainType);
        if (!spec) return out;

        const allowed = new Set();
        for (const grp of ['required', 'optional']) {
            for (const k of Object.keys(spec[grp] || {})) allowed.add(k);
        }
        // 阶段数组与 packs 是 spec 之外但合法的两块结构（定稿 1N / §2）
        allowed.add('phases');
        allowed.add('packs');

        const strays = Object.keys(structRaw).filter(k => !allowed.has(k) && !OUTLINE_OUTER_KEYS.includes(k));
        if (strays.length) {
            out.push(`structure 里有本类型没有的键：${strays.map(k => labelOf(k)).join('、')}`
                + `（主类型「${mainType}」的骨架里没有这些；pack 字段要写在 structure.packs 下面）`);
        }
        // 外层键重复：structure 里又出现一遍 event_name 之类
        const dup = Object.keys(structRaw).filter(k => OUTLINE_OUTER_KEYS.includes(k) && k !== 'structure');
        if (dup.length) {
            out.push(`外层键 ${dup.map(k => labelOf(k)).join('、')} 重复写进了 structure 里，应只写在外层`);
        }

        // ---- 结构包的跨层撞键（M15，2026-11-09 15:47 复核要求）----
        // 包字段与主类型字段是不同命名空间（structure.packs.<包名>.<字段>），
        // 真正要防的是模型把包字段平铺到 structure 顶层。
        // 这件事不会命中上面的 strays 检查：模型若把 trust / alert 直接写在 structure 下，
        // strays 会报「本类型没有的键」，但报的是「没有这个键」而不是「放错层了」，
        // 用户按着报错去改，很可能干脆删掉，包就白挂了。所以单独说清楚。
        const packStrays = [];
        const packsVal = structRaw.packs;
        if (packsVal && typeof packsVal === 'object' && !Array.isArray(packsVal)) {
            for (const [packName, packDef] of Object.entries(OUTLINE_PACK_BY_NAME)) {
                // 没挂的包，它的字段出现在顶层也算平铺
                for (const fieldName of Object.keys(packDef.fields || {})) {
                    if (Object.prototype.hasOwnProperty.call(structRaw, fieldName)) {
                        packStrays.push(`${labelOf(fieldName)}（应写在 structure.packs.${packName} 下）`);
                    }
                }
            }
        } else {
            // 连 packs 都没有，但顶层出现了某个包才有的字段：同样是平铺
            for (const [packName, packDef] of Object.entries(OUTLINE_PACK_BY_NAME)) {
                for (const fieldName of Object.keys(packDef.fields || {})) {
                    if (Object.prototype.hasOwnProperty.call(structRaw, fieldName)) {
                        packStrays.push(`${labelOf(fieldName)}（应写在 structure.packs.${packName} 下）`);
                    }
                }
            }
        }
        if (packStrays.length) {
            const uniq = [...new Set(packStrays)];
            out.push(`结构包字段被平铺到了 structure 顶层：${uniq.join('、')}；这些字段要收进 structure.packs 里`);
        }

        // 挂了几个包：定稿 §3.3 最多 1 个
        if (packsVal && typeof packsVal === 'object' && !Array.isArray(packsVal)) {
            const mounted = Object.keys(packsVal).filter(k => OUTLINE_PACK_BY_NAME[k]);
            if (mounted.length > 1) {
                out.push(`挂了 ${mounted.length} 个结构包（${mounted.join('、')}），最多只能挂 1 个`);
            }
        }
        return out;
    }

    /**
     * M6.3（2026-11-06）：引用完整性校验。
     * spec 里标了 ref 的字段，引用的编号必须真的存在，而且只能指向标了 refable 的列表。
     * 以前这几条是写在注释和 rules 文本里的，程序不查，写了不存在的编号也没人知道。
     */
    function refIntegrityWarnings(outline, mainType) {
        const out = [];
        const spec = specOfType(mainType);
        if (!spec) return out;
        const refables = refableNamesOf(spec);
        if (!refables.length) return out;

        const o = outline || {};
        const collect = (fieldName) => {
            const raw = innerField(o, fieldName);
            if (!Array.isArray(raw)) return [];
            return raw.map(x => (x && typeof x === 'object') ? nodeId(x) : x).filter(v => v != null && v !== '');
        };
        const present = {};
        for (const name of refables) present[name] = new Set(collect(name).map(String));

        const known = new Set();
        for (const name of refables) {
            for (const v of present[name]) known.add(String(v));
        }

        const visit = (meta, fieldPath) => {
            if (!meta || typeof meta !== 'object') return;
            if (meta.ref) {
                const vals = [];
                const raw = innerField(o, fieldPath);
                if (Array.isArray(raw)) raw.forEach(v => vals.push(v));
                else if (raw != null && raw !== '') vals.push(raw);
                const bad = vals
                    .filter(v => v != null && String(v).trim() !== '')
                    .filter(v => !known.has(String(v).trim()));
                if (bad.length) {
                    out.push(`${labelOf(fieldPath)} 引用了不存在的编号 ${bad.map(String).join('、')}`
                        + `（${refables.map(r => r + '.id').join('、')} 里没有）`);
                }
            }
            // 列表元素的子键：逐个元素查
            if (meta.item) {
                const raw = innerField(o, fieldPath);
                if (!Array.isArray(raw)) return;
                raw.forEach((el, i) => {
                    if (!el || typeof el !== 'object') return;
                    for (const [k, m] of Object.entries(meta.item)) {
                        if (!m || typeof m !== 'object' || !m.ref) continue;
                        if (el[k] == null || el[k] === '') continue;
                        const vs = Array.isArray(el[k]) ? el[k] : [el[k]];
                        const bad = vs.filter(v => v != null && String(v).trim() !== '')
                            .filter(v => !known.has(String(v).trim()));
                        if (bad.length) {
                            out.push(`第 ${i + 1} 条的 ${labelOf(k)} 引用了不存在的编号 ${bad.map(String).join('、')}`);
                        }
                    }
                });
            }
        };

        for (const grp of ['required', 'optional']) {
            for (const [k, meta] of Object.entries(spec[grp] || {})) {
                // 自己就是 refable 的列表不用查自己引用自己
                visit(meta, k);
            }
        }
        return out;
    }

    /**
     * M6.1：取某个主类型的进度来源声明（M5 起使用）。
     * 「其他」走通用骨架的 progress（按阶段推进，定稿 1U）。
     */
    function progressSpecOf(mainType) {
        // M7：自定义类型先解析到它映射到的内置类型，再取进度来源。
        // 不解析的话「盗墓」拿不到探险探索的进度字段，盘点页会是空的。
        const t = resolveSkeletonType(String(mainType || '').trim());
        if (t === '其他') {
            const p = OUTLINE_SPEC_OTHER.progress;
            return p ? { field: p.field, legacy: !!p.legacy } : null;
        }
        const spec = OUTLINE_INNER_KEYS_BY_TYPE[t];
        if (!spec || !spec.progress) return null;
        return { field: spec.progress.field, legacy: !!spec.progress.legacy };
    }

    // 2026-11-05 5.2 裁定后删除 OUTLINE_INNER_FALLBACK_TYPE。
    // 它以前在 prompt 拼装没拿到主类型时回落成「案件推理」，现在改成直接抛错，
    // 这个常量就没有使用点了。留着会让后来人以为还有兜底路径可走。
    // 注意：innerKeysOf 对没有骨架的类型仍然返回 known:false（跳过内层校验），
    // 那是「未知类型不套案件字段」的正常分支，跟这个已删的兜底常量不是一回事。

    /**
     * 取某个主类型的内层键清单。
     * 返回 { required, optional, known}：known=false 表示这个类型还没有骨架，
     * 调用方据此跳过内层校验（而不是回落到案件字段去套）。
     * 「其他」有骨架（通用七字段），known 为 true。
     */
    function innerKeysOf(mainType) {
        // M7：自定义类型按映射取内层键。没配映射的解析成「其他」，
        // 于是自动拿到通用六字段——这就是「默认套其他通用骨架」在字段层面的落实。
        const t = resolveSkeletonType(String(mainType || '').trim());
        if (t === '其他') {
            return {
                required: Object.keys(OUTLINE_SPEC_OTHER.required || {}),
                optional: Object.keys(OUTLINE_SPEC_OTHER.optional || {}),
                known: true,
            };
        }
        const spec = OUTLINE_INNER_KEYS_BY_TYPE[t];
        if (!spec) return { required: [], optional: [], known: false };
        return {
            required: (spec.required || []).slice(),
            optional: (spec.optional || []).slice(),
            known: true,
        };
    }

    /** 只要键名（prompt 里列清单用），把必填与可选合成一份，可选的标出「可选」 */
    function innerKeyNamesOf(mainType) {
        const spec = innerKeysOf(mainType);
        if (!spec.known) return [];
        return spec.required.concat(spec.optional.map(k => k + '（可选）'));
    }

    /**
     * M6.4/M6.5（2026-11-07）：把 spec 里声明的子键形态翻成给模型看的一行说明。
     * 只在字段确实是 map 且写了 sub 时才返回内容——没写 sub 的老字段一个字都不多吐，
     * 免得提示词凭空变长。
     */
    function subKeyHintOf(mainType, field) {
        const spec = specOfType(mainType);
        if (!spec) return '';
        for (const grp of ['required', 'optional']) {
            const meta = (spec[grp] || {})[field];
            if (!meta) continue;
            if (meta.kind !== 'map' || !meta.sub) return '';
            const parts = Object.entries(meta.sub).map(([sk, sd]) => {
                const req = sd && sd.required ? '（必需）' : '';
                const note = sd && sd.note ? '：' + sd.note : '';
                return sk + req + note;
            });
            return field + ' 是块状结构，子键为 ' + parts.join('；') + '。';
        }
        return '';
    }

    /**
     * 大纲的内层字段统一从 structure 里取（2026-11-05 M2 评审）。
     *
     * 为什么要有这个函数：M2 把内层挪进 structure 之后，代码里还有十几处直接
     * `parsed.nodes`、`outline.characters` 这样读顶层，每一处都会恒为 undefined，
     * 而且症状各不相同——节点统计恒 0、世界书条目缺角色、编辑保存被误判成空壳、
     * 盘点页整块节点进度不渲染。这种「同一个取值规则抄在多处」正是以前清单漂移的老路，
     * 所以收成一份，所有内层读取都走这里。
     *
     * 只认 structure，不回落读顶层（2026-11-05 危晓裁定）：
     * 旧事件兼容性明确不考虑——不做迁移、不做展示兜底、不做只读降级。
     * 因此老形状的条目在这里读不到内层字段，面板与统计会显示为空。
     * 这不是疏漏，是既定口径；不要再加回顶层兜底。
     *
     * 唯一保留的底线是实现层面的：读不到就返回空值，绝不能抛异常，
     * 免得一条读不出的旧条目把整个面板弄白。
     */
    function outlineInner(outline) {
        const o = (outline && typeof outline === 'object') ? outline : {};
        const st = o.structure;
        return (st && typeof st === 'object' && !Array.isArray(st)) ? st : {};
    }

    /** 取内层的一个字段（只认 structure，不回落顶层） */
    function innerField(outline, key) {
        const inner = outlineInner(outline);
        return inner[key];
    }

    /** 取内层的信息节点数组，读不到返回空数组 */
    function innerNodesOf(outline) {
        const n = innerField(outline, 'nodes');
        return Array.isArray(n) ? n : [];
    }

    // 悬浮窗尺寸（吸附竖条与展开图标）
    const FAB_TAB_VISIBLE = 20;   // 吸附时可见宽度
    const FAB_TAB_HEIGHT = 44;    // 吸附时高度，与展开图标边长一致
    const FAB_EXPANDED = 44;      // 展开时边长
    const CHRONICLE_NAME = '纪要表';

