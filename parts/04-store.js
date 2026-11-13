    // ==================== 3. 存储 ====================

    function getSettings() {
        const context = ctx();
        if (!context) return structuredClone(DEFAULT_SETTINGS);
        if (!context.extensionSettings[MODULE]) {
            context.extensionSettings[MODULE] = structuredClone(DEFAULT_SETTINGS);
        }
        const s = context.extensionSettings[MODULE];
        // 补默认值（升级时新字段缺失）
        s.apiProfiles = s.apiProfiles || structuredClone(DEFAULT_SETTINGS.apiProfiles);
        // 至少保住「跟随酒馆主连接」这一档，否则选不到任何配置
        if (!Array.isArray(s.apiProfiles) || !s.apiProfiles.length) {
            s.apiProfiles = structuredClone(DEFAULT_SETTINGS.apiProfiles);
        }
        if (!s.apiProfiles.some(p => p && p.id === 'main')) {
            s.apiProfiles.unshift(structuredClone(DEFAULT_SETTINGS.apiProfiles[0]));
        }
        // 「用酒馆里的连接」这一档已取消（2026-11-02）：留着它也选不出正确的连接源，
        // 所以旧配置直接删掉，只写一条日志说明，不静默处理
        const deadProfiles = s.apiProfiles.filter(p => p && p.mode === 'tavern');
        if (deadProfiles.length) {
            s.apiProfiles = s.apiProfiles.filter(p => !p || p.mode !== 'tavern');
            log('已移除 ' + deadProfiles.length + ' 个「用酒馆里的连接」旧配置（'
                + deadProfiles.map(p => p.name || p.id).join('、') + '），该方式已取消');
        }
        if (!s.activeProfileId || !s.apiProfiles.some(p => p && p.id === s.activeProfileId)) {
            s.activeProfileId = 'main';
        }
        s.ui = Object.assign(structuredClone(DEFAULT_SETTINGS.ui), s.ui || {});
        s.tracker = Object.assign({}, DEFAULT_SETTINGS.tracker, s.tracker || {});
        s.retention = Object.assign({}, DEFAULT_SETTINGS.retention, s.retention || {});
        s.memory = Object.assign({}, DEFAULT_SETTINGS.memory, s.memory || {});
        // 后加的两组也要补：老对话的设置里没有这两项，
        // 不补的话 s.worldbook 是 undefined，下面直接读 .maxChars 会抛异常
        s.worldbook = Object.assign({}, DEFAULT_SETTINGS.worldbook, s.worldbook || {});
        s.preset = Object.assign({}, DEFAULT_SETTINGS.preset, s.preset || {});
        return s;
    }

    function saveSettings() {
        const context = ctx();
        if (context && context.saveSettingsDebounced) context.saveSettingsDebounced();
    }

    function getMeta() {
        const context = ctx();
        if (!context) return null;
        // 2026-11-10 修（评审原第 19 条）：存档里的这一块是外部数据，可能被手工改坏或来自老版本，
        // 原来是「没有就建」，但存着 null、字符串、数组时会把那个值原样返回，
        // 调用方接着 `.events` 就抛「Cannot read properties of null」——整个面板直接崩。
        // 这里只认对象，别的类型一律重建。
        const holder = context.chatMetadata;
        if (!holder || typeof holder !== 'object') return null;
        let m = holder[MODULE];
        if (!m || typeof m !== 'object' || Array.isArray(m)) m = { version: 1, currentEventId: null, events: {} };
        holder[MODULE] = m;
        if (!m.events || typeof m.events !== 'object' || Array.isArray(m.events)) m.events = {};
        return m;
    }
    function saveMeta() {
        const context = ctx();
        if (context && context.saveMetadataDebounced) context.saveMetadataDebounced();
    }

    /**
     * 链骨架的存取（2026-11-10 危晓要）。
     *
     * 原来骨架只放在 S.chainDraft 这个内存变量里，刷新页面就没了，
     * 用户在预览里改过的时间压力、基调、节点名也跟着丢，得重新生成一次才能接着做。
     * 现在落到 chatMetadata 里，跟事件存档同一个地方——这样它天然跟着对话走，
     * 换角色卡不会串到别人身上。
     *
     * 只存「当前这一个」骨架：再次生成会覆盖，不保留历史。链本身有几个节点、
     * 节点事件生成到第几个（generated）也一并存，刷新回来能接着往下做。
     */
    function saveChainDraft(d) {
        const m = getMeta();
        if (!m) return;
        if (!d || !d.chain) { delete m.chainDraft; saveMeta(); return; }
        // running / 进度这类运行态不存，刷新回来一律当成没在跑
        m.chainDraft = {
            chain: d.chain,
            problems: Array.isArray(d.problems) ? d.problems : [],
            raw: String(d.raw || ''),
            chainId: d.chainId || ('chain_' + Date.now().toString(36)),
            generated: Array.isArray(d.generated) ? d.generated.map(x => ({
                id: x && x.id, pos: x && x.pos,
            })) : [],
            savedAt: new Date().toISOString(),
        };
        saveMeta();
    }

    /** 读回存着的链骨架；没有就返回 null */
    function loadChainDraft() {
        const m = getMeta();
        const saved = m && m.chainDraft;
        if (!saved || !saved.chain) return null;
        return {
            chain: saved.chain,
            problems: Array.isArray(saved.problems) ? saved.problems : [],
            raw: String(saved.raw || ''),
            rawOpen: false,
            chainId: saved.chainId || ('chain_' + Date.now().toString(36)),
            // generated 里存的只有 id/pos，用的时候按 id 回查事件对象
            generated: Array.isArray(saved.generated) ? saved.generated : [],
            running: false,
            cur: 0,
        };
    }

    /** 丢掉存着的链骨架 */
    function clearChainDraft() {
        const m = getMeta();
        if (!m) return;
        delete m.chainDraft;
        saveMeta();
    }


    function listEvents() {
        const m = getMeta();
        if (!m) return [];
        return Object.values(m.events).map(healOutline).sort((a, b) =>
            String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }

    function getCurrentEvent() {
        const m = getMeta();
        if (!m || !m.currentEventId) return null;
        return healOutline(m.events[m.currentEventId] || null);
    }

    /**
     * 修复旧事件卡：早期版本的 YAML 解析器不认识 `key: |` 块标量，
     * 解析结果只剩几个标量键，nodes / characters / paths 全丢。
     * 原始输出一直完整保存着，这里发现结构不完整就重新解析一次。
     */
    function healOutline(event) {
        if (!event) return event;
        // 旧事件卡的偏好字段（commissionLevel 等）迁移到新结构
        if (event.prefs) normalizePrefs(event.prefs);
        // 质量判定规则变了（例如模型的节点正文键名是 points_to 而旧规则只认 info），
        // 旧结论可能已经不成立，按当前规则重判一次，避免红色警示一直挂着
        if (event.outline) event.parseQuality = checkOutlineQuality(event.outline);
        if (!event.outlineRaw) return event;
        const o = event.outline || {};
        // 2026-11-05 M2 评审：M2 之后 nodes 在 structure 里，还按顶层读会恒判「坏了」。
        //
        // 2026-11-10 修（评审 P1-10）：原来只认 nodes，战斗、探险这些本来就没有 nodes 的类型
        // 每次加载都被判「坏了」，白跑一遍重解析，重解析读出来的当然还是没有 nodes，于是下次继续重跑。
        // 现在按这个类型自己的 spec 判：它要求的那些内层键里，只要有一个真的解析出了东西，
        // 就算这卡没坏。类型认不出来时退回看有没有任何内层键，别一律判坏。
        const looksBroken = (() => {
            const mainType = String((o.event_type && o.event_type.primary)
                || event.mainType || '').trim();
            const spec = innerKeysOf(mainType);
            const keys = spec.known && spec.required.length ? spec.required : null;
            const inner = outlineInner(o) || {};
            if (keys) {
                return keys.every((k) => {
                    const v = inner[k];
                    if (v === undefined || v === null) return true;
                    if (Array.isArray(v)) return v.length === 0;
                    if (typeof v === 'string') return v.trim() === '';
                    if (typeof v === 'object') return Object.keys(v).length === 0;
                    return false;
                });
            }
            // 类型认不出来：只要有任何一个内层键解析出了内容，就当它没坏
            const anyFilled = Object.keys(inner).some((k) => {
                const v = inner[k];
                if (v === undefined || v === null) return false;
                if (Array.isArray(v)) return v.length > 0;
                if (typeof v === 'string') return v.trim() !== '';
                if (typeof v === 'object') return Object.keys(v).length > 0;
                return true;
            });
            return !anyFilled;
        })();
        if (!looksBroken) return event;
        try {
            const re = parseOutline(event.outlineRaw).parsed;
            const n = innerNodesOf(re).length;
            if (n > 0) {
                event.outline = re;
                event.parseQuality = checkOutlineQuality(re);
                log(`事件「${event.name}」的大纲已按新解析器重建：${n} 个信息节点`);
            }
        } catch (e) {
            warn(`事件「${event.name}」的大纲重建失败：${e && e.message || e}`);
        }
        return event;
    }

