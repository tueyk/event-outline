    // ==================== 10. 事件流程 ====================

    let busy = S.busy; // 引用指向 S，值统一存 S
    /**
     * 令牌 → 人话（2026-11-10 批 3 第 18 项）。
     * 忙碌时用户看到「正在生成大纲」是够的，但多条流程互相避让时要能说清是谁占着，
     * 日志里写「inventoryOwner」这种东西没人看得懂。
     */
    const BUSY_OWNER_LABEL = {
        'gen': '生成大纲',
        'gen-chain': '逐条生成事件',
        'adopt': '采用事件',
        'inv': '盘点',
        'inv-auto': '自动盘点',
        'inv-manual': '手动盘点',
        'close': '废弃/完结',
    };
    function ownerLabel(owner) {
        return BUSY_OWNER_LABEL[owner] || String(owner || '另一个操作');
    }
    /**
     * 纯本地操作的占用者：写/删世界书条目、改状态、清历史，全程不发模型请求。
     * 这几步不该显示「放弃等待」——没有请求可打断，按钮点了什么也停不下来（2026-11-14 危晓反馈）。
     * 新加的 owner 默认仍显示按钮，只有确实纯本地的才往这里加，别把它们混成一团。
     */
    const LOCAL_ONLY_OWNERS = new Set(['adopt', 'close']);

    // 忙碌提示文案随操作变：废弃/完结是本地操作，不该显示「正在请求模型」
    let busyText = S.busyText; // 引用指向 S，值统一存 S

    /**
     * 切换忙碌状态。
     * @param on 是否忙碌
     * @param keepProgress 结束时是否保留进度列表（生成/盘点用）
     * @param text 忙碌提示文案。不传就沿用上一次的，避免文案互相覆盖
     * @param owner 占用者标识（2026-11-10 批 3 第 18 项）。
     *        解锁时只有持有者放得开：别人调 setBusy(false) 会被忽略，
     *        免得自动盘点跑完把手动盘点的提示条收掉。不传 owner 的老调用一律当作持有者，
     *        行为与改前一致，不会因为漏传就把锁死住。
     */
    function setBusy(on, keepProgress, text, owner) {
        const who = owner || null;
        if (!on && S.busy) {
            // 解锁时认持有者：记着别人名字的不放
            if (S.busyOwner && who && S.busyOwner !== who) {
                debug(`忽略 ${who} 的解锁：当前忙碌由 ${S.busyOwner} 占着`);
                return;
            }
        }
        S.busy = on;
        S.busyOwner = on ? (who || S.busyOwner) : null;
        if (text) S.busyText = text;
        if (S.panelEl) {
            const b = S.panelEl.querySelector('#eo_busy');
            if (b) {
                // 忙碌条上只放文字和一个「放弃等待」按钮：请求挂住时这是唯一出路，
                // 以前只能刷新整个页面。按钮点了之后走 abortPendingRequest，busy 随之解除
                b.innerHTML = '';
                b.appendChild(document.createTextNode(text || S.busyText || '处理中…'));
                // 2026-11-14 危晓反馈：采用和废弃时点「放弃等待」没有反应。
                // 根因不是按钮坏了——那两步是纯本地操作（写/删世界书条目），根本不发模型请求，
                // S.pendingRequest 是空的，点下去只能弹一句「没有可打断的请求」。
                // 界面上给一个按了不会拦下任何东西的按钮本身就是错：它承诺了做不到的事。
                // 所以本地操作干脆不显示这个按钮，而不是留着它骗人。
                if (on && !LOCAL_ONLY_OWNERS.has(who || S.busyOwner || '')) {
                    const giveUp = el('span', 'eo-giveup', '放弃等待');
                    giveUp.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (!abortPendingRequest()) {
                            // 走到这里说明以为能打断却没有请求在等（比如恰好落在两次请求之间），只提示不假装
                            toast('当前这一步没有可打断的请求，稍等片刻会自己结束');
                        } else {
                            log('已放弃等待模型返回');
                        }
                    });
                    b.appendChild(giveUp);
                }
                b.style.display = on ? 'block' : 'none';
            }
        }
        if (!on && !keepProgress) {
            resetProgress();
        } else if (!on && keepProgress) {
            // 跑完了：停掉计时器，保留进度列表让人看清各步耗时，几秒后变淡
            if (S.progress.timer) { clearInterval(S.progress.timer); S.progress.timer = null; }
            const box = S.panelEl && S.panelEl.querySelector('#eo_progress');
            if (box) {
                const t = box.querySelector('.eo-progress-timer');
                if (t) t.textContent = `共用时 ${Math.floor((Date.now() - S.progress.startedAt) / 1000)} 秒`;
            }
        }
    }

    // ---------- 字段中文对照（界面展示用，模型返回的键名不暴露给用户） ----------

    const OUTLINE_KEY_LABEL = {
        event_name: '事件名',
        event_brief: '事件简介',
        event_type: '事件类型',
        core_truth: '核心真相',
        nodes: '信息节点',
        min_nodes_for_deduction: '推理必需节点',
        characters: '参与角色',
        paths: '推进路径',
        forbidden: '禁止事项',
        helpers: '助力者',
        obstructers: '阻碍者',
        informants: '知情者',
        behind_scenes: '幕后方',
        // 2026-11-05 M3：战斗内层的七个键与它们的子项。
        // 不补的话世界书条目与面板上会直接露英文键名（enemy_forces、depart_time 这些），
        // 与「键名一律翻中文」的既定做法不符。
        enemy_forces: '敌方编制',
        objectives: '战斗目标',
        terrain: '地形',
        reinforcements: '援军',
        retreat: '撤退',
        casualty: '伤亡与俘虏',
        preparation: '事先准备',
        // ---- 二期 M9（2026-11-09）：谈判交涉的内层键 ----
        // 不补的话面板与世界书会直接露英文键名（parties、bottom_line 这些），
        // 与「键名一律翻中文」的既定做法不符。
        parties: '各方立场',
        leverage: '筹码',
        intermediaries: '中间人',
        rounds: '谈判轮次',
        agreement: '协议',
        demand: '诉求',
        bottom_line: '底线',
        can_concede: '可让步',
        cannot_concede: '不可让步',
        credibility: '可信度',
        holder: '持有方',
        item: '筹码内容',
        source: '来源',
        stance: '立场',
        can_do: '能做什么',
        // ---- 二期 M10（2026-11-09）：生存危机的内层键 ----
        resources: '剩余资源',
        environment: '环境',
        threats: '威胁波次',
        shelters: '避难所',
        time_window: '时间窗口',
        water: '水',
        food: '食物',
        medicine: '药品',
        fire: '火',
        stamina: '体力',
        weather: '天气',
        terrain: '地形',
        visibility: '能见度',
        wave: '波次',
        intensity: '强度',
        interval: '间隔',
        gain: '能得到什么',
        start: '开始',
        end: '结束',
        // ---- 二期 M11（2026-11-09）：探险探索 ----
        sites: '地点',
        // 探险的路线清单。用复数 routes 是为了与案件的 paths[].route 分开——
        // 标签表是扁平的，同一个 route 只能有一个中文名，
        // 案件那条（「路径正文」）是既有行为，不能因为探险来改。
        routes: '路线',
        hazards: '危险',
        discoveries: '发现',
        mechanism: '机关',
        guard: '守卫',
        supplies: '补给',
        site: '地点编号',
        path: '路线描述',
        required_pass: '是否必经',
        fail_result: '失败后果',
        trigger: '触发条件',
        result: '后果',
        // ---- 二期 M12（2026-11-09）：社交博弈 ----
        factions: '阵营',
        occasions: '场合',
        favours: '人情',
        rumours: '传言',
        reputation: '声望',
        // 2026-11-09：leverage 在谈判交涉里是「筹码」，在社交博弈里是「把柄」。
        // 标签表是全局字典，一 KEY 只能一个名字，后定义会覆盖先定义——
        // 社交这条一度把谈判的「筹码」顶成了「把柄」。
        // 两个类型都要用就各用一个键：谈判用 leverage（筹码），社交用 pressure（把柄）。
        pressure: '把柄',
        when_where: '何时何地',
        stake: '要定下什么',
        who: '谁欠谁',
        what: '欠什么',
        spread: '扩散程度',
        gain: '做什么会升',
        lose: '做什么会降',
        // ---- 二期 M13（2026-11-09）：日常杂务 ----
        steps: '步骤',
        deliverable: '交付物',
        complications: '变数',
        moral: '道德岔口',
        what: '做什么',
        where: '在哪',
        deadline: '时限',
        accept: '验收标准',
        how: '怎么收拾',
        // contract 的子键（外层，二期 M13 用到）
        giver: '委托人',
        reward: '报酬',
        // ---- 二期 M14（2026-11-09）：禁忌秘辛 ----
        taboo: '禁忌',
        knowers: '知情者',
        cost: '代价',
        cover_up: '掩盖手段',
        breaking: '破禁条件',
        consequences: '后果',
        silence: '沉默原因',
        method: '手段',
        trace: '痕迹',
        // ---- M15 结构包（2026-11-09）----
        trust: '信任程度',
        boundaries: '关系底线',
        history: '旧账',
        escalation: '升级条件',
        fallout: '崩了怎么收',
        procedure: '流程',
        roles: '各人角色',
        taboos: '禁忌',
        score: '判定标准',
        audience: '旁观者反应',
        alert: '警戒等级',
        patrol: '巡逻',
        disguise: '伪装',
        exposure: '暴露度',
        infiltration: '渗透深度',
        market: '行情',
        bidders: '竞价者',
        lots: '标的',
        terms: '交付与担保',
        budget: '预算',
        real: '真伪',
        value: '价值',
        can: '可以做的',
        participants: '参与关系',
        // ---- 二期 M14.5（2026-11-09）：NSFW ----
        pacing: '节奏控制',
        consent: '同意与边界',
        aftermath: '收束与后效',
        wants: '想要什么',
        hesitates: '顾虑',
        line: '底线',
        confirm: '怎么确认',
        go: '可以推进',
        stop: '必须停',
        slow: '放慢',
        cannot: '不能做的',
        progress: '进展程度',
        scene: '场景',
        state: '双方状态',
        end_mark: '结束标志',
        round: '轮次',
        topic: '议题',
        break_point: '破裂点',
        cooldown: '冷却',
        draft_effect: '草签后果',
        winner: '得利方',
        loser: '受损方',
        // preparation 的五个子项（定稿 §5：物资/陷阱/情报/盟友/出发时间）
        supplies: '物资',
        traps: '陷阱',
        intel: '情报',
        allies: '盟友',
        depart_time: '出发时间',
        // enemy_forces 每一项的四件事（定稿 §5：编制/等级/战术/士气）
        strength: '兵力',
        level: '等级',
        tactic: '战术',
        morale: '士气',
        // terrain 的三件事（定稿 §5：掩体/高低差/狭窄处）
        cover: '掩体',
        elevation: '高低差',
        chokepoint: '狭窄处',
        // reinforcements 的波次项
        wave: '波次',
        arrive: '到达时间',
        size: '规模',
        // 2026-11-05 M4：阶段数组
        phases: '阶段',
        goal: '目标',
        entry: '入场',
        exit: '退场',
        optional: '可跳过',
        avoid_condition: '避开条件',
        fields: '阶段字段',
        // objectives 的 condition / fail 在下面已有定义（案件路径也用），不在这里重复
        name: '名字',
        // 身份/动机/代价在提示词骨架里用短键（identity/motive/cost），
        // 早期模型输出用的是长键（role/motive_type/conditions），两套都认
        role: '身份',
        identity: '身份',
        motive: '动机',
        cost: '条件与代价',
        motive_type: '动机类型',
        motive_detail: '动机详述',
        conditions: '条件与代价',
        note: '备注',
        reason: '阻碍理由',
        resolvable_by: '化解方式',
        info_known: '掌握的信息',
        reveal: '揭示条件',
        authority: '支配关系',
        scope: '范围',
        reveal_condition: '揭示条件',
        exposure_path: '暴露路径',
        id: '编号',
        type: '类型',
        trigger: '触发条件',
        info: '信息内容',
        consequence: '后果',
        refute_by: '可被节点推翻',
        // 2026-11-05 M2：内层整体收进 structure，加上案件新补的 suspects
        structure: '事件结构',
        suspects: '嫌疑人',
        alibi: '不在场证明',
        lie: '他的谎言',
        keyword: '触发词',
        keywords: '触发词',
        desc: '描述',
        step: '步骤',
        node: '对应节点',
        detail: '说明',
        required_nodes: '必经节点',
        optional_nodes: '可跳过节点',
        risk: '风险',
        failure: '失败后果',
        fail: '失败情形',
        must: '是否必经',
        route: '路径正文',
        thrust: '推进作用',
        time_pressure: '时间压力',
        danger: '危险程度',
        points_to: '指向信息',
        content: '内容',
        when: '触发时机',
        why: '理由',
        behind_the_scenes: '幕后方',
        blockers: '阻碍者',
        obstructors: '阻碍者',
        can_resolve: '化解方式',
        condition: '条件',
        condition_or_cost: '条件与代价',
        expose_path: '暴露路径',
        hidden: '隐藏信息',
        holds: '掌握的信息',
        how_to_get: '获取方式',
        is_misleading: '是否误导',
        kind: '类别',
        knows: '知道什么',
        motivation_type: '动机类型',
        out_of_plan_paths: '大纲外走向',
        outcomes: '结果',
        path: '路径',
        primary: '主类型',
        reason_now: '当下的理由',
        required: '是否必需',
        resolution: '化解方式',
        resolvable: '可否化解',
        secondary: '次类型',
        steps: '步骤',
        why_now: '当下的理由',
        wont_tell: '不肯说的',
        // 时间压力 / 危险程度 两组的子键（2026-11-02 补）。
        // 中文键映射表早就收下了这些写法，但显示用的 OUTLINE_KEY_LABEL 没跟上，
        // 结果是编辑框里只有外层「时间压力：」「危险程度：」是中文，里面几个子键露着英文。
        countdown: '倒计时',
        duration: '时长',
        timeout_result: '超时后果',
        delay_cost: '拖延代价',
        lethality: '致死性',
        // 注意：failure / fail 两个名字在上面已经给过了（danger 组用 failure，paths 组用 fail），
        // 这里不要再写一遍——写重复了不报错，但标签表就出现两条一样的键，查起来费劲
        tolerance: '容错率',
        threat_source: '威胁来源',
    };

    const NODE_TYPE_LABEL = {
        物证: '物证', 证言: '证言', 环境: '环境', 时间线: '时间线', 关系: '关系',
        evidence: '物证', testimony: '证言', environment: '环境', timeline: '时间线', relation: '关系',
    };

    const EVENT_TYPE_LABEL = {
        案件: '案件', 谈判: '谈判', 探险: '探险', 危机: '危机', 社交博弈: '社交博弈', 其他: '其他',
        case: '案件', negotiation: '谈判', exploration: '探险', crisis: '危机', social: '社交博弈', other: '其他',
        // 2026-11-04 补：模型常按英文写类型，原来只认上面那几个，写 investigation 就原样显示英文。
        // 这里收的是实际见过的写法，认不得的走 keyText() 兜底，不再裸奔
        案件推理: '案件推理', investigation: '案件推理', detective: '案件推理', mystery: '悬疑',
        谈判交涉: '谈判交涉', persuasion: '谈判交涉',
        探险探索: '探险探索', adventure: '探险探索',
        生存危机: '生存危机', survival: '生存危机',
        战斗冲突: '战斗冲突', combat: '战斗冲突', battle: '战斗冲突',
        // M6（2026-11-06）：日常委托 → 日常杂务（定稿 1J）。
        // 旧名「日常委托」保留为别名，存量事件的 event_type.primary 里可能还是旧写法，
        // 认不出来会让它显示成未知类型。这只是读取时的名字归一，不是兼容性兜底。
        日常杂务: '日常杂务', daily: '日常杂务', commission: '日常杂务',
        日常委托: '日常杂务',
        禁忌秘辛: '禁忌秘辛', forbidden: '禁忌秘辛', secret: '禁忌秘辛',
        悬疑: '悬疑', suspense: '悬疑',
        恐怖: '恐怖', horror: '恐怖',
        情感: '情感', romance: '情感',
    };

    /**
     * 按 spec 表渲染一个内层字段（2026-11-09，二期 M6 收尾）。
     *
     * 为什么要这个函数：一期案件与战斗的渲染各自手写一份——案件是节点/路径那套
     * 写死的分支，战斗是 combatBlocks 数组。加一套骨架就要再抄一份，而 spec 表
     * （OUTLINE_SPEC_BY_TYPE）本来就写清了每个字段是什么形态。
     * 二期一次加六套骨架，再不收口就是九份手写分支。
     *
     * 输入是字段元数据 meta（含 kind / item / fields 等），输出若干行。
     * kind 不认识时退回「有什么显示什么」，不抛异常——模型给的东西形状再怪，
     * 也不能让整块面板白掉。
     */
    /**
     * 把标量取值转成给人看的一行文字（2026-11-09 真机）。
     *
     * bool 一律翻成「是/否」：面板上出现「是否必经：true」是漏的，
     * 而且这个字段本身就是是非题，写「是」才读得通。
     * 数字与字符串原样（去首尾空白）。
     */
    function scalarText(v) {
        if (typeof v === 'boolean') return v ? '是' : '否';
        if (v == null) return '';
        return String(v).trim();
    }

    /**
     * 判断一个值是不是「写了等于没写」（2026-11-09 M14.5 真机）。
     *
     * 真机上来过一个 aftermath: {}，渲染成光秃秃一行「收束与后效：」。
     * 根因是原来只拦 null 与空字符串，空对象照样往下走，进了文本分支以后
     * String({}) 得到 '[object Object]' 会被别的判断挡下，可空对象走到 scalarText
     * 就变成空串——标题留在那里，内容没了。
     *
     * 这里把「空对象、空数组、只含空值的对象」都算空。这不涉及旧事件兼容，
     * 纯粹是模型返回的东西不保证规整，渲染层不该把空壳当内容画出来。
     */
    function isBlankValue(v) {
        if (v == null) return true;
        if (typeof v === 'string') return v.trim() === '';
        if (typeof v === 'boolean' || typeof v === 'number') return false;
        if (Array.isArray(v)) return v.every(isBlankValue);
        if (typeof v === 'object') {
            const vals = Object.values(v);
            if (!vals.length) return true;
            return vals.every(isBlankValue);
        }
        return false;
    }

    function renderFieldBySpec(key, meta, value, opts) {
        const out = [];
        const o = opts || {};
        if (isBlankValue(value)) return out;
        const title = o.title || labelOf(key);
        const kind = (meta && meta.kind) || 'text';
        const indent = o.indent || '  ';

        const push = (t) => out.push(indent + t);

        // 标量直接一行
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            // bool 写成「是/否」，别让 true/false 直接露到面板上（2026-11-09 真机：
            // 探险的「是否必经：true」）。语义上 bool 字段问的都是是非题。
            const t = typeof value === 'boolean' ? (value ? '是' : '否') : String(value).trim();
            if (t) { out.push(title + '：' + t); }
            return out;
        }

        if (Array.isArray(value)) {
            // 元素全是标量
            const allScalar = value.every(x => x == null || typeof x !== 'object');
            if (allScalar) {
                out.push(title + '：');
                value.forEach((x, i) => push(`${i + 1}. ${String(x)}`));
                return out;
            }
            out.push(title + '：');
            // 元素形态：优先用 spec 的 item 声明，没有就用元素自己出现的键
            const itemMeta = (meta && (meta.item || meta.sub)) || {};
            value.forEach((el, i) => {
                if (el == null || typeof el !== 'object') { push(`${i + 1}. ${String(el)}`); return; }
                renderItem(el, itemMeta, i, out, indent);
            });
            return out;
        }

        if (typeof value === 'object') {
            out.push(title + '：');
            // spec 声明了 keys 时，先按它给的顺序渲染，没声明的键补在后面。
            // 只按 keys 显示会把「模型写了但 spec 没列」的内容吞掉，
            // 只按数据顺序又会让标了 keys 的字段乱序——两头都要。
            const declaredKeys = (meta && Array.isArray(meta.keys)) ? meta.keys : [];
            const actualKeys = Object.keys(value);
            const orderedKeys = [
                ...declaredKeys.filter(k => actualKeys.includes(k)),
                ...actualKeys.filter(k => !declaredKeys.includes(k)),
            ];
            for (const k of orderedKeys) {
                const v = value[k];
                if (v == null || v === '') continue;
                const sub = (meta && meta.sub && meta.sub[k]) || (meta && meta.item && meta.item[k]) || null;
                if (Array.isArray(v) || (v && typeof v === 'object')) {
                    out.push(...renderFieldBySpec(k, sub || {}, v, { indent: indent + '  ' }));
                } else {
                    push(labelOf(k) + '：' + scalarText(v));
                }
            }
            return out;
        }

        return out;
    }

    /**
     * 渲染数组里的一条。字段顺序优先按 spec 的 item 声明，
     * 声明里没有的键排在后面，保证模型自造的键也能看见。
     */
    function renderItem(el, itemMeta, index, out, indent) {
        const push = (t) => out.push(indent + t);
        const declared = itemMeta && typeof itemMeta === 'object' ? Object.keys(itemMeta) : [];
        const actual = Object.keys(el).filter(k => el[k] != null && el[k] !== '');
        const ordered = [
            ...declared.filter(k => actual.includes(k)),
            ...actual.filter(k => !declared.includes(k)),
        ];
        // 序号类字段不当标题：spec 里标了 seq 的，或者名字本身就是编号语义的。
        // 不含这一段的话「轮次 1」会渲染成「1. 1」——序号重复两遍。
        //
        // 2026-11-09 真机（探险探索「桦木沟的夜半翻篱客」）：routes 的 site 字段是
        // 「指向 sites 的编号」，标的是 ref 不是 seq，于是没被排除，渲染成「1. 1」「2. 2」——
        // 行首编号是列表序号，标题又是个纯数字，读者完全不知道这一段是哪条路。
        // 指向别处编号的字段属于引用而不是本条目的名字，一律不当标题。
        const isSeqKey = (k) => {
            const m = itemMeta && itemMeta[k];
            if (m && (m.seq || m.ref)) return true;
            return k === 'id' || k === 'round' || k === 'step' || k === 'index' || k === 'no';
        };
        const titleKeys = ordered.filter(k => !isSeqKey(k));
        const headKey = titleKeys.length ? titleKeys[0] : ordered[0];
        const headVal = headKey == null ? '' : String(el[headKey]).trim();
        // 引用类字段（如 routes.site 指向 sites 编号）不进正文子项，但也不能凭空消失——
        // 它是读者把这一段对回哪个地点的唯一线索。挂到标题行末尾，形状跟因果链里的指向一致。
        const refKeys = ordered.filter(k => {
            const m = itemMeta && itemMeta[k];
            return m && m.ref && !m.seq && k !== headKey
                && el[k] != null && el[k] !== '';
        });
        const refText = refKeys.map(k => '（' + labelOf(k) + ' ' + scalarText(el[k]) + '）').join('');
        push(`${index + 1}. ${headVal}${refText}`);
        for (const k of ordered) {
            if (k === headKey) continue;
            // 序号与引用字段都不单独占行：序号体现在行首数字里，
            // 引用已经并进标题行末尾（refText）。这两类都被 isSeqKey 判掉，
            // 所以这一句就覆盖住了，不用再为 refKeys 单独写一条（那是死代码）。
            if (isSeqKey(k)) continue;
            const v = el[k];
            const sub = itemMeta[k];
            if (Array.isArray(v) || (v && typeof v === 'object')) {
                out.push(...renderFieldBySpec(k, sub || {}, v, { indent: indent + '   ' }));
            } else {
                out.push(indent + '   ' + labelOf(k) + '：' + scalarText(v));
            }
        }
    }

    /** 键名转中文，认不出就保留原样 */
    function labelOf(key) {
        const k = String(key || '');
        return OUTLINE_KEY_LABEL[k] || OUTLINE_KEY_LABEL[k.toLowerCase()] || k;
    }

    /**
     * 把大纲结构渲染成人类可读的中文文本块，替代直接展示原始 YAML。
     * 解析失败时返回 null，由调用方退回显示原文。
     */
    /**
     * @param {object} outline
     * @param {object} [opts] { hideType } 隐藏事件类型那一行。
     *   待选卡片用（2026-11-09 危晓：展示待选事件大纲时不用展示事件类型）：
     *   待选卡片的标题和分组已经写明了类型，正文再重复一遍是噪音。
     *   当前事件的详情页仍然显示，那里是唯一一处能看到完整信息的地方。
     */
    function renderOutlineText(outline, opts) {
        if (!outline || typeof outline !== 'object') return null;
        const hideType = !!(opts && opts.hideType);
        const lines = [];
        // 2026-11-05 M2 复核：核心真相、节点、角色、路径都在 structure 里。
        // 这里以前直接读 outline.xxx，新事件会整块渲染成空壳——用户在面板上看不到自己的大纲。
        const inner = k => innerField(outline, k);

        if (outline.event_brief) lines.push(`一句话简介：${outline.event_brief}`);
        const et = outline.event_type;
        if (et && !hideType) {
            if (typeof et === 'string') {
                lines.push(`事件类型：${EVENT_TYPE_LABEL[et] || keyText(et)}`);
            } else {
                const main = et.primary || et.main || et['主类型'] || '';
                const subs = Array.isArray(et.secondary) ? et.secondary
                    : (Array.isArray(et.sub) ? et.sub
                    : (Array.isArray(et['次类型']) ? et['次类型'] : []));
                const mainText = EVENT_TYPE_LABEL[main] || keyText(main);
                lines.push(`事件类型：${mainText}${subs.length ? '（兼 ' + subs.map(x => EVENT_TYPE_LABEL[x] || keyText(x)).join('、') + '）' : ''}`);
            }
        }
        const coreTruth = inner('core_truth');
        if (coreTruth) {
            lines.push('');
            lines.push('核心真相（仅你知道，不会被透露给角色）：');
            lines.push(String(coreTruth).trim());
        }

        // 阶段数组（2026-11-05 M4）：按段的顺序展示。
        // 放在最前面（在节点与角色之前），因为它是「这一整场戏怎么分段」的骨架，
        // 读者要先知道分几段，再看每段里的细节。
        //
        // 2026-11-09 真机（危晓定）：生存危机不渲染阶段。
        // 这类型的推进单位是「熬过第几波威胁」，威胁波次已经把节奏说清了；
        // 模型还会顺手写一份 phases，两块一起显示就是同一件事说两遍。
        // 只对生存危机跳过，别的类型若写了阶段照旧显示。
        // 2026-11-09 M14.5：NSFW 的内层字段就叫 phases，与这里读的通用阶段数组同名。
        // 不跳过的话同一个数组会被渲染两遍（顶上「阶段（共 N 段）」一遍、spec 分派里再一遍），
        // 而且顶上那遍取的键对不上，显示成「第 1 段 / 第 2 段」这种空壳。
        // NSFW 的阶段一律交给 spec 分派去渲染，这里让路。
        const skipStages = (mainTypeOfOutline(outline) === '生存危机'
            || mainTypeOfOutline(outline) === 'NSFW');
        const stagesRaw = skipStages ? null : inner('phases');
        const stages = Array.isArray(stagesRaw) ? stagesRaw : [];
        if (stages.length) {
            lines.push('');
            lines.push(`阶段（共 ${stages.length} 段）：`);
            stages.forEach((st, i) => {
                if (!st || typeof st !== 'object') {
                    lines.push(`  ${i + 1}. ${String(st)}`);
                    return;
                }
                const stType = st.type ? `〔${st.type}〕` : '';
                const stGoal = st.goal ? String(st.goal).trim() : `第 ${i + 1} 段`;
                const opt = (st.optional === true || String(st.optional).toLowerCase() === 'true'
                    || st.optional === '是' || st.optional === '可跳过');
                lines.push(`  ${i + 1}. ${stType}${stGoal}${opt ? '（可跳过）' : ''}`);
                if (st.entry) lines.push(`     从：${String(st.entry).trim()}`);
                if (st.exit) lines.push(`     到：${String(st.exit).trim()}`);
                // 可跳过的段要说清什么情况下跳过，否则「可跳过」等于没说
                if (opt && st.avoid_condition) lines.push(`     跳过条件：${String(st.avoid_condition).trim()}`);
                if (st.fields && typeof st.fields === 'object') {
                    // 2026-11-09 真机：fields 有两种写法——对象（{要点: 说明}）与字符串数组。
                    // 模型按骨架写成了数组，而这里只按 Object.entries 解，
                    // 数组的下标 0/1/2 就被当成了键名，渲染成「这一段：0 千夏的态度…；1 走廊上…」。
                    // 现在两种都认，数组按顺序、对象按 键：值。
                    const sub = [];
                    if (Array.isArray(st.fields)) {
                        for (const v of st.fields) {
                            if (v == null || v === '') continue;
                            if (typeof v === 'object') {
                                // 元素本身是对象时，逐个子键摊平，别整个 JSON 甩出来
                                for (const [k, vv] of Object.entries(v)) {
                                    if (vv == null || vv === '') continue;
                                    const s = (typeof vv === 'object') ? JSON.stringify(vv) : String(vv).trim();
                                    sub.push(`${labelOf(k)}：${s}`);
                                }
                            } else {
                                sub.push(String(v).trim());
                            }
                        }
                    } else {
                        for (const [k, v] of Object.entries(st.fields)) {
                            if (v == null || v === '') continue;
                            const s = (typeof v === 'object') ? JSON.stringify(v) : String(v).trim();
                            sub.push(`${labelOf(k)}：${s}`);
                        }
                    }
                    if (sub.length) lines.push(`     这一段：${sub.join('；')}`);
                }
            });
        }

        const nodesRaw = inner('nodes');
        const nodes = Array.isArray(nodesRaw) ? nodesRaw : [];
        if (nodes.length) {
            lines.push('');
            lines.push(`信息节点（共 ${nodes.length} 条，按发现顺序）：`);
            for (const n of nodes) {
                const id = nodeId(n);
                const type = NODE_TYPE_LABEL[n.type] || (n.type ? keyText(n.type) : '');
                lines.push(`${id}.〔${type}〕${nodeText(n)}`);
                if (nodeTrigger(n)) {
                    lines.push(`   触发：${nodeTrigger(n)}`);
                }
                if (n.consequence) lines.push(`   后果：${n.consequence}`);
                // 2026-11-06：原来只写「可推翻误导：指向节点 X」。模型把这个字段用错时
                // （把普通佐证关系挂上来），面板上就变成一句读不通的话——
                // 节点本身说的是实情，却标着「可推翻」。现在把话说全：这是误导项才有的东西，
                // 且写明是被谁拆穿，读者一看就知道该不该有。
                if (n.refute_by != null) {
                    const rb = Array.isArray(n.refute_by) ? n.refute_by.join('、') : n.refute_by;
                    lines.push(`   若按此条误判，到节点 ${rb} 会被拆穿`);
                }
            }
        }

        const minNodes = inner('min_nodes_for_deduction');
        if (minNodes) {
            const arr = Array.isArray(minNodes) ? minNodes : [minNodes];
            lines.push('');
            lines.push(`推理必需节点：${arr.join('、')}（集齐这些就足以推出核心真相）`);
        }

        const chars = inner('characters');
        if (chars && typeof chars === 'object') {
            lines.push('');
            lines.push('参与角色：');
            for (const [side, list] of Object.entries(chars)) {
                const sideLabel = labelOf(side);
                if (!Array.isArray(list) || !list.length) continue;
                lines.push(`  ${sideLabel}：`);
                for (const c of list) {
                    // 模型有时整套用中文字段（名称/身份/动机），只认英文会全显示成「未命名」
                    const cname = c.name || c['名称'] || c['角色名'] || c['姓名'] || '未命名';
                    const cRole = c.role || c.identity || c['身份'] || c['职衔'];
                    const head = [cname, cRole ? `（${cRole}）` : ''].join('');
                    lines.push(`    · ${head}`);
                    if (c.motive_detail || c.motive_type) {
                        lines.push(`      动机：${[c.motive_type, c.motive_detail].filter(Boolean).join('——')}`);
                    } else if (c.motive || c['动机']) {
                        lines.push(`      动机：${c.motive || c['动机']}`);
                    }
                    if (c.reason) lines.push(`      阻碍理由：${c.reason}`);
                    if (c.resolvable_by) lines.push(`      化解方式：${c.resolvable_by}`);
                    if (c.conditions) lines.push(`      条件：${c.conditions}`);
                    const cost = c.cost || c['条件或代价'] || c['代价'];
                    if (cost) lines.push(`      条件或代价：${cost}`);
                    if (c.info || c.info_known || c['掌握信息'] || c['掌握']) {
                        lines.push(`      掌握信息：${c.info || c.info_known || c['掌握信息'] || c['掌握']}`);
                    }
                    if (c.note) lines.push(`      备注：${c.note}`);
                }
            }
        }

        const pathsRaw = inner('paths');
        const paths = Array.isArray(pathsRaw) ? pathsRaw : [];
        if (paths.length) {
            lines.push('');
            lines.push(`推进路径（共 ${paths.length} 步）：`);
            paths.forEach((p, i) => {
                if (typeof p === 'string') { lines.push(`  ${i + 1}. ${p}`); return; }
                // 模型给的键名不稳定：路线是 route/desc/detail，
                // 是否必经是 must/required，失败后果是 fail/failure。
                // 早期只认 desc/detail + failure，导致正文和失败后果都显示不出来
                // step 是数字时只是序号，不能当标题用，否则会显示成「1（节点 1，必经）」
                const stepIsIndex = p.step == null || typeof p.step === 'number'
                    || /^\d+$/.test(String(p.step).trim());
                let title = stepIsIndex ? (p.name || '') : String(p.step);
                // 路线正文：模型除了 route/desc/detail，还会直接写「内容」
                const route = p.route || p.desc || p.detail || p.description || p['内容'] || p['路线'];
                // 有些模型把「必经/可跳过」塞进 node 字段，那不是节点号，
                // 直接当号码用会渲染成「节点 必经」，所以先判断是不是纯数字
                const nodeRaw = (p.node != null ? p.node : (p['节点'] != null ? p['节点'] : '')) + '';
                const nodeRawT = nodeRaw.trim();
                const nodeIsNum = /^\d+$/.test(nodeRawT);
                const badge = [];
                if (nodeIsNum) badge.push(`节点 ${nodeRawT}`);
                const must = p.must || p.required || p.required_nodes || (nodeIsNum ? '' : nodeRawT) || '';
                const mustText = must ? (Array.isArray(must) ? must.join('、') : String(must)) : '';
                if (mustText) badge.push(mustText);
                // 没有独立标题时，用路线首句当标题，别让序号后面空着
                if (!title && route) title = String(route).split(/[，。；]/)[0];
                lines.push(`  ${i + 1}. ${title}`
                    + (badge.length ? `（${badge.join('，')}）` : ''));

                if (route) lines.push(`     路线：${route}`);
                const why = p.why || p.reason || p['存在理由'];
                if (why) lines.push(`     存在理由：${why}`);
                if (p.risk) lines.push(`     风险：${p.risk}`);
                const fail = p.fail || p.failure || p.consequence || p['失败后果'];
                if (fail) lines.push(`     失败后果：${fail}`);
            });
        }

        // ---- 内层字段按 spec 表渲染（2026-11-09，二期收口）----
        // 原先案件是写死的节点/路径分支、战斗是 combatBlocks 数组，各一份。
        // 二期一次加六套骨架，手写分支会变成九份，所以统一改成从 spec 表分派：
        // spec 里声明了什么字段、各自什么形态，渲染就按那个来。
        // 案件与战斗的字段表都在 OUTLINE_SPEC_BY_TYPE 里，输出与改造前一致。
        {
            const mainType = mainTypeOfOutline(outline);
            const spec = specOfType(mainType);
            // 案件那套已有专门的中文渲染（节点带类型角标、路径带节点号），
            // 走 spec 通用分支会丢掉这些细节，所以案件仍走上面的专用渲染；
            // 其余类型一律按 spec 分派，没有 spec 的（尚无骨架）不渲染内层。
            const genericTypes = ['战斗冲突', '谈判交涉', '生存危机', '探险探索',
                '社交博弈', '日常杂务', '禁忌秘辛', 'NSFW', '其他'];
            if (spec && genericTypes.includes(mainType)) {
                // required 与 optional 都要渲染：optional 只是「可以不写」，
                // 写了就要显示出来。2026-11-09 只取 required，战斗的援军/撤退/伤亡全丢了。
                //
                // 顺序由 spec 的 order 显式声明。不写 order 时按 required 再 optional，
                // 那样「事先准备」会被挤到最后——旧版把它排在援军前面是有理由的：
                // 准备是战前的动作，援军撤退伤亡是战中的结果，按叙事时序读更顺。
                const skip = new Set(['nodes', 'paths', 'min_nodes_for_deduction',
                    'core_truth', 'suspects', 'characters']);   // 案件专用，已在上文渲染
                const all = {};
                for (const g of [spec.required, spec.optional]) {
                    if (!g || typeof g !== 'object') continue;
                    for (const [k, m] of Object.entries(g)) if (!(k in all)) all[k] = m;
                }
                const order = (Array.isArray(spec.order) && spec.order.length)
                    ? [...spec.order.filter(k => k in all), ...Object.keys(all).filter(k => !spec.order.includes(k))]
                    : Object.keys(all);
                for (const key of order) {
                    if (skip.has(key)) continue;
                    const v = inner(key);
                    if (v == null || v === '') continue;
                    const rows = renderFieldBySpec(key, all[key], v);
                    if (rows.length) {
                        lines.push('');
                        lines.push(...rows);
                    }
                }
            }
        }

        // 结构包（M15，2026-11-09）：写在 structure.packs.<包名> 下面。
        // 与主类型内层字段不同命名空间，所以单独渲染，标题带包名。
        // 最多挂 1 个，但渲染层不强制——真有多余的也照实列出来，
        // 该由校验去报警，渲染层不该悄悄藏掉用户看得见的东西。
        {
            const packsRaw = inner('packs');
            if (packsRaw && typeof packsRaw === 'object' && !Array.isArray(packsRaw)) {
                for (const [packName, packVal] of Object.entries(packsRaw)) {
                    if (!packVal || typeof packVal !== 'object' || Array.isArray(packVal)) continue;
                    const def = OUTLINE_PACK_BY_NAME[packName];
                    const fieldDefs = def ? def.fields : null;
                    const rows = [];
                    const known = fieldDefs ? Object.keys(fieldDefs) : [];
                    const rest = Object.keys(packVal).filter(k => !known.includes(k));
                    for (const k of [...known, ...rest]) {
                        const v = packVal[k];
                        if (isBlankValue(v)) continue;
                        const meta = fieldDefs && fieldDefs[k] ? fieldDefs[k] : { kind: 'text' };
                        rows.push(...renderFieldBySpec(k, meta, v, { indent: '  ' }));
                    }
                    if (!rows.length) continue;
                    lines.push('');
                    lines.push(`${packName}（结构包）：`);
                    lines.push(...rows);
                }
            }
        }

        // contract（外层可选）：事先约定的条件，不分类型，有就渲染
        if (outline.contract) {
            lines.push('');
            lines.push('约定条件：');
            const c = outline.contract;
            if (typeof c === 'string') lines.push('  ' + c.trim());
            else if (typeof c === 'object') {
                for (const [k, v] of Object.entries(c)) {
                    if (v == null || v === '') continue;
                    lines.push(`  ${labelOf(k)}：${Array.isArray(v) ? v.join('、') : String(v).trim()}`);
                }
            }
        }

        // 时间压力与危险程度：这两块以前只写不显示，用户看不到模型对难度的判断
        const dumpGroup = (obj, title) => {
            if (!obj || typeof obj !== 'object') return;
            const entries = Object.entries(obj).filter(([, v]) => v != null && String(v).trim());
            if (!entries.length) return;
            lines.push('');
            lines.push(`${title}：`);
            for (const [k, v] of entries) {
                // 子键要走 labelOf（2026-11-04 修）。这里以前直接打原始键名 k，
                // 而历史样本全是中文键（倒计时 / 致死性），所以一直没露；
                // A2 把骨架换成英文键的完整示例后，模型开始照示例吐 countdown / lethality，
                // 展示大纲里就整段变成英文了。认不得的键也不要裸奔，见 keyText()。
                lines.push(`  ${keyText(k)}：${Array.isArray(v) ? v.join('、') : String(v).trim()}`);
            }
        };
        dumpGroup(outline.time_pressure, '时间压力');
        dumpGroup(outline.danger, '危险程度');

        if (outline.forbidden) {
            lines.push('');
            const f = outline.forbidden;
            lines.push('禁止事项：');
            const list = Array.isArray(f) ? f : String(f).split('\n');
            for (const x of list) if (String(x).trim()) lines.push(`  - ${String(x).trim()}`);
        }

        return lines.length ? lines.join('\n') : null;
    }

    // 模型给节点正文起的键名不稳定（info / desc / content / points_to…），统一取
    const NODE_TEXT_KEYS = ['info', 'desc', 'content', 'points_to', 'point_to', 'pointsTo', 'detail', 'description', 'what', 'reveal'];
    const NODE_TRIGGER_KEYS = ['trigger', 'keyword', 'keywords', 'trigger_keyword', 'when'];

    /** 取节点正文，取不到返回空串 */
    function nodeText(n) {
        if (!n || typeof n !== 'object') return '';
        for (const k of NODE_TEXT_KEYS) {
            const v = n[k];
            if (v != null && String(v).trim()) return String(v).trim();
        }
        return '';
    }

    /** 取节点触发条件，取不到返回空串 */
    function nodeTrigger(n) {
        if (!n || typeof n !== 'object') return '';
        for (const k of NODE_TRIGGER_KEYS) {
            const v = n[k];
            if (v != null && String(v).trim()) {
                return Array.isArray(v) ? v.join('、') : String(v).trim();
            }
        }
        return '';
    }

    /** 取节点编号 */
    function nodeId(n) {
        if (!n || typeof n !== 'object') return null;
        const v = n.id != null ? n.id : n.index;
        return v == null ? null : Number(v);
    }

    /**
     * 取一个键的中文名，取不到也不要裸奔（2026-11-04 加）。
     * 背景：标签表是手抄的白名单，模型换个写法就漏一个英文键到界面上。
     * 白名单命不中就退到这层的归纳：已知后缀按词根翻，还不行就把下划线拆成空格。
     * 宁可显示「某 描述」这种半通不通的中文，也不要让界面上出现 countdown、hazard 这类原样英文。
     */
    function keyText(key) {
        const labeled = labelOf(key);
        if (labeled !== String(key || '')) return labeled;
        const k = String(key || '').trim();
        if (!k) return '';
        const tail = [
            [/(countdown|timer|deadline)$/i, '倒计时'],
            [/(duration|length|span)$/i, '时长'],
            [/(result|outcome|consequence)$/i, '后果'],
            [/(cost|penalty|price)$/i, '代价'],
            [/(source|origin|from)$/i, '来源'],
            [/(tolerance|margin|buffer)$/i, '容错'],
            [/(lethality|deadliness)$/i, '致死性'],
            [/(failure|fail|risk|hazard|danger)$/i, '风险后果'],
            [/(descr?|detail|note|remark|comment)$/i, '说明'],
            [/(reason|why|cause)$/i, '理由'],
            [/(path|route|way)$/i, '路径'],
            [/(name|title)$/i, '名字'],
            [/(info|content|value|text)$/i, '内容'],
        ];
        for (const [re, zh] of tail) if (re.test(k)) return zh;
        return k.replace(/[_-]+/g, ' ');
    }

    /** HTML 转义，进度条等少量需要拼字符串的地方用 */
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ---------- 生成进度 ----------
    // 生成一次大纲要跑好几步（读世界书、读纪要、拉楼层、请模型、解析），
    // 每步耗时从几毫秒到几十秒不等，只显示「生成中」用户无法判断卡没卡死。
    let progress = S.progress; // 引用指向 S，值统一存 S

    function resetProgress() {
        S.progress.steps = [];
        S.progress.startedAt = 0;
        if (S.progress.timer) { clearInterval(S.progress.timer); S.progress.timer = null; }
    }

    /** 开始一次带进度的操作，返回 step 函数 */
    function startProgress(title) {
        resetProgress();
        S.progress.startedAt = Date.now();
        S.progress.title = title;
        renderProgress();
        // 每秒刷新一次耗时，让用户看到时间在走
        S.progress.timer = setInterval(() => {
            const box = S.panelEl && S.panelEl.querySelector('#eo_progress');
            if (!box) return;
            const sec = Math.floor((Date.now() - S.progress.startedAt) / 1000);
            const el2 = box.querySelector('.eo-progress-timer');
            if (el2) el2.textContent = `已用时 ${sec} 秒`;
        }, 1000);
        return step;
    }

    /** 推进到某一步。done=true 表示该步完成，否则标记为进行中 */
    function step(text, done) {
        const last = S.progress.steps[S.progress.steps.length - 1];
        if (last && !last.done) {
            last.done = true;
            last.ms = Date.now() - last.at;
        }
        if (text) S.progress.steps.push({ text, at: Date.now(), done: !!done });
        renderProgress();
    }

    /** 把当前进行中的那一步标成失败，并保留列表让人看是卡在哪（2026-11-02） */
    function failProgress(reason) {
        const last = S.progress.steps[S.progress.steps.length - 1];
        if (last && !last.done && !last.failed) {
            last.failed = true;
            last.ms = Date.now() - last.at;
            if (reason) last.text = last.text + '：' + reason;
        }
        renderProgress();
    }

    function renderProgress() {
        if (!S.panelEl) return;
        // 进度条挂在操作按钮下方：找当前页的锚点，找不到才退回面板顶部
        const host = S.panelEl.querySelector('#eo_progress_host');
        let box = document.getElementById('eo_progress');
        if (!box) {
            box = document.createElement('div');
            box.id = 'eo_progress';
            box.className = 'eo-progress';
        }
        if (host) {
            if (box.parentNode !== host) host.appendChild(box);
        } else if (box.parentNode !== S.panelEl.querySelector('#eo_body')) {
            const busyEl = S.panelEl.querySelector('#eo_busy');
            if (S.busyEl && S.busyEl.parentNode) S.busyEl.parentNode.insertBefore(box, S.busyEl);
        }
        box.innerHTML = buildProgressHtml();
        box.style.display = S.progress.steps.length ? 'block' : 'none';
    }

    function buildProgressHtml() {
        const sec = Math.floor((Date.now() - S.progress.startedAt) / 1000);
        const rows = S.progress.steps.map((s) => {
            // 失败那一步单独标红（2026-11-02）：以前失败后就停在 ⋯ 或灰着，看不出卡在哪
            if (s.failed) {
                return `<div class="eo-progress-row eo-progress-failed">`
                    + `<span class="eo-progress-mark">✕</span>${escapeHtml(s.text)}</div>`;
            }
            const mark = s.done ? '✓' : '⋯';
            const cost = s.done && s.ms != null ? `　${(s.ms / 1000).toFixed(1)} 秒` : '';
            return `<div class="eo-progress-row${s.done ? ' eo-progress-done' : ''}">`
                + `<span class="eo-progress-mark">${mark}</span>${escapeHtml(s.text)}${cost}</div>`;
        }).join('');
        return `<div class="eo-progress-head">${escapeHtml(S.progress.title || '处理中')}`
            + `　<span class="eo-progress-timer">已用时 ${sec} 秒</span></div>${rows}`;
    }

    function genEventId() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `evt-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
            + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }

    /**
     * 把事件卡状态压成世界书条目内容（800-1500 字）。
     * statusOverride：采用时正文要写「进行中」，而那时 event.status 还是 draft
     * （状态在写入成功后才改），直接读 event.status 会把 draft 写进世界书正文，
     * 用户在世界书面板看到 draft 会以为没采用成功。见 2026-11-10 批 2 遗留问题一。
     */
    function buildEntryContent(event, round, statusOverride) {
        const context = ctx();
        const lines = [];
        lines.push(`〔事件大纲｜chatId=${context.chatId || ''}｜v${event.entryVersion || 1}｜更新于 ${new Date().toLocaleString('zh-CN')}〕`);
        lines.push(buildStateCard(event, statusOverride));
        if (round) lines.push(`盘点轮次：${round}`);
        const o = event.outline || {};
        // forbidden 在外层，直接读；characters 属于内层（2026-11-05 M2 评审 4.3）：
        // M2 之后它在 structure.characters，按顶层读恒为 undefined，世界书条目会缺一整块。
        if (o.forbidden) lines.push(`禁止事项：${typeof o.forbidden === 'string' ? o.forbidden : JSON.stringify(o.forbidden)}`);
        const chars = innerField(o, 'characters');
        if (chars) {
            // 老形状可能是字符串，新形状是 {helpers/obstructers/informants/behind_scenes} 分组对象。
            // 只处理字符串的话，新事件永远写不进去角色——收成一段可读文本，两种都能落到底。
            if (typeof chars === 'string') {
                lines.push(`角色：${chars}`);
            } else if (typeof chars === 'object') {
                const groups = [];
                for (const [group, list] of Object.entries(chars)) {
                    const names = (Array.isArray(list) ? list : [list])
                        .map(x => (x && typeof x === 'object') ? String(x.name || '').trim() : String(x || '').trim())
                        .filter(Boolean);
                    if (names.length) groups.push(`${labelOf(group)}：${names.join('、')}`);
                }
                if (groups.length) lines.push(`角色：${groups.join('；')}`);
            }
        }
        // 2026-11-05 M3：其余内层字段兜一段摘要。
        // 案件靠 nodes/characters 已经够了，跳过它们免得重复；战斗的敌方编制、目标、
        // 地形、准备全靠这段落地——不写的话战斗事件在世界书里是个空条目。
        // core_truth 是剧透，绝不进世界书（模型知道真相就会在正文里说漏）。
        // phases 单独写一段处理，这里跳过免得被压成一行数组。
        const summary = innerSummaryText(o, ['nodes', 'characters', 'core_truth', 'paths',
            'min_nodes_for_deduction', 'phases'], 600);
        if (summary) lines.push(summary);

        // 2026-11-05 M4：阶段数组进展世界书。
        // 为什么必须进：多段事件的「现在演到第几段」是模型每楼都要判断的事，
        // 不写进去它就只能从最近的对话里猜，很容易还在上一段里打转。
        const stagesRaw = innerField(o, 'phases');
        const stages = Array.isArray(stagesRaw) ? stagesRaw : [];
        if (stages.length) {
            const segs = stages.map((st, i) => {
                if (!st || typeof st !== 'object') return `${i + 1}.${String(st)}`;
                const g = String(st.goal || st.name || `第 ${i + 1} 段`).trim();
                return `${i + 1}.${g}`;
            }).filter(Boolean);
            if (segs.length) lines.push(`阶段：${segs.join(' → ')}`);
        }
        let text = lines.filter(Boolean).join('\n');
        if (text.length > 1500) text = text.slice(0, 1490) + '…';
        return text;
    }

    /**
     * 内层字段摘要：把 structure 里那些「模型下一楼必须记住」的字段压成可读文本。
     *
     * 为什么需要它（2026-11-05 M3）：buildEntryContent 原来只写 forbidden 与 characters，
     * 那是案件的口径。战斗事件的世界书条目因此只剩一行标题与禁止事项——
     * 对面有多少人、要守住哪里、地形什么样，下一楼全丢了，模型会当场忘掉战场。
     *
     * 为什么不做成「战斗专用」：骨架一共十三类，一类型写一套渲染等于抄十三份，
     * 这正是 M2 那轮治过的病。这里按字段的形态通用处理（数组→列名字、对象→列子项、
     * 标量→原样），键名走 labelOf 翻中文，任何类型的骨架都能落下来。
     *
     * 跳过已经单独写过的字段：characters（上面有分组的可读写法）、nodes（状态卡里有清单）、
     * 以及剧情真相类不该进世界书的（core_truth 剧透）。
     *
     * @param {object} outline 大纲
     * @param {string[]} skip 已单独处理的键
     * @param {number} budget 字符预算
     */
    function innerSummaryText(outline, skip, budget) {
        const inner = outlineInner(outline);
        const parts = [];
        for (const [k, v] of Object.entries(inner)) {
            if (skip.indexOf(k) >= 0) continue;
            if (v == null || v === '') continue;
            const label = labelOf(k);
            if (Array.isArray(v)) {
                // 数组：每一项取名字，取不到就用第一行文本
                const items = v.map(x => {
                    if (x && typeof x === 'object') {
                        return String(x.name || x['名称'] || x.title || x.what || '').trim();
                    }
                    return String(x || '').trim();
                }).filter(Boolean);
                if (items.length) parts.push(`${label}：${items.join('、')}`);
            } else if (typeof v === 'object') {
                // 对象：列子项，键名同样翻中文；太长的值截断
                const subs = [];
                for (const [sk, sv] of Object.entries(v)) {
                    if (sv == null || sv === '') continue;
                    const s = (typeof sv === 'object') ? JSON.stringify(sv) : String(sv).trim();
                    if (!s) continue;
                    subs.push(`${labelOf(sk)} ${s.length > 40 ? s.slice(0, 38) + '…' : s}`);
                }
                if (subs.length) parts.push(`${label}：${subs.join('；')}`);
            } else {
                parts.push(`${label}：${String(v).trim()}`);
            }
            // 到预算就停，别把 1500 字上限吃光，后面还有别的段要写
            if (parts.join('\n').length >= (budget || 600)) break;
        }
        return parts.join('\n');
    }

    // ---------- M16 生成引擎 ----------

    /**
     * 第一步：生成链骨架。只出目录，不落事件、不写世界书。
     * 返回 { chain, raw }，front 由界面拿去预览，用户确认后才往下生成。
     */
    async function createChainSkeleton(chainName, prefs, nodeCount, nodePrefs, pressure) {
        const context = ctx();
        if (!context) throw new Error('未取到酒馆上下文');
        if (!context.chatId) throw new Error('请先打开一个对话');

        // 破甲段按主类型拼（2026-11-09 危晓：不管是不是 NSFW 都要挂）。
        // 链骨架这一步还没定节点类型，看节点里有没有 NSFW：有就按 NSFW 加强，
        // 因为整条链里只要出现一次成人向节点，骨架这一步就该按那个基调写。
        const anyNsfw = (Array.isArray(nodePrefs) ? nodePrefs : [])
            .some(w => String((w && w.primary) || '').trim() === 'NSFW');
        const systemPrompt = buildChainSystemPrompt(anyNsfw ? 'NSFW' : '');
        const ctxParts = await gatherContext(null);
        const prompt = buildChainSkeletonPrompt(chainName, prefs, ctxParts.worldBook,
            buildOutlineContextText(ctxParts), nodeCount, nodePrefs, pressure);
        const raw = await callModel(systemPrompt, prompt, ARMOR_PREFILL);
        const chain = parseChainSkeleton(raw);

        // 节点数对不上时按请求的补/截，但不偷偷改模型的类型选择
        const want = chainNodeCountOf(nodeCount);
        const problems = [];
        if (chain.nodes.length !== want) {
            problems.push(`模型给了 ${chain.nodes.length} 个节点，要求是 ${want} 个`);
        }
        const bad = checkChainSkeleton(chain);
        problems.push(...bad);

        // 用户指定了类型，但模型给了别的：提醒一句，让用户在预览里当场改回来。
        // 不拦——模型有时确实会发现用户选的类型不合适，但用户得知道它没照办。
        const wanted = (Array.isArray(nodePrefs) ? nodePrefs : []).slice(0, want);
        chain.nodes.forEach((nd, i) => {
            const w = wanted[i];
            const wt = String((w && w.primary) || '').trim();
            const got = String((nd && nd.primary) || '').trim();
            if (wt && got && wt !== got) {
                problems.push(`节点 ${i + 1} 你指定的是「${wt}」，模型给的是「${got}」`);
            }
        });

        // 2026-11-09 危晓：衔接条件在「各节点」配置里填，规则是他定的——
        // 用户填了就用用户的，没填就用模型自己想的那句。
        // 所以这里合并：模型给的 triggers 已由 parseChainSkeleton 解析好，
        // 用户填过的节点（prefs.__chainNodePrefs[i].triggers）整组替换掉模型给该节点的出边。
        if (!Array.isArray(chain.triggers)) chain.triggers = [];
        const users = Array.isArray(nodePrefs) ? nodePrefs : [];
        const replacedFrom = new Set();
        const added = [];
        users.forEach((w, i) => {
            const from = i + 1;
            const mine = Array.isArray(w && w.triggers) ? w.triggers : [];
            const valid = mine.filter(t => t && Number.isFinite(parseInt(t.to, 10)));
            if (!valid.length) return;   // 这个节点没填过，模型给它留的照旧
            replacedFrom.add(from);
            for (const t of valid) {
                const to = parseInt(t.to, 10);
                const cond = String(t.condition || '').trim();
                const modelOne = chain.triggers.find(x => parseInt(x.from, 10) === from
                    && parseInt(x.to, 10) === to);
                added.push({
                    from,
                    to,
                    // 用户填了条件就用他的；他填了去向但没写条件，就用模型为这条去向写的条件
                    condition: cond || String((modelOne && modelOne.condition) || ''),
                });
            }
        });
        if (replacedFrom.size) {
            chain.triggers = chain.triggers
                .filter(t => !replacedFrom.has(parseInt(t.from, 10)))
                .concat(added);
        }

        return { chain, raw, problems };
    }


    /**
     * 第二步：按骨架逐条生成本节点，落成 draft 事件。
     *
     * 生成的条目与单事件完全同构（同样的 id/status/outline/entryUid 字段），
     * 只多一个 chain 字段记住它在链里的位置。这样「采用」「写世界书」「追踪器」
     * 这些现成逻辑一个都不用改。
     */
    async function createChainNode(chain, nodeIdx, chainId, prefs, prevExit) {
        const context = ctx();
        if (!context) throw new Error('未取到酒馆上下文');
        const book = getCharacterBookName();
        if (!book) throw new Error('当前角色未绑定世界书');

        const pos = chainPosOf(chain, nodeIdx);
        const nodes = Array.isArray(chain.nodes) ? chain.nodes : [];
        const node = nodes[pos - 1] || {};

        // 破甲段按本节点的主类型拼（2026-11-09 危晓：不管是不是 NSFW 都要挂）
        const systemPrompt = buildOutlineSystemPrompt(node.primary);
        const ctxParts = await gatherContext(null);
        const prompt = buildChainNodePrompt(chain, nodeIdx, prefs,
            ctxParts.worldBook, buildOutlineContextText(ctxParts), prevExit);
        const raw = await callModel(systemPrompt, prompt, ARMOR_PREFILL);
        const { parsed, raw: rawText, quality } = parseOutline(raw);

        // 2026-11-09 真机：两个节点全都被模型返回了空内容，扩展照样造出事件、写进存档，
        // 用户在列表里看到两条名字正常、内容全空的东西，直到展开才看见「结构不完整」。
        // 模型为什么吐空这里管不了（可能超上下文、可能被截断），但至少要把这件事记下来、
        // 明确标废，不能让一个空壳看起来像正常事件。
        const failReasons = [];
        if (!String(raw || '').trim()) {
            failReasons.push('模型返回了空内容');
        } else if (quality && !quality.ok) {
            failReasons.push('大纲结构不完整：' + (quality.missing || []).join('；'));
        }
        const genFailed = failReasons.length > 0;
        if (genFailed) {
            warn('链节点 ' + pos + '/' + nodes.length + ' 生成失败：' + failReasons.join('；'));
        }

        const id = genEventId();
        // 节点类型：以骨架里定的为准；骨架没给才用模型的
        const mainType = String(node.primary || '').trim();
        // 骨架定的类型优先于模型自己判断的类型。
        // 注意要兜住 event_type 整个缺失的情况——只在存在时覆盖的话，
        // 模型漏写 event_type 就会变成一个没有主类型的事件，后面全部报错。
        if (mainType && parsed) {
            if (!parsed.event_type || typeof parsed.event_type !== 'object') parsed.event_type = {};
            parsed.event_type.primary = mainType;
        }
        const name = String(node.brief || (parsed && parsed.event_name) || '').trim()
            || `未命名节点（${new Date().toLocaleDateString('zh-CN')}）`;

        const event = {
            id,
            name,
            autoNamed: !node.brief,
            brief: String((parsed && parsed.event_brief) || '').trim(),
            status: 'draft',
            createdAt: new Date().toISOString(),
            closedAt: null,
            chatId: context.chatId,
            worldBook: book,
            entryUid: null,
            entryVersion: 1,
            floorBase: countFloors(),
            floorBaseNarration: !!getSettings().memory.narrationMode,
            prefs: (() => {
                const o = Object.assign({}, prefs);
                delete o._groupMode;
                return o;
            })(),
            outline: parsed,
            outlineRaw: rawText,
            parseQuality: quality,
            // M16：在链里的位置
            chain: {
                id: chainId,
                name: chain.chain_name || '',
                idx: nodeIdx,
                pos,
                total: nodes.length,
            },
            exitState: exitStateOf(parsed),
            // 2026-11-09：生成失败就存下来，但打上标记。列表里会标出来、不能直接采用。
            // 老事件没这个字段，读的时候按正常处理。
            genFailed,
            genFailReasons: failReasons,
        };

        const meta = getMeta();
        // 2026-11-09：链节点原来是直接写进去的，完全不过上限。
        // 现在走同一套分配：链按条数限流，节点不占单事件的名额。
        // 注意新链的骨架刚落，此时这条链已经有两个以上节点才算「满」，
        // 所以这里传 id 排除自己后按链计数。
        enforceDraftLimits(meta, id);
        meta.events[id] = event;
        // 2026-11-09 危晓：调试模式下链节点也要能看模型原文，所以原输出必须留着。
        // 原来这行把 outlineRaw 清成 undefined，理由写的是「与单事件一致」，
        // 但单事件那边根本没清，这句注释是错的，直接导致链节点没有「展示原文」按钮。
        saveMeta();
        return event;
    }

    /**
     * 整条链跑完。mode: 'auto' 自动往下 / 'manual' 每条等用户确认。
     *
     * hooks 是界面给的两个回调：
     *   onNode(ev, i, total)  每生成完一条调用一次，用来摊开内容；返回 'stop' 就停在这
     *   waitNext(i, total)    仅手动模式用，等用户点「下一个」；返回 'stop' 就停
     * 两个回调都可省略（测试时只想要数据）。
     */
    async function runChain(chain, chainId, prefs, mode, hooks) {
        const h = hooks || {};
        const nodes = Array.isArray(chain.nodes) ? chain.nodes : [];
        const order = nodes.map((n, i) => (n && n.idx != null) ? parseInt(n.idx, 10) : (i + 1));
        const made = [];
        let prevExit = null;
        for (let i = 0; i < order.length; i++) {
            step(`生成第 ${i + 1}/${order.length} 个节点`);
            const ev = await createChainNode(chain, order[i], chainId, prefs, prevExit);
            made.push(ev);
            prevExit = ev.exitState;
            const done = h.onNode ? await h.onNode(ev, i, order.length) : undefined;
            if (done === 'stop') break;
            if (mode === 'manual' && i < order.length - 1 && typeof h.waitNext === 'function') {
                const go = await h.waitNext(i + 1, order.length);
                if (go === 'stop') break;
            }
        }
        return made;
    }

    async function createEvent(eventName, prefs) {
        const context = ctx();
        if (!context) throw new Error('未取到酒馆上下文');
        if (!context.chatId) throw new Error('请先打开一个对话');
        const book = getCharacterBookName();
        if (!book) throw new Error('当前角色未绑定世界书');

        setBusy(true, false, '正在生成大纲，请稍候…', 'gen');
        try {
            startProgress('正在生成事件大纲');
            step('准备提示词');
            // 破甲段按本次选择的主类型拼（2026-11-09 危晓：不管是不是 NSFW 都要挂）
            const systemPrompt = buildOutlineSystemPrompt(prefs && prefs.eventMainType);
            // 生成大纲同样需要剧情上下文与世界设定：楼层 + 纪要 + 世界书
            const ctxParts = await gatherContext(null);
            step('组装最终 prompt');
            const prompt = buildOutlinePrompt(eventName, prefs, ctxParts.worldBook, buildOutlineContextText(ctxParts));
            const raw = await callModel(systemPrompt, prompt, ARMOR_PREFILL);
            step('解析模型返回的大纲');
            const { parsed, raw: rawText, quality } = parseOutline(raw);
            // 模型没按骨架写字段名时点一句，方便判断是不是 prompt 需要再加压
            if (quality && quality.drift && quality.drift.length) {
                warn(`字段名没有按骨架输出：${quality.drift.join('；')}（渲染层有容错，仍可正常显示）`);
            }
            // 2026-11-05 M2 评审 4.2：同样改读 structure，否则进度条永远显示 0 个节点
            const nodeCount = innerNodesOf(parsed).length;
            step(`解析完成：${nodeCount} 个信息节点`
                + (nodeCount ? '' : '（未识别到节点，原始输出可在日志页查看）'));
            // 结构残缺时，「解析完成」后面要跟一条醒目的步骤，让用户当场看见
            if (quality && !quality.ok) {
                step(`⚠ 结构不完整：${quality.missing.join('；')}`);
            }

            const id = genEventId();
            const meta = getMeta();
            // 事件名留空时用模型自己起的名；模型也没给就退回按日期兜底
            const givenName = String(eventName || '').trim();
            const aiName = String((parsed && parsed.event_name) || '').trim();
            const finalName = givenName || aiName || `未命名事件（${new Date().toLocaleDateString('zh-CN')}）`;
            if (!givenName) {
                if (aiName) log(`事件名留空，采用模型自动命名：「${finalName}」`);
                else warn('事件名留空且模型没有返回 event_name，已用日期兜底命名');
            }
            const event = {
                id,
                name: finalName,
                autoNamed: !givenName,
                brief: String((parsed && parsed.event_brief) || '').trim(),
                // 新事件先落成待选草稿：不写世界书、不设为当前事件。
                // 用户点「采用」之后才真正生效，避免反复重生成时来回写删世界书
                status: 'draft',
                createdAt: new Date().toISOString(),
                closedAt: null,
                chatId: context.chatId,
                worldBook: book,
                entryUid: null,
                entryVersion: 1,
                // 自动盘点的计数基线：自上次盘点以来的楼层数（口径随转述模式变，见 countFloors）
                floorBase: countFloors(),
                // 记下基线是按哪种口径量的。模式一变，旧基线就失效，要按新口径重挂
                floorBaseNarration: !!getSettings().memory.narrationMode,
                // 只存真正的偏好项；界面草稿状态不进事件卡
                prefs: (() => {
                    const o = Object.assign({}, prefs);
                    delete o._groupMode;
                    return o;
                })(),
                outline: parsed,
                outlineRaw: rawText,
                // 解析质量留档：事后在事件详情页能看到这次生成到底缺了什么
                parseQuality: quality,
                tracker: {
                    triggeredNodes: [],
                    pendingNodes: [],
                    // 2026-11-06：战斗目标与阶段用这套字符串 key（node 类型仍走 triggeredNodes）
                    progress: [],
                    refutedMisleads: [],
                    offPathBranches: [],
                    nodeVetoed: [],
                    autoCommitted: [],
                    manualNotes: '',
                },
                inventories: [],
            };

            // 只存成待选草稿，不写世界书。
            // 用户看到满意后点「采用」才走 commitDraft，那时才写条目、设为当前事件
            //
            // 2026-11-09 危晓指出：一条 4 节点的链会占掉 4 个待选名额，把别的待选挤掉。
            // 所以链节点与单事件分开计数：链节点不算进 MAX_DRAFTS，
            // 它们归各自那条链管，链级上限见 MAX_CHAIN_DRAFTS。
            enforceDraftLimits(meta, id);
            meta.events[id] = event;
            saveMeta();
            return event;
            meta.events[id] = event;
            saveMeta();
            return event;
        } catch (e) {
            // 失败也要让人看出卡在哪一步，进度列表留着（2026-11-02）
            failProgress(e && e.message || String(e));
            throw e;
        } finally {
            setBusy(false, true, null, 'gen');
        }
    }

    /**
     * 采用一个待选事件：写世界书条目、设为当前事件。
     * 生成和写入分开，就是为了反复重生成时不弄脏世界书。
     */
    async function commitDraft(id, opts) {
        const meta = getMeta();
        const event = meta.events[id];
        if (!event) throw new Error('找不到这个待选事件');
        if (event.status !== 'draft') throw new Error('这个事件不是待选状态');

        const cur = getCurrentEvent();
        if (cur) {
            // 2026-11-10 修：整条链一起采用时，前一个节点刚被设成当前事件，
            // 走到第二个节点必然撞上这道守卫，于是整条链只能落第一个。
            // 同一条链内部的节点互相接续是正常状态，不算冲突；
            // 只有「当前事件属于别的链或别的单事件」时才拦。
            const sameChain = !!(opts && opts.allowChain
                && cur.chain && cur.chain.id
                && event.chain && event.chain.id
                && String(cur.chain.id) === String(event.chain.id));
            if (!sameChain) {
                throw new Error(`「${cur.name}」还在进行中，请先完结或废弃它，再采用新的待选事件`);
            }
        }
        setBusy(true, false, '正在采用事件并写入世界书…', 'adopt');
        try {
            const book = event.worldBook || getCharacterBookName();
            if (!book) throw new Error('当前角色未绑定世界书');
            // 正文按「采用后的状态」写：此时 event.status 还是 draft，不传这个就会把 draft 写进世界书
            const content = buildEntryContent(event, 0, 'active');
            const res = await upsertEventEntry(
                book,
                content,
                `${ENTRY_PREFIX}${event.name}｜chatId=${event.chatId}`,
                null,
                event,
            );
            event.entryUid = res.uid;
            event.status = 'active';
            event.floorBase = countFloors();
            event.floorBaseNarration = !!getSettings().memory.narrationMode;
            meta.currentEventId = id;
            saveMeta();
            // 采用不再清空生成页配置（2026-11-14 危晓改口径）：
            // 原来按 2026-11-01 的规矩「采用即用掉、清空表单」，放到事件链上就说不通——
            // 一条链有多个节点，采用第一个就把配置清掉，第二个得从头再填。
            // 现在只丢掉草稿名，参数与分组粗细留着，要恢复默认只能点「重置为默认」。
            clearGenFormOnAdopt();
            log(`已采用事件「${event.name}」，世界书条目 uid=${res.uid}`);
            // 2026-11-04 危晓反馈：采用后在世界书面板里搜不到条目，F5 一次才出现。
            // 根因是世界书面板读的是页面加载那一刻的数据，服务端写入不会让面板自己变新；
            // 最危险的是在那份旧数据上手动编辑再保存，会把刚写入的条目（以及 shujuku 维护的纪要条目）一起盖掉。
            // 所以写完给一句明确的动作，别让人以为没写成功。
            toast('已写入世界书。要查看或手动编辑世界书，请先刷新页面（F5），否则改的是旧数据，会把这批内容盖掉', { ms: 9000 });
            return event;
        } catch (e) {
            // 2026-11-10 修（评审 P1-9）：内容已经写进世界书、只是校验没过时，错误上带着 uid。
            // 这里必须记账——不记的话，书里那条属于本事件的条目从此没人认领，
            // 下次采用会在旁边再写一条，同一件事在书里出现两遍。
            // 状态也推进到进行中：条目确实已经在世界里了，装成没发生反而更乱。
            if (e && e.written && e.uid != null) {
                event.entryUid = e.uid;
                event.status = 'active';
                event.floorBase = countFloors();
                event.floorBaseNarration = !!getSettings().memory.narrationMode;
                meta.currentEventId = id;
                try { saveMeta(); } catch (e2) { /* 存盘失败不该盖住原始错误 */ }
                warn(`事件「${event.name}」的条目已写入（uid=${e.uid}）但校验未通过，已记账避免重复写入`);
            }
            failProgress(e && e.message || String(e));
            throw e;
        } finally {
            setBusy(false, true, null, 'adopt');
        }
    }

    /**
     * 读待选上限（2026-11-10 危晓定：默认 5，设置页可改）。
     *
     * 为什么做成函数而不是常量：上限现在能在设置页改，改了要立刻生效，
     * 所以每次判断都得现读。设置里存坏值（空、负数、不是数字）时回落到默认值，
     * 不能让一个非法值把「生成完立刻被自己挤掉」这种事故带进正常流程。
     */
    function draftCap(which) {
        const sm = getSettings();
        const raw = which === 'chain'
            ? (sm.draftCapChain !== undefined ? sm.draftCapChain : MAX_CHAIN_DRAFTS_DEFAULT)
            : (sm.draftCapSingle !== undefined ? sm.draftCapSingle : MAX_DRAFTS_DEFAULT);
        let n = Math.floor(Number(raw));
        if (!Number.isFinite(n)) n = which === 'chain' ? MAX_CHAIN_DRAFTS_DEFAULT : MAX_DRAFTS_DEFAULT;
        if (n < DRAFT_CAP_MIN) n = DRAFT_CAP_MIN;
        if (n > DRAFT_CAP_MAX) n = DRAFT_CAP_MAX;
        return n;
    }

    /**
     * 待选上限：单事件与链分开算（2026-11-09 危晓定）。
     *
     * 原来只有一个 MAX_DRAFTS，而链的每个节点都是一个独立待选事件，
     * 于是一条 4 节点链就会把 3 个名额全占满、还挤出别人的。
     * 现在：
     *   - 链节点不参与单事件计数，它们归各自那条链管
     *   - 链按 chain.id 计条数，最多 MAX_CHAIN_DRAFTS 条；
     *     超了就丢最早那条链的全部节点
     *   - 单事件之间还是按 MAX_DRAFTS 挤掉最早的
     *
     * @param {object} meta 存档
     * @param {string} newId 即将写入的事件 id（计数时排除它自己）
     */
    function enforceDraftLimits(meta, newId) {
        if (!meta || !meta.events) return;
        const all = Object.values(meta.events).filter(e => e && e.id !== newId);

        // --- 单事件：不含链节点 ---
        const singles = all.filter(e => e.status === 'draft' && !e.chain);
        singles.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        while (singles.length >= draftCap('single')) {
            const drop = singles.shift();
            delete meta.events[drop.id];
            cleanupDraftViewState(drop.id);
            log(`待选事件已有 ${draftCap('single')} 个，挤掉最早的「${drop.name}」`);
        }

        // --- 链：按 chain.id 数条数 ---
        // 2026-11-09 真机 bug：这里原来用 chainIds.length >= MAX_CHAIN_DRAFTS 判停，
        // 但新链是一个节点一个节点写进来的，写第 2 个节点的那一刻，
        // 旧链 2 条全在、新链已有 1 条，chainIds.length 正好等于 2，
        // 于是「还没超限就先把旧链挤掉了」。
        // 正确口径是：只有「已有链数」已经超过上限时才挤，
        // 且新链刚起头时（newId 指向的这条链还没有第 2 个节点）不参与判断。
        const byChain = {};
        for (const e of all) {
            if (e.status !== 'draft' || !e.chain || !e.chain.id) continue;
            (byChain[e.chain.id] = byChain[e.chain.id] || []).push(e);
        }
        const born = Object.keys(byChain).map(cid => {
            const evs = byChain[cid].slice()
                .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
            return {
                id: cid,
                at: String((evs[0] && evs[0].createdAt) || ''),
                evs,
                name: (evs[0] && evs[0].chain && evs[0].chain.name) || '',
            };
        }).sort((a, b) => a.at.localeCompare(b.at));

        // 严格大于才挤：允许恰好 MAX_CHAIN_DRAFTS 条并存
        //
        // 2026-11-10 修（评审第 14 条，设计债 F）：上面统计的是 all，而 all 排除了 newId。
        // 新链的第一个节点正在写入时，它自己不在 all 里，于是「已有链数」只数到旧链，
        // 判停看起来没超，可新链一进来就变成上限加一。差一就差在这里。
        // 现在把 newId 自己那条链先补进计数再判——它马上就要占一个名额。
        const capChain = draftCap('chain');
        const metaNew = meta.events[newId];
        let extraNewChain = 0;
        if (metaNew && metaNew.status === 'draft' && metaNew.chain && metaNew.chain.id
            && !byChain[metaNew.chain.id]) {
            extraNewChain = 1;
        }
        while (born.length + extraNewChain > capChain) {
            // 没有旧链可挤时不能死循环：新链自己必须留下，超出的额度只能由旧的让出来
            if (!born.length) break;
            const drop = born.shift();
            for (const e of drop.evs) { delete meta.events[e.id]; cleanupDraftViewState(e.id); }
            log(`待选链超过 ${capChain} 条，挤掉最早的「${drop.name || drop.id}」`);
        }
    }

    function discardDraft(id) {
        const meta = getMeta();
        const event = meta.events[id];
        if (!event || event.status !== 'draft') return false;
        delete meta.events[id];
        // 2026-11-10 修（评审 P1-14）：草稿没了，跟着它走的内存状态也要清。
        // 原来这里只删事件，正在编辑的是它、预览着的也是它，那些状态就留在了内存里：
        // 下次点开另一条草稿，编辑框里可能是上一个已删草稿的正文，保存下去会写回谁都不对。
        cleanupDraftViewState(id);
        saveMeta();
        log(`已丢弃待选事件「${event.name}」`);
        return true;
    }

    /**
     * 清掉属于某条草稿的编辑态与预览态。
     * 草稿被丢弃、被挤掉、被采用之后都要调一次，否则那些状态会挂在一个已经不存在的事件上。
     */
    function cleanupDraftViewState(id) {
        const key = String(id);
        if (S.editingDraftId != null && String(S.editingDraftId) === key) {
            discardPendingEdit();
        }
        if (S.previewDraftIds && S.previewDraftIds.delete && S.previewDraftIds.has(key)) {
            S.previewDraftIds.delete(key);
        }
    }

    /**
     * 保存草稿编辑（还没采用的事件）。
     *
     * 编辑方式只有一种：直接改大纲原文，像改文档一样。不再拆成表单逐格填。
     * 落点仍是 outlineRaw —— 改完先把 YAML 重新解析一遍，解析成功就整体替换
     * event.outline，让它和原本由模型生成的结构走同一条路径，
     * 后续的「展示大纲」、采用时写的世界书条目、状态卡自然都跟着变。
     *
     * 校验分两档：
     *   硬错（解析不出结构 / 没有节点）→ 抛错，拒绝保存，界面停在编辑框上
     *   软错（编号跳号、引用对不上）→ 只返回 issues 给界面提示，照常保存
     * 这样「改坏格式」不会落盘，「改得不完整」可以存一半接着改。
     *
     * 已采用（active）的事件不走这里：它的大纲已经写进世界书，中途改口径不可追溯，
     * 要换大纲请把它废弃后重新生成，再对新草稿做编辑。
     *
     * 返回 { event, quality, issues }。
     */
    function saveDraftEdit(id, patch) {
        const meta = getMeta();
        const event = meta.events[id];
        if (!event) throw new Error('找不到这个待选事件');
        if (event.status !== 'draft') {
            throw new Error('只能编辑还没采用的事件；已采用的大纲已经写进世界书，请废弃后重新生成');
        }
        const p = patch || {};

        const rawText = String(p.raw == null ? '' : p.raw);
        if (!rawText.trim()) throw new Error('大纲内容为空，保存会清空这个事件');

        const r = parseOutline(rawText);

        // ---- 硬错：格式坏到没法用，拒绝保存，原文一个字都不落盘 ----
        const fatal = [];
        if (!r.parsed || typeof r.parsed !== 'object' || !Object.keys(r.parsed).length) {
            fatal.push('解析不出任何字段，这份内容不是合法的 YAML');
        }
        if (!String(r.raw || '').trim()) {
            fatal.push('内容为空');
        }
        // 缩进被改乱时解析器很宽容：字段还在，但节点认不出来，存下去就是个空壳。
        // 大纲没有信息节点等于废了，这一条按硬错处理。
        if (!fatal.length) {
            // 2026-11-05 M2 评审：按顶层读会让新形状草稿改完保存时被判「一个节点都没有」而拒存。
            // 这是用户直接撞得上的功能中断，比日志误报严重。
            //
            // 2026-11-10 修（评审 P0-2）：这条检查的本意是「缩进被改乱、节点认不出来，
            // 存下去就是空壳」，可它只看 nodes，而九类里只有案件推理有 nodes，
            // 其余八类（战斗/谈判/生存/探险/社交/日常/禁忌/NSFW）就算内容完整也一律被拒。
            //
            // 改成：外层必备键齐全，或该类型声明的进度字段有内容，满足任一就放行。
            // 为什么不是「只认进度字段」：那样等于把 nodes 换成 phases 继续拦——
            // 一份战斗大纲写了参战者、战场、契约，只是还没排阶段，照样存不进去，
            // 和原来的毛病一模一样。真正被改坏的稿子，外层键会一起缺；
            // 外层齐全却进度为空，那是「还没填完」，不是「坏了」，该让用户存。
            const shape = checkOutlineShape(r.parsed);
            const outerOk = !!(shape && shape.ok);
            let hasProgress = false;
            try { hasProgress = progressItemsOf(r.parsed).items.length > 0; } catch (e) { hasProgress = false; }
            if (!outerOk && !hasProgress) {
                fatal.push('内容结构不完整，多半是缩进或破折号被改坏了');
            }
        }
        if (fatal.length) {
            warn(`大纲编辑未保存（格式错误）：${fatal.join('；')}`);
            throw new Error('格式有问题，没有保存：' + fatal.join('；')
                + '。检查一下缩进、冒号、破折号有没有被删掉。');
        }

        // ---- 软错：编号跳号 / 引用不存在的节点，只警告不拦 ----
        const issues = checkOutlineRefs(r.parsed);
        if (issues.length) warn(`编辑后大纲自检：${issues.join('；')}`);

        event.outline = r.parsed;
        event.outlineRaw = rawText;
        // 名字以原文里的 event_name 为准，原文没有才沿用旧的
        const parsedName = String(r.parsed.event_name || '').trim();
        if (parsedName && parsedName !== event.name) {
            event.name = parsedName;
            event.autoNamed = false;
        }
        const brief = String(r.parsed.event_brief || '').trim();
        if (brief) event.brief = brief;

        event.parseQuality = checkOutlineShape(r.parsed);
        event.editedAt = new Date().toISOString();
        event.editedCount = (event.editedCount || 0) + 1;

        saveMeta();
        log(`已保存待选事件「${event.name}」的大纲编辑（第 ${event.editedCount} 次，${rawText.length} 字）`);
        return { event, quality: event.parseQuality, issues };
    }

    /**
     * 结构自检：与 parseOutline 的 quality 保持同一套口径，供表单保存后使用
     * （2026-11-06 修为真按类型判，见下方说明）
     */
    function checkOutlineShape(outline) {
        const o = outline || {};
        // 2026-11-06：这里原来是一份独立实现的案件专用检查——
        // 只要没有 nodes 或 core_truth 就判 ok=false。可这两个都是案件的内层字段，
        // 战斗事件天生没有核心真相，于是任何战斗事件在编辑页存过一次原文，
        // 面板顶上就挂一条红警告「结构不完整：信息节点；核心真相」。
        // 注释写着「与 parseOutline 保持同一套口径」，实际是两份各写各的，
        // 口径已经分叉。现在直接复用 checkOutlineQualityFor，类型从大纲自己读
        // （编辑后的 textarea 里就有 event_type.primary，模型改类型也能跟上）。
        // 拿不到主类型时它不查内层、只报外层——这正是要的行为，不会误判战斗。
        const hinted = String((o.event_type && o.event_type.primary) || '').trim();
        return checkOutlineQualityFor(o, hinted);
    }

    /**
     * 大纲引用自检：节点编号是否连续、路径与角色是否引用了不存在的节点。
     * 只做检查不做修正 —— 编号跳号未必是错，但多半是手改时漏删了别处引用。
     */
    function checkOutlineRefs(outline) {
        if (!outline || typeof outline !== 'object') return [];
        const issues = [];
        // 2026-11-05 M2 复核：nodes 与 paths 都在 structure 里。
        // 按顶层读会同时造成两件事：常驻假警告「没有识别到任何信息节点」，
        // 以及 idSet 为空导致路径引用检查全部跳过——等于这项检查对新事件失效。
        const nodes = innerNodesOf(outline);
        const ids = nodes.map(n => Number(nodeId(n))).filter(n => Number.isFinite(n));
        for (let i = 1; i <= ids.length; i++) {
            if (!ids.includes(i)) { issues.push(`节点编号从 1 到 ${ids.length} 之间缺 ${i}`); break; }
        }
        const dup = ids.filter((n, i) => ids.indexOf(n) !== i);
        if (dup.length) issues.push(`节点编号重复：${[...new Set(dup)].join('、')}`);
        if (!nodes.length) issues.push('没有识别到任何信息节点');

        const idSet = new Set(ids);
        const pathsRaw = innerField(outline, 'paths');
        (Array.isArray(pathsRaw) ? pathsRaw : []).forEach((s, i) => {
            if (!s || typeof s !== 'object') return;
            const ref = s.node;
            if (ref == null) return;
            const refs = Array.isArray(ref) ? ref : [ref];
            refs.forEach(r => {
                const v = Number(r);
                if (Number.isFinite(v) && !idSet.has(v)) {
                    issues.push(`推进路径第 ${s.step || i + 1} 步引用了不存在的节点 ${r}`);
                }
            });
        });
        for (const n of nodes) {
            const rb = n.refute_by;
            if (rb == null) continue;
            (Array.isArray(rb) ? rb : [rb]).forEach(r => {
                const v = Number(r);
                if (Number.isFinite(v) && !idSet.has(v)) {
                    issues.push(`节点 ${nodeId(n)} 的反向证据引用了不存在的节点 ${r}`);
                }
            });
        }
        return issues;
    }

    /**
     * 把结构化大纲拼回 YAML 文本。
     * 只在两处用：草稿编辑框首次展开（原文丢了才走这条，正常永远用 outlineRaw）、
     * 以及用户把编辑框清空后点「从结构重建」。
     * 不追求和模型原输出逐字一致 —— 改过的草稿，原文本来就已经变了。
     */
    function outlineToYaml(outline) {
        if (!outline || typeof outline !== 'object') return '';
        const q = s => {
            const t = String(s).replace(/\\r/g, '');
            if (/[\\n"'#:]/.test(t) || /^\\s|\\s$/.test(t) || /^(true|false|null|~|\\d+(\\.\\d+)?)$/.test(t)) {
                return JSON.stringify(t);
            }
            return t;
        };
        const scalar = v => {
            if (v == null) return 'null';
            if (Array.isArray(v)) return '[' + v.map(x => q(typeof x === 'object' ? JSON.stringify(x) : x)).join(', ') + ']';
            if (typeof v === 'object') return null;
            return q(v);
        };
        const lines = [];
        const pushKV = (k, v, indent) => {
            const pad = ' '.repeat(indent);
            const s = scalar(v);
            lines.push(`${pad}${k}: ${s}`);
        };
        const pushBlockOrKV = (k, v, indent) => {
            const pad = ' '.repeat(indent);
            if (v == null) return;
            if (typeof v === 'string') {
                if (v.includes('\\n')) {
                    lines.push(`${pad}${k}: |`);
                    v.split('\\n').forEach(l => lines.push(`${pad}  ${l}`));
                } else pushKV(k, v, indent);
                return;
            }
            if (Array.isArray(v)) {
                if (!v.length) { lines.push(`${pad}${k}: []`); return; }
                lines.push(`${pad}${k}:`);
                for (const item of v) writeListItem(item, indent + 2, '');
                return;
            }
            if (typeof v === 'object') {
                const entries = Object.entries(v).filter(([, x]) => x !== undefined);
                if (!entries.length) { lines.push(`${pad}${k}: {}`); return; }
                lines.push(`${pad}${k}:`);
                for (const [k2, v2] of entries) pushBlockOrKV(k2, v2, indent + 2);
                return;
            }
            pushKV(k, v, indent);
        };
        // item 可以是标量或对象；path 用 '-' 打头，对象的键再缩进两格
        const writeListItem = (item, indent) => {
            const pad = ' '.repeat(indent);
            if (item == null || typeof item !== 'object') {
                lines.push(`${pad}- ${scalar(item)}`);
                return;
            }
            if (Array.isArray(item)) {
                lines.push(`${pad}-`);
                item.forEach(x => writeListItem(x, indent + 2));
                return;
            }
            const entries = Object.entries(item).filter(([, x]) => x !== undefined);
            if (!entries.length) { lines.push(`${pad}- {}`); return; }
            entries.forEach(([k, v], idx) => {
                if (idx === 0) {
                    const s = scalar(v);
                    if (s != null) return lines.push(`${pad}- ${k}: ${s}`);
                    // 第一个键本身是对象/数组/多行：先占一行 `- key:` 再往下展开
                    lines.push(`${pad}- ${k}:`);
                } else if (v === null) {
                    lines.push(`${pad}  ${k}: null`);
                } else if (typeof v === 'object') {
                    pushBlockOrKV(k, v, indent + 2);
                    return;
                } else {
                    const s = scalar(v);
                    lines.push(`${pad}  ${k}: ${s}`);
                    return;
                }
                // 第一个键就是对象/多行时，往下一层展开
                if (typeof v === 'object') {
                    if (Array.isArray(v)) {
                        if (!v.length) lines[lines.length - 1] += ' []';
                        else v.forEach(x => writeListItem(x, indent + 4));
                    } else {
                        const es = Object.entries(v).filter(([, x]) => x !== undefined);
                        if (!es.length) lines[lines.length - 1] += ' {}';
                        else es.forEach(([k2, v2]) => pushBlockOrKV(k2, v2, indent + 4));
                    }
                } else if (typeof v === 'string' && v.includes('\\n')) {
                    // 列表项里的多行文本没有块标量，退化成缩进续行
                    lines.push(`${pad}  ${k}: ${v.split('\\n').join(`\\n${pad}    `)}`);
                }
            });
        };

        for (const [k, v] of Object.entries(outline)) {
            if (v === undefined) continue;
            pushBlockOrKV(k, v, 0);
        }
        return lines.join('\\n') + '\\n';
    }

    /**
     * 盘点。owner 区分自动与手动（2026-11-10 批 3 第 18 项）：
     * 自动盘点由消息事件触发、手动由按钮触发，两者抢同一把锁。
     * 令牌不同，自动那次跑完就不会把手动那次的提示条收掉。
     * 默认 giveup:true 让「放弃等待」按钮照旧可用。
     */
    async function runInventory(owner) {
        const event = getCurrentEvent();
        if (!event) throw new Error('当前没有进行中的事件');
        if (event.status !== 'active') throw new Error('该事件已结束');
        const inventoryOwner = owner || 'inv';


        setBusy(true, false, '正在盘点事件状态，请稍候…', inventoryOwner);
        try {
            startProgress('正在盘点事件状态');
            step('准备提示词');
            const parts = await gatherContext(event);
            const systemPrompt = buildInventorySystemPrompt();
            const prompt = buildInventoryPrompt(parts, event);
            const raw = await callModel(systemPrompt, prompt);
            step('解析盘点结果');
            const { structured, raw: rawText } = parseInventory(raw);
            step(structured ? '结构化结果解析成功' : '未解析到结构化结果，仅保留文字报告');

            const round = (event.inventories || []).length + 1;
            const record = {
                at: new Date().toISOString(),
                round,
                raw: rawText,
                parsed: structured,
                committedToBook: false,
            };

            // 应用结构化结果
            if (structured) {
                const t = event.tracker;
                const mode = getSettings().tracker.mode;
                const vetoed = new Set(t.nodeVetoed || []);
                const triggered = new Set(t.triggeredNodes || []);
                // 半自动：把模型判出的节点收进「待确认」暂存，不直接改 tracker
                const pending = new Set();

                for (const n of (Array.isArray(structured.triggeredNodes) ? structured.triggeredNodes : [])) {
                    const num = Number(n);
                    if (!Number.isFinite(num)) continue;
                    if (vetoed.has(num)) continue;
                    if (mode === 'manual') continue;
                    if (mode === 'semi') {
                        if (!triggered.has(num)) pending.add(num);
                        continue;
                    }
                    if (!triggered.has(num)) {
                        triggered.add(num);
                        t.autoCommitted.push({ node: num, at: record.at, round });
                    }
                }
                if (mode === 'semi') {
                    // 只保留本轮的建议，上一轮没处理的自然被覆盖
                    t.pendingNodes = Array.from(pending).sort((a, b) => a - b);
                    record.suggestedNodes = t.pendingNodes.slice();
                    log(`半自动：模型建议打勾 ${t.pendingNodes.length ? t.pendingNodes.join('、') : '无'}，等待确认`);
                }
                if (mode === 'auto') {
                    t.triggeredNodes = Array.from(triggered).sort((a, b) => a - b);
                }
                // 战斗目标 / 阶段：模型回 triggeredProgress（字符串 key），
                // 只认盘点页真实存在的 key，防止模型编一个不存在的条目进来把进度弄脏
                if (Array.isArray(structured.triggeredProgress) && structured.triggeredProgress.length) {
                    const valid = new Set(progressItemsOf(event.outline).items.map(it => it.key));
                    if (mode !== 'manual') {
                        const done = new Set(t.progress || []);
                        for (const k of structured.triggeredProgress) {
                            const key = String(k || '').trim();
                            if (!valid.has(key)) continue;
                            if (mode === 'semi') {
                                // 半自动下不直接改，留到确认——这里先记进本轮建议
                                if (!record.suggestedProgress) record.suggestedProgress = [];
                                if (!done.has(key)) record.suggestedProgress.push(key);
                                continue;
                            }
                            if (!done.has(key)) {
                                done.add(key);
                                t.autoCommitted.push({ progress: key, at: record.at, round });
                            }
                        }
                        if (mode === 'auto') t.progress = Array.from(done).sort();
                        if (mode === 'semi') {
                            log(`半自动：模型建议打勾 ${record.suggestedProgress.length} 个进度条目，等待确认`);
                        }
                    }
                }
                if (Array.isArray(structured.refutedMisleads) && mode === 'auto') {
                    const set = new Set(t.refutedMisleads || []);
                    for (const r of structured.refutedMisleads) set.add(String(r));
                    t.refutedMisleads = Array.from(set);
                }
                if (Array.isArray(structured.offPathBranches) && mode === 'auto') {
                    t.offPathBranches = structured.offPathBranches.filter(o => o && o.desc);
                }
            }

            event.inventories = event.inventories || [];
            event.inventories.push(record);

            // 覆盖更新世界书同一条
            event.entryVersion = (event.entryVersion || 1) + 1;
            const content = buildEntryContent(event, round);
            const res = await upsertEventEntry(
                event.worldBook,
                content,
                `${ENTRY_PREFIX}${event.name}｜chatId=${event.chatId}`,
                event.entryUid,
                event,
            );
            if (String(event.entryUid) !== String(res.uid)) {
                // 位置被纠正过，同步回事件卡，避免下次又按原编号找
                event.entryUid = res.uid;
            }
            // 2026-11-10 修（评审 P1-9）：上面那条只在位置变了时才更新，
            // 而盘点这条路的记录常常本来就是空的——书里明明有对应条目，扩展却始终不知道它是自己的。
            // 这里补一句无条件记回来，保证写入成功后一定有账。
            if (res && res.uid != null) event.entryUid = res.uid;
            // 盘点成功即把计数基线挪到当前楼层，下一轮从零开始累计。
            // 基线要连模式一起记，否则用户切换转述后这个基线就按错口径算了
            event.floorBase = countFloors();
            event.floorBaseNarration = !!getSettings().memory.narrationMode;

            saveMeta();
            // 同采用：盘点也改了世界书，面板那份数据已经旧了（2026-11-04）
            toast('盘点已写回世界书。要查看或手动编辑世界书，请先刷新页面（F5），否则改的是旧数据，会把这批内容盖掉', { ms: 9000 });
            return { record, event };
        } catch (e) {
            failProgress(e && e.message || String(e));
            throw e;
        } finally {
            setBusy(false, true, null, inventoryOwner);
        }
    }

    /**
     * 收尾时清理指向已删除条目的旧记录（2026-11-10，批 1 遗留问题二）。
     *
     * 背景：uid 607 同时被三个事件记着——废弃旧链时只废弃了第三个节点，
     * 前两个还是 active、entryUid 都写 607，而那个编号已经写进新链第一个节点的内容。
     * 现在虽然「认不出来就按新增」不会覆盖别人，但脏记录留着迟早误导人，
     * 也会让 healEntryUids 反复去校正一个本来就不该存在的指向。
     *
     * 清理范围只收窄到有把握的那部分，宁可漏清也不误清：
     *   - 同一本书、同一对话下，同一条链的兄弟节点；以及状态已不是 draft/active 的历史卡片；
     *   - 且它们的 entryUid 与刚被删掉的那个编号相同（deletedUid 传 null 时只清链上未知归属的记录）。
     * 别的链、别的对话一概不碰。
     */
    function clearSiblingEntryRefs(meta, closedEvent, deletedUid) {
        if (!meta || !meta.events || !closedEvent) return 0;
        const hasUid = deletedUid != null;
        const chainId = closedEvent.chain && closedEvent.chain.id ? String(closedEvent.chain.id) : '';
        let cleared = 0;
        for (const ev of Object.values(meta.events)) {
            if (!ev || ev === closedEvent) continue;
            if (ev.entryUid == null) continue;
            if (hasUid && String(ev.entryUid) !== String(deletedUid)) continue;
            if (String(ev.worldBook || '') !== String(closedEvent.worldBook || '')) continue;
            if (String(ev.chatId || '') !== String(closedEvent.chatId || '')) continue;
            const sameChain = chainId && ev.chain && ev.chain.id && String(ev.chain.id) === chainId;
            const isHistorical = ev.status !== 'draft' && ev.status !== 'active';
            if (!sameChain && !isHistorical) continue;
            warn(`清掉事件「${ev.name}」指向 uid=${ev.entryUid} 的旧记录（${sameChain ? '同一链' : '历史卡片'}，该条目已不属于它）`);
            ev.entryUid = null;
            cleared++;
        }
        return cleared;
    }

    async function closeEvent(abandoned) {
        const event = getCurrentEvent();
        if (!event) throw new Error('当前没有事件');
        // 废弃/完结是纯本地操作：删世界书条目、改状态、清历史，不碰模型
        setBusy(true, false, abandoned ? '正在废弃事件并清理世界书条目…' : '正在完结事件并清理世界书条目…', 'close');
        try {
            let deletedUid = null;
            if (event.entryUid != null || event.worldBook) {
                // 位置现查，不用 event.entryUid —— 世界书可能被重排过
                const book = event.worldBook || getCharacterBookName();
                if (book) {
                    // 真正被删掉的是 findEventEntryUid 现查到的那个编号，不一定等于 event.entryUid
                    const before = findEventEntryUid(await readWorldBook(book), event);
                    const res = await deleteEventEntryForEvent(book, event);
                    if (res && res.deleted) deletedUid = before != null ? before : event.entryUid;
                }
                event.entryUid = null;
            }
            event.status = abandoned ? 'abandoned' : 'completed';
            event.closedAt = new Date().toISOString();
            const meta = getMeta();
            meta.currentEventId = null;
            // 2026-11-10 修（批 1 遗留问题二：uid 607 三个事件都声称属于自己）：
            // 废弃/完结只清掉当前这一个事件的 entryUid，链上其它还挂着同一个编号的兄弟节点没动，
            // 那个编号后来被新链第一个节点写进去了，旧节点就指着一个已经属于别人的条目。
            // 今天靠「认不出来就按新增」不覆盖，但脏记录悬着迟早出事。
            // 所以收尾时把世界书里所有它的残留一并清掉：同一本书、同一对话、同一链的兄弟节点，
            // 以及状态已不是 draft/active 的历史卡片。
            const cleared = clearSiblingEntryRefs(meta, event, deletedUid);
            if (cleared) log(`收尾时清掉 ${cleared} 条指向已删除条目的旧记录（同一链或同书同对话的历史卡片）`);
            await applyRetention(meta);
            saveMeta();
            log(`事件「${event.name}」已${abandoned ? '废弃' : '完结'}，世界书条目已清理，事件卡转历史`);
            return event;
        } finally {
            setBusy(false, null, null, 'close');
        }
    }

    /** 按保留数量清理历史事件卡 */
    async function applyRetention(meta) {
        const s = getSettings();
        const all = Object.values(meta.events || {});
        const pick = (status) => all
            .filter(e => e.status === status)
            .sort((a, b) => String(b.closedAt || '').localeCompare(String(a.closedAt || '')));

        const done = pick('completed');
        const limitDone = Math.max(1, Number(s.retention.completed) || 20);
        const dropDone = done.slice(limitDone);
        for (const e of dropDone) delete meta.events[e.id];
        if (dropDone.length) log(`历史保留：完结事件超上限 ${limitDone}，清理了 ${dropDone.length} 条最旧的：${dropDone.map(e => e.name).join('、')}`);

        const ab = pick('abandoned');
        const limitAb = Math.max(1, Number(s.retention.abandoned) || 3);
        const dropAb = ab.slice(limitAb);
        for (const e of dropAb) delete meta.events[e.id];
        if (dropAb.length) log(`历史保留：废弃事件超上限 ${limitAb}，清理了 ${dropAb.length} 条最旧的：${dropAb.map(e => e.name).join('、')}`);
    }

    /**
     * 进度条目：把一个大纲里「能打勾的东西」统一成一张清单。
     *
     * 为什么需要（2026-11-06）：文档要求盘点页按类型渲染进度条目。
     * 原来只有案件能追踪——渲染入口是 innerNodesOf + if(nodes.length)，
     * 战斗没有节点、多段事件也没有节点，这两个类型从采用那一刻起就勾不了。
     *
     * 设计口径（危晓 2026-11-06 定）：新增一套平行字段 tracker.progress，
     * key 用字符串，不去动旧的 triggeredNodes 数字数组。
     * 旧案件事件完全不受影响，回滚只需停用这批 key。
     *
     * 返回 [{key, label, detail}]：
     * - 案件：节点，key 沿用 node:<编号>，实际仍读写 triggeredNodes（为了不迁移旧数据）
     * - 战斗：目标，key 为 obj:<序号>，读写 tracker.progress
     * - 多段：阶段，key 为 stage:<序号>，读写 tracker.progress
     *
     * M5（2026-11-06）：取哪一套由骨架的 progress 声明决定，不再靠现场探测。
     * 有声明就只认那一个字段——战斗没写目标就是没有进度，不退回读它的节点，
     * 否则会把「大纲缺目标」这个缺陷掩盖成「进度正常但为空」。
     * 没声明（无骨架的类型、或 event_type 读不出主类型）保留原来的顺序探测，
     * 因为那部分类型还没有骨架，探测是当前唯一能给出进度的办法。
     */
    function progressItemsOf(outline) {
        const o = outline || {};

        // M5（2026-11-06）：先看骨架有没有声明进度来源。
        // 声明了就以声明为准——这是 spec 化的第一步，以后加类型只往表里填一行，不改这个函数。
        const decl = progressSpecOf(mainTypeOfOutline(o));

        // 有声明：只认声明的那一个字段，读不出来就是没有进度，不往别的字段退。
        // 往别处退会让「战斗没写目标」变成「去读它并不存在的节点」，等于掩盖大纲缺陷。
        if (decl) {
            if (decl.field === 'nodes') {
                const nodes = innerNodesOf(o);
                if (!Array.isArray(nodes) || !nodes.length) return { kind: 'node', title: '节点进度', items: [] };
                return {
                    kind: 'node',
                    title: '节点进度',
                    legacy: decl.legacy,
                    items: nodes.map(n => {
                        const id = nodeId(n);
                        return {
                            key: 'node:' + id,
                            id,
                            label: `${id}. ${n.type || ''} ${nodeText(n)}`.trim(),
                            trigger: nodeTrigger(n),
                        };
                    }),
                };
            }
            if (decl.field === 'objectives') {
                const objs = innerField(o, 'objectives');
                if (!Array.isArray(objs) || !objs.length) return { kind: 'objective', title: '目标进度', items: [] };
                return {
                    kind: 'objective',
                    title: '目标进度',
                    legacy: decl.legacy,
                    items: objs.map((x, i) => {
                        const name = (x && typeof x === 'object')
                            ? String(x.name || x['名称'] || '').trim() || `目标 ${i + 1}`
                            : String(x || '').trim() || `目标 ${i + 1}`;
                        const cond = (x && typeof x === 'object') ? String(x.condition || '').trim() : '';
                        const fail = (x && typeof x === 'object') ? String(x.fail || '').trim() : '';
                        return {
                            key: 'obj:' + i,
                            id: i,
                            label: `${i + 1}. ${name}`,
                            // 达成条件是判断「算不算完成」的依据，打勾时要看得见
                            detail: cond ? `达成：${cond}` + (fail ? `｜失败：${fail}` : '') : (fail ? `失败：${fail}` : ''),
                        };
                    }),
                };
            }
            // M6（2026-11-06 真机）：声明 field:'phases' 的类型（「其他」）按阶段推进。
            // 之前这里只实现了 nodes 与 objectives，phases 一路掉到下面的 none，
            // 结果「其他」事件生成得完全正确，盘点页却一个字都不显示——声明了却没人实现，
            // 比没声明更糟，因为校验层认它有骨架、界面却是空的。
            if (decl.field === 'phases') {
                const phs = innerField(o, 'phases');
                if (!Array.isArray(phs) || !phs.length) return { kind: 'stage', title: '阶段进度', items: [] };
                return {
                    kind: 'stage',
                    title: '阶段进度',
                    legacy: decl.legacy,
                    items: phs.map((st, i) => {
                        const goal = (st && typeof st === 'object')
                            ? String(st.goal || st['目标'] || '').trim() || `第 ${i + 1} 段`
                            : String(st || '').trim() || `第 ${i + 1} 段`;
                        const entry = (st && typeof st === 'object') ? String(st.entry || '').trim() : '';
                        const exit = (st && typeof st === 'object') ? String(st.exit || '').trim() : '';
                        // 段的 type 是模型自己起的分类（社交博弈/探险/危机），
                        // 和主类型列表同一套词，写在标题里会被误读成「这个事件是社交博弈」。
                        // 2026-11-06 危晓定：只在标题里写目标，不显示 type。
                        return {
                            key: 'stage:' + i,
                            id: i,
                            label: `${i + 1}. ${goal}`,
                            detail: (entry ? `从：${entry}` : '') + (exit ? `${entry ? '｜' : ''}到：${exit}` : ''),
                        };
                    }),
                };
            }
            // 声明了别的字段：本期还没有对应实现（M6 随类型补齐），按无进度处理。
            return { kind: 'none', title: '', items: [] };
        }

        // 没有声明（无骨架的类型，或 event_type 读不出主类型）：保持原来的顺序探测，
        // 一个字段都不认得就返回 none，交给调用方走「尚未触及的大纲要点」那条兜底文案。
        const nodes = innerNodesOf(o);
        if (Array.isArray(nodes) && nodes.length) {
            return {
                kind: 'node',
                title: '节点进度',
                legacy: true,
                items: nodes.map(n => {
                    const id = nodeId(n);
                    return {
                        key: 'node:' + id,
                        id,
                        label: `${id}. ${n.type || ''} ${nodeText(n)}`.trim(),
                        trigger: nodeTrigger(n),
                    };
                }),
            };
        }
        const objs = innerField(o, 'objectives');
        if (Array.isArray(objs) && objs.length) {
            return {
                kind: 'objective',
                title: '目标进度',
                items: objs.map((x, i) => {
                    const name = (x && typeof x === 'object')
                        ? String(x.name || x['名称'] || '').trim() || `目标 ${i + 1}`
                        : String(x || '').trim() || `目标 ${i + 1}`;
                    const cond = (x && typeof x === 'object') ? String(x.condition || '').trim() : '';
                    const fail = (x && typeof x === 'object') ? String(x.fail || '').trim() : '';
                    return {
                        key: 'obj:' + i,
                        id: i,
                        label: `${i + 1}. ${name}`,
                        detail: cond ? `达成：${cond}` + (fail ? `｜失败：${fail}` : '') : (fail ? `失败：${fail}` : ''),
                    };
                }),
            };
        }
        const stages = innerField(o, 'phases');
        if (Array.isArray(stages) && stages.length) {
            return {
                kind: 'stage',
                title: '阶段进度',
                items: stages.map((st, i) => {
                    const goal = (st && typeof st === 'object')
                        ? String(st.goal || st['目标'] || '').trim() || `第 ${i + 1} 段`
                        : String(st || '').trim() || `第 ${i + 1} 段`;
                    const entry = (st && typeof st === 'object') ? String(st.entry || '').trim() : '';
                    const exit = (st && typeof st === 'object') ? String(st.exit || '').trim() : '';
                    return {
                        key: 'stage:' + i,
                        id: i,
                        label: `${i + 1}. ${goal}`,
                        detail: (entry ? `从：${entry}` : '') + (exit ? `${entry ? '｜' : ''}到：${exit}` : ''),
                    };
                }),
            };
        }
        return { kind: 'none', title: '', items: [] };
    }

    /** 读一组已完成进度 key（2026-11-06 M5 前置：战斗目标 / 阶段用这套） */
    function getProgressSet(event) {
        return new Set((event && event.tracker && event.tracker.progress) || []);
    }

    /**
     * 切换一个进度条目的完成状态。
     * 案件的节点仍走 toggleNode（它还要维护 vetoed / pending 两套旧字段），
     * 战斗目标与阶段没有那套机制，只记一个 key 的有无。
     */
    function toggleProgress(key) {
        const event = getCurrentEvent();
        if (!event) return;
        if (!event.tracker) event.tracker = {};
        const done = getProgressSet(event);
        if (done.has(key)) done.delete(key);
        else done.add(key);
        event.tracker.progress = Array.from(done).sort();
        log(`手动${done.has(key) ? '打勾' : '撤销'}进度 ${key}（当前已完成 ${event.tracker.progress.length} 项）`);
        saveMeta();
    }

    function toggleNode(nodeId) {
        const event = getCurrentEvent();
        if (!event) return;
        const triggered = new Set(event.tracker.triggeredNodes || []);
        const vetoed = new Set(event.tracker.nodeVetoed || []);
        const pending = new Set(event.tracker.pendingNodes || []);
        const id = Number(nodeId);
        if (triggered.has(id)) {
            triggered.delete(id);
            vetoed.add(id);
        } else {
            triggered.add(id);
            vetoed.delete(id);
        }
        // 不管勾还是撤，这个节点都不再算「待确认」
        pending.delete(id);
        event.tracker.triggeredNodes = Array.from(triggered).sort((a, b) => a - b);
        event.tracker.nodeVetoed = Array.from(vetoed).sort((a, b) => a - b);
        event.tracker.pendingNodes = Array.from(pending).sort((a, b) => a - b);
        log(`手动${triggered.has(id) ? '打勾' : '撤销'}节点 ${id}（当前已触发 ${event.tracker.triggeredNodes.length} 个）`);
        saveMeta();
        // 撤勾的后果不直观：自动盘点以后也不会再勾它。这里说清楚，并给出恢复入口
        if (!triggered.has(id)) {
            toast(`已撤销节点 ${id}：自动盘点以后不会再勾选它。要恢复点盘点页的「恢复自动勾选」`, { bad: true });
        }
    }

    /**
     * 恢复被否定的节点（2026-11-02）。
     * 撤勾这件事有两种来源，不能一把清：直接清掉否决的话，
     * 模型会连你亲手里撤掉的、已经确认过的节点也重新勾上。所以分开处理：
     *   1. 自动勾选后又手撤的：从自动记录里摘掉，节点交回模型重新判断；
     *   2. 纯人工否决的：清掉否决标记即可。
     */
    function restoreVetoedNodes() {
        const event = getCurrentEvent();
        if (!event) return 0;
        const t = event.tracker || {};
        const vetoed = (t.nodeVetoed || []).slice();
        if (!vetoed.length) return 0;
        const auto = (t.autoCommitted || []).slice();
        const hitAuto = auto.filter(a => vetoed.includes(a.node)).map(a => a.node);
        let n = 0;
        if (hitAuto.length) {
            t.autoCommitted = auto.filter(a => !hitAuto.includes(a.node));
            log(`已撤回 ${hitAuto.length} 个自动勾选并交回模型判断（${hitAuto.join('、')}）`);
            n += hitAuto.length;
        }
        const rest = vetoed.filter(id => !hitAuto.includes(id));
        if (rest.length) {
            n += rest.length;
            log(`已恢复 ${rest.length} 个被否决的节点，自动盘点会重新判断（${rest.join('、')}）`);
        }
        t.nodeVetoed = [];
        saveMeta();
        return n;
    }

    /** 半自动：确认一条模型建议 */
    function confirmPending(nodeId) {
        const event = getCurrentEvent();
        if (!event) return;
        const id = Number(nodeId);
        const pending = new Set(event.tracker.pendingNodes || []);
        if (!pending.has(id)) return;
        const triggered = new Set(event.tracker.triggeredNodes || []);
        const vetoed = new Set(event.tracker.nodeVetoed || []);
        triggered.add(id);
        vetoed.delete(id);
        pending.delete(id);
        event.tracker.triggeredNodes = Array.from(triggered).sort((a, b) => a - b);
        event.tracker.nodeVetoed = Array.from(vetoed).sort((a, b) => a - b);
        event.tracker.pendingNodes = Array.from(pending).sort((a, b) => a - b);
        event.tracker.autoCommitted.push({ node: id, at: new Date().toISOString(), round: (event.inventories || []).length, confirmed: true });
        log(`确认建议：节点 ${id} 已打勾（剩余待确认 ${pending.size} 个）`);
        saveMeta();
    }

    /** 半自动：忽略一条模型建议 */
    function dismissPending(nodeId) {
        const event = getCurrentEvent();
        if (!event) return;
        const id = Number(nodeId);
        const pending = new Set(event.tracker.pendingNodes || []);
        if (!pending.has(id)) return;
        pending.delete(id);
        event.tracker.pendingNodes = Array.from(pending).sort((a, b) => a - b);
        log(`忽略建议：节点 ${id}（剩余待确认 ${pending.size} 个）`);
        saveMeta();
    }


    let panelEl = S.panelEl; // 引用指向 S，值统一存 S
    let fabEl = S.fabEl; // 引用指向 S，值统一存 S
    let backdropEl = S.backdropEl; // 引用指向 S，值统一存 S

    function injectStyle() {
        if (document.getElementById('eo_style')) return;
        const style = document.createElement('style');
        style.id = 'eo_style';
        style.textContent = `
:root{
  /* 主题色板（2026-11-02）：以前这些颜色散在各条规则里、同一色值重复十几遍，
     改一次配色要全文找替换。现在统一在这里改，别处只用变量。 */
  --eo-bg:#fffdf7;--eo-bg-soft:#fffaf0;--eo-bg-warm:#fff6e0;--eo-bg-busy:#fff3d6;
  --eo-accent:#b8860b;--eo-accent-soft:#f5d080;--eo-accent-deep:#8a5b00;
  --eo-line:rgba(184,134,11,.35);--eo-line-strong:rgba(184,134,11,.55);
  --eo-text:#3c2f14;--eo-text-2:#6b5424;--eo-text-3:#8a7333;--eo-text-4:#9b8a5e;
  --eo-dark:#4a3200;--eo-dark-2:#5a3e0b;
  --eo-ok:#2c6e2c;--eo-bad:#a11;--eo-bad-bg:#fdecea;--eo-bad-line:#e7a9a3;--eo-bad-text:#8b0000;
  --eo-danger:#c0392b;--eo-danger-deep:#a0301f;--eo-white:#fff;
  /* 2026-11-09 修：下面四个原来写成 var(--自己)，CSS 里属循环引用、按无效值处理，
     用到它们的十来处文字和按钮底色会退化成继承色或浏览器默认色。
     按现有色阶补上具体值：文字由深到浅 3c2f14 → 6b5424 → 8a7333 → 9b8a5e 已有四档，
     text-5/6 接在后面继续往浅走；ok-2 比 --eo-ok 亮一档；accent-2 取 accent 与 soft 之间。 */
  --eo-text-5:#7a6438;--eo-text-6:#a3946a;--eo-ok-2:#3d8f3d;--eo-accent-2:#c9961a;

}
#eo_fab{position:fixed;z-index:30001;display:flex;align-items:center;justify-content:center;
  width:44px;height:44px;border-radius:12px;cursor:grab;box-sizing:border-box;
  user-select:none;-webkit-user-select:none;touch-action:none;
  -webkit-tap-highlight-color:transparent;outline:none;
  background:linear-gradient(160deg,var(--eo-bg-busy),var(--eo-accent-soft));border:1px solid var(--eo-line-strong);
  box-shadow:0 2px 10px rgba(0,0,0,.25);color:var(--eo-dark-2);font-size:15px;font-weight:700;
  transition:width .16s ease,height .16s ease,left .16s ease,top .16s ease,filter .16s ease;}
#eo_fab:hover{filter:brightness(1.06);}
#eo_fab:active{cursor:grabbing;}
#eo_fab.eo-dragging{transition:none!important;cursor:grabbing;filter:brightness(1.08);
  box-shadow:0 6px 20px rgba(0,0,0,.35);}
.eo-fab-label{line-height:1;pointer-events:none;}

/* 吸附竖条：尺寸由 JS 通过内联 width/height 控制，这里只管外观 */
#eo_fab.eo-collapsed{border-radius:0;padding:0;overflow:hidden;cursor:pointer;
  background:transparent;border:0;box-shadow:none;}
#eo_fab.eo-collapsed .eo-fab-label{display:none;}
#eo_fab.eo-collapsed::after{content:"";position:absolute;top:50%;transform:translateY(-50%);
  width:10px;height:100%;background:linear-gradient(160deg,var(--eo-bg-busy),var(--eo-accent-soft));
  border:1px solid var(--eo-line-strong);box-sizing:border-box;}
#eo_fab.eo-collapsed.eo-dock-left::after{left:0;border-radius:0 6px 6px 0;border-left:0;}
#eo_fab.eo-collapsed.eo-dock-right::after{right:0;border-radius:6px 0 0 6px;border-right:0;}

/* 悬停时把竖条撑开成完整图标 */
#eo_fab.eo-collapsed.eo-hover{background:linear-gradient(160deg,var(--eo-bg-busy),var(--eo-accent-soft));
  border:1px solid var(--eo-line-strong);box-shadow:0 2px 10px rgba(0,0,0,.25);}
#eo_fab.eo-collapsed.eo-hover .eo-fab-label{display:inline;}
#eo_fab.eo-collapsed.eo-hover::after{display:none;}
#eo_fab.eo-collapsed.eo-hover.eo-dock-left{border-radius:0 12px 12px 0;border-left:0;}
#eo_fab.eo-collapsed.eo-hover.eo-dock-right{border-radius:12px 0 0 12px;border-right:0;}
.eo-fab-label{line-height:1;}
#eo_backdrop{position:fixed;inset:0;z-index:30000;display:none;
  background:rgba(30,22,8,.55);backdrop-filter:blur(2px);}
#eo_backdrop.eo-open{display:block;}
#eo_panel.eo-open{display:flex;}
/* 面板铺满整个视口，正文区自己滚（2026-11-02 第二次修）。
   第一版把面板写成 height:auto 让高度随内容长，但它是 position:fixed——
   fixed 元素不占文档流，页面不会因它变长，而 body 滚动又被锁了，
   结果面板再长也没有任何地方能滚，手机滑动和 PC 滚轮全部失效。
   现在高度钉死在视口，正文区吃掉剩余空间自己滚，内部不出第二条页面滚动条。 */
#eo_panel{position:fixed;left:0;top:0;right:0;bottom:0;z-index:30001;display:none;flex-direction:column;
  width:100%;height:100vh;height:100dvh;overflow:hidden;
  background:var(--eo-bg);border:0;border-radius:0;box-shadow:none;
  font-size:14px;color:var(--eo-text);}
/* 正文区：吃掉剩余高度（min-height:0 是关键，否则会被内容撑破），自己滚 */
/* 上边距为 0：标签栏要贴着头栏，中间不留缝（2026-11-02 危晓指出） */
#eo_panel .eo-body{flex:1 1 auto;min-height:0;max-width:1100px;width:100%;margin:0 auto;
  padding:0 20px 48px;overflow-y:auto;overflow-x:hidden;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;}
/* 原先是重置 .eo-box 的高度上限，2026-11-14 起内容框改自带限高自滚，这条不再需要，删掉免得与后面的定义互相矛盾 */
/* 请求体三段（2026-11-02）：三块文本域上下排，别挤成一坨 */
.eo-yaml-field{margin:8px 0 4px;}
.eo-yaml-field>textarea{font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;
  resize:vertical;min-height:56px;}
@media (max-width:640px){
  #eo_panel .eo-body{padding:0 12px 40px;}
  .eo-head{padding:10px 12px;}
  .eo-tabs{margin-left:-12px;margin-right:-12px;padding-left:12px;padding-right:12px;}
  /* 手机窄屏（2026-11-02）：输入类控件字号提到 16px。
     iOS Safari 对字号小于 16px 的输入控件聚焦时会把整页放大，放完不回缩。
     只提输入类，桌面不动；下拉框弹出列表会跟着大一号，这是预期的。 */
  #eo_panel .eo-input,
  #eo_panel select.eo-sel,
  #eo_panel .eo-textarea,
  #eo_panel .eo-yaml-field>textarea{font-size:16px;}
}
.eo-busy{display:none;padding:8px 12px;background:var(--eo-bg-busy);border-bottom:1px solid rgba(184,134,11,.3);
  color:var(--eo-accent-deep);font-size:12px;text-align:center;}
.eo-giveup{margin-left:10px;padding:1px 8px;border:1px solid rgba(184,134,11,.6);border-radius:6px;
  background:rgba(255,255,255,.6);cursor:pointer;font-size:12px;white-space:nowrap;}
.eo-giveup:hover{background:#fff;}
.eo-progress{display:none;padding:8px 12px;background:#f6f8fa;border-bottom:1px solid rgba(0,0,0,.08);
  font-size:12px;transition:opacity .6s;}
.eo-progress-head{color:#333;font-weight:600;margin-bottom:4px;}
.eo-progress-timer{color:#888;font-weight:400;}
.eo-progress-row{color:#666;line-height:1.7;padding-left:2px;}
.eo-progress-mark{display:inline-block;width:14px;color:var(--eo-accent);}
.eo-progress-done{color:var(--eo-ok-2);}
.eo-progress-done .eo-progress-mark{color:var(--eo-ok-2);}
.eo-head{display:flex;align-items:center;gap:8px;padding:12px 20px;user-select:none;
  /* 页面交给浏览器窗口滚，标题栏和标签栏跟着吸在窗口顶上，往下翻也能关面板、切页签 */
  position:sticky;top:0;z-index:50;
  background:linear-gradient(160deg,var(--eo-bg-busy),var(--eo-accent-soft));border-bottom:1px solid rgba(184,134,11,.4);}
.eo-title{font-weight:700;flex:1;}
.eo-close{cursor:pointer;padding:4px 12px;border-radius:8px;background:rgba(255,255,255,.55);font-size:15px;}
.eo-close:hover{background:rgba(255,255,255,.85);}
.eo-body{padding:12px;overflow:visible;flex:1;}
.eo-row{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;}
.eo-row>label{min-width:78px;color:var(--eo-text-2);}
.eo-btn{padding:5px 12px;border-radius:8px;border:1px solid rgba(184,134,11,.5);
  background:var(--eo-bg-warm);cursor:pointer;color:var(--eo-dark-2);font-size:13px;}
.eo-btn:hover{background:#fdeec4;}
.eo-btn:disabled{opacity:.5;cursor:not-allowed;}
.eo-btn.eo-primary{background:var(--eo-accent-2);border-color:var(--eo-accent);font-weight:600;}
/* 2026-11-10 危晓：土黄实心块在面板里显得突兀，改成跟悬浮球、激活标签同一套渐变。
   保留「主要操作」的分量（加粗、深一点的边框），但颜色归到面板色系里。 */
.eo-btn.eo-grad{background:linear-gradient(160deg,var(--eo-bg-busy),var(--eo-accent-soft));
  border-color:var(--eo-line-strong);color:var(--eo-dark-2);font-weight:600;
  box-shadow:0 1px 3px rgba(184,134,11,.18);}
.eo-btn.eo-grad:hover{filter:brightness(1.04);background:linear-gradient(160deg,var(--eo-bg-busy),var(--eo-accent-soft));}
/* 待选事件的操作按钮（采用/丢弃）：默认不高亮，只有按住的那一下亮，松开就灭。
   采用不再用 eo-primary 常亮——列表里好几个草稿时，常亮的按钮容易让人以为是当前选中 */
.eo-btn.eo-press:active{background:var(--eo-accent-2);border-color:var(--eo-accent);font-weight:600;}
/* 看大纲/编辑：开关类按钮，开着高亮、关掉回原样。
   2026-11-14 危晓改口径：以前定的是「整页只由窗口滚动，内容框一律不另设滚动条」，
   那条现在废弃——一条几百行的日志或大纲会把整页拉得极长，找按钮要翻半天。
   改成各框自己限高、自己滚，整页长度因此可控。52dvh 而不是 52vh：手机地址栏收放时 vh 不变，
   用 vh 会让框比可视区高、底部被挡住。 */
.eo-box{border:1px solid rgba(184,134,11,.32);border-radius:9px;padding:9px 10px;
  background:var(--eo-bg-soft);margin-bottom:9px;white-space:pre-wrap;word-break:break-word;
  max-height:52dvh;overflow-y:auto;overflow-x:auto;
  overscroll-behavior:contain;-webkit-overflow-scrolling:touch;line-height:1.55;}
.eo-hint{color:var(--eo-text-3);font-size:12px;line-height:1.5;}
/* 骨架映射表（M7 2026-11-07）：一行一条「自定义名 → 内置名」，右侧带删除 */
.eo-map-list{margin:4px 0 6px;}
.eo-map-from{font-weight:600;}
.eo-map-to{color:var(--eo-text-2);}
.eo-err{color:#c62828;font-size:12px;line-height:1.5;}
/* 行内提醒（2026-11-04）：跟着输入框走，不带边框和背景，只把字染色，免得撑开行高 */
.eo-hint-note{color:#a35c00;font-weight:600;}
/* 大纲正文：保留换行与缩进，不加高度上限（大纲本来就有几百行，截断反而看不到全貌） */
.eo-outline-text{white-space:pre-wrap;word-break:break-word;line-height:1.7;
  font-size:13px;color:var(--eo-text);background:var(--eo-bg);border:1px solid rgba(184,134,11,.28);
  border-radius:9px;padding:10px 12px;margin-bottom:10px;}
/* 子项语义说明：紧跟在对应下拉框下面，小一号、更淡 */
.eo-subdesc{font-size:11px;color:var(--eo-text-4);margin:-2px 0 6px 8px;}
.eo-warn{color:#a35c00;background:var(--eo-bg-busy);border:1px solid #e6c37a;
  border-radius:8px;padding:7px 9px;margin-bottom:9px;font-size:12px;}
.eo-ok{color:var(--eo-ok);}
/* 面板内确认条（2026-11-02：替代原生 confirm，原生框在手机上阻塞且与本面板样式脱节） */
.eo-confirmbar{display:none;align-items:center;gap:10px;padding:10px 20px;
  background:var(--eo-bg-busy);border-bottom:1px solid rgba(184,134,11,.45);font-size:13px;color:#6b4a00;}
.eo-confirmbar.eo-confirmbar-open{display:flex;}
.eo-confirmbar .eo-confirm-text{flex:1;line-height:1.5;}
.eo-confirmbar .eo-btn{flex:none;}
.eo-btn-danger{background:var(--eo-danger);border-color:var(--eo-danger-deep);color:#fff;}
.eo-btn-danger:hover{background:var(--eo-danger-deep);}
/* 右下角轻提示（替代 alert）：3 秒自走，失败的留 6 秒 */
.eo-toasts{position:fixed;right:16px;bottom:16px;z-index:30005;display:flex;
  flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;}
.eo-toast{max-width:min(420px,80vw);padding:9px 14px;border-radius:8px;font-size:13px;line-height:1.5;
  background:var(--eo-bg);border:1px solid rgba(184,134,11,.5);color:var(--eo-text);
  box-shadow:0 4px 14px rgba(0,0,0,.16);pointer-events:auto;opacity:0;transform:translateY(6px);
  transition:opacity .18s,transform .18s;}
.eo-toast.eo-toast-in{opacity:1;transform:none;}
.eo-toast.eo-toast-bad{background:var(--eo-bad-bg);border-color:var(--eo-bad-line);color:var(--eo-bad-text);}
.eo-bad{color:#a11;font-size:12px;}
.eo-bad-box{color:var(--eo-bad-text);background:var(--eo-bad-bg);border:1px solid var(--eo-bad-line);
  border-radius:8px;padding:8px 10px;margin-bottom:9px;font-size:12px;line-height:1.6;}
/* 2026-11-09：生成失败的待选事件在列表里就要标出来，不能混在正常事件里 */
.eo-bad-flag{color:var(--eo-bad-text);background:var(--eo-bad-bg);border:1px solid var(--eo-bad-line);
  border-radius:6px;padding:1px 7px;font-size:11px;white-space:nowrap;cursor:help;}

select.eo-sel{padding:4px 8px;border-radius:7px;border:1px solid rgba(184,134,11,.45);
  background:var(--eo-bg);color:var(--eo-text);font-size:13px;}
/* 待选事件：列表式排布，每一项带采用/丢弃/展示大纲/编辑
   按钮样式（2026-11-02 危晓定）：采用、丢弃平时不高亮，按住那一下才亮；
   展示大纲、编辑是开关，开着常亮、点一次收起就灭 */
.eo-drafts{display:flex;flex-direction:column;gap:8px;margin:6px 0 10px;}
/* M16 待选里的链分组 */
.eo-chaindraft{border:1px dashed #d9c48a;border-radius:8px;padding:6px;display:block;}
/* 2026-11-10 危晓：待选链改成可折叠。details 默认是 block，
   原来这里是 flex 排版，改成 block 之后节点卡片靠 gap 已经不够，
   用 margin 补回来，同时给 summary 一个可点的样子。 */
.eo-chaindraft>.eo-chaindraft-head-row{cursor:pointer;list-style:none;}
.eo-chaindraft>.eo-chaindraft-head-row::-webkit-details-marker{display:none;}
.eo-chaindraft>.eo-chaindraft-head-row::before{content:'▸';display:inline-block;margin-right:4px;
  color:var(--eo-accent);transition:transform .15s;}
.eo-chaindraft[open]>.eo-chaindraft-head-row::before{transform:rotate(90deg);}
.eo-chaindraft>div{margin-top:6px;}

/* 2026-11-09：链预览里的衔接条件行——两个下拉 + 输入框 + 删除按钮 */
.eo-trig-row{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;}
.eo-trig-line{display:flex;gap:6px;align-items:flex-start;}
.eo-trig-line>span.eo-hint{flex:0 0 auto;padding-top:7px;white-space:nowrap;}
.eo-trig-line .eo-auto{flex:1 1 auto;min-width:0;}
.eo-trig-line select.eo-sel{flex:0 0 auto;min-width:88px;}
.eo-trig-preview{display:block;font-size:12px;color:var(--eo-text-2);opacity:.85;
  padding-left:2px;word-break:break-all;}

.eo-btn-del{padding:2px 8px;flex:0 0 auto;}

.eo-draft{background:var(--eo-bg);border:1px solid var(--eo-line);border-radius:8px;
  padding:8px 10px;}
.eo-draft-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;}
/* 待选卡片的操作区（2026-11-02）：左边是「只是看看」的开关，右边是真正生效的采用/丢弃。
   开关态靠左侧竖条与文案表达，不靠底色——底色会和主按钮混在一起，分不清哪个会生效。 */
.eo-draft-acts{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:6px;}
.eo-draft-acts-look{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.eo-draft-acts-use{display:flex;gap:6px;align-items:center;margin-left:auto;}
/* 设置页顶部原本有一排锚点按钮（模型、记忆与判定、界面与世界书、难度挡位），
   2026-11-02 危晓要求删掉：页面上不需要这排快捷跳转，直接按段落顺读即可。
   各段的锚点占位 div 一并去掉，空 div 不再需要定位。 */
.eo-keybox{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.eo-keymask{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--eo-text-4);}
.eo-btn-toggle{border-left:3px solid transparent;}
.eo-btn-toggle.eo-on{border-left-color:var(--eo-accent);font-weight:700;}
/* 进度条：失败那一步要看得出来是哪一步（2026-11-02） */
.eo-progress-row.eo-progress-failed{color:var(--eo-danger);}
.eo-progress-row.eo-progress-failed .eo-progress-mark{color:var(--eo-danger);font-weight:700;}
.eo-draft-name{font-weight:700;color:var(--eo-text-2);font-size:13px;}
.eo-draft-meta{font-size:11px;color:var(--eo-text-4);}
.eo-draft-brief{font-size:12px;color:var(--eo-text-6);line-height:1.6;margin:4px 0 6px;}
.eo-draft-body{margin-top:8px;border-top:1px dashed rgba(184,134,11,.3);padding-top:8px;}
/* 草稿编辑：中文表单，一格一格填，不用看 YAML */
.eo-draft-edit .eo-form-sec{font-weight:600;color:var(--eo-text-2);font-size:13px;margin:12px 0 6px;
  border-bottom:1px solid rgba(184,134,11,.25);padding-bottom:4px;}
.eo-draft-edit .eo-list{display:flex;flex-direction:column;gap:8px;}
.eo-formcard{background:var(--eo-bg-soft);border:1px solid rgba(184,134,11,.3);border-radius:8px;padding:8px 10px;}
.eo-formcard-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;}
.eo-formcard-title{font-weight:700;color:var(--eo-text-2);font-size:12px;flex:1;min-width:60px;}
.eo-draft-edit .eo-field{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;}
.eo-draft-edit .eo-field-label{flex:0 0 96px;font-size:12px;color:var(--eo-text-5);padding-top:6px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eo-draft-edit .eo-field .eo-input{margin-bottom:0;font-size:13px;}
.eo-draft-edit .eo-field .eo-textarea{min-height:42px;}
.eo-btn.eo-sm{padding:3px 9px;font-size:12px;}
.eo-extra-keys summary{font-size:11px;color:var(--eo-text-4);cursor:pointer;margin:4px 0;}
/* YAML 编辑框用等宽字，行号对齐、编号一眼能看出跳没跳 */
.eo-draft-yaml{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12px;
  white-space:pre;overflow-y:auto;overflow-x:auto;max-height:52dvh;
  overscroll-behavior:contain;-webkit-overflow-scrolling:touch;line-height:1.5;min-height:160px;}
.eo-draft-edit label,.eo-draft-edit .eo-label{font-size:12px;color:var(--eo-text-5);white-space:nowrap;}
.eo-draft-edit .eo-sec-inline{margin-top:6px;}
.eo-sec{border-top:1px dashed var(--eo-line);margin:10px 0 6px;padding-top:8px;
  font-weight:600;color:var(--eo-text-2);}

/* 标签栏 */
/* 标签栏贴着头栏，自己留一点上边距当呼吸，不再靠正文区的 padding 撑（2026-11-02） */
.eo-tabs{display:flex;gap:4px;border-bottom:1px solid var(--eo-line);
  margin:0 -20px 14px;padding:6px 20px 0;position:sticky;top:0;background:var(--eo-bg);z-index:40;
  box-shadow:0 -1px 0 0 var(--eo-bg) inset;}
.eo-tab{padding:9px 16px;cursor:pointer;border-radius:9px 9px 0 0;color:var(--eo-text-5);
  font-size:14px;display:flex;align-items:center;gap:6px;white-space:nowrap;}
.eo-tab:hover{background:var(--eo-bg-warm);color:var(--eo-dark-2);}
.eo-tab-active{background:linear-gradient(160deg,var(--eo-bg-busy),var(--eo-accent-soft));color:#4a3208;
.eo-tab:focus-visible,.eo-node:focus-visible,.eo-btn:focus-visible,
.eo-input:focus-visible,.eo-sel:focus-visible,.eo-close:focus-visible{
  outline:2px solid var(--eo-accent);outline-offset:2px;}
  font-weight:700;border-bottom:2px solid var(--eo-accent);margin-bottom:-1px;}
.eo-badge{background:var(--eo-accent);color:#fff;border-radius:9px;padding:0 6px;
  font-size:11px;line-height:16px;min-width:16px;text-align:center;font-weight:600;}
.eo-badge-err{background:var(--eo-danger);}
.eo-page{display:block;}

/* 折叠块 */
.eo-details{border:1px solid rgba(184,134,11,.32);border-radius:9px;
  background:var(--eo-bg-soft);margin:8px 0;padding:0 10px;}
.eo-details>summary{cursor:pointer;padding:9px 0;color:var(--eo-text-2);font-weight:600;
  font-size:13px;user-select:none;list-style:none;}
.eo-details>summary::-webkit-details-marker{display:none;}
.eo-details>summary::before{content:"▸ ";color:var(--eo-accent);}
.eo-details[open]>summary::before{content:"▾ ";}
.eo-details[open]>summary{border-bottom:1px dashed rgba(184,134,11,.3);margin-bottom:8px;}
/* 折叠块里的框：外面已经收了一层，可以放宽一点，但仍是有限值。
   2026-11-14 危晓要求核对小屏：原来写 70dvh，手机上一个参数组展开就吃掉大半个屏幕，
   框内滚动和页面滚动叠在一起，反而更难滑。现在按常见的窄屏可视高度重估：
   46dvh 大约留出上下各四分之一给标题和按钮，同时给 180px 下限防止横屏时框太矮。 */
.eo-details .eo-box{max-height:46dvh;min-height:180px;}
.eo-subsec{margin:12px 0 4px;color:#8a6a1e;font-weight:600;font-size:12px;}

/* 输入 */
.eo-input{padding:6px 10px;border-radius:8px;border:1px solid rgba(184,134,11,.45);
  background:var(--eo-bg);color:var(--eo-text);font-size:13px;flex:1;min-width:0;}
.eo-input:focus{outline:2px solid rgba(184,134,11,.28);outline-offset:0;}
.eo-textarea{width:100%;box-sizing:border-box;resize:vertical;line-height:1.6;
  font-family:inherit;margin-bottom:9px;}
/* 大纲原文编辑框：整份 YAML 直接改。
   底色和字色必须显式给——只挂 eo-textarea 不挂 eo-input 时是浏览器默认的深灰底白字，
   对着这份米黄界面像块补丁（2026-11-01 实测踩到）。等宽字是为了让缩进对齐看得出来。 */
.eo-outline-editor{
  background:var(--eo-bg);color:var(--eo-text);
  border:1px solid var(--eo-line);border-radius:9px;
  padding:10px 12px;margin-bottom:6px;
  font-family:ui-monospace,Consolas,"Courier New",monospace;
  font-size:12.5px;line-height:1.65;
  white-space:pre;overflow-y:auto;overflow-x:auto;max-height:58dvh;
  overscroll-behavior:contain;-webkit-overflow-scrolling:touch;tab-size:2;min-height:320px;
}
.eo-outline-editor:focus{outline:2px solid rgba(184,134,11,.28);outline-offset:0;
  border-color:rgba(184,134,11,.6);}
.eo-editor-stat{color:var(--eo-text-4);font-size:12px;margin:0 0 8px;}
.eo-editor-dirty{color:var(--eo-accent);font-weight:600;}

/* 节点行 */
.eo-node{padding:4px 6px;cursor:pointer;border-radius:6px;line-height:1.55;}
.eo-node:hover{background:var(--eo-bg-busy);}
.eo-node-on{color:var(--eo-ok);font-weight:600;}
.eo-node-suggest{color:#8a5a00;background:var(--eo-bg-warm);}
.eo-suggest{display:flex;align-items:center;gap:8px;padding:3px 4px;border-bottom:1px dashed #e6d7b0;}
.eo-suggest span{flex:1;}

/* 运行日志框：自己滚动，进来就停在最新一条（2026-11-14 危晓反馈：日志页排版不像样）
   上一版这两行写的是 max-height:none;overflow:visible —— 与这条注释正好相反，
   于是日志框跟着整页一起变长，靠外层的 .eo-body 滚，renderLogPage 里那几行
   scrollTop = scrollHeight 落在一个根本不会滚的元素上，全是空转。
   现在定死高度上限、自己滚，用的是 dvh 而不是 vh：手机浏览器地址栏收放时 vh 不会变，
   用 vh 会出现「框比可视区还高，底部被地址栏挡掉」。 */
.eo-logbox{max-height:52dvh;min-height:120px;overflow-y:auto;overflow-x:auto;
  overscroll-behavior:contain;-webkit-overflow-scrolling:touch;
  font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;
  white-space:pre-wrap;word-break:break-word;}

/* 日志级别筛选按钮 */
.eo-logfilter{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0 4px;}
.eo-filterbtn{padding:3px 10px;font-size:12px;}
.eo-filterbtn-on{background:var(--eo-accent-soft);color:var(--eo-dark);font-weight:700;}

/* 事件类型：次类型多选按钮 */
.eo-subtype-wrap{align-items:flex-start;}
.eo-subtypes{display:flex;flex-wrap:wrap;gap:5px;flex:1;}
.eo-subtype{padding:2px 9px;font-size:12px;line-height:1.5;}
.eo-subtype-on{background:var(--eo-accent-soft);color:var(--eo-dark);font-weight:700;border-color:#c9a13a;}

/* 事件参数：可折叠分组 + 大致/详细 */
.eo-prefgroup{margin:6px 0;border:1px solid #e8dbb3;border-radius:8px;background:var(--eo-bg);}
/* M16 事件链 */
.eo-chainmode{margin:6px 0 8px;}
.eo-chainbox{margin:8px 0;border:1px solid #d9c48a;border-radius:8px;background:#fdfaf0;padding:8px 10px;}
.eo-chainbox .eo-sec-title{font-weight:600;color:var(--eo-text-2);font-size:13px;margin-bottom:6px;}
.eo-chainlist{margin:6px 0;}
/* M16 链模式：每个节点一个折叠块 */
.eo-chainnodes{display:flex;flex-direction:column;gap:8px;margin:6px 0 10px;}
.eo-chainnode-box{margin:0;}
.eo-chainnode-prefs{padding:6px 0 0 6px;border-top:1px dashed #e0d3ae;margin-top:6px;}
.eo-chainnode-prefs .eo-sec{margin-top:8px;}
.eo-chainprefs{margin:4px 0 8px;padding:6px 8px;border:1px solid #e8dbb3;border-radius:8px;background:#fdfaf0;}
/* 2026-11-09 手机端显示修复（危晓：一眼看完文字，而不是只看得到开头几个字）。
   原来节点行是 display:flex 横排「编号 + 类型下拉 + 简介输入框」，
   手机宽度约 390px，减去编号 20px、下拉 96px、两处间距 12px，简介只剩 262px；
   再叠加 input 是单行框，长文本只能看到开头几个字。
   改成上下两行：第一行编号 + 类型，第二行简介独占整行、多行自适应。 */
.eo-chainnode{display:flex;flex-direction:column;gap:4px;margin:6px 0;}
.eo-chainnode .eo-chainnode-head{display:flex;gap:8px;align-items:center;}
.eo-chainnum{flex:0 0 20px;text-align:center;font-weight:600;color:var(--eo-text-2);font-size:12px;}
.eo-chainnode .eo-select{flex:0 0 auto;min-width:96px;max-width:50%;}
.eo-chaintype-txt{flex:0 0 auto;min-width:96px;max-width:50%;
  padding:4px 8px;border-radius:7px;border:1px solid rgba(184,134,11,.28);
  background:#f4ecd8;color:var(--eo-text-2);font-size:12px;text-align:center;}

.eo-chainnode .eo-input{min-width:0;width:100%;box-sizing:border-box;}
/* 多行自适应框：默认一行高，内容多了自动撑高（脚本里按 scrollHeight 调）。
   2026-11-09 修：原来写成 .eo-chainnode .eo-auto / .eo-chainnode-edge .eo-auto，

   只在链骨架预览那两个容器里生效。节点配置里的衔接条件框在 .eo-nodetrig 里，
   两个选择器都不匹配，于是它用的是浏览器原生 textarea 样式——
   灰底、浅灰字、右下角一个缩放斜线柄，跟面板完全不搭（危晓截图报的）。
   直接挂类名本身，以后不管塞进哪个容器都一样。 */
.eo-auto{
  width:100%;box-sizing:border-box;resize:vertical;
  font:inherit;font-size:13px;line-height:1.5;min-height:2.2em;
  padding:6px 10px;border-radius:8px;border:1px solid rgba(184,134,11,.45);
  background:#fffdf7;color:inherit;
  -webkit-appearance:none;appearance:none;
}
.eo-auto::placeholder{color:var(--eo-text-2);opacity:.55;}
.eo-auto:focus{outline:2px solid rgba(184,134,11,.28);outline-offset:0;}


.eo-chaintri{margin:6px 0;}
/* 2026-11-09：节点配置里的衔接条件区 */
.eo-nodetrig{margin:8px 0 4px;padding:6px 8px;border:1px solid #e8dbb3;border-radius:8px;background:#fdfaf0;}
.eo-nodetrig{margin:8px 0 4px;padding:6px 8px;border:1px solid #e8dbb3;border-radius:8px;background:#fdfaf0;}
/* 2026-11-14：整块改成可折叠，summary 去掉默认三角、换成和别处一致的样式 */
.eo-nodetrig>summary{cursor:pointer;font-size:12px;color:var(--eo-text-3);list-style:none;}
.eo-nodetrig>summary::-webkit-details-marker{display:none;}
.eo-nodetrig>summary::before{content:"▸ ";color:var(--eo-accent);}
.eo-nodetrig[open]>summary::before{content:"▾ ";}
.eo-nodetrig[open]>summary{margin-bottom:6px;color:var(--eo-text-2);}
.eo-nodetrig-list{margin:4px 0;}
.eo-nodetrig-row{margin:6px 0;padding-bottom:6px;border-bottom:1px dashed #e8dbb3;}
.eo-nodetrig-row:last-child{border-bottom:none;padding-bottom:0;}
/* 2026-11-09：衔接条件挪进节点内部，挂在节点行下面，左边缩进对齐编号 */
.eo-chainnode-edge{margin:2px 0 6px 26px;padding-left:8px;border-left:2px solid var(--eo-line);}

.eo-chaingen{margin:6px 0;padding-top:4px;border-top:1px dashed #e0d3ae;}
.eo-chainwait{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:99999;
  display:flex;align-items:center;justify-content:center;}
.eo-chainwait-box{background:#fffdf6;border:1px solid #d9c48a;border-radius:10px;
  padding:14px 18px;max-width:420px;display:flex;flex-direction:column;gap:8px;}
.eo-chainwait-box .eo-hint{line-height:1.5;}
.eo-prefgroup-sum{cursor:pointer;padding:7px 10px;font-weight:600;color:var(--eo-text-2);font-size:13px;
  list-style:none;user-select:none;}
.eo-prefgroup-sum::-webkit-details-marker{display:none;}
.eo-prefgroup-sum::before{content:'▸ ';color:var(--eo-accent);}
.eo-prefgroup[open] .eo-prefgroup-sum::before{content:'▾ ';}
.eo-prefgroup-body{padding:2px 10px 8px;}
/* 设置页可折叠节（2026-11-04）：难度档位、事件类型、参数自定义项都用它 */
.eo-setsec{margin:4px 0 10px;border:1px solid #e8dbb3;border-radius:8px;padding:0 10px 6px;}
.eo-setsec-sum{cursor:pointer;padding:8px 2px;font-weight:700;color:var(--eo-text-2);font-size:13px;
  list-style:none;user-select:none;display:flex;align-items:center;gap:8px;}
.eo-setsec-sum::-webkit-details-marker{display:none;}
.eo-setsec-sum::before{content:'▸ ';color:var(--eo-accent);}
.eo-setsec[open] .eo-setsec-sum::before{content:'▾ ';}
.eo-setsec-title{flex:0 0 auto;}
.eo-setsec-hint{font-weight:400;font-size:12px;}
/* 偏好项的自定义输入行：缩进一格，表示从属于上面那个下拉 */
.eo-customrow{padding-left:6px;}
.eo-prefopt-row{align-items:flex-start;}
.eo-prefmode{display:flex;align-items:center;gap:6px;padding:2px 0 6px;}
.eo-modebtn{padding:3px 12px;font-size:12px;}
.eo-modebtn-on{background:var(--eo-accent-soft);color:var(--eo-dark);font-weight:700;}

/* 记忆来源的子项（shujuku 诊断） */
.eo-sub{margin:2px 0 6px 18px;padding:6px 10px;border-left:3px solid #e6cd8a;background:var(--eo-bg);border-radius:0 6px 6px 0;}
.eo-sub-title{font-size:13px;font-weight:600;color:var(--eo-text-2);margin-bottom:2px;}

/* 打勾模式：标题上的问号 */
.eo-sec-inline{display:flex;align-items:center;gap:6px;}
.eo-help{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;
  border-radius:50%;border:1px solid var(--eo-accent);color:#8a6a10;font-size:11px;font-weight:700;
  cursor:pointer;user-select:none;position:relative;background:#fff8e2;}
.eo-help:hover{background:#f5e0a8;}
.eo-help-on{background:var(--eo-accent-soft);color:var(--eo-dark);}
.eo-tip{position:absolute;left:22px;top:-4px;width:260px;padding:8px 10px;border-radius:8px;
  background:#3a3222;color:var(--eo-bg-warm);font-size:12px;font-weight:400;line-height:1.6;
  box-shadow:0 3px 12px rgba(0,0,0,.28);z-index:10;white-space:normal;}
/* 偏好项里的问号在行内偏右，提示框改成从问号正下方向右展开，
   否则 260px 的框会顶出面板右缘 */
.eo-help-inline .eo-tip{left:-6px;top:20px;}
/* 重置按钮旁边的问号：按钮外侧留白，点它只弹说明，不会误触重置 */
.eo-reset-row{display:flex;align-items:center;gap:8px;}

/* 打勾模式：三档各占一行 */
.eo-modes{display:flex;flex-direction:column;gap:5px;margin:4px 0;}
.eo-mode{display:flex;gap:8px;align-items:flex-start;padding:5px 8px;border-radius:6px;
  background:#fdf8ec;font-size:12px;line-height:1.6;color:var(--eo-text-6);}
.eo-mode-tag{flex:0 0 auto;font-weight:700;color:#7a5a0a;}

`;
        document.head.appendChild(style);
    }

    // ---------- 悬浮窗几何：参照 Izumi「泉此方悬浮窗」edge-dock ----------

    const FAB_DOCK_THRESHOLD = 24;   // 与展开盒边缘的距离小于此值即吸附
    const FAB_SAFE_PADDING = 4;      // 可用区内边距
    const FAB_DRAG_SLOP = 5;         // 位移阈值，超过才算拖动

    function fabIsMobile() {
        return (Number(window.innerWidth) || 0) <= 768;
    }

    /** 视口可用范围（扣掉安全区内边距） */
    function fabUsableBounds(edgeFlush) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // 吸附时左右贴到 0，自由悬浮时留一点内边距避免贴死角
        const padX = edgeFlush ? 0 : FAB_SAFE_PADDING;
        const padY = FAB_SAFE_PADDING;
        return {
            left: padX,
            right: Math.max(padX, vw - padX),
            top: padY,
            bottom: Math.max(padY, vh - padY),
        };
    }

    /** 展开状态下的尺寸。测量前临时去掉吸附类，否则量到的是竖条 */
    function fabExpandedSize() {
        if (!S.fabEl) return { width: 44, height: 44 };
        const folded = S.fabEl.classList.contains('eo-collapsed');
        if (folded) S.fabEl.classList.remove('eo-collapsed');
        try {
            const w = S.fabEl.offsetWidth;
            const h = S.fabEl.offsetHeight;
            return {
                width: w > 0 ? w : 44,
                height: h > 0 ? h : 44,
            };
        } finally {
            if (folded) S.fabEl.classList.add('eo-collapsed');
        }
    }

    /** 吸附时的命中区域。手机上给可见竖条留出额外的触摸余量 */
    function fabHitSize() {
        if (fabIsMobile()) {
            return { width: FAB_TAB_VISIBLE + 10, height: FAB_TAB_HEIGHT + 8 };
        }
        return { width: FAB_EXPANDED, height: 44 };
    }

    /** 把坐标夹进可用区，尺寸按展开盒算 */
    function clampFabPos(x, y) {
        const b = fabUsableBounds();
        const size = fabExpandedSize();
        return {
            x: Math.min(Math.max(b.left, x), Math.max(b.left, b.right - size.width)),
            y: Math.min(Math.max(b.top, y), Math.max(b.top, b.bottom - size.height)),
        };
    }

    /** 用展开后的完整盒子判断贴哪边 */
    function detectDockSide(anchor) {
        const b = fabUsableBounds(true);
        const size = fabExpandedSize();
        const clamped = clampFabPos(anchor.x, anchor.y);
        const dLeft = Math.abs(clamped.x - b.left);
        const dRight = Math.abs(b.right - clamped.x - size.width);
        if (dLeft <= FAB_DOCK_THRESHOLD && dLeft <= dRight) return 'left';
        if (dRight <= FAB_DOCK_THRESHOLD) return 'right';
        return null;
    }

    /** 吸附态的实际落点 */
    function fabDockPosition(side, y) {
        const b = fabUsableBounds(true);
        const hit = fabHitSize();
        const width = Math.min(hit.width, Math.max(0, b.right - b.left));
        const height = Math.min(hit.height, Math.max(0, b.bottom - b.top));
        return {
            x: side === 'right' ? b.right - width : b.left,
            y: Math.min(Math.max(b.top, y), Math.max(b.top, b.bottom - height)),
            width,
            height,
        };
    }

    /**
     * 应用悬浮窗位置。
     * state: { anchor: {x,y}, dock: 'left'|'right'|null }
     */
    function applyFabState(state, initial) {
        if (!S.fabEl) return;
        const st = state || {};
        const dock = st.dock || null;
        const anchor = clampFabPos(
            (st.anchor && st.anchor.x != null) ? st.anchor.x : FAB_SAFE_PADDING + 10,
            (st.anchor && st.anchor.y != null) ? st.anchor.y : 40,
        );

        S.fabEl.classList.toggle('eo-collapsed', !!dock);
        S.fabEl.classList.toggle('eo-dock-left', dock === 'left');
        S.fabEl.classList.toggle('eo-dock-right', dock === 'right');
        S.fabEl.classList.remove('eo-hover');

        if (dock) {
            const d = fabDockPosition(dock, anchor.y);
            S.fabEl.style.width = d.width + 'px';
            S.fabEl.style.height = d.height + 'px';
            S.fabEl.style.left = Math.round(d.x) + 'px';
            S.fabEl.style.top = Math.round(d.y) + 'px';
        } else {
            S.fabEl.style.width = '';
            S.fabEl.style.height = '';
            S.fabEl.style.left = Math.round(anchor.x) + 'px';
            S.fabEl.style.top = Math.round(anchor.y) + 'px';
        }
        S.fabEl.style.right = 'auto';

        if (initial) {
            S.fabEl.style.transition = 'none';
            requestAnimationFrame(() => { if (S.fabEl) S.fabEl.style.transition = ''; });
        }
    }

    function loadFabState() {
        const s = getSettings();
        const saved = s.ui.floatingPos || {};
        S.fabState = {
            anchor: {
                x: saved.anchor && Number.isFinite(saved.anchor.x) ? saved.anchor.x : 14,
                y: saved.anchor && Number.isFinite(saved.anchor.y) ? saved.anchor.y : 40,
            },
            dock: saved.dock === 'left' || saved.dock === 'right' ? saved.dock : null,
        };
    }

    function saveFabState() {
        const s = getSettings();
        // 2026-11-10 修（原第 15 条）：这里原来是两个来源混用。
        // anchor 取自一个早已失效的别名（loadFabState 整个替换了 S.fabState，别名还指着旧对象），
        // 永远读到初始值 {x:14,y:40}，于是拖完悬浮球、刷新又回左上角；
        // dock 却取的是新对象，两者不同步，pointercancel 时还会瞬移。
        // 现在两个字段都从 S.fabState 就地读。
        s.ui.floatingPos = { anchor: { ...S.fabState.anchor }, dock: S.fabState.dock };
        saveSettings();
    }

    function ensureFab() {
        const s = getSettings();
        if (!s.ui.floatingEnabled) {
            if (S.fabEl) { S.fabEl.remove(); S.fabEl = null; }
            return;
        }
        if (S.fabEl) return;

        loadFabState();

        S.fabEl = document.createElement('div');
        S.fabEl.id = 'eo_fab';
        S.fabEl.setAttribute('role', 'button');
        S.fabEl.tabIndex = 0;
        S.fabEl.innerHTML = '<span class="eo-fab-label">事件</span>';
        S.fabEl.title = '事件大纲';
        document.body.appendChild(S.fabEl);

        bindFabGestures(S.fabEl);
        applyFabState(S.fabState, true);

        window.addEventListener('resize', () => {
            if (!S.fabEl) return;
            S.fabState.anchor = clampFabPos(S.fabState.anchor.x, S.fabState.anchor.y);
            applyFabState(S.fabState);
        });
    }

    /** 从吸附态恢复成自由悬浮 */
    function restoreFab() {
        S.fabState.dock = null;
        S.fabState.anchor = clampFabPos(S.fabState.anchor.x, S.fabState.anchor.y);
        applyFabState(S.fabState);
        saveFabState();
    }

    /** 收起并吸附到指定侧 */
    function dockFab(side) {
        S.fabState.dock = side;
        applyFabState(S.fabState);
        saveFabState();
        showDockHintOnce();
    }

    /**
     * 吸附后球只剩一条竖条，不知道怎么恢复是第一次用最容易卡住的地方（2026-11-02）。
     * 提示只给一次，看过就记进设置，别每次都来打扰。
     */
    function showDockHintOnce() {
        const s = getSettings();
        if (s.ui.dockHintShown) return;
        s.ui.dockHintShown = true;
        saveSettings();
        toast('球已收进边缘，轻点一下就展开；拖出来就恢复悬浮', { ms: 6000 });
    }

    function activateFab() {
        if (S.fabState.dock) {
            // 吸附状态：只恢复，不打开面板
            restoreFab();
            return;
        }
        togglePanel(true);
    }

    /**
     * 手势绑定。参照 Izumi 的实现：
     * - 全程使用 Pointer Events，setPointerCapture 保证滑出元素也不断
     * - 位移 < 5px 视为点击，否则视为拖动
     * - 桌面端 pointerdown 时 preventDefault，移动端不阻止（避免影响滚动与合成事件）
     * - 点击统一由 pointerup 判定，原生 click 一律忽略
     */
    function bindFabGestures(el) {
        let gesture = null;
        let suppressClickUntil = 0;

        const finish = (cancelled) => {
            if (!gesture) return;
            const g = gesture;
            gesture = null;

            try { el.releasePointerCapture(g.id); } catch (e) { /* 忽略 */ }

            if (cancelled) {
                S.fabState.anchor = clampFabPos(g.anchor.x, g.anchor.y);
                S.fabState.dock = g.dock;
                applyFabState(S.fabState);
                suppressClickUntil = Date.now() + 320;
                return;
            }

            if (g.moved) {
                suppressClickUntil = Date.now() + 320;
                const side = detectDockSide(S.fabState.anchor);
                if (side) dockFab(side);
                else { S.fabState.dock = null; applyFabState(S.fabState); saveFabState(); }
                return;
            }

            // 轻点
            suppressClickUntil = Date.now() + 320;
            activateFab();
        };

        el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
        el.addEventListener('dragstart', (e) => e.preventDefault());

        el.addEventListener('pointerdown', (e) => {
            if (gesture) {
                if (e.pointerId !== gesture.id) finish(true);
                return;
            }
            if (e.button !== 0 || e.isPrimary === false) return;
            if (suppressClickUntil && Date.now() < suppressClickUntil) {
                suppressClickUntil = 0;
            }

            const mobile = fabIsMobile();
            if (!mobile) e.preventDefault();
            e.stopPropagation();

            const rect = el.getBoundingClientRect();
            gesture = {
                id: e.pointerId,
                moved: false,
                startX: e.clientX,
                startY: e.clientY,
                offsetX: e.clientX - (S.fabState.dock ? rect.left : S.fabState.anchor.x),
                offsetY: e.clientY - (S.fabState.dock ? rect.top : S.fabState.anchor.y),
                anchor: { ...S.fabState.anchor },
                dock: S.fabState.dock,
            };

            // 从吸附态按下：立即展开为完整图标
            if (S.fabState.dock) {
                gesture.offsetX = e.clientX - rect.left;
                gesture.offsetY = e.clientY - rect.top;
            }

            try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        });

        el.addEventListener('pointermove', (e) => {
            if (!gesture || e.pointerId !== gesture.id) return;
            if (!gesture.moved) {
                if (Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) < FAB_DRAG_SLOP) return;
                gesture.moved = true;
                // 一旦开始拖，解除吸附，切到完整图标
                S.fabState.dock = null;
                el.classList.remove('eo-collapsed', 'eo-hover');
                el.classList.add('eo-dragging');
                el.style.width = '';
                el.style.height = '';
                el.style.transition = 'none';
            }
            if (e.cancelable) e.preventDefault();
            const p = clampFabPos(e.clientX - gesture.offsetX, e.clientY - gesture.offsetY);
            S.fabState.anchor = p;
            el.style.left = Math.round(p.x) + 'px';
            el.style.top = Math.round(p.y) + 'px';
            el.style.right = 'auto';
        });

        el.addEventListener('pointerup', (e) => {
            if (gesture && e.pointerId === gesture.id) {
                el.classList.remove('eo-dragging');
                el.style.transition = '';
                finish(false);
            }
        });

        for (const type of ['pointercancel', 'lostpointercapture']) {
            el.addEventListener(type, (e) => {
                if (gesture && e.pointerId === gesture.id) {
                    el.classList.remove('eo-dragging');
                    el.style.transition = '';
                    finish(true);
                }
            });
        }

        el.addEventListener('pointerenter', () => {
            if (!gesture && S.fabState.dock) el.classList.add('eo-hover');
        });
        el.addEventListener('pointerleave', () => {
            el.classList.remove('eo-hover');
        });

        // 原生 click 一律忽略：轻点已由 pointerup 处理
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
        }, true);

        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activateFab();
            }
        });
    }

    function ensurePanel() {
        if (S.panelEl) return S.panelEl;

        S.backdropEl = document.createElement('div');
        S.backdropEl.id = 'eo_backdrop';
        document.body.appendChild(S.backdropEl);

        S.panelEl = document.createElement('div');
        S.panelEl.id = 'eo_panel';
        S.panelEl.innerHTML = `
<div class="eo-head" id="eo_panel_head">
  <span class="eo-title">事件大纲</span>
  <span class="eo-hint" id="eo_ver">v${VERSION}</span>
  <span class="eo-close" id="eo_close">✕ 关闭</span>
</div>
<div class="eo-busy" id="eo_busy">处理中…</div>
<div class="eo-confirmbar" id="eo_confirmbar">
  <span class="eo-confirm-text" id="eo_confirm_text"></span>
  <button type="button" class="eo-btn eo-btn-danger" id="eo_confirm_ok">确定</button>
  <button type="button" class="eo-btn" id="eo_confirm_cancel">取消</button>
</div>
<div class="eo-body" id="eo_body"></div>
<div class="eo-toasts" id="eo_toasts"></div>`;
        document.body.appendChild(S.panelEl);
        S.panelEl.querySelector('#eo_close').addEventListener('click', () => togglePanel(false));
        S.backdropEl.addEventListener('click', () => togglePanel(false));

        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && S.panelEl && S.panelEl.classList.contains('eo-open')) {
                togglePanel(false);
            }
        });
        return S.panelEl;
    }

    function togglePanel(force) {
        const p = ensurePanel();
        if (!S.backdropEl) ensurePanel();
        const open = force === undefined ? !p.classList.contains('eo-open') : force;
        p.classList.toggle('eo-open', open);
        if (S.backdropEl) S.backdropEl.classList.toggle('eo-open', open);
        // 2026-11-02 删掉这里原本的 document.body.style.overflow 写入（评审 7.3 附带项，危晓裁决 B）。
        // 酒馆 1.19 的 public/style.css 给 body 写了 overflow:hidden，遮罩 #eo_backdrop 又盖满视口吞掉点击与滚动，
        // 这行写成 hidden 等于没写，关面板写空串却会往别人共用的全局 body 样式里留下东西。
        // 4.1：面板和悬浮球同 z-index，球会盖在面板内容上。面板开着就把球藏起来
        if (S.fabEl) S.fabEl.style.visibility = open ? 'hidden' : '';
        if (open) {
            renderPanel();
            // 每次打开面板顺手校正一次条目位置，世界书被重排过也能自动纠正
            healEntryUids().then(n => { if (n) renderPanel(); })
                .catch(e => warn('校正条目位置失败', e));
        }
    }

