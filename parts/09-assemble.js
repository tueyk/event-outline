    // ==================== 8. 上下文拼装 ====================

    function getChatMessages() {
        const context = ctx();
        const chat = (context && context.chat) || [];
        return chat.filter(m => m && !m.is_system && String(m.mes || '').trim());
    }

    /** 楼层总数（玩家楼 + AI 楼，不含系统消息），用于自动盘点的计数 */
    /**
     * 按当前模式统计楼层数（2026-11-04 危晓定：口径一）。
     * 非转述模式下用户楼也在推进剧情，玩家楼与 AI 楼合计；
     * 转述模式下用户楼只是给 AI 的指令、内容会在 AI 楼里重述一遍，所以只数 AI 楼。
     * 这个函数既用于「最近楼层」，也用于自动盘点的间隔判断，两边必须是同一个口径，
     * 否则会出现「读 8 层剧情，却按 6 条消息触发盘点」这种对不上的情况。
     */
    function countFloors() {
        const msgs = getChatMessages();
        // 读设置失败时按非转述处理：宁可多算一层，也不要因为异常把楼层数成 0。
        // 注意 getSettings() 本身也要包在 try 里——它抛的话整段函数就断了，
        // 只包住读属性那一步接不住
        let narration = false;
        try {
            const s = getSettings();
            narration = !!(s && s.memory && s.memory.narrationMode);
        } catch (e) {
            narration = false;
        }
        if (!narration) return msgs.length;
        return msgs.filter(m => !m.is_user).length;
    }

    /**
     * 自动盘点是否该跑：自上次盘点以来新积累的楼层数达到设置值就返回。
     * autoEveryFloors = 0 关闭自动盘点；没有进行中事件时不跑。
     *
     * 楼层口径跟着转述模式走（2026-11-04 危晓定）：非转述时玩家楼也在推进剧情，
     * 玩家楼 + AI 楼合计；转述时用户楼只是指令、内容会在 AI 楼里重述，所以只数 AI 楼。
     * 因为口径会变，基线必须连着「当时是哪种口径」一起记：
     * 用户切了模式，旧基线就作废，按新口径在当前位置重挂一次，从这一刻重新累计。
     * 不这么做的话，一开转述，计数从「全部楼」掉成「只数 AI」，since 会突然变负；
     * 关掉转述又会让攒了很久的差额一次性冒出来，直接把盘点触发掉。
     */
    function shouldAutoInventory() {
        const s = getSettings();
        if (s.tracker.mode !== 'auto') return false;
        const every = Math.max(0, Number(s.tracker.autoEveryFloors) || 0);
        if (every <= 0) return false;
        const ev = getCurrentEvent();
        if (!ev || ev.status !== 'active') return false;
        const cur = countFloors();
        const narrationNow = !!(s.memory && s.memory.narrationMode);
        // 老事件没有 floorBase：以当前楼层为基线，从现在开始累计
        if (!Number.isFinite(Number(ev.floorBase))) {
            ev.floorBase = cur;
            ev.floorBaseNarration = narrationNow;
            saveMeta();
            return false;
        }
        // 模式换了，旧基线是按另一种口径量的，现在重挂
        if (!!ev.floorBaseNarration !== narrationNow) {
            ev.floorBase = cur;
            ev.floorBaseNarration = narrationNow;
            saveMeta();
            log(`转述模式${narrationNow ? '开启' : '关闭'}，自动盘点基线按新口径重挂到第 ${cur} 层`);
            return false;
        }
        const since = cur - Number(ev.floorBase);
        if (since < every) return false;
        return { cur, since, every };
    }

    /**
     * 收集最近楼层。
     * 转述模式（2026-11-04）：开着时只取 AI 楼。有些卡的玩家楼只是给 AI 的指令，
     * AI 楼会把内容转述一遍，两边都读等于同一段剧情读两遍，
     * 既浪费 token，又可能让模型把一件事当成发生了两次。
     * 上限按「实际取到的楼数」算，不是按扫过的消息数——转述模式下用户楼被跳过，要一直往前够到够数为止。
     */
    async function collectRecentFloors(limit) {
        const s = getSettings();
        const narration = !!(s.memory && s.memory.narrationMode);
        const msgs = getChatMessages();
        const out = [];
        for (let i = msgs.length - 1; i >= 0 && out.length < limit; i--) {
            const m = msgs[i];
            if (narration && m.is_user) continue;
            const name = m.name || (m.is_user ? '玩家' : '角色');
            out.unshift(`${name}：\n${String(m.mes || '').trim()}`);
        }
        return out.join('\n\n');
    }

    /** 生成事件状态卡文本 */
    function buildStateCard(event) {
        if (!event) return '';
        const lines = [];
        lines.push(`事件：${event.name}（${event.status === 'active' ? '进行中' : event.status}）`);

        // 内层取值（2026-11-05 M1；M2 评审后收成公共函数）：
        // 内层字段只从 structure 下面取，不回落顶层。老事件的扁平形状读不出来，这是既定口径。
        const outlineOf = event.outline || {};
        const inner = k => innerField(outlineOf, k);

        // 主类型：新事件写在 event_type.primary，老事件可能没有
        const typeNode = outlineOf.event_type;
        const mainType = (typeNode && typeof typeNode === 'object')
            ? String(typeNode.primary || '').trim() : '';
        if (mainType) {
            const subs = (typeNode && Array.isArray(typeNode.secondary)) ? typeNode.secondary : [];
            lines.push(`类型：${mainType}${subs.length ? '（次类型：' + subs.join('、') + '）' : ''}`);
        }

        // 委托关系（2026-11-05 M1 新增，定稿 §4 contract）：可选，有才写
        // 2026-11-09 M14.5 真机：这段原来只认 client/request/reward/acceptance/breach/subcontract
        // 六个子键。NSFW 骨架里 contract 写的是 scope（范围）/ authority（支配关系），
        // 两个都不在名单里，整块被静默丢掉——界面上看不出「漏了」，因为连标题都没有。
        // 现在按下表统一取，表外的子键也兜住（用 keyText 出中文名），不再静默吞。
        const CONTRACT_FIELDS = [
            ['client', '委托人'],
            ['request', '诉求'],
            ['reward', '报酬'],
            ['acceptance', '验收'],
            ['breach', '违约'],
            ['subcontract', '转包'],
            ['scope', '范围'],
            ['authority', '支配关系'],
            ['reveal', '揭示条件'],
        ];
        const contract = outlineOf.contract;
        if (contract && typeof contract === 'object') {
            const parts = [];
            const taken = new Set();
            for (const [k, label] of CONTRACT_FIELDS) {
                taken.add(k);
                const v = contract[k];
                if (isBlankValue(v)) continue;
                parts.push(`${label}：${scalarText(v)}`);
            }
            // 表里没有的键也别吞掉，出个中文名放后面
            for (const [k, v] of Object.entries(contract)) {
                if (taken.has(k) || isBlankValue(v)) continue;
                parts.push(`${keyText(k)}：${scalarText(v)}`);
            }
            if (parts.length) lines.push(`委托：${parts.join('；')}`);
        }

        const coreTruth = inner('core_truth');
        if (coreTruth) {
            lines.push(`核心真相：〔禁止透露〕${coreTruth}`);
        }
        const nodes = Array.isArray(inner('nodes')) ? inner('nodes') : [];
        if (nodes.length) {
            const triggered = new Set(event.tracker && event.tracker.triggeredNodes || []);
            lines.push('节点清单：');
            for (const n of nodes) {
                const id = nodeId(n);
                const mark = triggered.has(Number(id)) ? '已触发' : '未触发';
                lines.push(` ${id}. ${n.type || ''}${nodeText(n)} —— ${mark}`
                    + (nodeTrigger(n) ? `（触发词：${nodeTrigger(n)}）` : ''));
            }
        }
        if (inner('min_nodes_for_deduction')) {
            lines.push(`推理所需最少节点：${JSON.stringify(inner('min_nodes_for_deduction'))}`);
        }
        // 战斗目标与阶段（2026-11-06 M4 待补项）
        // 原来状态卡只写节点清单，战斗事件里模型拿不到「打到第几个目标了」，
        // 多段事件也拿不到「演到第几段」。这两个都是盘点时最该知道的东西。
        const doneProg = new Set((event.tracker && event.tracker.progress) || []);
        const objs = inner('objectives');
        if (Array.isArray(objs) && objs.length) {
            lines.push('战斗目标：');
            objs.forEach((x, i) => {
                const name = (x && typeof x === 'object')
                    ? String(x.name || x['名称'] || '').trim() || `目标 ${i + 1}`
                    : String(x || '').trim() || `目标 ${i + 1}`;
                const cond = (x && typeof x === 'object') ? String(x.condition || '').trim() : '';
                // 失败后果也要给模型看（2026-11-06 真机）：只有达成条件时，
                // 模型分不清「还没做到」和「已经失败」，盘点会把失败报成进度为零。
                const fail = (x && typeof x === 'object') ? String(x.fail || '').trim() : '';
                const mark = doneProg.has('obj:' + i) ? '已达成' : '未达成';
                const tail = [cond ? `达成条件：${cond}` : '', fail ? `失败后果：${fail}` : '']
                    .filter(Boolean).join('；');
                lines.push(` ${i + 1}. ${name} —— ${mark}${tail ? `（${tail}）` : ''}`);
            });
        }
        const stagesCard = inner('phases');
        if (Array.isArray(stagesCard) && stagesCard.length) {
            const curIdx = stagesCard.findIndex((_, i) => !doneProg.has('stage:' + i));
            lines.push(`阶段（共 ${stagesCard.length} 段，当前演到第 ${curIdx < 0 ? stagesCard.length : curIdx + 1} 段）：`);
            stagesCard.forEach((st, i) => {
                const goal = (st && typeof st === 'object')
                    ? String(st.goal || st['目标'] || '').trim() || `第 ${i + 1} 段`
                    : String(st || '').trim() || `第 ${i + 1} 段`;
                const exit = (st && typeof st === 'object') ? String(st.exit || '').trim() : '';
                const mark = doneProg.has('stage:' + i) ? '已走完' : '未走完';
                lines.push(` ${i + 1}. ${goal} —— ${mark}${exit ? `（退场条件：${exit}）` : ''}`);
            });
        }
        const refuted = (event.tracker && event.tracker.refutedMisleads) || [];
        if (refuted.length) lines.push(`已推翻误导：${refuted.join('、')}`);
        const offPath = (event.tracker && event.tracker.offPathBranches) || [];
        if (offPath.length) {
            lines.push('大纲外新路径：' + offPath.map(o => `【大纲外】${o.desc}（${o.reason}）`).join('；'));
        }
        const vetoed = (event.tracker && event.tracker.nodeVetoed) || [];
        if (vetoed.length) lines.push(`人工否决节点（不要再判为已触发）：${vetoed.join('、')}`);
        return lines.join('\n');
    }

    /** 收集上下文三个部分 */
    async function gatherContext(event) {
        const s = getSettings();
        const resolved = resolveAdapter();
        debug(`拼装上下文：适配器=${resolved.adapter.id}，降级=${!!resolved.degraded}`);
        const out = {
            stateCard: buildStateCard(event),
            worldBook: '',
            jiyaoList: '',
            jiyaoDetail: '',
            recentChat: '',
            adapterId: resolved.adapter.id,
        };

        // 第一层半：角色世界书的常驻设定（蓝灯）。generateRaw 不自动带世界书，必须自己拼
        step('读取角色世界书');
        try {
            const wb = await loadWorldBookContext();
            if (wb) {
                out.worldBook = wb.text;
                step(`世界书已载入：${wb.kept} 条常驻设定，${wb.used} 字`);
            } else {
                step('世界书：未启用或没有可用条目');
            }
        } catch (e) {
            warn('世界书带入失败，本次不带设定', e);
            step('世界书读取失败，已跳过');
        }

        // 第二层：记忆召回
        if (resolved.adapter.id === 'shujuku-jiyao' && resolved.adapter.rows) {
            step('读取 shujuku 纪要');
            try {
                const rows = resolved.adapter.rows();
                const mode = resolved.adapter.mode ? resolved.adapter.mode() : null;
                const recentRows = Math.max(1, Number(s.memory.jiyaoRecentRows) || 30);

                if (mode === 'llm' && rows.length > recentRows) {
                    // 点名模式：先给概览清单
                    const head = rows.slice(0, Math.max(1, Number(s.memory.jiyaoOverviewMax) || 60));
                    out.jiyaoList = head.map(r => `${r.code}｜${r.span}｜${r.summary}`).join('\n');
                    out.jiyaoDetail = '';
                    log(`纪要召回：LLM 模式，共 ${rows.length} 条，带入前 ${head.length} 条概览供点名`);
                } else {
                    // 固定窗口：直接给最近 N 条正文
                    const tail = rows.slice(-recentRows);
                    out.jiyaoList = '';
                    out.jiyaoDetail = tail.map(r => `${r.code}｜${r.span}\n${r.text}`).join('\n\n');
                    log(`纪要召回：${MODE_LABEL[mode] || mode || '未知'}模式，共 ${rows.length} 条，带入最近 ${tail.length} 条正文`);
                }
            } catch (e) {
                warn('纪要读取失败，降级为纯楼层', e);
                step('纪要读取失败，已降级为纯楼层');
            }
        }

        // 第三层：最近楼层
        // 读楼也走同一套规整：手改过设置文件、存了个 0 或 9999，这里也要收在 1..100
        const floors = clampFloors(s.memory.recentFloors);
        const narration = !!(s.memory && s.memory.narrationMode);
        step(narration ? `读取最近 ${floors} 楼（转述模式，只取 AI 楼）` : `读取最近 ${floors} 楼`);
        out.recentChat = await collectRecentFloors(floors);
        step(`最近剧情已载入：${out.recentChat.length} 字`);
        if (!out.recentChat.length) {
            error('上下文的最近楼层是空的，模型将只能凭世界书和纪要发挥；请确认当前对话有内容');
        }

        // 汇总一行，一眼看清这次到底喂了什么
        const total = out.worldBook.length + out.stateCard.length
            + out.jiyaoList.length + out.jiyaoDetail.length + out.recentChat.length;
        log(`上下文汇总：世界书 ${out.worldBook.length} 字、事件卡 ${out.stateCard.length} 字、`
            + `纪要概览 ${out.jiyaoList.length} 字、纪要正文 ${out.jiyaoDetail.length} 字、`
            + `最近楼层 ${floors} 楼${narration ? '（转述模式，只取 AI 楼）' : ''}共 ${out.recentChat.length} 字，合计 ${total} 字`);
        if (total < 500) {
            warn(`上下文总量只有 ${total} 字，模型可参考的信息很少，生成结果可能凭空发挥`);
        }
        return out;
    }

