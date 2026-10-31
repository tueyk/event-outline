/* 事件大纲 / 状态盘点 扩展
 * 单文件，按分区组织。无构建步骤，不使用 import。
 * 分区：0 常量 1 上下文 2 存储 3 世界书 4 适配器 5 界面 6 设置 7 入口
 */
(function () {
    'use strict';

    const MODULE = 'event_outline';
    const VERSION = '0.1.1';
    const ENTRY_PREFIX = '▸事件｜';
    const LOG_PREFIX = '[事件大纲]';

    // ==================== 0. 常量 ====================

    const DEFAULT_SETTINGS = {
        version: 1,
        // 打开后 debug 级日志才会被收集（默认关，避免刷屏）
        debug: false,
        // 模型 API 配置档。三种 mode：
        //   main   = 跟随酒馆主连接（generateRaw 不带 api 参数）
        //   tavern = 走酒馆已配好的连接源，可指定连接源类型与模型名
        //   direct = 扩展自己直连 OpenAI 兼容接口，自带 base URL / 密钥 / 模型
        apiProfiles: [
            { id: 'main', name: '跟随酒馆主连接', mode: 'main' },
        ],
        activeProfileId: 'main',
        ui: {
            floatingEnabled: true,
            floatingPos: { anchor: { x: 4, y: 40 }, dock: 'left' },
        },
        tracker: {
            mode: 'auto',
            // 自动模式下，每积累多少层楼（玩家楼 + AI 楼）触发一次自动盘点；0 = 关闭
            autoEveryFloors: 10,
        },
        retention: { completed: 20, abandoned: 3 },
        memory: {
            source: 'auto',
            recentFloors: 15,
            jiyaoOverviewMax: 60,
            jiyaoRecentRows: 30,
        },
        worldbook: {
            // 是否把角色世界书的常驻条目（蓝灯）拼进生成上下文
            enabled: true,
            // 字数上限，超出按 order 顺序截断；0 = 不限
            maxChars: 30000,
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

    // 悬浮窗尺寸（吸附竖条与展开图标）
    const FAB_TAB_VISIBLE = 20;   // 吸附时可见宽度
    const FAB_TAB_HEIGHT = 44;    // 吸附时高度，与展开图标边长一致
    const FAB_EXPANDED = 44;      // 展开时边长
    const CHRONICLE_NAME = '纪要表';

    // ==================== 1. 上下文 ====================

    function ctx() {
        return window.SillyTavern && window.SillyTavern.getContext
            ? window.SillyTavern.getContext()
            : null;
    }

    /**
     * 扩展运行日志（内存环形缓冲，不落盘，刷新页面即清空）。
     * 只记录本扩展自己的动作：挂载、读写世界书、适配器判定、生成与解析、
     * 打勾变更、错误。不记录聊天内容本身，避免把剧情抄进日志。
     */
    const RUNTIME_LOG_MAX = 500;
    const runtimeLog = [];
    // 未读错误数：日志页标签上挂红点用，点进日志页就清零
    let unreadErrors = 0;

    // 日志级别：info / warn / error 默认都收；debug 只在设置里打开开关后才收
    const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
    const LOG_LEVEL_LABEL = { debug: '调试', info: '信息', warn: '警告', error: '错误' };

    function debugEnabled() {
        try {
            const s = getSettings();
            return !!(s && s.debug);
        } catch (e) {
            return false;
        }
    }

    function pushRuntimeLog(level, args) {
        if (level === 'debug' && !debugEnabled()) return;
        let text;
        try {
            text = args.map(a => {
                if (typeof a === 'string') return a;
                if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack.split('\n')[1] : '');
                try { return JSON.stringify(a); } catch (e) { return String(a); }
            }).join(' ');
        } catch (e) {
            text = String(args[0]);
        }
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        runtimeLog.push({ at: hh + ':' + mi + ':' + ss, level, text });
        if (runtimeLog.length > RUNTIME_LOG_MAX) runtimeLog.splice(0, runtimeLog.length - RUNTIME_LOG_MAX);
    }

    function log(...args) {
        pushRuntimeLog('info', args);
        console.log(LOG_PREFIX, ...args);
    }

    function warn(...args) {
        pushRuntimeLog('warn', args);
        // 警告也算未读：结构缺失这类问题以前只落 warn，没人看见就等于没报
        unreadErrors++;
        console.warn(LOG_PREFIX, ...args);
    }

    function error(...args) {
        pushRuntimeLog('error', args);
        unreadErrors++;
        console.error(LOG_PREFIX, ...args);
    }

    function debug(...args) {
        pushRuntimeLog('debug', args);
        if (debugEnabled()) console.debug(LOG_PREFIX, ...args);
    }

    // ==================== 2. 存储 ====================

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
        if (!s.activeProfileId || !s.apiProfiles.some(p => p && p.id === s.activeProfileId)) {
            s.activeProfileId = 'main';
        }
        s.ui = Object.assign(structuredClone(DEFAULT_SETTINGS.ui), s.ui || {});
        s.tracker = Object.assign({}, DEFAULT_SETTINGS.tracker, s.tracker || {});
        s.retention = Object.assign({}, DEFAULT_SETTINGS.retention, s.retention || {});
        s.memory = Object.assign({}, DEFAULT_SETTINGS.memory, s.memory || {});
        return s;
    }

    function saveSettings() {
        const context = ctx();
        if (context && context.saveSettingsDebounced) context.saveSettingsDebounced();
    }

    function getMeta() {
        const context = ctx();
        if (!context) return null;
        if (!context.chatMetadata[MODULE]) {
            context.chatMetadata[MODULE] = { version: 1, currentEventId: null, events: {}, snapshots: {} };
        }
        const m = context.chatMetadata[MODULE];
        m.events = m.events || {};
        m.snapshots = m.snapshots || {};
        return m;
    }

    function saveMeta() {
        const context = ctx();
        if (context && context.saveMetadataDebounced) context.saveMetadataDebounced();
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
        // 质量判定规则变了（例如模型的节点正文键名是 points_to 而旧规则只认 info），
        // 旧结论可能已经不成立，按当前规则重判一次，避免红色警示一直挂着
        if (event.outline) event.parseQuality = checkOutlineQuality(event.outline);
        if (!event.outlineRaw) return event;
        const o = event.outline || {};
        const looksBroken = !Array.isArray(o.nodes) || o.nodes.length === 0;
        if (!looksBroken) return event;
        try {
            const re = parseOutline(event.outlineRaw).parsed;
            const n = (re && Array.isArray(re.nodes)) ? re.nodes.length : 0;
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

    // ==================== 3. 世界书 ====================

    let writeChain = Promise.resolve();

    function withWriteLock(fn) {
        const run = writeChain.then(fn, fn);
        writeChain = run.catch(() => { });
        return run;
    }

    function headers() {
        const context = ctx();
        return context && context.getRequestHeaders ? context.getRequestHeaders() : {};
    }

    async function readWorldBook(name) {
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
            body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(`读取世界书失败 HTTP ${res.status}`);
        return await res.json();
    }

    async function writeWorldBook(name, data) {
        const res = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
            body: JSON.stringify({ name, data }),
        });
        if (!res.ok) throw new Error(`写入世界书失败 HTTP ${res.status}`);
        return await res.json();
    }

    /** 简易稳定哈希，用于内容比对 */
    function hashString(str) {
        let h1 = 0x811c9dc5;
        let h2 = 0x01000193;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 = (h1 ^ c) * 0x01000193 >>> 0;
            h2 = (h2 + c * (i + 1)) >>> 0;
        }
        return h1.toString(16) + '-' + h2.toString(16) + '-' + str.length;
    }

    function entryFingerprint(entry) {
        return hashString([
            String(entry.content || ''),
            String(entry.comment || ''),
            entry.constant ? 1 : 0,
            entry.disable ? 1 : 0,
            Array.isArray(entry.key) ? entry.key.join('|') : '',
        ].join('\u0000'));
    }

    /** 该条目是否由 shujuku 动态维护（它会每轮增删，不能纳入比对） */
    function isForeignManagedEntry(entry) {
        return String(entry && entry.comment || '').startsWith(SHUJUKU_EXPORT_PREFIX);
    }

    /**
     * 快照我们需要保护的外部条目。
     * 排除两类：
     *   1. 本扩展自己的 ▸事件｜ 条目
     *   2. shujuku 动态维护的 TavernDB-ACU-CustomExport- 条目
     * 剩下的是用户手写的设定，这些必须逐字节不变。
     */
    function snapshotForeignEntries(data) {
        const map = new Map();
        const entries = (data && data.entries) || {};
        for (const [uid, entry] of Object.entries(entries)) {
            const comment = String(entry && entry.comment || '');
            if (comment.startsWith(ENTRY_PREFIX)) continue;
            if (isForeignManagedEntry(entry)) continue;
            map.set(String(uid), entryFingerprint(entry));
        }
        return map;
    }

    function verifyForeignEntriesUnchanged(before, afterData) {
        const after = snapshotForeignEntries(afterData);
        const problems = [];
        for (const [uid, hash] of before) {
            if (!after.has(uid)) {
                problems.push(`uid=${uid} 消失`);
            } else if (after.get(uid) !== hash) {
                problems.push(`uid=${uid} 内容变化`);
            }
        }
        return problems.length ? { ok: false, reason: problems.slice(0, 3).join('；') } : { ok: true };
    }

    /** 找下一个可用 uid */
    function nextUid(data) {
        let max = -1;
        for (const uid of Object.keys(data.entries || {})) {
            const n = Number(uid);
            if (Number.isFinite(n) && n > max) max = n;
        }
        return max + 1;
    }

    function buildEntry(uid, content, comment) {
        return {
            uid,
            key: [],
            keysecondary: [],
            comment,
            content,
            constant: true,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: true,
            order: 100,
            position: 0,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 4,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: 0,
            cooldown: 0,
            delay: 0,
            displayIndex: uid,
        };
    }

    /**
     * 写入或更新事件条目。返回 {uid, snapshotKey}
     * 只在 entries 里新增/更新 ▸事件｜ 前缀条目，其余严格不动。
     */
    async function upsertEventEntry(bookName, content, comment, existingUid) {
        return withWriteLock(async () => {
            const data = await readWorldBook(bookName);
            if (!data || !data.entries) throw new Error('世界书数据无效');

            // 写前快照
            const meta = getMeta();
            const snapshotKey = 'ts' + Date.now();
            if (meta) {
                meta.snapshots[snapshotKey] = { worldBook: bookName, at: new Date().toISOString() };
                try {
                    sessionStorage.setItem(
                        `${MODULE}_snapshot_${snapshotKey}`,
                        JSON.stringify(data),
                    );
                } catch (e) {
                    warn('快照过大，未能保存到 sessionStorage', e);
                }
            }

            const foreignBefore = snapshotForeignEntries(data);
            let uid = existingUid;

            if (uid != null && data.entries[uid] &&
                String(data.entries[uid].comment || '').startsWith(ENTRY_PREFIX)) {
                data.entries[uid].content = content;
                data.entries[uid].comment = comment;
                data.entries[uid].constant = true;
            } else {
                uid = nextUid(data);
                data.entries[uid] = buildEntry(uid, content, comment);
            }

            await writeWorldBook(bookName, data);
            log(`世界书已写入「${bookName}」：${existingUid != null ? '更新' : '新增'}条目 uid=${uid}，正文 ${String(content).length} 字`);
            debug(`世界书写入明细：条目总数 ${Object.keys(data.entries).length}，本次改动 uid=${uid}，快照键 ${snapshotKey}`);

            // 回读校验
            const after = await readWorldBook(bookName);
            const check = verifyForeignEntriesUnchanged(foreignBefore, after);
            if (!check.ok) {
                error(`世界书写后校验失败：${check.reason}`);
                throw new Error(`世界书写后校验失败：${check.reason}`);
            }
            if (!after.entries[uid] || String(after.entries[uid].content || '') !== String(content)) {
                error(`世界书回读内容不一致：uid=${uid}，期望 ${String(content).length} 字，实际 ${String((after.entries[uid] || {}).content || '').length} 字`);
                throw new Error('世界书写后回读内容不一致');
            }
            debug(`世界书写后校验通过：uid=${uid}，其余 ${Object.keys(foreignBefore).length} 条外部条目零变化`);

            return { uid, snapshotKey };
        });
    }

    async function deleteEventEntry(bookName, uid) {
        return withWriteLock(async () => {
            const data = await readWorldBook(bookName);
            if (!data || !data.entries) throw new Error('世界书数据无效');
            const entry = data.entries[uid];
            if (!entry) {
                warn(`删除条目 uid=${uid} 时发现它已不存在，可能已被别处删过`);
                return { deleted: false, reason: '条目不存在' };
            }
            if (!String(entry.comment || '').startsWith(ENTRY_PREFIX)) {
                error(`拒绝删除 uid=${uid}：注释「${entry.comment}」不是本扩展创建的条目`);
                throw new Error('拒绝删除：该条目不是本扩展创建的');
            }
            const foreignBefore = snapshotForeignEntries(data);
            delete data.entries[uid];
            await writeWorldBook(bookName, data);
            const after = await readWorldBook(bookName);
            const check = verifyForeignEntriesUnchanged(foreignBefore, after);
            if (!check.ok) {
                error(`删除后校验失败：${check.reason}`);
                throw new Error(`删除后校验失败：${check.reason}`);
            }
            log(`世界书已删除事件条目 uid=${uid}，退回 ${Object.keys(foreignBefore).length} 条外部条目`);
            return { deleted: true };
        });
    }

    /** 列出当前世界书里本扩展的条目 */
    async function listEventEntries(bookName) {
        const data = await readWorldBook(bookName);
        const out = [];
        for (const [uid, entry] of Object.entries((data && data.entries) || {})) {
            const comment = String(entry && entry.comment || '');
            if (comment.startsWith(ENTRY_PREFIX)) {
                out.push({ uid, comment, contentLength: String(entry.content || '').length });
            }
        }
        return out;
    }

    function getCharacterBookName() {
        const context = ctx();
        if (!context) return null;
        const chid = context.characterId;
        const chars = context.characters || [];
        if (chid == null || !chars[chid]) return null;
        const ext = (chars[chid].data && chars[chid].data.extensions) || {};
        return ext.world || null;
    }

    // ---------- 世界书常驻条目（生成上下文用） ----------

    /**
     * 判断一条世界书条目是否该拼进生成上下文。
     * 只取蓝灯（constant: true，无条件常驻），并剔除三类：
     *   - TavernDB-ACU-*：shujuku 自动导出的表格副本与包裹标记，
     *     扩展已通过 collectSheetsFromChat 单独读表，拼进来是重复
     *   - [mvu_update]* / 变量列表：变量更新格式说明，只服务于主对话的 MVU，不产生剧情设定
     *   - ▸事件｜*：本扩展自己写的事件条目，拼进去会自我循环
     * 外加入口带 EJS 条件模板的「状态渲染」条目：它们是按当前变量动态展开的，
     * 原文里所有分支都在，直接拼会让模型看到没生效的分支。
     */
    function shouldIncludeWorldEntry(entry) {
        if (!entry) return false;
        if (!entry.constant) return false;
        if (entry.disable) return false;
        const comment = String(entry.comment || '');
        const content = String(entry.content || '');
        if (comment.startsWith(ENTRY_PREFIX) || content.startsWith(ENTRY_PREFIX)) return false;
        if (comment.startsWith('TavernDB-ACU-') || content.trim().startsWith('TavernDB-ACU-')) return false;
        if (content.includes(SHUJUKU_EXPORT_PREFIX)) return false;
        if (comment.startsWith('[mvu_update]')) return false;
        if (comment === '变量列表') return false;
        // EJS 条件模板：原始内容里带 <% %> 说明是按变量展开的状态描述
        if (content.includes('<%')) return false;
        if (!content.trim()) return false;
        return true;
    }

    /** 从世界书数据里筛出常驻条目，按 order 升序，返回 {entries, dropped} */
    function pickWorldEntries(data) {
        const all = Object.values((data && data.entries) || {});
        const kept = [];
        let dropped = 0;
        for (const e of all) {
            if (shouldIncludeWorldEntry(e)) {
                kept.push({
                    uid: e.uid,
                    comment: String(e.comment || ''),
                    order: Number(e.order) || 0,
                    content: String(e.content || '').trim(),
                });
            } else if (e && e.constant && !e.disable) {
                dropped++;
            }
        }
        kept.sort((a, b) => (a.order - b.order) || (a.uid - b.uid));
        return { entries: kept, dropped };
    }

    /** 把常驻条目拼成一段文本，超字数上限时按 order 顺序截断 */
    function buildWorldBookBlock(entries, maxChars) {
        const lines = [];
        let used = 0;
        let kept = 0;
        let truncated = false;
        const cap = Number(maxChars) || 0;
        for (const e of entries) {
            const piece = `〔${e.comment || '未命名'}〕\n${e.content}`;
            if (cap > 0 && used + piece.length > cap) { truncated = true; break; }
            lines.push(piece);
            used += piece.length;
            kept++;
        }
        return { text: lines.join('\n\n'), used, kept, truncated };
    }

    /**
     * 读角色世界书的常驻条目，失败返回 null 并写 warn。
     * 返回 {bookName, text, kept, dropped, truncated, used}
     */
    async function loadWorldBookContext() {
        const s = getSettings();
        if (!s.worldbook || s.worldbook.enabled === false) {
            debug('世界书：设置里已关闭，本次不带设定');
            return null;
        }
        const bookName = getCharacterBookName();
        if (!bookName) {
            debug('世界书：当前角色没有绑定世界书');
            return null;
        }
        let data;
        try {
            data = await readWorldBook(bookName);
        } catch (e) {
            error(`角色世界书「${bookName}」读取失败，本次生成将不含任何设定：${e.message}。`
                + '生成结果很可能与世界观不符，请检查世界书是否存在或酒馆接口是否正常');
            return null;
        }
        const total = Object.keys((data && data.entries) || {}).length;
        const picked = pickWorldEntries(data);
        debug(`世界书「${bookName}」共 ${total} 条，筛选后保留 ${picked.entries.length} 条、剔除 ${picked.dropped} 条`);
        if (!picked.entries.length) {
            warn(`角色世界书「${bookName}」有 ${total} 条但筛不出可用的常驻条目，本次生成不含设定`);
            return null;
        }
        const built = buildWorldBookBlock(picked.entries, s.worldbook.maxChars);
        log(`世界书「${bookName}」带入 ${built.kept} 条常驻设定，共 ${built.used} 字`
            + (picked.dropped ? `，剔除 ${picked.dropped} 条技术或重复条目` : '')
            + (built.truncated ? `，已达 ${s.worldbook.maxChars} 字上限并截断` : ''));
        if (built.truncated) {
            warn(`世界书超出 ${s.worldbook.maxChars} 字上限，后面的条目没有带进去，可在设置里调高上限或精简条目`);
        }
        debug(`世界书带入条目：${built.kept ? '' : '（空）'}` + picked.entries.slice(0, built.kept)
            .map(e => e.comment).join('、'));
        return {
            bookName,
            text: built.text,
            kept: built.kept,
            dropped: picked.dropped,
            truncated: built.truncated,
            used: built.used,
        };
    }

    // ==================== 4. 记忆适配器 ====================

    const MODE_LABEL = {
        classic: '经典表格',
        vector: '向量表格',
        llm: 'LLM召回',
        crossfire: '交火',
    };

    /** 从楼层里收集 sheet 数据，返回 Map<sheetKey, sheet> */
    function collectSheetsFromChat() {
        const context = ctx();
        const chat = (context && context.chat) || [];
        const result = new Map();

        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg) continue;
            const iso = msg.TavernDB_ACU_IsolatedData;
            if (!iso || typeof iso !== 'object') continue;

            for (const key of Object.keys(iso)) {
                const container = iso[key];
                if (!container || typeof container !== 'object') continue;

                // v2: storageFrame.logEntries
                const entries = container.storageFrame && container.storageFrame.logEntries;
                if (Array.isArray(entries)) {
                    const sorted = entries.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
                    for (const e of sorted) {
                        for (const op of (e.operations || [])) {
                            if (op && op.sheetKey && op.sheet && op.sheet.content) {
                                // 楼层是从新到旧遍历的，第一次遇到即最新快照；
                                // 后面更旧的楼层会带同一张表的旧版本，不能覆盖
                                if (!result.has(op.sheetKey)) result.set(op.sheetKey, op.sheet);
                            }
                        }
                    }
                }

                // legacy: independentData / 直接 sheet_
                const legacy = container.independentData || container;
                if (legacy && typeof legacy === 'object') {
                    for (const [k, v] of Object.entries(legacy)) {
                        if (k.startsWith('sheet_') && v && typeof v === 'object' && v.content) {
                            if (!result.has(k)) result.set(k, v);
                        }
                    }
                }

                // 老字段兜底：TavernDB_ACU_Data / SummaryData / IndependentData
                for (const legacyKey of ['TavernDB_ACU_IndependentData', 'TavernDB_ACU_Data', 'TavernDB_ACU_SummaryData']) {
                    const box = msg[legacyKey];
                    if (box && typeof box === 'object') {
                        for (const [k, v] of Object.entries(box)) {
                            if (k.startsWith('sheet_') && v && typeof v === 'object' && v.content) {
                                if (!result.has(k)) result.set(k, v);
                            }
                        }
                    }
                }
            }
        }
        return result;
    }

    /** 按名字找纪要表（不按 key，见设计 §4.3） */
    function findChronicleSheet(sheets) {
        for (const sheet of sheets.values()) {
            if (sheet && sheet.name === CHRONICLE_NAME) return sheet;
        }
        // 退回 key 匹配
        for (const [k, sheet] of sheets.entries()) {
            if (k === 'sheet_ji_yao_biao') return sheet;
        }
        return null;
    }

    /** 解析纪要表二维数组 -> [{code, span, summary, text}] */
    function parseChronicle(sheet) {
        const content = sheet && sheet.content;
        if (!Array.isArray(content) || content.length < 2) {
            debug('纪要表解析：没有表数据或只有表头，跳过');
            return [];
        }
        const header = content[0].map(x => String(x || '').trim());
        const idx = name => header.findIndex(h => h.includes(name));
        const iCode = idx('编码');
        const iSpan = idx('时间跨度');
        const iSum = idx('概览');
        const iText = idx('纪要');

        // 表头认不出来是严重问题：字段会按错误的列取，纪要内容会串行
        if (iCode < 0) {
            error(`纪要表表头里找不到「编码」列，当前表头：${header.join('｜') || '（空）'}。`
                + '列会按位置兜底取，纪要内容可能取错列');
        }
        const missingCols = [];
        if (iSpan < 0) missingCols.push('时间跨度');
        if (iSum < 0) missingCols.push('概览');
        if (iText < 0) missingCols.push('纪要');
        if (missingCols.length) {
            warn(`纪要表缺少列：${missingCols.join('、')}，这些字段会按位置兜底取。表头：${header.join('｜')}`);
        }

        const rows = [];
        let skipped = 0;
        for (let i = 1; i < content.length; i++) {
            const r = content[i];
            if (!Array.isArray(r)) { skipped++; continue; }
            const code = String(r[iCode >= 0 ? iCode : 1] || '').trim();
            if (!code) { skipped++; continue; }
            rows.push({
                code,
                span: String(r[iSpan >= 0 ? iSpan : 2] || '').trim(),
                summary: String(r[iSum >= 0 ? iSum : 3] || '').trim(),
                text: String(r[iText >= 0 ? iText : 4] || '').trim(),
            });
        }
        const emptyText = rows.filter(r => !r.text).length;
        if (emptyText) {
            warn(`纪要表有 ${emptyText} 条记录的「纪要」列是空的，这些条目对生成没有参考价值`);
        }
        debug(`纪要表解析：共 ${content.length - 1} 行数据，采用 ${rows.length} 条，跳过 ${skipped} 行（无编码或不是数组）`);
        return rows;
    }

    /**
     * 读 shujuku 当前填表模式。
     * 实测路径（shujuku 1.3）：
     *   chat_metadata.TavernDB_ACU_ScopedConfig.fillModeByIsolationKey[隔离码].mode
     * 隔离码在未启用数据隔离时是空字符串。
     * 读不到返回 null，由调用方显示「模式未识别」。
     */
    function detectShujukuMode() {
        const context = ctx();
        const meta = (context && context.chatMetadata) || {};
        const scoped = meta.TavernDB_ACU_ScopedConfig;
        if (!scoped || typeof scoped !== 'object') return null;

        const byKey = scoped.fillModeByIsolationKey;
        if (!byKey || typeof byKey !== 'object') return null;

        // 优先空隔离码，否则取记录时间最新的一条
        const empty = byKey[''];
        if (empty && typeof empty === 'object' && empty.mode) return String(empty.mode);

        let best = null;
        for (const rec of Object.values(byKey)) {
            if (!rec || typeof rec !== 'object' || !rec.mode) continue;
            if (!best || (Number(rec.recordedAt) || 0) > (Number(best.recordedAt) || 0)) best = rec;
        }
        return best ? String(best.mode) : null;
    }

    function shujukuAdapter() {
        return {
            id: 'shujuku-jiyao',
            label: 'shujuku 纪要',
            detect() {
                const sheets = collectSheetsFromChat();
                const sheet = findChronicleSheet(sheets);
                const rows = parseChronicle(sheet);
                return rows.length > 0;
            },
            describe() {
                const sheets = collectSheetsFromChat();
                const sheet = findChronicleSheet(sheets);
                const rows = parseChronicle(sheet);
                if (!rows.length) return '未检测到纪要数据';
                const mode = detectShujukuMode();
                const modeText = mode ? (MODE_LABEL[mode] || mode) : '模式未识别';
                return `shujuku 纪要（${modeText}模式，${rows.length} 条可用）`;
            },
            rows() {
                return parseChronicle(findChronicleSheet(collectSheetsFromChat()));
            },
            mode() {
                return detectShujukuMode();
            },
        };
    }

    function floorsAdapter() {
        return {
            id: 'recent-floors',
            label: '仅最近楼层',
            detect() { return true; },
            describe() {
                const context = ctx();
                const n = ((context && context.chat) || []).length;
                return `仅最近楼层（共 ${n} 楼）`;
            },
        };
    }

    const ADAPTERS = [
        Object.assign(shujukuAdapter(), { priority: 1 }),
        Object.assign(floorsAdapter(), { priority: 99 }),
    ];

    /** 分步诊断 shujuku 接入状态，供设置页显示 */
    function diagnoseShujuku() {
        const out = [];
        const mode = detectShujukuMode();
        out.push(mode ? `模式：${MODE_LABEL[mode] || mode}` : '模式：未识别（ScopedConfig 里没有记录）');

        const sheets = collectSheetsFromChat();
        out.push(`从楼层扫到表格：${sheets.size} 张${sheets.size ? '（' + Array.from(sheets.keys()).slice(0, 6).join('、') + '）' : ''}`);

        const sheet = findChronicleSheet(sheets);
        if (!sheet) {
            out.push('纪要表：未找到（按 name「纪要表」和 key sheet_ji_yao_biao 都没匹配到）');
            return out;
        }
        out.push(`纪要表：已找到（key 匹配，${(sheet.content || []).length} 行）`);
        const rows = parseChronicle(sheet);
        out.push(`解析出纪要：${rows.length} 条${rows.length ? '（' + rows[0].code + ' … ' + rows[rows.length - 1].code + '）' : ''}`);
        if (!rows.length && sheet.content && sheet.content.length >= 1) {
            out.push('表头：' + (sheet.content[0] || []).join(' | '));
        }
        return out;
    }

    // 上次判定结果，用于去重：设置页每渲染一次都会探测一次，
    // 结果没变就不该再记一条日志
    let lastAdapterSig = null;

    function resolveAdapter() {
        const s = getSettings();
        const wanted = s.memory.source || 'auto';
        const decided = (() => {
            if (wanted !== 'auto') {
                const a = ADAPTERS.find(x => x.id === wanted);
                if (a && a.detect()) return { adapter: a, degraded: false };
                const fallback = ADAPTERS.find(x => x.id === 'recent-floors');
                return { adapter: fallback, degraded: true, wanted };
            }
            const hits = ADAPTERS.filter(a => a.detect()).sort((x, y) => x.priority - y.priority);
            const picked = hits[0] || ADAPTERS[ADAPTERS.length - 1];
            return { adapter: picked, degraded: false };
        })();

        // 只有判定结果（适配器 + 是否降级 + 数据量描述）真的变了才记日志
        const sig = decided.adapter.id + '|' + (decided.degraded ? 'degraded' : 'ok') + '|' + decided.adapter.describe();
        if (sig !== lastAdapterSig) {
            lastAdapterSig = sig;
            if (decided.degraded) {
                warn(`记忆来源：设置要「${ADAPTERS.find(x => x.id === wanted)?.label || wanted}」但检测不到数据，已降级为「${decided.adapter.label}」（${decided.adapter.describe()}）`);
            } else if (wanted === 'auto') {
                log(`记忆来源：自动选择「${decided.adapter.label}」，${decided.adapter.describe()}`);
            } else {
                // 首次判定和之后切换来源、数据量变化都报，方便一进来就确认用的是什么
                log(`记忆来源：按设置使用「${decided.adapter.label}」，${decided.adapter.describe()}`);
            }
        }
        return decided;
    }

    // ==================== 8. OOC 词与偏好 ====================

    // 原文存档：运维/VPS/酒馆/OOC词-伊瑟利亚-兰开斯特-事件大纲与状态盘点.md
    // 第 12-45 行 = 大纲词，51-63 行 = 盘点词。此处为改良版，差异见设计文档。

    const PREF_AUTO_NEW = '根据当前情况自行设定';
    // 子项的「交还给上层」选项：委托等级没选时按当前剧情判断，
    // 选了委托等级就改成按那个等级推导
    const PREF_AUTO_BY_LEVEL = '根据委托等级自行设定';
    const PREF_AUTO_BY_NONE = '根据当前情况自行设定';

    /** 某个子项此刻该用哪句「自行设定」文案 */
    function autoByText(prefs) {
        const lv = String((prefs && prefs.commissionLevel) || '').trim();
        const hasLevel = lv && lv !== PREF_AUTO_NEW;
        return hasLevel ? PREF_AUTO_BY_LEVEL : PREF_AUTO_BY_NONE;
    }

    /** 生成子项选项：两个「自行设定」合并成一个动态文案 */
    function subOptions(base) {
        // base 里已经含两句固定文案，去掉后由调用方按当前状态动态插入
        return base.filter(o => o !== PREF_AUTO_BY_NONE && o !== PREF_AUTO_BY_LEVEL);
    }

    // 子项选项的分隔标记：渲染时替换成当前的「自行设定」文案
    const SUB_AUTO = '__eo_sub_auto__';

    // 事件类型：主类型单选，次类型最多三个，都可以不选
    const EVENT_TYPE_DEFAULT = '根据当前情况自行设定';
    const EVENT_MAIN_TYPES = [
        '案件推理', '谈判交涉', '探险探索', '生存危机',
        '社交博弈', '战斗冲突', '日常委托', '禁忌秘辛',
    ];
    const EVENT_SUB_TYPES = [
        '悬疑', '复仇', '背叛', '失踪', '盗窃', '走私',
        '政治阴谋', '超自然', '瘟疫', '营救', '交易', '追捕',
        '守护', '潜入', '解谜', '人情',
    ];
    const MAX_SUB_TYPES = 3;

    const PREF_GROUPS = [
        {
            key: 'commissionLevel',
            label: '委托等级',
            options: [PREF_AUTO_NEW, '村中琐事', '城镇委托', '王国要务', '禁忌事件'],
        },
        {
            key: 'clueSufficiency',
            label: '线索充足度',
            group: '推理难度',
            options: [SUB_AUTO, '充足', '够用', '稀缺'],
        },
        {
            key: 'misleadingStrength',
            label: '误导强度',
            group: '推理难度',
            options: [SUB_AUTO, '无', '轻度', '中度', '重度'],
        },
        {
            key: 'hiddenSegments',
            label: '隐藏环节',
            group: '推理难度',
            options: [SUB_AUTO, '无', '1 个', '2 个', '需玩家自行提出关键假设'],
        },
        {
            key: 'infoPresentation',
            label: '信息呈现',
            group: '推理难度',
            options: [SUB_AUTO, '直给', '间接', '隐晦'],
        },
        {
            key: 'lethality',
            label: '致死性',
            group: '危险程度',
            options: [SUB_AUTO, '无', '低', '中', '高'],
        },
        {
            key: 'failureConsequence',
            label: '失败后果',
            group: '危险程度',
            options: [SUB_AUTO, '仅损失机会', '受伤或被俘', '失去关键物品或盟友', '不可逆的惨重损失'],
        },
        {
            key: 'tolerance',
            label: '容错率',
            group: '危险程度',
            options: [SUB_AUTO, '高', '中', '低'],
        },
        {
            key: 'threatSource',
            label: '威胁来源',
            group: '危险程度',
            options: [SUB_AUTO, '环境', '敌对角色', '时间', '自身状态', '多重叠加'],
        },
        {
            key: 'timePressure',
            label: '倒计时',
            group: '时间压力',
            options: [SUB_AUTO, '无', '隐藏', '可见'],
        },
        {
            key: 'timeDuration',
            label: '时长',
            group: '时间压力',
            options: [SUB_AUTO, '宽松', '适中', '紧张'],
        },
        {
            key: 'timeoutConsequence',
            label: '超时后果',
            group: '时间压力',
            options: [SUB_AUTO, '无', '损失机会或信息', '事件走向坏结局', '角色死亡或不可逆损失'],
        },
        {
            key: 'procrastinationCost',
            label: '拖延代价',
            group: '时间压力',
            options: [SUB_AUTO, '无', '持续损耗', '阶段性恶化'],
        },
    ];

    /**
     * 三个可折叠分组的档位定义（大致模式用）。
     * 每个档位把该组下所有子项一次性定好，用户只选一个粗粒度档位。
     * 详细模式则逐项挑，能拼出档位覆盖不了的组合。
     */
    /** 每组档位都先有这一项：全子项回到「根据当前情况自行设定」 */
    function autoPreset(groupName, prefs) {
        const items = PREF_GROUPS.filter(x => x.group === groupName);
        const values = {};
        // 值用当前正确的「自行设定」文案（委托等级定了就是「根据委托等级自行设定」）
        const text = autoByText(prefs);
        for (const g of items) values[g.key] = text;
        return { key: 'auto', label: text, desc: '这一组交给模型自行配一套合理的，你不用逐项挑', values };
    }

    const PREF_PRESETS = {
        '推理难度': {
            options: [
                { key: 'easy', label: '大致·轻松', desc: '线索给足、几乎不设误导，重在剧情推进',
                  values: { clueSufficiency: '充足', misleadingStrength: '无', hiddenSegments: '无', infoPresentation: '直给' } },
                { key: 'normal', label: '大致·常规', desc: '线索够用，少量误导，需要主动串联',
                  values: { clueSufficiency: '够用', misleadingStrength: '轻度', hiddenSegments: '1 个', infoPresentation: '间接' } },
                { key: 'hard', label: '大致·硬核', desc: '线索稀缺、误导与真线索混杂，还要自己补环节',
                  values: { clueSufficiency: '稀缺', misleadingStrength: '中度', hiddenSegments: '2 个', infoPresentation: '隐晦' } },
                { key: 'brutal', label: '大致·极端', desc: '误导重度叠加，关键假设要玩家自己提出来',
                  values: { clueSufficiency: '稀缺', misleadingStrength: '重度', hiddenSegments: '需玩家自行提出关键假设', infoPresentation: '隐晦' } },
            ],
        },
        '危险程度': {
            options: [
                { key: 'easy', label: '大致·安全', desc: '不致死，错了只损失机会',
                  values: { lethality: '无', failureConsequence: '仅损失机会', tolerance: '高', threatSource: '环境' } },
                { key: 'normal', label: '大致·常规', desc: '部分节点可致死，错了要受伤或被俘',
                  values: { lethality: '低', failureConsequence: '受伤或被俘', tolerance: '中', threatSource: '敌对角色' } },
                { key: 'hard', label: '大致·凶险', desc: '多处节点可致死，容错低，威胁多重叠加',
                  values: { lethality: '高', failureConsequence: '失去关键物品或盟友', tolerance: '低', threatSource: '多重叠加' } },
                { key: 'brutal', label: '大致·致命', desc: '一次关键失误就走向坏结局，损失不可逆',
                  values: { lethality: '高', failureConsequence: '不可逆的惨重损失', tolerance: '低', threatSource: '多重叠加' } },
            ],
        },
        '时间压力': {
            options: [
                { key: 'easy', label: '大致·宽松', desc: '没有硬倒计时，拖一拖也无妨',
                  values: { timePressure: '无', timeDuration: '宽松', timeoutConsequence: '无', procrastinationCost: '无' } },
                { key: 'normal', label: '大致·常规', desc: '有倒计时但看得见，时间够规划，拖延有持续损耗',
                  values: { timePressure: '可见', timeDuration: '适中', timeoutConsequence: '损失机会或信息', procrastinationCost: '持续损耗' } },
                { key: 'hard', label: '大致·紧迫', desc: '倒计时隐藏，时间紧张，超时事件走向坏结局',
                  values: { timePressure: '隐藏', timeDuration: '紧张', timeoutConsequence: '事件走向坏结局', procrastinationCost: '阶段性恶化' } },
                { key: 'brutal', label: '大致·绝命', desc: '隐藏倒计时叠加极度紧张，超时即角色死亡或不可逆损失',
                  values: { timePressure: '隐藏', timeDuration: '紧张', timeoutConsequence: '角色死亡或不可逆损失', procrastinationCost: '阶段性恶化' } },
            ],
        },
    };

    /** 某个分组当前是否所有子项都落在同一个档位上 */
    function matchPreset(groupName, prefs) {
        const def = PREF_PRESETS[groupName];
        if (!def) return null;
        for (const opt of def.options) {
            const ok = Object.keys(opt.values).every(k => (prefs[k] || PREF_AUTO_NEW) === opt.values[k]);
            if (ok) return opt.key;
        }
        return null;
    }

    /** 档位列表 = 自行设定 + 四个粗档 */
    function presetOptions(groupName, prefs) {
        return [autoPreset(groupName, prefs)].concat((PREF_PRESETS[groupName] || {}).options || []);
    }

    function defaultPrefs() {
        const p = {};
        for (const g of PREF_GROUPS) p[g.key] = PREF_AUTO_NEW;
        p.eventMainType = EVENT_TYPE_DEFAULT;
        p.eventSubTypes = [];
        p.extra = '无';
        return p;
    }

    // 生成页的草稿偏好与分组模式：跨重渲染保留，点了「开始生成」才用掉
    let draftPrefs = null;
    let draftGroupModes = null;

    function getDraftPrefs() {
        if (!draftPrefs) draftPrefs = defaultPrefs();
        return draftPrefs;
    }

    function getGroupModes() {
        if (!draftGroupModes) {
            draftGroupModes = {};
            for (const name of Object.keys(PREF_PRESETS)) draftGroupModes[name] = 'rough';
        }
        return draftGroupModes;
    }

    /** 生成成功后清掉草稿，下次进来是全新的一份 */
    function resetDraftPrefs() {
        draftPrefs = null;
        draftGroupModes = null;
    }

    function buildPrefsBlock(prefs) {
        const lines = ['【体验偏好（已在界面选定，直接采用，不要再询问）】'];
        // 事件类型：主类型单选，次类型最多三个
        const main = String(prefs.eventMainType || '').trim();
        const subs = Array.isArray(prefs.eventSubTypes) ? prefs.eventSubTypes.filter(Boolean) : [];
        const hasMain = main && main !== EVENT_TYPE_DEFAULT;
        lines.push(`- 主类型：${hasMain ? main : '未指定，请根据当前剧情判断该事件属于哪一类'}`);
        // 「自行设定」在提示词里要写清楚是按什么推导，避免模型理解成「随便来」
        const autoText = autoByText(prefs);
        const lv = String(prefs.commissionLevel || '').trim();
        const useByLevel = autoText === PREF_AUTO_BY_LEVEL;
        let curGroup = null;
        for (const g of PREF_GROUPS) {
            if (g.group && g.group !== curGroup) {
                curGroup = g.group;
                lines.push(`- ${g.group}：`);
            }
            let v = prefs[g.key] || PREF_AUTO_NEW;
            // 残留的旧文案统一归一化
            if (v === PREF_AUTO_BY_NONE || v === PREF_AUTO_BY_LEVEL || v === SUB_AUTO) v = autoText;
            if (g.group && useByLevel && v === PREF_AUTO_BY_LEVEL) {
                v = `根据委托等级「${lv}」自行设定`;
            }
            const indent = g.group ? '  · ' : '- ';
            lines.push(`${indent}${g.label}：${v}`);
        }
        if (useByLevel) {
            lines.push(`说明：委托等级已定为「${lv}」，凡写「根据委托等级自行设定」的子项，请按该等级应有的难度、危险程度与时间压力成套推导，同一组内要互相匹配。`);
        } else {
            lines.push('说明：委托等级未指定，凡写「根据当前情况自行设定」的子项，请结合当前剧情阶段与该角色所处处境，自己配一套合理的取值。');
        }
        // 次类型：没选就让模型自己配
        if (subs.length) {
            lines.push(`- 次类型：${subs.join('、')}（次要性质可以混入，但要围绕主类型展开，不要喧宾夺主）`);
        } else {
            lines.push('- 次类型：未指定，请按主类型与当前剧情自行搭配 1-3 个次要性质');
        }
        lines.push(`- 额外要求：${prefs.extra || '无'}`);
        return lines.join('\n');
    }

    function buildOutlineSystemPrompt() {
        return [
            '你是一个叙事结构设计师，负责为角色扮演游戏生成事件结构大纲。',
            '严格按用户要求输出 YAML，不要输出 YAML 以外的客套话。',
            '所有【硬性要求】必须遵守，这些是后续剧情推进的约束条件。',
        ].join('\n');
    }

    function buildOutlinePrompt(eventName, prefs, worldBook, contextText) {
        const named = String(eventName || '').trim();
        const head = named
            ? `OOC: 暂停扮演。为即将开始的【${named}】生成完整结构大纲，用 YAML 输出，包含：`
            : 'OOC: 暂停扮演。为即将开始的事件生成完整结构大纲，用 YAML 输出，包含：';
        const nameLine = named
            ? '   a. 事件名直接用上面给定的名字'
            : '   a. 事件名：你没有收到指定的名字，请根据当前剧情、角色处境和即将发生的事，起一个简洁的中文事件名（4-12 字，如「开膛手杰克案」「石桥镇失踪案」），写进 event_name 键';
        return [
            head,
            '0. 事件名（event_name）与事件简介（event_brief，一句话说清这事件要解决什么）',
            nameLine,
            '1. 事件类型与核心真相：判断本事件属于哪类（案件/谈判/探险/危机/社交博弈/其他），写出核心真相或隐情（仅记录，后续不得直接透露）',
            '2. 信息节点清单：按发现顺序列 5-8 条，每条含编号（从 1 开始）、类型（物证/证言/环境/时间线/关系）、触发关键词、指向的信息或后果',
            '   节点字段名固定用：id（编号，数字）、type（类型）、trigger（触发关键词或触发条件）、info（指向的信息或后果）、refute_by（可选，这条是误导时填可推翻它的节点编号数组）',
            '   另外单独输出「推进所需最少信息节点编号」：只列出推理必需的最少节点编号',
            '3. 参与角色：按立场分类——',
            '   a. 助力者：每个助力者的动机须各不相同（利益一致/情感羁绊/交易/被迫/其他），并标明是否有条件或代价。同阵营且利益一致者可以无条件；交易或被迫者须写明代价。按实际情况判断，不要为所有助力者统一附加条件',
            '   b. 阻碍者：会阻止玩家推进，其阻碍理由须合理且可被化解',
            '   c. 知情者/关键人物：掌握核心信息，不会无理由主动交出；其信息只能经由信息节点清单中的条目逐步获得',
            '   d. 幕后方（如有）：标记 reveal: forbidden，暴露路径只能经由信息节点清单逐步指向',
            '4. 推进路径：从开局到结局的分步逻辑链，注明哪些节点是必经、哪些可跳过；并按"危险程度"标注每个高风险节点的失败后果（如受伤/被俘/死亡/失去关键信息）',
            '5. 禁止事项：不得新增清单外信息节点、不得提前揭示核心真相、不得让角色知道其不应知道的信息',
            '',
            buildPrefsBlock(prefs),
            '',
            '【硬性要求（不得违反）】',
            '- 公平性：所有指向核心真相的信息必须在事件中可获得；核心真相不得依赖大纲外的新信息',
            '- 误导：允许 1-2 个误导性信息，但每个误导信息必须有一条可推翻它的反向证据，且该证据必须是信息节点清单中的条目，须注明 refute_by 节点编号',
            '- 允许根据当前情况设计大纲之外的合理路径，但每条必须标注「【大纲外】」并说明为什么现在会出现这条路径',
            '',
            '输出格式：只输出一个 YAML 代码块，顶层键为 event_name / event_brief / event_type / core_truth / nodes / min_nodes_for_deduction / characters / paths / forbidden。',
            '',
            '---',
            '【世界观设定】（角色世界书的常驻条目，本世界的规则与设定，所有内容必须与之相容）',
            worldBook || '（未加载）',
            '',
            '【当前剧情】',
            contextText || '（无）',
        ].join('\n');
    }

    /** 生成大纲时的剧情上下文：纪要（概览或正文）+ 最近楼层 */
    function buildOutlineContextText(ctxParts) {
        const parts = [];
        if (ctxParts.jiyaoList) {
            parts.push('【纪要概览】（shujuku 纪要，编号 AMxxxx）');
            parts.push(ctxParts.jiyaoList);
        }
        if (ctxParts.jiyaoDetail) {
            parts.push('【纪要正文】');
            parts.push(ctxParts.jiyaoDetail);
        }
        if (ctxParts.recentChat) {
            parts.push('【最近剧情】');
            parts.push(ctxParts.recentChat);
        }
        return parts.join('\n\n') || '（无）';
    }

    function buildInventorySystemPrompt() {
        return [
            '你是一个严谨的剧情状态记录员，负责核对事件进度。',
            '只做整理和核对，绝不推进剧情、不代替角色行动、不发明对话中没发生过的事。',
            '所有判断必须基于提供的【事件状态卡】和【剧情内容】，不得编造。',
        ].join('\n');
    }

    function buildInventoryPrompt(ctxParts) {
        const parts = [];
        parts.push('OOC: 暂停扮演，做一次状态盘点。基于本事件开场大纲和到目前为止的对话，输出：');
        parts.push('A. 已确认信息（只列对话中已实际出现的，注明大致的楼层或纪要编号）');
        parts.push('B. 尚未触发的信息节点（对照大纲，列出还没出现的节点编号及各自触发词）');
        parts.push('C. 按体验偏好核对当前状态：');
        parts.push('   - 线索充足度：当前信息是否足以支撑下一步推进？如不足，说明缺什么、可经由哪条未触发节点补上');
        parts.push('   - 误导状态：已出现的误导是否已被反向证据推翻？如未推翻，提醒其存在');
        parts.push('   - 隐藏环节：当前是否卡在需推理补全的环节？如是，指出已有哪些信息可作为推理依据');
        parts.push('   - 危险状态：当前威胁来源是什么？最近一个高风险节点是什么、失败后果是什么？容错已消耗多少？');
        parts.push('D. 当前可走的路：2-4 条具体行动分支，每条注明大致耗时（剧情内时间）、主要风险、可能获得的信息。允许新开路径，但须标注「【大纲外】」并说明原因');
        parts.push('E. 矛盾检查：是否有前后不一致的信息或角色行为？如有，指出并建议以哪条为准。');
        parts.push('不要推进剧情，只做整理。');
        parts.push('');
        parts.push('除上述文字报告外，最后再输出一个 JSON 代码块，用于程序更新进度：');
        parts.push('```json');
        parts.push('{');
        parts.push('  "triggeredNodes": [已触发的节点编号, 数字数组],');
        parts.push('  "refutedMisleads": [已被推翻的误导标识, 字符串数组],');
        parts.push('  "offPathBranches": [{"desc": "大纲外新路径简述", "reason": "为什么现在出现"}],');
        parts.push('  "nodeVetoed": [本次明确判定不可能再触发的节点编号],');
        parts.push('  "summary": "一句话概括当前进度"');
        parts.push('}');
        parts.push('```');
        parts.push('');
        parts.push('---');
        parts.push('【世界观设定】（角色世界书的常驻条目，本世界的规则与设定，所有内容必须与之相容）');
        parts.push(ctxParts.worldBook || '（未加载）');
        parts.push('');
        parts.push('【事件状态卡】');
        parts.push(ctxParts.stateCard || '（无）');
        if (ctxParts.jiyaoList) {
            parts.push('');
            parts.push('【纪要概览】（shujuku 纪要，编号 AMxxxx）');
            parts.push(ctxParts.jiyaoList);
        }
        if (ctxParts.jiyaoDetail) {
            parts.push('');
            parts.push('【纪要精读】');
            parts.push(ctxParts.jiyaoDetail);
        }
        parts.push('');
        parts.push('【最近剧情】');
        parts.push(ctxParts.recentChat || '（无）');
        return parts.join('\n');
    }

    // ==================== 9. 上下文拼装 ====================

    function getChatMessages() {
        const context = ctx();
        const chat = (context && context.chat) || [];
        return chat.filter(m => m && !m.is_system && String(m.mes || '').trim());
    }

    /** 楼层总数（玩家楼 + AI 楼，不含系统消息），用于自动盘点的计数 */
    function countFloors() {
        return getChatMessages().length;
    }

    /**
     * 自动盘点是否该跑：自上次盘点以来，新积累的楼层数（玩家楼 + AI 楼）达到设置值就返回。
     * autoEveryFloors = 0 关闭自动盘点；没有进行中事件时不跑。
     */
    function shouldAutoInventory() {
        const s = getSettings();
        if (s.tracker.mode !== 'auto') return false;
        const every = Math.max(0, Number(s.tracker.autoEveryFloors) || 0);
        if (every <= 0) return false;
        const ev = getCurrentEvent();
        if (!ev || ev.status !== 'active') return false;
        const cur = countFloors();
        // 老事件没有 floorBase：以当前楼层为基线，从现在开始累计
        if (!Number.isFinite(Number(ev.floorBase))) {
            ev.floorBase = cur;
            saveMeta();
            return false;
        }
        const since = cur - Number(ev.floorBase);
        if (since < every) return false;
        return { cur, since, every };
    }

    /** 按 token 预算从最新往前累加楼层 */
    async function collectRecentFloors(limit) {
        const context = ctx();
        const msgs = getChatMessages();
        const out = [];
        for (let i = msgs.length - 1; i >= 0 && out.length < limit; i--) {
            const m = msgs[i];
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
        if (event.outline && event.outline.core_truth) {
            lines.push(`核心真相：〔禁止透露〕${event.outline.core_truth}`);
        }
        const nodes = (event.outline && event.outline.nodes) || [];
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
        if (event.outline && event.outline.min_nodes_for_deduction) {
            lines.push(`推理所需最少节点：${JSON.stringify(event.outline.min_nodes_for_deduction)}`);
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
        const floors = Math.max(1, Number(s.memory.recentFloors) || 15);
        step(`读取最近 ${floors} 楼`);
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
            + `最近楼层 ${floors} 楼共 ${out.recentChat.length} 字，合计 ${total} 字`);
        if (total < 500) {
            warn(`上下文总量只有 ${total} 字，模型可参考的信息很少，生成结果可能凭空发挥`);
        }
        return out;
    }

    // ==================== 10. 生成与解析 ====================

    // 酒馆 generateRaw 支持的连接源类型（api 参数取值）
    const TAVERN_APIS = [
        ['openai', 'OpenAI / 兼容接口（openai）'],
        ['claude', 'Claude（claude）'],
        ['makersuite', 'Google AI Studio（makersuite）'],
        ['vertexai', 'Vertex AI（vertexai）'],
        ['mistralai', 'Mistral（mistralai）'],
        ['custom', '自定义 OpenAI 兼容（custom）'],
        ['cohere', 'Cohere（cohere）'],
        ['deepseek', 'DeepSeek（deepseek）'],
        ['perplexity', 'Perplexity（perplexity）'],
        ['groq', 'Groq（groq）'],
        ['01ai', '01.AI（01ai）'],
        ['openrouter', 'OpenRouter（openrouter）'],
    ];

    function callModel(systemPrompt, prompt) {
        const context = ctx();
        if (!context) {
            error('调用模型失败：取不到酒馆上下文');
            return Promise.reject(new Error('未取到酒馆上下文'));
        }
        const s = getSettings();
        const profile = (s.apiProfiles || []).find(p => p.id === s.activeProfileId)
            || { id: 'main', name: '跟随酒馆主连接', mode: 'main' };
        const t0 = Date.now();
        debug(`调用模型：配置「${profile.name || profile.id}」（mode=${profile.mode || 'main'}），system ${String(systemPrompt).length} 字，prompt ${String(prompt).length} 字`);
        if (busy && progress.startedAt) {
            step(`请求模型（「${profile.name || profile.id}」，输入约 ${Math.round((String(systemPrompt).length + String(prompt).length) / 1000)} 千字）`);
        }

        const finish = (out) => {
            log(`模型返回：${String(out || '').length} 字，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
            if (busy && progress.startedAt) step(`模型已返回 ${String(out || '').length} 字`);
            return out;
        };
        const failed = (e) => {
            error(`调用模型失败（耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${e && e.message || e}`);
            if (busy && progress.startedAt) step(`模型调用失败：${(e && e.message) || e}`);
            throw e;
        };

        // 直连模式：自己发 HTTP，不经过酒馆
        if (profile.mode === 'direct') {
            return callDirectApi(profile, systemPrompt, prompt).then(finish, failed);
        }

        // 走酒馆 generateRaw 的两种模式
        if (!context.generateRaw) {
            error('调用模型失败：当前酒馆上下文没有 generateRaw，无法发起生成');
            return Promise.reject(new Error('generateRaw 不可用'));
        }
        const params = { prompt, systemPrompt };
        if (profile.mode === 'tavern') {
            if (profile.api) params.api = profile.api;
            if (profile.model) params.model = profile.model;
            if (Number(profile.responseLength) > 0) params.responseLength = Number(profile.responseLength);
            debug(`走酒馆连接源：api=${profile.api || '（跟随）'}，model=${profile.model || '（跟随）'}`);
        }
        return Promise.resolve(context.generateRaw(params)).then(finish, failed);
    }

    /** 直接调用 OpenAI 兼容的 /chat/completions，不经过酒馆连接源 */
    async function callDirectApi(profile, systemPrompt, prompt) {
        const base = String(profile.baseUrl || '').trim().replace(/\/+$/, '');
        if (!base) throw new Error('直连配置缺少 base URL');
        if (!profile.model) throw new Error('直连配置缺少模型名');
        if (!profile.apiKey) throw new Error('直连配置缺少 API 密钥');

        const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
        const body = {
            model: profile.model,
            messages: [
                { role: 'system', content: String(systemPrompt || '') },
                { role: 'user', content: String(prompt || '') },
            ],
            temperature: Number.isFinite(Number(profile.temperature)) ? Number(profile.temperature) : 1,
            stream: false,
        };
        if (Number(profile.maxTokens) > 0) body.max_tokens = Number(profile.maxTokens);

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + profile.apiKey,
                },
                body: JSON.stringify(body),
            });
        } catch (e) {
            throw new Error(`无法连接 ${url}：${e && e.message || e}`);
        }
        const text = await resp.text();
        if (!resp.ok) {
            const brief = text.length > 300 ? text.slice(0, 300) + '…' : text;
            throw new Error(`HTTP ${resp.status}：${brief}`);
        }
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error('返回的不是 JSON：' + (text.length > 200 ? text.slice(0, 200) + '…' : text));
        }
        const msg = data && data.choices && data.choices[0] && data.choices[0].message;
        const out = msg && (msg.content != null ? msg.content : msg.reasoning_content);
        if (out == null) {
            throw new Error('返回结构里没有 choices[0].message.content：' + JSON.stringify(data).slice(0, 200));
        }
        return String(out);
    }

    /** 测试连接：发一条极短请求，返回结果文本供界面显示 */
    async function testProfile(profile) {
        const t0 = Date.now();
        const out = await callModel('你是一个连通性测试助手，只回一个字。', '只回复两个字：收到');
        return { ok: true, ms: Date.now() - t0, sample: String(out || '').trim().slice(0, 60) };
    }

    /** 从文本中提取代码块内容 */
    function extractCodeBlock(text, lang) {
        const src = String(text || '');
        if (lang) {
            const re = new RegExp('```' + lang + '\\s*([\\s\\S]*?)```', 'i');
            const m = src.match(re);
            if (m) return m[1].trim();
        }
        const m = src.match(/```\s*([\s\S]*?)```/);
        return m ? m[1].trim() : null;
    }

    /** 极简 YAML 解析：覆盖大纲实际会出现的结构（2-4 层映射与列表） */
    function parseSimpleYaml(text) {
        const rawLines = String(text || '').replace(/\r/g, '').split('\n');

        // 去注释：只有引号外、且前面是空白或行首的 # 才算注释
        const stripComment = (s) => {
            let inSingle = false;
            let inDouble = false;
            let out = '';
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];
                if (ch === '\\' && inDouble) { out += ch + (s[i + 1] || ''); i++; continue; }
                if (ch === '"' && !inSingle) inDouble = !inDouble;
                else if (ch === "'" && !inDouble) inSingle = !inSingle;
                else if (ch === '#' && !inSingle && !inDouble) {
                    if (i === 0 || /\s/.test(s[i - 1])) return out;
                }
                out += ch;
            }
            return out;
        };

        const unquote = (v) => {
            let t = String(v).trim();
            if (t.length >= 2 &&
                ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
                t = t.slice(1, -1);
            }
            if (t === 'true') return true;
            if (t === 'false') return false;
            if (t === 'null' || t === '~' || t === '') return null;
            if (/^-?\d+$/.test(t)) return Number(t);
            if (/^-?\d+\.\d+$/.test(t)) return Number(t);
            // 行内数组 [1, 2, 3]
            if (t.startsWith('[') && t.endsWith(']')) {
                const inner = t.slice(1, -1).trim();
                if (!inner) return [];
                return inner.split(',').map(x => unquote(x.trim()));
            }
            return t;
        };

        // 预扫描：把有效行整理成 {indent, text}
        const lines = [];
        for (const raw of rawLines) {
            const s = stripComment(raw);
            if (!s.trim()) continue;
            const trimmed = s.trim();
            if (trimmed === '---' || trimmed === '...') continue;
            lines.push({ indent: s.length - s.trimStart().length, text: trimmed });
        }

        // 块标量（| 或 >）的后续行必须以原样保留缩进与空行，不能走上面的通用预处理。
        // 先标记出哪些行属于块标量正文，后面统一跳过。
        const isBlockHeader = (t) => /^[|>][+-]?\d*$/.test(t) || /^[|>][+-]?$/.test(t);
        const blockBody = new Array(lines.length).fill(false);
        for (let i = 0; i < lines.length; i++) {
            const kv = lines[i].text.match(/^[^:]+:\s*([|>][+-]?)\s*$/);
            if (!kv) continue;
            const baseIndent = lines[i].indent;
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].indent <= baseIndent) break;
                blockBody[j] = true;
            }
        }

        // 找某层第一个真实子节点类型，决定容器是 map 还是 list
        let pos = 0;

        /**
         * 读取块标量正文：从当前 pos 起，把所有缩进大于 baseIndent 的行原样取出。
         * 去掉公共缩进，| 保留换行、> 折成空格。
         */
        function readBlockScalar(baseIndent, marker) {
            const buffer = [];
            while (pos < lines.length && lines[pos].indent > baseIndent) {
                buffer.push(lines[pos]);
                pos++;
            }
            if (!buffer.length) return '';
            const minIndent = Math.min.apply(null, buffer.map(l => l.indent));
            const texts = buffer.map(l => ' '.repeat(Math.max(0, l.indent - minIndent)) + l.text);
            if (marker.startsWith('>')) {
                return texts.join(' ').replace(/\s+/g, ' ').trim();
            }
            return texts.join('\n').replace(/\s+$/, '');
        }

        /** 值是否为块标量标记 */
        const isBlockMarker = (v) => /^[|>][+-]?\d*$/.test(String(v || '').trim());

        function parseBlock(parentIndent) {
            // 窥探首个有效子行的缩进与形态
            if (pos >= lines.length) return null;
            const first = lines[pos];
            if (first.indent <= parentIndent) return null;

            const childIndent = first.indent;
            const isList = first.text === '-' || first.text.startsWith('- ');

            if (isList) {
                const arr = [];
                while (pos < lines.length && lines[pos].indent === childIndent
                    && (lines[pos].text === '-' || lines[pos].text.startsWith('- '))) {
                    const line = lines[pos];
                    const content = line.text === '-' ? '' : line.text.slice(2).trim();

                    if (!content) {
                        // "-" 单独一行，子结构在下一层
                        pos++;
                        const child = parseBlock(childIndent);
                        arr.push(child === null ? null : child);
                        continue;
                    }

                    // "- key: value" 形式，属于对象列表项
                    const kvIdx = content.indexOf(':');
                    const looksLikeKv = kvIdx > 0 && !content.startsWith('"') && !content.startsWith("'")
                        && (kvIdx === content.length - 1 || /\s/.test(content[kvIdx + 1]));

                    if (looksLikeKv) {
                        const itemObj = {};
                        const key = content.slice(0, kvIdx).trim();
                        const valStr = content.slice(kvIdx + 1).trim();
                        pos++;
                        if (valStr === '') {
                            const child = parseBlock(childIndent);
                            itemObj[key] = child === null ? null : child;
                        } else if (isBlockMarker(valStr)) {
                            itemObj[key] = readBlockScalar(childIndent, String(valStr).trim());
                        } else {
                            itemObj[key] = unquote(valStr);
                        }
                        // 后续同缩进（childIndent+2 起）的同级键并入本对象
                        while (pos < lines.length && lines[pos].indent > childIndent
                            && !(lines[pos].text === '-' || lines[pos].text.startsWith('- '))) {
                            const sub = lines[pos];
                            const kIdx = sub.text.indexOf(':');
                            if (kIdx <= 0) { pos++; continue; }
                            const k2 = sub.text.slice(0, kIdx).trim();
                            const v2 = sub.text.slice(kIdx + 1).trim();
                            const subIndent = sub.indent;
                            pos++;
                            if (v2 === '') {
                                const child = parseBlock(subIndent);
                                itemObj[k2] = child === null ? null : child;
                            } else if (isBlockMarker(v2)) {
                                itemObj[k2] = readBlockScalar(subIndent, String(v2).trim());
                            } else {
                                itemObj[k2] = unquote(v2);
                            }
                        }
                        arr.push(itemObj);
                    } else {
                        arr.push(unquote(content));
                        pos++;
                    }
                }
                return arr;
            }

            const obj = {};
            while (pos < lines.length && lines[pos].indent === childIndent
                && !(lines[pos].text === '-' || lines[pos].text.startsWith('- '))) {
                const line = lines[pos];
                const kvIdx = line.text.indexOf(':');
                if (kvIdx <= 0) { pos++; continue; }
                const key = line.text.slice(0, kvIdx).trim();
                const valStr = line.text.slice(kvIdx + 1).trim();
                pos++;
                if (valStr === '') {
                    const child = parseBlock(childIndent);
                    obj[key] = child === null ? null : child;
                } else if (isBlockMarker(valStr)) {
                    obj[key] = readBlockScalar(childIndent, String(valStr).trim());
                } else {
                    obj[key] = unquote(valStr);
                }
            }
            return obj;
        }

        const root = parseBlock(-1);
        return root === null ? {} : root;
    }

    function parseOutline(raw) {
        const block = extractCodeBlock(raw, 'yaml') || extractCodeBlock(raw) || raw;
        const parsed = parseSimpleYaml(block);
        const hasYaml = !!extractCodeBlock(raw, 'yaml');
        const nodeCount = (parsed && Array.isArray(parsed.nodes)) ? parsed.nodes.length : 0;
        const keys = Object.keys(parsed || {});
        const quality = checkOutlineQuality(parsed);

        debug(`大纲解析：原文 ${String(raw || '').length} 字，YAML 块${hasYaml ? '命中' : '未命中（整段兜底）'}，`
            + `顶层键 ${keys.length} 个：${keys.join('、') || '无'}，节点 ${nodeCount} 个`);
        if (hasYaml) {
            log(`大纲解析成功：节点 ${nodeCount} 个，顶层键 ${keys.length} 个`);
        } else {
            warn(`大纲解析：模型没有返回 yaml 代码块，已把整段回复当 YAML 兜底解析，节点 ${nodeCount} 个`);
        }

        // 结构缺陷逐条报出：以前这里只报「没有节点」一句，键整块丢失不吭声，出了问题查不出来
        if (quality.missing.length) {
            warn(`大纲结构缺失：${quality.missing.join('；')}。这通常意味着模型没按格式输出，或解析器不认识某种写法`);
        }
        if (!nodeCount) {
            error('大纲里没有解析出任何信息节点，这次生成的事件卡将无法跟踪进度。'
                + `原始输出前 200 字：${String(raw || '').slice(0, 200)}`);
        }
        if (quality.ok) {
            log(`大纲完整性检查通过：${quality.summary}`);
        } else {
            error(`大纲完整性检查未通过：${quality.summary}`);
        }
        return { parsed: parsed || {}, raw: String(raw || ''), fromFallback: !hasYaml, quality };
    }

    /**
     * 检查大纲结构是否完整。返回 {ok, missing[], summary}。
     * 这里只判断，不修复——解析器出错时要让用户立刻看见，而不是静默降级。
     */
    function checkOutlineQuality(parsed) {
        const o = parsed || {};
        const missing = [];
        const nodes = Array.isArray(o.nodes) ? o.nodes : null;
        if (!nodes) missing.push('信息节点（nodes）缺失或不是列表');
        else if (!nodes.length) missing.push('信息节点（nodes）是空列表');
        else {
            const badId = nodes.filter(n => nodeId(n) == null);
            if (badId.length) missing.push(`${badId.length} 个节点没有编号`);
            const noInfo = nodes.filter(n => !nodeText(n));
            if (noInfo.length) missing.push(`${noInfo.length} 个节点没有内容`);
        }
        const minNodes = o.min_nodes_for_deduction;
        if (!minNodes) missing.push('推理必需节点（min_nodes_for_deduction）缺失');
        const chars = o.characters;
        if (!chars) missing.push('参与角色（characters）缺失');
        else if (typeof chars === 'object' && !Object.keys(chars).length) missing.push('参与角色是空对象');
        if (!o.event_brief) missing.push('事件简介（event_brief）缺失');
        if (!o.core_truth) missing.push('核心真相（core_truth）缺失');

        const nodeN = nodes ? nodes.length : 0;
        const charN = (chars && typeof chars === 'object')
            ? Object.values(chars).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0) : 0;
        const summary = `节点 ${nodeN} 个、角色 ${charN} 人、`
            + `推理必需节点 ${Array.isArray(minNodes) ? minNodes.length : 0} 个、`
            + `顶层键 ${Object.keys(o).length} 个`;
        return { ok: missing.length === 0, missing, summary };
    }

    function parseInventory(raw) {
        const jsonText = extractCodeBlock(raw, 'json');
        let structured = null;
        if (!jsonText) {
            warn('盘点解析：模型回复里没有 json 代码块，本次盘点只保留原文，节点清单不动');
        }
        if (jsonText) {
            try {
                structured = JSON.parse(jsonText);
            } catch (e) {
                // 尝试修补常见错误
                try {
                    structured = JSON.parse(jsonText.replace(/,\s*([}\]])/g, '$1'));
                    warn('盘点解析：JSON 有尾逗号等格式问题，修补后解析成功');
                } catch (e2) {
                    error('盘点 JSON 解析失败，本次盘点不更新节点', e2);
                }
            }
            if (structured) {
                const t = Array.isArray(structured.triggeredNodes) ? structured.triggeredNodes.length : 0;
                debug(`盘点解析：触发节点 ${t} 条，顶层键 ${Object.keys(structured).join('、') || '无'}`);
            }
        }
        return { structured, raw: String(raw || '') };
    }

    // ==================== 11. 事件流程 ====================

    let busy = false;

    function setBusy(on, keepProgress) {
        busy = on;
        if (panelEl) {
            const b = panelEl.querySelector('#eo_busy');
            if (b) b.style.display = on ? 'block' : 'none';
        }
        if (!on && !keepProgress) {
            resetProgress();
        } else if (!on && keepProgress) {
            // 跑完了：停掉计时器，保留进度列表让人看清各步耗时，几秒后变淡
            if (progress.timer) { clearInterval(progress.timer); progress.timer = null; }
            const box = panelEl && panelEl.querySelector('#eo_progress');
            if (box) {
                const t = box.querySelector('.eo-progress-timer');
                if (t) t.textContent = `共用时 ${Math.floor((Date.now() - progress.startedAt) / 1000)} 秒`;
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
        name: '名字',
        role: '身份',
        motive_type: '动机类型',
        motive_detail: '动机详述',
        conditions: '条件与代价',
        note: '备注',
        reason: '阻碍理由',
        resolvable_by: '化解方式',
        info_known: '掌握的信息',
        reveal: '揭示条件',
        reveal_condition: '揭示条件',
        id: '编号',
        type: '类型',
        trigger: '触发条件',
        info: '信息内容',
        consequence: '后果',
        refute_by: '可被节点推翻',
        keyword: '触发词',
        keywords: '触发词',
        desc: '描述',
        step: '步骤',
        detail: '说明',
        required_nodes: '必经节点',
        optional_nodes: '可跳过节点',
        risk: '风险',
        failure: '失败后果',
    };

    const NODE_TYPE_LABEL = {
        物证: '物证', 证言: '证言', 环境: '环境', 时间线: '时间线', 关系: '关系',
        evidence: '物证', testimony: '证言', environment: '环境', timeline: '时间线', relation: '关系',
    };

    const EVENT_TYPE_LABEL = {
        案件: '案件', 谈判: '谈判', 探险: '探险', 危机: '危机', 社交博弈: '社交博弈', 其他: '其他',
        case: '案件', negotiation: '谈判', exploration: '探险', crisis: '危机', social: '社交博弈', other: '其他',
    };

    /** 键名转中文，认不出就保留原样 */
    function labelOf(key) {
        const k = String(key || '');
        return OUTLINE_KEY_LABEL[k] || OUTLINE_KEY_LABEL[k.toLowerCase()] || k;
    }

    /**
     * 把大纲结构渲染成人类可读的中文文本块，替代直接展示原始 YAML。
     * 解析失败时返回 null，由调用方退回显示原文。
     */
    function renderOutlineText(outline) {
        if (!outline || typeof outline !== 'object') return null;
        const lines = [];

        if (outline.event_brief) lines.push(`一句话简介：${outline.event_brief}`);
        const et = outline.event_type;
        if (et) {
            if (typeof et === 'string') {
                lines.push(`事件类型：${EVENT_TYPE_LABEL[et] || et}`);
            } else {
                const main = et.primary || et.main || '';
                const subs = Array.isArray(et.secondary) ? et.secondary : (Array.isArray(et.sub) ? et.sub : []);
                const mainText = EVENT_TYPE_LABEL[main] || main;
                lines.push(`事件类型：${mainText}${subs.length ? '（兼 ' + subs.join('、') + '）' : ''}`);
            }
        }
        if (outline.core_truth) {
            lines.push('');
            lines.push('核心真相（仅你知道，不会被透露给角色）：');
            lines.push(String(outline.core_truth).trim());
        }

        const nodes = Array.isArray(outline.nodes) ? outline.nodes : [];
        if (nodes.length) {
            lines.push('');
            lines.push(`信息节点（共 ${nodes.length} 条，按发现顺序）：`);
            for (const n of nodes) {
                const id = nodeId(n);
                const type = NODE_TYPE_LABEL[n.type] || n.type || '';
                lines.push(`${id}.〔${type}〕${nodeText(n)}`);
                if (nodeTrigger(n)) {
                    lines.push(`   触发：${nodeTrigger(n)}`);
                }
                if (n.consequence) lines.push(`   后果：${n.consequence}`);
                if (n.refute_by != null) lines.push(`   可推翻误导：指向节点 ${Array.isArray(n.refute_by) ? n.refute_by.join('、') : n.refute_by}`);
            }
        }

        const minNodes = outline.min_nodes_for_deduction;
        if (minNodes) {
            const arr = Array.isArray(minNodes) ? minNodes : [minNodes];
            lines.push('');
            lines.push(`推理必需节点：${arr.join('、')}（集齐这些就足以推出核心真相）`);
        }

        const chars = outline.characters;
        if (chars && typeof chars === 'object') {
            lines.push('');
            lines.push('参与角色：');
            for (const [side, list] of Object.entries(chars)) {
                const sideLabel = labelOf(side);
                if (!Array.isArray(list) || !list.length) continue;
                lines.push(`  ${sideLabel}：`);
                for (const c of list) {
                    const head = [c.name || c.角色 || '未命名', c.role ? `（${c.role}）` : ''].join('');
                    lines.push(`    · ${head}`);
                    if (c.motive_detail || c.motive_type) {
                        lines.push(`      动机：${[c.motive_type, c.motive_detail].filter(Boolean).join('——')}`);
                    }
                    if (c.reason) lines.push(`      阻碍理由：${c.reason}`);
                    if (c.resolvable_by) lines.push(`      化解方式：${c.resolvable_by}`);
                    if (c.conditions) lines.push(`      条件：${c.conditions}`);
                    if (c.info_known) lines.push(`      掌握信息：${c.info_known}`);
                    if (c.note) lines.push(`      备注：${c.note}`);
                }
            }
        }

        const paths = Array.isArray(outline.paths) ? outline.paths : [];
        if (paths.length) {
            lines.push('');
            lines.push(`推进路径（共 ${paths.length} 步）：`);
            paths.forEach((p, i) => {
                if (typeof p === 'string') { lines.push(`  ${i + 1}. ${p}`); return; }
                const title = p.step || p.desc || p.name || `第 ${i + 1} 步`;
                lines.push(`  ${i + 1}. ${title}`);
                if (p.detail) lines.push(`     ${p.detail}`);
                if (p.required_nodes) lines.push(`     必经节点：${Array.isArray(p.required_nodes) ? p.required_nodes.join('、') : p.required_nodes}`);
                if (p.risk) lines.push(`     风险：${p.risk}`);
                if (p.failure) lines.push(`     失败后果：${p.failure}`);
            });
        }

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

    /** HTML 转义，进度条等少量需要拼字符串的地方用 */
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ---------- 生成进度 ----------
    // 生成一次大纲要跑好几步（读世界书、读纪要、拉楼层、请模型、解析），
    // 每步耗时从几毫秒到几十秒不等，只显示「生成中」用户无法判断卡没卡死。
    const progress = { steps: [], startedAt: 0, timer: null };

    function resetProgress() {
        progress.steps = [];
        progress.startedAt = 0;
        if (progress.timer) { clearInterval(progress.timer); progress.timer = null; }
    }

    /** 开始一次带进度的操作，返回 step 函数 */
    function startProgress(title) {
        resetProgress();
        progress.startedAt = Date.now();
        progress.title = title;
        renderProgress();
        // 每秒刷新一次耗时，让用户看到时间在走
        progress.timer = setInterval(() => {
            const box = panelEl && panelEl.querySelector('#eo_progress');
            if (!box) return;
            const sec = Math.floor((Date.now() - progress.startedAt) / 1000);
            const el2 = box.querySelector('.eo-progress-timer');
            if (el2) el2.textContent = `已用时 ${sec} 秒`;
        }, 1000);
        return step;
    }

    /** 推进到某一步。done=true 表示该步完成，否则标记为进行中 */
    function step(text, done) {
        const last = progress.steps[progress.steps.length - 1];
        if (last && !last.done) {
            last.done = true;
            last.ms = Date.now() - last.at;
        }
        if (text) progress.steps.push({ text, at: Date.now(), done: !!done });
        renderProgress();
    }

    function renderProgress() {
        if (!panelEl) return;
        // 进度条挂在操作按钮下方：找当前页的锚点，找不到才退回面板顶部
        const host = panelEl.querySelector('#eo_progress_host');
        let box = document.getElementById('eo_progress');
        if (!box) {
            box = document.createElement('div');
            box.id = 'eo_progress';
            box.className = 'eo-progress';
        }
        if (host) {
            if (box.parentNode !== host) host.appendChild(box);
        } else if (box.parentNode !== panelEl.querySelector('#eo_body')) {
            const busyEl = panelEl.querySelector('#eo_busy');
            if (busyEl && busyEl.parentNode) busyEl.parentNode.insertBefore(box, busyEl);
        }
        box.innerHTML = buildProgressHtml();
        box.style.display = progress.steps.length ? 'block' : 'none';
    }

    function buildProgressHtml() {
        const sec = Math.floor((Date.now() - progress.startedAt) / 1000);
        const rows = progress.steps.map((s) => {
            const mark = s.done ? '✓' : '⋯';
            const cost = s.done && s.ms != null ? `　${(s.ms / 1000).toFixed(1)} 秒` : '';
            return `<div class="eo-progress-row${s.done ? ' eo-progress-done' : ''}">`
                + `<span class="eo-progress-mark">${mark}</span>${escapeHtml(s.text)}${cost}</div>`;
        }).join('');
        return `<div class="eo-progress-head">${escapeHtml(progress.title || '处理中')}`
            + `　<span class="eo-progress-timer">已用时 ${sec} 秒</span></div>${rows}`;
    }

    function genEventId() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `evt-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
            + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }

    /** 把事件卡状态压成世界书条目内容（800-1500 字） */
    function buildEntryContent(event, round) {
        const context = ctx();
        const lines = [];
        lines.push(`〔事件大纲｜chatId=${context.chatId || ''}｜v${event.entryVersion || 1}｜更新于 ${new Date().toLocaleString('zh-CN')}〕`);
        lines.push(buildStateCard(event));
        if (round) lines.push(`盘点轮次：${round}`);
        const o = event.outline || {};
        if (o.forbidden) lines.push(`禁止事项：${typeof o.forbidden === 'string' ? o.forbidden : JSON.stringify(o.forbidden)}`);
        if (o.characters) {
            const chars = o.characters;
            if (typeof chars === 'string') lines.push(`角色：${chars}`);
        }
        let text = lines.filter(Boolean).join('\n');
        if (text.length > 1500) text = text.slice(0, 1490) + '…';
        return text;
    }

    async function createEvent(eventName, prefs) {
        const context = ctx();
        if (!context) throw new Error('未取到酒馆上下文');
        if (!context.chatId) throw new Error('请先打开一个对话');
        const book = getCharacterBookName();
        if (!book) throw new Error('当前角色未绑定世界书');

        setBusy(true);
        try {
            startProgress('正在生成事件大纲');
            step('准备提示词');
            const systemPrompt = buildOutlineSystemPrompt();
            // 生成大纲同样需要剧情上下文与世界设定：楼层 + 纪要 + 世界书
            const ctxParts = await gatherContext(null);
            step('组装最终 prompt');
            const prompt = buildOutlinePrompt(eventName, prefs, ctxParts.worldBook, buildOutlineContextText(ctxParts));
            const raw = await callModel(systemPrompt, prompt);
            step('解析模型返回的大纲');
            const { parsed, raw: rawText, quality } = parseOutline(raw);
            const nodeCount = (parsed && Array.isArray(parsed.nodes)) ? parsed.nodes.length : 0;
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
                status: 'active',
                createdAt: new Date().toISOString(),
                closedAt: null,
                chatId: context.chatId,
                worldBook: book,
                entryUid: null,
                entryVersion: 1,
                // 自动盘点的计数基线：自上次盘点以来的楼层数（玩家楼 + AI 楼）
                floorBase: countFloors(),
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
                    refutedMisleads: [],
                    offPathBranches: [],
                    nodeVetoed: [],
                    autoCommitted: [],
                    manualNotes: '',
                },
                inventories: [],
            };

            // 写世界书
            const content = buildEntryContent(event, 0);
            const res = await upsertEventEntry(
                book,
                content,
                `${ENTRY_PREFIX}${eventName}｜chatId=${event.chatId}`,
                null,
            );
            event.entryUid = res.uid;

            meta.events[id] = event;
            meta.currentEventId = id;
            saveMeta();
            return event;
        } finally {
            setBusy(false, true);
        }
    }

    async function runInventory() {
        const event = getCurrentEvent();
        if (!event) throw new Error('当前没有进行中的事件');
        if (event.status !== 'active') throw new Error('该事件已结束');

        setBusy(true);
        try {
            startProgress('正在盘点事件状态');
            step('准备提示词');
            const parts = await gatherContext(event);
            const systemPrompt = buildInventorySystemPrompt();
            const prompt = buildInventoryPrompt(parts);
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
            );
            event.entryUid = res.uid;
            record.committedToBook = true;
            // 盘点成功即把计数基线挪到当前楼层，下一轮从零开始累计
            event.floorBase = countFloors();

            saveMeta();
            return { record, event };
        } finally {
            setBusy(false, true);
        }
    }

    async function closeEvent(abandoned) {
        const event = getCurrentEvent();
        if (!event) throw new Error('当前没有事件');
        setBusy(true);
        try {
            if (event.entryUid != null && event.worldBook) {
                await deleteEventEntry(event.worldBook, event.entryUid);
                event.entryUid = null;
            }
            event.status = abandoned ? 'abandoned' : 'completed';
            event.closedAt = new Date().toISOString();
            const meta = getMeta();
            meta.currentEventId = null;
            await applyRetention(meta);
            saveMeta();
            log(`事件「${event.name}」已${abandoned ? '废弃' : '完结'}，世界书条目已清理，事件卡转历史`);
            return event;
        } finally {
            setBusy(false);
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

    // ==================== 5. 界面 ====================

    let panelEl = null;
    let fabEl = null;
    let backdropEl = null;

    function injectStyle() {
        if (document.getElementById('eo_style')) return;
        const style = document.createElement('style');
        style.id = 'eo_style';
        style.textContent = `
#eo_fab{position:fixed;z-index:30001;display:flex;align-items:center;justify-content:center;
  width:44px;height:44px;border-radius:12px;cursor:grab;box-sizing:border-box;
  user-select:none;-webkit-user-select:none;touch-action:none;
  -webkit-tap-highlight-color:transparent;outline:none;
  background:linear-gradient(160deg,#fff3d6,#f5d080);border:1px solid rgba(184,134,11,.55);
  box-shadow:0 2px 10px rgba(0,0,0,.25);color:#5a3e0b;font-size:15px;font-weight:700;
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
  width:10px;height:100%;background:linear-gradient(160deg,#fff3d6,#f5d080);
  border:1px solid rgba(184,134,11,.55);box-sizing:border-box;}
#eo_fab.eo-collapsed.eo-dock-left::after{left:0;border-radius:0 6px 6px 0;border-left:0;}
#eo_fab.eo-collapsed.eo-dock-right::after{right:0;border-radius:6px 0 0 6px;border-right:0;}

/* 悬停时把竖条撑开成完整图标 */
#eo_fab.eo-collapsed.eo-hover{background:linear-gradient(160deg,#fff3d6,#f5d080);
  border:1px solid rgba(184,134,11,.55);box-shadow:0 2px 10px rgba(0,0,0,.25);}
#eo_fab.eo-collapsed.eo-hover .eo-fab-label{display:inline;}
#eo_fab.eo-collapsed.eo-hover::after{display:none;}
#eo_fab.eo-collapsed.eo-hover.eo-dock-left{border-radius:0 12px 12px 0;border-left:0;}
#eo_fab.eo-collapsed.eo-hover.eo-dock-right{border-radius:12px 0 0 12px;border-right:0;}
.eo-fab-label{line-height:1;}
#eo_backdrop{position:fixed;inset:0;z-index:30000;display:none;
  background:rgba(30,22,8,.55);backdrop-filter:blur(2px);}
#eo_backdrop.eo-open{display:block;}
#eo_panel{position:fixed;inset:0;z-index:30001;display:none;flex-direction:column;
  width:100vw;height:100vh;height:100dvh;max-width:none;max-height:none;
  background:#fffdf7;border:0;border-radius:0;box-shadow:none;overflow:hidden;
  font-size:14px;color:#3c2f14;}
#eo_panel.eo-open{display:flex;}
#eo_panel .eo-body{max-width:1100px;width:100%;margin:0 auto;padding:16px 20px 48px;
  overflow-y:auto;-webkit-overflow-scrolling:touch;}
.eo-box{max-height:320px;}
@media (max-width:640px){
  #eo_panel .eo-body{padding:12px 12px 40px;}
  .eo-head{padding:10px 12px;}
}
.eo-busy{display:none;padding:8px 12px;background:#fff3d6;border-bottom:1px solid rgba(184,134,11,.3);
  color:#8a5b00;font-size:12px;text-align:center;}
.eo-progress{display:none;padding:8px 12px;background:#f6f8fa;border-bottom:1px solid rgba(0,0,0,.08);
  font-size:12px;transition:opacity .6s;}
.eo-progress-head{color:#333;font-weight:600;margin-bottom:4px;}
.eo-progress-timer{color:#888;font-weight:400;}
.eo-progress-row{color:#666;line-height:1.7;padding-left:2px;}
.eo-progress-mark{display:inline-block;width:14px;color:#b8860b;}
.eo-progress-done{color:#38761d;}
.eo-progress-done .eo-progress-mark{color:#38761d;}
.eo-head{display:flex;align-items:center;gap:8px;padding:12px 20px;user-select:none;
  background:linear-gradient(160deg,#fff3d6,#f5d080);border-bottom:1px solid rgba(184,134,11,.4);}
.eo-title{font-weight:700;flex:1;}
.eo-close{cursor:pointer;padding:4px 12px;border-radius:8px;background:rgba(255,255,255,.55);font-size:15px;}
.eo-close:hover{background:rgba(255,255,255,.85);}
.eo-body{padding:12px;overflow:auto;flex:1;}
.eo-row{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;}
.eo-row>label{min-width:78px;color:#6b5424;}
.eo-btn{padding:5px 12px;border-radius:8px;border:1px solid rgba(184,134,11,.5);
  background:#fff8e6;cursor:pointer;color:#5a3e0b;font-size:13px;}
.eo-btn:hover{background:#fdeec4;}
.eo-btn:disabled{opacity:.5;cursor:not-allowed;}
.eo-btn.eo-primary{background:#f0c464;border-color:#b8860b;font-weight:600;}
.eo-box{border:1px solid rgba(184,134,11,.32);border-radius:9px;padding:9px 10px;
  background:#fffaf0;margin-bottom:9px;white-space:pre-wrap;word-break:break-word;
  max-height:220px;overflow:auto;line-height:1.55;}
.eo-hint{color:#8a7333;font-size:12px;line-height:1.5;}
.eo-warn{color:#a35c00;background:#fff3d6;border:1px solid #e6c37a;
  border-radius:8px;padding:7px 9px;margin-bottom:9px;font-size:12px;}
.eo-ok{color:#2c6e2c;}
.eo-bad{color:#a11;font-size:12px;}
.eo-bad-box{color:#8b0000;background:#fdecea;border:1px solid #e7a9a3;
  border-radius:8px;padding:8px 10px;margin-bottom:9px;font-size:12px;line-height:1.6;}
select.eo-sel{padding:4px 8px;border-radius:7px;border:1px solid rgba(184,134,11,.45);
  background:#fffdf7;color:#3c2f14;font-size:13px;}
.eo-sec{border-top:1px dashed rgba(184,134,11,.35);margin:10px 0 6px;padding-top:8px;
  font-weight:600;color:#6b5424;}

/* 标签栏 */
.eo-tabs{display:flex;gap:4px;border-bottom:1px solid rgba(184,134,11,.35);
  margin-bottom:14px;position:sticky;top:0;background:#fffdf7;z-index:2;padding-top:4px;}
.eo-tab{padding:9px 16px;cursor:pointer;border-radius:9px 9px 0 0;color:#7a6431;
  font-size:14px;display:flex;align-items:center;gap:6px;white-space:nowrap;}
.eo-tab:hover{background:#fff6e0;color:#5a3e0b;}
.eo-tab-active{background:linear-gradient(160deg,#fff3d6,#f5d080);color:#4a3208;
  font-weight:700;border-bottom:2px solid #b8860b;margin-bottom:-1px;}
.eo-badge{background:#b8860b;color:#fff;border-radius:9px;padding:0 6px;
  font-size:11px;line-height:16px;min-width:16px;text-align:center;font-weight:600;}
.eo-badge-err{background:#c0392b;}
.eo-page{display:block;}

/* 折叠块 */
.eo-details{border:1px solid rgba(184,134,11,.32);border-radius:9px;
  background:#fffaf0;margin:8px 0;padding:0 10px;}
.eo-details>summary{cursor:pointer;padding:9px 0;color:#6b5424;font-weight:600;
  font-size:13px;user-select:none;list-style:none;}
.eo-details>summary::-webkit-details-marker{display:none;}
.eo-details>summary::before{content:"▸ ";color:#b8860b;}
.eo-details[open]>summary::before{content:"▾ ";}
.eo-details[open]>summary{border-bottom:1px dashed rgba(184,134,11,.3);margin-bottom:8px;}
.eo-details .eo-box{max-height:420px;}
.eo-subsec{margin:12px 0 4px;color:#8a6a1e;font-weight:600;font-size:12px;}

/* 输入 */
.eo-input{padding:6px 10px;border-radius:8px;border:1px solid rgba(184,134,11,.45);
  background:#fffdf7;color:#3c2f14;font-size:13px;flex:1;min-width:0;}
.eo-input:focus{outline:2px solid rgba(184,134,11,.28);outline-offset:0;}

/* 节点行 */
.eo-node{padding:4px 6px;cursor:pointer;border-radius:6px;line-height:1.55;}
.eo-node:hover{background:#fff3d6;}
.eo-node-on{color:#2c6e2c;font-weight:600;}
.eo-node-suggest{color:#8a5a00;background:#fff6e0;}
.eo-suggest{display:flex;align-items:center;gap:8px;padding:3px 4px;border-bottom:1px dashed #e6d7b0;}
.eo-suggest span{flex:1;}

/* 运行日志框：自己滚动，进来就停在最新一条 */
.eo-logbox{max-height:340px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;}

/* 日志级别筛选按钮 */
.eo-logfilter{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0 4px;}
.eo-filterbtn{padding:3px 10px;font-size:12px;}
.eo-filterbtn-on{background:#f5d080;color:#4a3200;font-weight:700;}

/* 事件类型：次类型多选按钮 */
.eo-subtype-wrap{align-items:flex-start;}
.eo-subtypes{display:flex;flex-wrap:wrap;gap:5px;flex:1;}
.eo-subtype{padding:2px 9px;font-size:12px;line-height:1.5;}
.eo-subtype-on{background:#f5d080;color:#4a3200;font-weight:700;border-color:#c9a13a;}

/* 体验偏好：可折叠分组 + 大致/详细 */
.eo-prefgroup{margin:6px 0;border:1px solid #e8dbb3;border-radius:8px;background:#fffdf7;}
.eo-prefgroup-sum{cursor:pointer;padding:7px 10px;font-weight:600;color:#6b5424;font-size:13px;
  list-style:none;user-select:none;}
.eo-prefgroup-sum::-webkit-details-marker{display:none;}
.eo-prefgroup-sum::before{content:'▸ ';color:#b8860b;}
.eo-prefgroup[open] .eo-prefgroup-sum::before{content:'▾ ';}
.eo-prefgroup-body{padding:2px 10px 8px;}
.eo-prefmode{display:flex;align-items:center;gap:6px;padding:2px 0 6px;}
.eo-modebtn{padding:3px 12px;font-size:12px;}
.eo-modebtn-on{background:#f5d080;color:#4a3200;font-weight:700;}

/* 记忆来源的子项（shujuku 诊断） */
.eo-sub{margin:2px 0 6px 18px;padding:6px 10px;border-left:3px solid #e6cd8a;background:#fffdf6;border-radius:0 6px 6px 0;}
.eo-sub-title{font-size:13px;font-weight:600;color:#6b5424;margin-bottom:2px;}

/* 打勾模式：标题上的问号 */
.eo-sec-inline{display:flex;align-items:center;gap:6px;}
.eo-help{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;
  border-radius:50%;border:1px solid #b8860b;color:#8a6a10;font-size:11px;font-weight:700;
  cursor:pointer;user-select:none;position:relative;background:#fff8e2;}
.eo-help:hover{background:#f5e0a8;}
.eo-help-on{background:#f5d080;color:#4a3200;}
.eo-tip{position:absolute;left:22px;top:-4px;width:260px;padding:8px 10px;border-radius:8px;
  background:#3a3222;color:#fff6e0;font-size:12px;font-weight:400;line-height:1.6;
  box-shadow:0 3px 12px rgba(0,0,0,.28);z-index:10;white-space:normal;}

/* 打勾模式：三档各占一行 */
.eo-modes{display:flex;flex-direction:column;gap:5px;margin:4px 0;}
.eo-mode{display:flex;gap:8px;align-items:flex-start;padding:5px 8px;border-radius:6px;
  background:#fdf8ec;font-size:12px;line-height:1.6;color:#5a4a2a;}
.eo-mode-active{background:#fff2cc;box-shadow:inset 0 0 0 1px #e0c078;}
.eo-mode-tag{flex:0 0 auto;font-weight:700;color:#7a5a0a;}
.eo-ctx-preview{font-size:12px;color:#6b5424;background:#fdf7e8;}

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
        if (!fabEl) return { width: 44, height: 44 };
        const folded = fabEl.classList.contains('eo-collapsed');
        if (folded) fabEl.classList.remove('eo-collapsed');
        try {
            const w = fabEl.offsetWidth;
            const h = fabEl.offsetHeight;
            return {
                width: w > 0 ? w : 44,
                height: h > 0 ? h : 44,
            };
        } finally {
            if (folded) fabEl.classList.add('eo-collapsed');
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
        if (!fabEl) return;
        const st = state || {};
        const dock = st.dock || null;
        const anchor = clampFabPos(
            (st.anchor && st.anchor.x != null) ? st.anchor.x : FAB_SAFE_PADDING + 10,
            (st.anchor && st.anchor.y != null) ? st.anchor.y : 40,
        );

        fabEl.classList.toggle('eo-collapsed', !!dock);
        fabEl.classList.toggle('eo-dock-left', dock === 'left');
        fabEl.classList.toggle('eo-dock-right', dock === 'right');
        fabEl.classList.remove('eo-hover');

        if (dock) {
            const d = fabDockPosition(dock, anchor.y);
            fabEl.style.width = d.width + 'px';
            fabEl.style.height = d.height + 'px';
            fabEl.style.left = Math.round(d.x) + 'px';
            fabEl.style.top = Math.round(d.y) + 'px';
        } else {
            fabEl.style.width = '';
            fabEl.style.height = '';
            fabEl.style.left = Math.round(anchor.x) + 'px';
            fabEl.style.top = Math.round(anchor.y) + 'px';
        }
        fabEl.style.right = 'auto';

        if (initial) {
            fabEl.style.transition = 'none';
            requestAnimationFrame(() => { if (fabEl) fabEl.style.transition = ''; });
        }
    }

    let fabState = { anchor: { x: 14, y: 40 }, dock: 'left' };

    function loadFabState() {
        const s = getSettings();
        const saved = s.ui.floatingPos || {};
        fabState = {
            anchor: {
                x: saved.anchor && Number.isFinite(saved.anchor.x) ? saved.anchor.x : 14,
                y: saved.anchor && Number.isFinite(saved.anchor.y) ? saved.anchor.y : 40,
            },
            dock: saved.dock === 'left' || saved.dock === 'right' ? saved.dock : null,
        };
    }

    function saveFabState() {
        const s = getSettings();
        s.ui.floatingPos = { anchor: { ...fabState.anchor }, dock: fabState.dock };
        saveSettings();
    }

    function ensureFab() {
        const s = getSettings();
        if (!s.ui.floatingEnabled) {
            if (fabEl) { fabEl.remove(); fabEl = null; }
            return;
        }
        if (fabEl) return;

        loadFabState();

        fabEl = document.createElement('div');
        fabEl.id = 'eo_fab';
        fabEl.setAttribute('role', 'button');
        fabEl.tabIndex = 0;
        fabEl.innerHTML = '<span class="eo-fab-label">事件</span>';
        fabEl.title = '事件大纲';
        document.body.appendChild(fabEl);

        bindFabGestures(fabEl);
        applyFabState(fabState, true);

        window.addEventListener('resize', () => {
            if (!fabEl) return;
            fabState.anchor = clampFabPos(fabState.anchor.x, fabState.anchor.y);
            applyFabState(fabState);
        });
    }

    /** 从吸附态恢复成自由悬浮 */
    function restoreFab() {
        fabState.dock = null;
        fabState.anchor = clampFabPos(fabState.anchor.x, fabState.anchor.y);
        applyFabState(fabState);
        saveFabState();
    }

    /** 收起并吸附到指定侧 */
    function dockFab(side) {
        fabState.dock = side;
        applyFabState(fabState);
        saveFabState();
    }

    function activateFab() {
        if (fabState.dock) {
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
                fabState.anchor = clampFabPos(g.anchor.x, g.anchor.y);
                fabState.dock = g.dock;
                applyFabState(fabState);
                suppressClickUntil = Date.now() + 320;
                return;
            }

            if (g.moved) {
                suppressClickUntil = Date.now() + 320;
                const side = detectDockSide(fabState.anchor);
                if (side) dockFab(side);
                else { fabState.dock = null; applyFabState(fabState); saveFabState(); }
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
                offsetX: e.clientX - (fabState.dock ? rect.left : fabState.anchor.x),
                offsetY: e.clientY - (fabState.dock ? rect.top : fabState.anchor.y),
                anchor: { ...fabState.anchor },
                dock: fabState.dock,
            };

            // 从吸附态按下：立即展开为完整图标
            if (fabState.dock) {
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
                fabState.dock = null;
                el.classList.remove('eo-collapsed', 'eo-hover');
                el.classList.add('eo-dragging');
                el.style.width = '';
                el.style.height = '';
                el.style.transition = 'none';
            }
            if (e.cancelable) e.preventDefault();
            const p = clampFabPos(e.clientX - gesture.offsetX, e.clientY - gesture.offsetY);
            fabState.anchor = p;
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
            if (!gesture && fabState.dock) el.classList.add('eo-hover');
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
        if (panelEl) return panelEl;

        backdropEl = document.createElement('div');
        backdropEl.id = 'eo_backdrop';
        document.body.appendChild(backdropEl);

        panelEl = document.createElement('div');
        panelEl.id = 'eo_panel';
        panelEl.innerHTML = `
<div class="eo-head" id="eo_panel_head">
  <span class="eo-title">事件大纲</span>
  <span class="eo-hint" id="eo_ver">v${VERSION}</span>
  <span class="eo-close" id="eo_close">✕ 关闭</span>
</div>
<div class="eo-busy" id="eo_busy">正在请求模型，请稍候…</div>
<div class="eo-body" id="eo_body"></div>`;
        document.body.appendChild(panelEl);
        panelEl.querySelector('#eo_close').addEventListener('click', () => togglePanel(false));
        backdropEl.addEventListener('click', () => togglePanel(false));

        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && panelEl && panelEl.classList.contains('eo-open')) {
                togglePanel(false);
            }
        });
        return panelEl;
    }

    function togglePanel(force) {
        const p = ensurePanel();
        if (!backdropEl) ensurePanel();
        const open = force === undefined ? !p.classList.contains('eo-open') : force;
        p.classList.toggle('eo-open', open);
        if (backdropEl) backdropEl.classList.toggle('eo-open', open);
        document.body.style.overflow = open ? 'hidden' : '';
        if (open) renderPanel();
    }

    function el(tag, cls, text) {
        const d = document.createElement(tag);
        if (cls) d.className = cls;
        if (text !== undefined) d.textContent = text;
        return d;
    }

    let activeTab = 'gen';

    const TABS = [
        { key: 'gen', label: '生成事件' },
        { key: 'inv', label: '盘点' },
        { key: 'log', label: '日志' },
        { key: 'set', label: '设置' },
    ];

    function renderPanel() {
        const body = panelEl && panelEl.querySelector('#eo_body');
        if (!body) return;
        body.innerHTML = '';

        const context = ctx();
        if (!context) {
            body.appendChild(el('div', 'eo-warn', '未取到酒馆上下文，扩展可能未正确加载。'));
            return;
        }

        // --- 标签栏 ---
        const tabBar = el('div', 'eo-tabs');
        for (const t of TABS) {
            const b = el('div', 'eo-tab' + (activeTab === t.key ? ' eo-tab-active' : ''), t.label);
            if (t.key === 'inv') {
                const ev = getCurrentEvent();
                if (ev && ev.status === 'active') {
                    const badge = el('span', 'eo-badge');
                    badge.textContent = String((ev.inventories || []).length);
                    b.appendChild(badge);
                }
            }
            // 日志页出错时挂红点：不能等人自己去翻日志才发现解析失败
            if (t.key === 'log' && unreadErrors > 0) {
                const badge = el('span', 'eo-badge eo-badge-err');
                badge.textContent = unreadErrors > 99 ? '99+' : String(unreadErrors);
                b.appendChild(badge);
            }
            b.addEventListener('click', () => {
                activeTab = t.key;
                if (t.key === 'log') unreadErrors = 0;
                renderPanel();
            });
            tabBar.appendChild(b);
        }
        body.appendChild(tabBar);

        const page = el('div', 'eo-page');
        body.appendChild(page);

        if (activeTab === 'gen') renderGenPage(page);
        else if (activeTab === 'inv') renderInvPage(page);
        else if (activeTab === 'log') {
            renderLogPage(page);
            // 切到日志页时再滚一次：此时元素已经挂到文档上，scrollHeight 才是真值
            requestAnimationFrame(() => {
                const lb = page.querySelector('.eo-logbox');
                if (lb) lb.scrollTop = lb.scrollHeight;
            });
        }
        else renderSetPage(page);
    }

    // ---------- 页：生成事件 ----------

    function renderGenPage(page) {
        const ev = getCurrentEvent();

        const statusBox = el('div', 'eo-box');
        statusBox.textContent = ev
            ? `进行中：${ev.name}\n开始于 ${String(ev.createdAt || '').slice(0, 19)}\n世界书：${ev.worldBook}　条目 uid=${ev.entryUid}`
            : '当前没有进行中的事件。填好下面的事件名和偏好即可开始。';
        page.appendChild(statusBox);

        if (ev) {
            const opOut = el('div', 'eo-hint');
            const row = el('div', 'eo-row');

            const btnInv = el('button', 'eo-btn eo-primary', '去盘点这一页');
            btnInv.addEventListener('click', () => { activeTab = 'inv'; renderPanel(); });
            row.appendChild(btnInv);

            const btnDone = el('button', 'eo-btn', '完结');
            btnDone.addEventListener('click', async () => {
                if (!confirm(`确认完结「${ev.name}」？世界书条目会被删除，事件卡转为历史。`)) return;
                btnDone.disabled = true;
                opOut.className = 'eo-hint';
                opOut.textContent = '处理中…';
                try {
                    await closeEvent(false);
                    opOut.className = 'eo-ok';
                    opOut.textContent = '已完结。';
                    renderPanel();
                } catch (e) {
                    opOut.className = 'eo-bad';
                    opOut.textContent = '失败：' + (e && e.message || e);
                } finally { btnDone.disabled = false; }
            });
            row.appendChild(btnDone);

            const btnAb = el('button', 'eo-btn', '废弃');
            btnAb.addEventListener('click', async () => {
                if (!confirm(`确认废弃「${ev.name}」？`)) return;
                btnAb.disabled = true;
                opOut.className = 'eo-hint';
                opOut.textContent = '处理中…';
                try {
                    await closeEvent(true);
                    opOut.className = 'eo-ok';
                    opOut.textContent = '已废弃。';
                    renderPanel();
                } catch (e) {
                    opOut.className = 'eo-bad';
                    opOut.textContent = '失败：' + (e && e.message || e);
                } finally { btnAb.disabled = false; }
            });
            row.appendChild(btnAb);
            page.appendChild(row);
            page.appendChild(opOut);

            // 大纲正文：优先展示中文渲染结果，原文折叠备查
            // 解析质量有问题时，先在顶上摆一条红色警示——不能让残缺的大纲看起来像正常的
            const q = ev.parseQuality;
            if (q && !q.ok) {
                const bad = el('div', 'eo-bad-box');
                bad.textContent = '⚠ 这次生成的大纲结构不完整：' + q.missing.join('；')
                    + '。节点进度将无法正常跟踪。可点「重新生成」，或到日志页查看模型原始输出。';
                page.appendChild(bad);
            }
            const outlineText = renderOutlineText(ev.outline);
            if (outlineText) {
                const det = el('details', 'eo-details');
                det.open = true;
                det.appendChild(el('summary', null, '事件大纲'));
                const ob = el('div', 'eo-box');
                ob.textContent = outlineText;
                det.appendChild(ob);
                page.appendChild(det);
            }
            if (ev.outlineRaw) {
                const det = el('details', 'eo-details');
                const sum = el('summary', null, '模型原始输出（排查用，含英文字段名）');
                det.appendChild(sum);
                const ob = el('div', 'eo-box');
                ob.textContent = ev.outlineRaw;
                det.appendChild(ob);
                page.appendChild(det);
            }
            return;
        }

        // --- 新建事件表单 ---
        page.appendChild(el('div', 'eo-sec', '事件'));
        const nameRow = el('div', 'eo-row');
        nameRow.appendChild(el('label', null, '事件名'));
        const nameInput = el('input', 'eo-input');
        nameInput.type = 'text';
        nameInput.placeholder = '可留空，留空由 AI 根据当前剧情自动命名';
        nameRow.appendChild(nameInput);
        page.appendChild(nameRow);
        page.appendChild(el('div', 'eo-hint',
            '事件名可以留空。留空时模型会读当前剧情，自己起一个 4-12 字的事件名，并同时写一句事件简介。想自己起就填这里。'));

        // 偏好状态放在闭包里，切换大致/详细或改档位只重绘内容区，
        // 不重建折叠壳，所以不会自己折回去
        const prefs = getDraftPrefs();
        const groupMode = getGroupModes();

        // --- 事件类型：主类型单选，次类型最多三个 ---
        page.appendChild(el('div', 'eo-sec', '事件类型'));
        page.appendChild(el('div', 'eo-hint',
            `主类型只能选一个，次类型最多选 ${MAX_SUB_TYPES} 个，两个都可以不选，不选就由模型按当前剧情判断。`));

        const mainRow = el('div', 'eo-row');
        mainRow.appendChild(el('label', null, '主类型'));
        const mainSel = el('select', 'eo-sel');
        mainSel.style.flex = '1';
        for (const t of [EVENT_TYPE_DEFAULT].concat(EVENT_MAIN_TYPES)) {
            const o = el('option', null, t);
            o.value = t;
            mainSel.appendChild(o);
        }
        mainSel.value = prefs.eventMainType || EVENT_TYPE_DEFAULT;
        mainSel.addEventListener('change', () => { prefs.eventMainType = mainSel.value; });
        mainRow.appendChild(mainSel);
        page.appendChild(mainRow);

        // 次类型：多选按钮，点一下选中/取消，超过上限就拦住
        const subWrap = el('div', 'eo-row eo-subtype-wrap');
        subWrap.appendChild(el('label', null, '次类型'));
        const subBox = el('div', 'eo-subtypes');
        const selSet = new Set(prefs.eventSubTypes || []);
        const counter = el('span', 'eo-hint', '');
        const paintCounter = () => {
            counter.textContent = `已选 ${selSet.size}/${MAX_SUB_TYPES}`;
            counter.className = selSet.size >= MAX_SUB_TYPES ? 'eo-warn' : 'eo-hint';
        };
        for (const t of EVENT_SUB_TYPES) {
            const b = el('button', 'eo-btn eo-subtype' + (selSet.has(t) ? ' eo-subtype-on' : ''), t);
            b.type = 'button';
            b.addEventListener('click', () => {
                if (selSet.has(t)) {
                    selSet.delete(t);
                } else {
                    if (selSet.size >= MAX_SUB_TYPES) {
                        counter.textContent = `最多选 ${MAX_SUB_TYPES} 个，先取消一个再选`;
                        counter.className = 'eo-bad';
                        return;
                    }
                    selSet.add(t);
                }
                b.className = 'eo-btn eo-subtype' + (selSet.has(t) ? ' eo-subtype-on' : '');
                prefs.eventSubTypes = Array.from(selSet);
                paintCounter();
            });
            subBox.appendChild(b);
        }
        subWrap.appendChild(subBox);
        page.appendChild(subWrap);
        paintCounter();
        page.appendChild(counter);

        page.appendChild(el('div', 'eo-sec', '体验偏好'));
        page.appendChild(el('div', 'eo-hint',
            '这里是「这次想玩什么样的体验」，会原样写进生成大纲的提示词，模型按你的选择决定难度和危险程度。不确定选哪个的，留着「根据当前情况自行设定」就行，模型会自己配一套合理的。'));

        // 单项下拉（大致模式下的档位、详细模式下的子项都用它）
        function makeSelect(row, labelText, options, current, onChange) {
            const lab = el('label', null, labelText);
            lab.style.minWidth = '92px';
            row.appendChild(lab);
            const sel = el('select', 'eo-sel');
            sel.style.flex = '1';
            for (const opt of options) {
                const o = el('option', null, opt.label);
                o.value = opt.value;
                sel.appendChild(o);
            }
            sel.value = current;
            sel.addEventListener('change', () => onChange(sel.value));
            row.appendChild(sel);
            return sel;
        }

        // 重绘某个分组的内容区（折叠壳与按钮不动）
        function paintGroup(groupName, body, hintSpan) {
            body.textContent = '';
            const mode = groupMode[groupName];
            const def = PREF_PRESETS[groupName];
            const items = PREF_GROUPS.filter(x => x.group === groupName);

            if (hintSpan) {
                hintSpan.textContent = mode === 'rough'
                    ? `选一个粗档位（含「${PREF_AUTO_NEW}」），${items.length} 个子项一次定好`
                    : '逐项挑，可以拼出档位覆盖不了的组合';
            }

            if (mode === 'rough') {
                const row = el('div', 'eo-row');
                const all = presetOptions(groupName, prefs);
                // 全部子项都是默认值时就是「自行设定」；组合拼不出来时也归到这一项
                const cur = matchPreset(groupName, prefs) || 'auto';
                makeSelect(row, '档位',
                    all.map(o => ({ value: o.key, label: o.label })),
                    cur,
                    (v) => {
                        const pick = all.find(o => o.key === v);
                        if (!pick) return;
                        for (const k of Object.keys(pick.values)) prefs[k] = pick.values[k];
                        paintGroup(groupName, body, hintSpan);
                    });
                body.appendChild(row);
                const pick = all.find(o => o.key === cur);
                if (pick) body.appendChild(el('div', 'eo-hint', pick.desc));
                return;
            }

            // 详细模式：逐项列出
            const autoText = autoByText(prefs);
            for (const g of items) {
                const row = el('div', 'eo-row');
                const opts = g.options.map(o => (o === SUB_AUTO ? autoText : o));
                const curVal = prefs[g.key] || autoText;
                makeSelect(row, g.label,
                    opts.map(o => ({ value: o, label: o })),
                    // 历史值可能是另一句文案，归一化后选中
                    opts.includes(curVal) ? curVal : autoText,
                    (v) => { prefs[g.key] = v; });
                body.appendChild(row);
            }
        }

        let curGroup = null;
        // 各组内容区的重绘函数，供委托等级变化时统一刷新「自行设定」文案
        const groupPainters = {};
        function repaintAllGroups() {
            for (const name of Object.keys(groupPainters)) {
                try { groupPainters[name](); } catch (e) { warn('重绘偏好分组失败：' + name, e); }
            }
        }
        for (const g of PREF_GROUPS) {
            const isGrouped = !!g.group && !!PREF_PRESETS[g.group];

            if (!isGrouped) {
                // 独立项：直接一行（委托等级在这里）
                const row = el('div', 'eo-row');
                makeSelect(row, g.label,
                    g.options.map(o => ({ value: o, label: o })),
                    prefs[g.key] || PREF_AUTO_NEW,
                    (v) => {
                        prefs[g.key] = v;
                        // 委托等级变了，下面各组的「自行设定」文案要跟着变
                        if (g.key === 'commissionLevel') repaintAllGroups();
                    });
                page.appendChild(row);
                continue;
            }

            if (g.group !== curGroup) {
                curGroup = g.group;
                const box = el('details', 'eo-prefgroup');
                box.open = false;
                const sum = el('summary', 'eo-prefgroup-sum');
                const count = PREF_GROUPS.filter(x => x.group === g.group).length;
                sum.textContent = `${g.group}（${count} 项）`;
                box.appendChild(sum);

                const modeRow = el('div', 'eo-row eo-prefmode');
                const btns = {};
                const hintSpan = el('span', 'eo-hint', '');
                const body = el('div', 'eo-prefgroup-body');
                const paintModes = () => {
                    for (const mk of ['rough', 'detail']) {
                        btns[mk].className = 'eo-btn eo-modebtn' + (groupMode[g.group] === mk ? ' eo-modebtn-on' : '');
                    }
                };
                for (const [mk, ml] of [['rough', '大致'], ['detail', '详细']]) {
                    const b = el('button', 'eo-btn eo-modebtn', ml);
                    b.type = 'button';
                    b.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (groupMode[g.group] === mk) return;
                        groupMode[g.group] = mk;
                        paintModes();
                        paintGroup(g.group, body, hintSpan);
                    });
                    btns[mk] = b;
                    modeRow.appendChild(b);
                }
                modeRow.appendChild(hintSpan);
                box.appendChild(modeRow);
                box.appendChild(body);
                page.appendChild(box);

                paintModes();
                paintGroup(g.group, body, hintSpan);
                // 登记，供委托等级切换时刷新文案（重绘内容区，折叠壳不动）
                groupPainters[g.group] = () => paintGroup(g.group, body, hintSpan);
            }
        }

        const extraRow = el('div', 'eo-row');
        extraRow.appendChild(el('label', null, '额外要求'));
        const extraInput = el('input', 'eo-input');
        extraInput.type = 'text';
        extraInput.value = prefs.extra || '无';
        extraInput.addEventListener('input', () => { prefs.extra = extraInput.value; });
        extraInput.style.flex = '1';
        extraRow.appendChild(extraInput);
        page.appendChild(extraRow);

        // 上下文预览
        const ctxBox = el('div', 'eo-box eo-ctx-preview');
        ctxBox.textContent = '正在统计上下文…';
        page.appendChild(ctxBox);
        refreshCtxPreview(ctxBox);

        const opOut = el('div', 'eo-hint');
        const goRow = el('div', 'eo-row');
        const btnGo = el('button', 'eo-btn eo-primary', '开始生成大纲');
        // 生成中 / 切页回来后恢复按钮状态：busy 是模块级变量，切换标签页不会丢，
        // 但每次 renderPanel 都会新建按钮，所以要按 busy 重新禁用
        if (busy) {
            btnGo.disabled = true;
            btnGo.textContent = '正在生成…';
        }
        btnGo.addEventListener('click', async () => {
            if (busy) return;
            const name = String(nameInput.value || '').trim();
            // 事件名可以留空：留空就由模型根据当前剧情自己起名
            prefs.extra = String(extraInput.value || '无').trim() || '无';
            btnGo.disabled = true;
            btnGo.textContent = '正在生成…';
            opOut.className = 'eo-hint';
            opOut.textContent = '正在生成大纲，请稍候…';
            try {
                const event = await createEvent(name, prefs);
                const nodeN = (event.outline && event.outline.nodes || []).length;
                log(`生成大纲成功：${event.name}，节点 ${nodeN} 个，世界书条目 uid=${event.entryUid}`);
                resetDraftPrefs();
                opOut.className = 'eo-ok';
                opOut.textContent = `已生成：${event.name}，世界书条目 uid=${event.entryUid}`;
                activeTab = 'gen';
                renderPanel();
            } catch (e) {
                error('生成大纲失败：', e);
                opOut.className = 'eo-bad';
                opOut.textContent = '生成失败：' + (e && e.message || e);
            } finally {
                btnGo.disabled = false;
                btnGo.textContent = '开始生成大纲';
            }
        });
        goRow.appendChild(btnGo);
        page.appendChild(goRow);
        page.appendChild(opOut);
        // 进度条挂在这里，紧跟按钮下方
        const ph = el('div');
        ph.id = 'eo_progress_host';
        page.appendChild(ph);
        if (progress.steps.length) renderProgress();
    }

    async function refreshCtxPreview(box) {
        try {
            const resolved = resolveAdapter();
            const s = getSettings();
            const context = ctx();
            const chatLen = ((context && context.chat) || []).filter(m => m && !m.is_system && String(m.mes || '').trim()).length;
            const lines = [
                `记忆来源：${resolved.adapter.describe()}${resolved.degraded ? '（已降级）' : ''}`,
                `最近楼层：${Math.max(1, Number(s.memory.recentFloors) || 15)} 楼（可用 ${chatLen} 楼）`,
                `世界书：${getCharacterBookName() || '（角色未绑定）'}`,
            ];
            if (resolved.adapter.id === 'shujuku-jiyao' && resolved.adapter.rows) {
                const rows = resolved.adapter.rows();
                const mode = resolved.adapter.mode ? resolved.adapter.mode() : null;
                const modeName = MODE_LABEL[mode] || mode || '未识别';
                lines.push(`纪要：${rows.length} 条（${modeName}模式，取最近 ${s.memory.jiyaoRecentRows} 条）`);
            }
            box.textContent = lines.join('\n');
        } catch (e) {
            box.textContent = '上下文统计失败：' + (e && e.message || e);
        }
    }

    // ---------- 页：盘点 ----------

    function renderInvPage(page) {
        const ev = getCurrentEvent();
        if (!ev) {
            page.appendChild(el('div', 'eo-hint', '当前没有进行中的事件。请先到「生成事件」页开一个。'));
            return;
        }

        const opOut = el('div', 'eo-hint');
        const row = el('div', 'eo-row');
        const btnInv = el('button', 'eo-btn eo-primary', '开始盘点');
        if (busy) { btnInv.disabled = true; btnInv.textContent = '正在盘点…'; }
        btnInv.addEventListener('click', async () => {
            if (busy) return;
            btnInv.disabled = true;
            btnInv.textContent = '正在盘点…';
            opOut.className = 'eo-hint';
            opOut.textContent = '正在盘点…';
            try {
                const r = await runInventory();
                log(`第 ${r.record.round} 次盘点完成，世界书条目已更新（uid=${r.event.entryUid}）`);
                opOut.className = 'eo-ok';
                opOut.textContent = `第 ${r.record.round} 次盘点完成，已更新世界书条目 uid=${r.event.entryUid}`;
                renderPanel();
            } catch (e) {
                error('盘点失败：', e);
                opOut.className = 'eo-bad';
                opOut.textContent = '盘点失败：' + (e && e.message || e);
            } finally {
                btnInv.disabled = false;
                btnInv.textContent = '开始盘点';
            }
        });
        row.appendChild(btnInv);

        const mode = getSettings().tracker.mode;
        row.appendChild(el('span', 'eo-hint', `打勾模式：${TRACKER_MODES[mode] || mode}`));
        page.appendChild(row);
        page.appendChild(opOut);
        const invPh = el('div');
        invPh.id = 'eo_progress_host';
        page.appendChild(invPh);
        if (progress.steps.length) renderProgress();

        // 节点进度
        const nodes = (ev.outline && ev.outline.nodes) || [];
        if (Array.isArray(nodes) && nodes.length) {
            const triggered = new Set(ev.tracker.triggeredNodes || []);
            const pending = new Set(ev.tracker.pendingNodes || []);
            const mode = getSettings().tracker.mode;

            // 半自动：待确认建议单独列一块，放在节点清单上面
            if (mode === 'semi' && pending.size) {
                page.appendChild(el('div', 'eo-sec', `待确认的建议（${pending.size} 条，模型认为已达成）`));
                page.appendChild(el('div', 'eo-hint',
                    '这些是模型在这一轮剧情里认为碰到的节点。点「确认」才算真正打勾，点「忽略」就不算；不处理的话，下次盘点会被新建议覆盖。'));
                const pb = el('div', 'eo-box');
                for (const id of Array.from(pending).sort((a, b) => a - b)) {
                    const node = nodes.find(n => nodeId(n) === id);
                    const row = el('div', 'eo-suggest');
                    const txt = el('span', null, `${id}. ${(node && (node.type || '')) || ''} ${(node && nodeText(node)) || '（大纲里找不到这个节点）'}`);
                    row.appendChild(txt);
                    const bOk = el('button', 'eo-btn eo-primary', '确认');
                    bOk.addEventListener('click', (e) => {
                        e.stopPropagation();
                        confirmPending(id);
                        renderPanel();
                    });
                    const bNo = el('button', 'eo-btn', '忽略');
                    bNo.addEventListener('click', (e) => {
                        e.stopPropagation();
                        dismissPending(id);
                        renderPanel();
                    });
                    row.appendChild(bOk);
                    row.appendChild(bNo);
                    pb.appendChild(row);
                }
                page.appendChild(pb);
            }

            page.appendChild(el('div', 'eo-sec', `节点进度（${triggered.size}/${nodes.length}，点击切换）`));
            const nb = el('div', 'eo-box');
            for (const n of nodes) {
                const id = nodeId(n);
                const on = triggered.has(id);
                const isPending = pending.has(id);
                const line = el('div', 'eo-node' + (on ? ' eo-node-on' : '') + (isPending ? ' eo-node-suggest' : ''));
                line.textContent = `${on ? '☑' : (isPending ? '◐' : '☐')} ${id}. ${n.type || ''} ${nodeText(n)}`
                    + (nodeTrigger(n) ? `（${nodeTrigger(n)}）` : '')
                    + (isPending ? '　← 模型建议，待确认' : '');
                line.addEventListener('click', () => {
                    toggleNode(id);
                    renderPanel();
                });
                nb.appendChild(line);
            }
            page.appendChild(nb);

            const core = (ev.outline && ev.outline.core_truth) || '';
            if (core) {
                const c = el('div', 'eo-hint');
                c.textContent = `核心真相（禁止透露）：${core}`;
                page.appendChild(c);
            }
        } else {
            page.appendChild(el('div', 'eo-hint', '大纲解析出的节点清单为空，请到「日志」页查看原始输出。'));
        }

        // 盘点记录
        const invs = ev.inventories || [];
        page.appendChild(el('div', 'eo-sec', `盘点记录（${invs.length} 次）`));
        if (!invs.length) {
            page.appendChild(el('div', 'eo-hint', '还没有盘点过。'));
        } else {
            for (const rec of invs.slice().reverse()) {
                const det = el('details', 'eo-details');
                det.appendChild(el('summary', null,
                    `第 ${rec.round} 次｜${String(rec.at || '').slice(0, 19)}`
                    + (rec.committedToBook ? '｜已入库' : '｜未入库')));
                const box = el('div', 'eo-box');
                box.textContent = rec.raw;
                det.appendChild(box);
                page.appendChild(det);
            }
        }
    }

    // ---------- 页：日志 ----------

    // 日志页的级别筛选：记在模块级，切页签不丢；'all' = 全部
    let logFilter = 'all';

    function renderRuntimeLogSection(page) {
        const head = el('div', 'eo-sec eo-sec-inline');
        head.appendChild(el('span', null, '扩展运行日志'));
        head.appendChild(el('span', 'eo-hint', `（${runtimeLog.length} 条，最多保留 ${RUNTIME_LOG_MAX}）`));
        page.appendChild(head);
        page.appendChild(el('div', 'eo-hint',
            '这里记录扩展自己做过的事：挂载、读写世界书、记忆适配器判定、生成与解析、打勾变更、报错。只存在内存里，刷新页面就清空，不会写进聊天记录。'));

        // 级别筛选
        const cnt = { debug: 0, info: 0, warn: 0, error: 0 };
        for (const l of runtimeLog) if (cnt[l.level] != null) cnt[l.level]++;
        const fRow = el('div', 'eo-row eo-logfilter');
        const mkBtn = (key, label) => {
            const b = el('button', 'eo-btn eo-filterbtn' + (logFilter === key ? ' eo-filterbtn-on' : ''), label);
            b.type = 'button';
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                logFilter = key;
                renderPanel();
            });
            fRow.appendChild(b);
        };
        mkBtn('all', `全部 ${runtimeLog.length}`);
        for (const lv of LOG_LEVELS) mkBtn(lv, `${LOG_LEVEL_LABEL[lv]} ${cnt[lv]}`);
        page.appendChild(fRow);

        if (!debugEnabled()) {
            const tip = el('div', 'eo-hint');
            tip.textContent = '调试级日志默认不收集。需要看细节时到「设置」页打开「调试日志」，再回来就能看到。';
            page.appendChild(tip);
        }

        // 只收调试级却一条都没有，说明这不只是筛选问题
        const shown = logFilter === 'all' ? runtimeLog : runtimeLog.filter(l => l.level === logFilter);
        if (!shown.length) {
            page.appendChild(el('div', 'eo-hint',
                runtimeLog.length ? '这个级别下暂时没有记录，点上面的「全部」看其它级别。' : '还没有记录。'));
            return;
        }
        const box = el('div', 'eo-box eo-logbox');
        box.textContent = shown.map(l =>
            `${l.at} ${LOG_LEVEL_LABEL[l.level] || l.level}｜${l.text}`
        ).join(String.fromCharCode(10));
        page.appendChild(box);
        // 日志按时间正序排，最新一条在最下面：渲染完直接滚到底，一进来就看到最新的
        const toBottom = () => { box.scrollTop = box.scrollHeight; };
        toBottom();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(toBottom);
        setTimeout(toBottom, 60);
        const btn = el('button', 'eo-btn', '清空运行日志');
        btn.addEventListener('click', () => {
            runtimeLog.length = 0;
            renderPanel();
        });
        const r = el('div', 'eo-row');
        r.appendChild(btn);
        page.appendChild(r);
    }

    function renderLogPage(page) {
        // 运行日志放最上面：它是「扩展是否在正常工作」的全貌，
        // 与下面的事件状态是两件事，没在进行中的事件也要能看到。
        renderRuntimeLogSection(page);

        const ev = getCurrentEvent();
        if (!ev) {
            page.appendChild(el('div', 'eo-sec', '当前事件状态'));
            page.appendChild(el('div', 'eo-hint', '当前没有进行中的事件，没有可观察的事件状态。'));
            const hist = listEvents();
            if (hist.length) {
                page.appendChild(el('div', 'eo-sec', '历史事件'));
                const b = el('div', 'eo-box');
                b.textContent = hist.map(e =>
                    `${e.status === 'active' ? '●' : '○'} ${e.name}｜${e.status}｜${String(e.createdAt || '').slice(0, 19)}`
                ).join('\n');
                page.appendChild(b);
            }
            return;
        }

        const t = ev.tracker || {};
        const lines = [];
        lines.push(`事件：${ev.name}（${ev.status}）`);
        lines.push(`创建：${String(ev.createdAt || '').slice(0, 19)}`);
        lines.push(`已触发节点：${(t.triggeredNodes || []).join('、') || '无'}`);
        lines.push(`已推翻误导：${(t.refutedMisleads || []).join('、') || '无'}`);
        lines.push(`人工否决：${(t.nodeVetoed || []).join('、') || '无'}`);
        const pend = t.pendingNodes || [];
        if (pend.length) lines.push(`待确认建议：${pend.join('、')}（半自动模式，等你点确认）`);
        const offPath = t.offPathBranches || [];
        lines.push(`大纲外路径：${offPath.length ? offPath.map(o => `【大纲外】${o.desc}`).join('；') : '无'}`);
        if (offPath.some(o => o.reason)) {
            lines.push('　理由：' + offPath.filter(o => o.reason).map(o => o.reason).join('；'));
        }
        page.appendChild(el('div', 'eo-sec', '当前事件状态'));
        const sb = el('div', 'eo-box');
        sb.textContent = lines.join('\n');
        page.appendChild(sb);

        // 自动打勾记录
        const auto = t.autoCommitted || [];
        page.appendChild(el('div', 'eo-sec', `自动打勾记录（${auto.length} 条）`));
        if (!auto.length) {
            page.appendChild(el('div', 'eo-hint', '暂无自动打勾。切换到自动模式后，模型判定的触发节点会记录在这里。'));
        } else {
            const ab = el('div', 'eo-box');
            ab.textContent = auto.map(a =>
                `第 ${a.round} 次盘点｜节点 ${a.node}｜${String(a.at || '').slice(0, 19)}`
            ).join('\n');
            page.appendChild(ab);
        }

        // 世界书条目内容
        page.appendChild(el('div', 'eo-sec', '世界书条目'));
        const eb = el('div', 'eo-box');
        eb.textContent = buildEntryContent(ev, (ev.inventories || []).length);
        page.appendChild(eb);

        const btn = el('button', 'eo-btn', '刷新');
        btn.addEventListener('click', () => renderPanel());
        const r = el('div', 'eo-row');
        r.appendChild(btn);
        page.appendChild(r);

        // 历史事件
        const hist = listEvents().filter(e => e.id !== ev.id);
        if (hist.length) {
            page.appendChild(el('div', 'eo-sec', '历史事件'));
            const b = el('div', 'eo-box');
            b.textContent = hist.map(e =>
                `${e.status === 'active' ? '●' : '○'} ${e.name}｜${e.status}｜${String(e.createdAt || '').slice(0, 19)}`
            ).join('\n');
            page.appendChild(b);
        }
    }

    // ---------- 页：设置 ----------

    function renderSetPage(page) {
        // --- API ---
        page.appendChild(el('div', 'eo-sec', '模型 API'));
        const s = getSettings();

        // 使用哪套配置
        const apiRow = el('div', 'eo-row');
        apiRow.appendChild(el('label', null, '使用配置'));
        const apiSel = el('select', 'eo-sel');
        apiSel.style.flex = '1';
        for (const p of s.apiProfiles) {
            const o = el('option', null, p.name + (p.mode === 'main' ? '' : p.mode === 'direct' ? '（直连）' : '（酒馆连接源）'));
            o.value = p.id;
            apiSel.appendChild(o);
        }
        apiSel.value = s.activeProfileId;
        apiSel.addEventListener('change', () => {
            getSettings().activeProfileId = apiSel.value;
            saveSettings();
            const p = (getSettings().apiProfiles || []).find(x => x.id === apiSel.value);
            log(`模型 API 已切换为「${p ? p.name : apiSel.value}」`);
            renderPanel();
        });
        apiRow.appendChild(apiSel);
        page.appendChild(apiRow);

        const cur = (s.apiProfiles || []).find(p => p.id === s.activeProfileId) || { mode: 'main' };
        page.appendChild(el('div', 'eo-hint',
            cur.mode === 'main'
                ? '跟随酒馆主连接：用酒馆当前选的模型和连接，最省心。'
                : cur.mode === 'direct'
                    ? '直连：扩展自己请求你填的接口，与酒馆主模型完全独立。'
                    : '酒馆连接源：调用酒馆里已配好的连接，可以指定模型名。'));

        // 配置档列表：每行一套，可以编辑/删除
        const listHead = el('div', 'eo-sec eo-sec-inline');
        listHead.appendChild(el('span', null, '配置档'));
        page.appendChild(listHead);

        for (const p of s.apiProfiles) {
            const box = el('details', 'eo-prefgroup');
            box.open = false;
            const sum = el('summary', 'eo-prefgroup-sum');
            sum.textContent = `${p.name}${p.mode === 'main' ? '（跟随酒馆）' : p.mode === 'direct' ? '（直连）' : '（酒馆连接源）'}`;
            box.appendChild(sum);
            const body = el('div', 'eo-prefgroup-body');

            if (p.mode === 'main') {
                body.appendChild(el('div', 'eo-hint', '这套配置不需要填写任何东西，永远跟随酒馆当前连接。'));
            } else {
                const nameRow2 = el('div', 'eo-row');
                nameRow2.appendChild(el('label', null, '名称'));
                const nameIn = el('input', 'eo-input');
                nameIn.type = 'text';
                nameIn.value = p.name || '';
                nameIn.style.flex = '1';
                nameRow2.appendChild(nameIn);
                body.appendChild(nameRow2);

                const modeRow2 = el('div', 'eo-row');
                modeRow2.appendChild(el('label', null, '方式'));
                const modeSel = el('select', 'eo-sel');
                for (const [mv, ml] of [['tavern', '走酒馆连接源'], ['direct', '直连接口']]) {
                    const o = el('option', null, ml);
                    o.value = mv;
                    modeSel.appendChild(o);
                }
                modeSel.value = p.mode;
                modeSel.addEventListener('change', () => {
                    const t = (getSettings().apiProfiles || []).find(x => x.id === p.id);
                    if (t) { t.mode = modeSel.value; saveSettings(); }
                    renderPanel();
                });
                modeRow2.appendChild(modeSel);
                body.appendChild(modeRow2);

                if (p.mode === 'tavern') {
                    const apiRow2 = el('div', 'eo-row');
                    apiRow2.appendChild(el('label', null, '连接源'));
                    const apiSel2 = el('select', 'eo-sel');
                    const o0 = el('option', null, '（跟随酒馆当前连接源）');
                    o0.value = '';
                    apiSel2.appendChild(o0);
                    for (const [av, al] of TAVERN_APIS) {
                        const o = el('option', null, al);
                        o.value = av;
                        apiSel2.appendChild(o);
                    }
                    apiSel2.value = p.api || '';
                    apiSel2.addEventListener('change', () => {
                        const t = (getSettings().apiProfiles || []).find(x => x.id === p.id);
                        if (t) { t.api = apiSel2.value; saveSettings(); }
                    });
                    apiRow2.appendChild(apiSel2);
                    body.appendChild(apiRow2);

                    const mRow = el('div', 'eo-row');
                    mRow.appendChild(el('label', null, '模型名'));
                    const mIn = el('input', 'eo-input');
                    mIn.type = 'text';
                    mIn.placeholder = '留空=跟随酒馆当前模型';
                    mIn.value = p.model || '';
                    mIn.style.flex = '1';
                    mIn.addEventListener('change', () => {
                        const t = (getSettings().apiProfiles || []).find(x => x.id === p.id);
                        if (t) { t.model = mIn.value.trim(); saveSettings(); }
                    });
                    mRow.appendChild(mIn);
                    body.appendChild(mRow);

                    const rRow = el('div', 'eo-row');
                    rRow.appendChild(el('label', null, '输出上限'));
                    const rIn = el('input', 'eo-input');
                    rIn.type = 'number';
                    rIn.min = '0';
                    rIn.step = '100';
                    rIn.placeholder = '0=用酒馆当前设置';
                    rIn.value = String(Number(p.responseLength) || 0);
                    rIn.style.width = '90px';
                    rIn.addEventListener('change', () => {
                        const t = (getSettings().apiProfiles || []).find(x => x.id === p.id);
                        if (t) { t.responseLength = Number(rIn.value) || 0; saveSettings(); }
                    });
                    rRow.appendChild(rIn);
                    body.appendChild(rRow);
                } else {
                    const uRow = el('div', 'eo-row');
                    uRow.appendChild(el('label', null, '接口地址'));
                    const uIn = el('input', 'eo-input');
                    uIn.type = 'text';
                    uIn.placeholder = 'https://api.example.com/v1';
                    uIn.value = p.baseUrl || '';
                    uIn.style.flex = '1';
                    uIn.addEventListener('change', () => {
                        const t = (getSettings().apiProfiles || []).find(x => x.id === p.id);
                        if (t) { t.baseUrl = uIn.value.trim(); saveSettings(); }
                    });
                    uRow.appendChild(uIn);
                    body.appendChild(uRow);

                    const kRow = el('div', 'eo-row');
                    kRow.appendChild(el('label', null, '密钥'));
                    const kIn = el('input', 'eo-input');
                    kIn.type = 'password';
                    kIn.placeholder = 'sk-…';
                    kIn.value = p.apiKey || '';
                    kIn.style.flex = '1';
                    kIn.addEventListener('change', () => {
                        const t = (getSettings().apiProfiles || []).find(x => x.id === p.id);
                        if (t) { t.apiKey = kIn.value.trim(); saveSettings(); }
                    });
                    kRow.appendChild(kIn);
                    body.appendChild(kRow);

                    const mRow2 = el('div', 'eo-row');
                    mRow2.appendChild(el('label', null, '模型名'));
                    const mIn2 = el('input', 'eo-input');
                    mIn2.type = 'text';
                    mIn2.placeholder = '如 deepseek-chat';
                    mIn2.value = p.model || '';
                    mIn2.style.flex = '1';
                    mIn2.addEventListener('change', () => {
                        const t = (getSettings().apiProfiles || []).find(x => x.id === p.id);
                        if (t) { t.model = mIn2.value.trim(); saveSettings(); }
                    });
                    mRow2.appendChild(mIn2);
                    body.appendChild(mRow2);

                    const tRow = el('div', 'eo-row');
                    tRow.appendChild(el('label', null, '温度'));
                    const tIn = el('input', 'eo-input');
                    tIn.type = 'number';
                    tIn.min = '0';
                    tIn.max = '2';
                    tIn.step = '0.1';
                    tIn.value = String(Number.isFinite(Number(p.temperature)) ? Number(p.temperature) : 1);
                    tIn.style.width = '76px';
                    tIn.addEventListener('change', () => {
                        const t = (getSettings().apiProfiles || []).find(x => x.id === p.id);
                        if (t) { t.temperature = Number(tIn.value); saveSettings(); }
                    });
                    tRow.appendChild(tIn);
                    tRow.appendChild(el('span', 'eo-hint', '0-2，越高越发散；结构化输出建议 0.7 以下'));
                    body.appendChild(tRow);

                    const xRow = el('div', 'eo-row');
                    xRow.appendChild(el('label', null, '输出上限'));
                    const xIn = el('input', 'eo-input');
                    xIn.type = 'number';
                    xIn.min = '0';
                    xIn.step = '100';
                    xIn.placeholder = '0=不限制';
                    xIn.value = String(Number(p.maxTokens) || 0);
                    xIn.style.width = '90px';
                    xIn.addEventListener('change', () => {
                        const t = (getSettings().apiProfiles || []).find(x => x.id === p.id);
                        if (t) { t.maxTokens = Number(xIn.value) || 0; saveSettings(); }
                    });
                    xRow.appendChild(xIn);
                    body.appendChild(xRow);
                }

                // 保存名称按钮 + 测试 + 删除
                const actRow = el('div', 'eo-row');
                const btnSave = el('button', 'eo-btn', '保存名称');
                btnSave.type = 'button';
                btnSave.addEventListener('click', () => {
                    const t = (getSettings().apiProfiles || []).find(x => x.id === p.id);
                    const nm = String(nameIn.value || '').trim();
                    if (!nm) { nameIn.value = p.name; return; }
                    if (t) { t.name = nm; saveSettings(); }
                    log(`模型配置「${p.name}」已更名为「${nm}」`);
                    renderPanel();
                });
                actRow.appendChild(btnSave);

                const btnTest = el('button', 'eo-btn', '测试连接');
                btnTest.type = 'button';
                const testOut = el('span', 'eo-hint', '');
                btnTest.addEventListener('click', async () => {
                    btnTest.disabled = true;
                    testOut.className = 'eo-hint';
                    testOut.textContent = '测试中…';
                    const prevActive = getSettings().activeProfileId;
                    try {
                        // 临时切到这套配置试一次
                        getSettings().activeProfileId = p.id;
                        const r = await testProfile(p);
                        testOut.className = 'eo-ok';
                        testOut.textContent = `通！${r.ms} 毫秒，返回「${r.sample}」`;
                        log(`配置「${p.name}」测试连接通过：${r.ms} 毫秒`);
                    } catch (e) {
                        testOut.className = 'eo-bad';
                        testOut.textContent = '不通：' + (e && e.message || e);
                    } finally {
                        getSettings().activeProfileId = prevActive;
                        saveSettings();
                        btnTest.disabled = false;
                    }
                });
                actRow.appendChild(btnTest);
                actRow.appendChild(testOut);
                body.appendChild(actRow);

                if (p.id !== 'main') {
                    const delRow = el('div', 'eo-row');
                    const btnDel = el('button', 'eo-btn', '删除这套配置');
                    btnDel.type = 'button';
                    btnDel.addEventListener('click', () => {
                        const st = getSettings();
                        st.apiProfiles = (st.apiProfiles || []).filter(x => x.id !== p.id);
                        if (st.activeProfileId === p.id) st.activeProfileId = 'main';
                        saveSettings();
                        log(`已删除模型配置「${p.name}」`);
                        renderPanel();
                    });
                    delRow.appendChild(btnDel);
                    body.appendChild(delRow);
                }
            }

            box.appendChild(body);
            page.appendChild(box);
        }

        // 新建
        const addRow = el('div', 'eo-row');
        const btnAdd = el('button', 'eo-btn eo-primary', '新建配置');
        btnAdd.type = 'button';
        btnAdd.addEventListener('click', () => {
            const st = getSettings();
            const n = (st.apiProfiles || []).length;
            const id = 'custom-' + Date.now();
            st.apiProfiles.push({
                id,
                name: `自定义配置 ${n}`,
                mode: 'direct',
                baseUrl: '',
                apiKey: '',
                model: '',
                temperature: 1,
                maxTokens: 0,
            });
            saveSettings();
            log(`新建了模型配置「自定义配置 ${n}」，请填写地址、密钥和模型名`);
            renderPanel();
        });
        addRow.appendChild(btnAdd);
        page.appendChild(addRow);

        // --- 记忆来源 ---
        page.appendChild(el('div', 'eo-sec', '记忆来源'));
        const memRow = el('div', 'eo-row');
        memRow.appendChild(el('label', null, '来源'));
        const memSel = el('select', 'eo-sel');
        for (const [k, label] of Object.entries(MEMORY_SOURCES)) {
            const o = el('option', null, label);
            o.value = k;
            memSel.appendChild(o);
        }
        memSel.value = s.memory.source;
        memSel.addEventListener('change', () => {
            getSettings().memory.source = memSel.value;
            saveSettings();
            log(`记忆来源已切换为「${MEMORY_SOURCES[memSel.value] || memSel.value}」`);
            renderPanel();
        });
        memRow.appendChild(memSel);
        page.appendChild(memRow);

        const resolved = resolveAdapter();
        const memInfo = el('div', resolved.degraded ? 'eo-warn' : 'eo-hint');
        memInfo.textContent = resolved.degraded
            ? `已选「${MEMORY_SOURCES[resolved.wanted] || resolved.wanted}」，但当前对话没有可用数据，已自动降级为：${resolved.adapter.describe()}`
            : `当前使用：${resolved.adapter.describe()}`;
        page.appendChild(memInfo);

        const flRow = el('div', 'eo-row');
        flRow.appendChild(el('label', null, '最近楼层'));
        const flIn = el('input', 'eo-input');
        flIn.type = 'number';
        flIn.min = '1';
        flIn.max = '100';
        flIn.value = String(s.memory.recentFloors);
        flIn.style.width = '76px';
        flIn.addEventListener('change', () => {
            const v = Math.max(1, Math.min(100, Number(flIn.value) || 15));
            flIn.value = String(v);
            getSettings().memory.recentFloors = v;
            saveSettings();
        });
        flRow.appendChild(flIn);
        flRow.appendChild(el('span', 'eo-hint', '楼'));
        page.appendChild(flRow);

        // --- 角色世界书 ---
        const wbBox = el('div', 'eo-row');
        const wbChk = el('input');
        wbChk.type = 'checkbox';
        wbChk.checked = !(s.worldbook && s.worldbook.enabled === false);
        wbChk.addEventListener('change', () => {
            getSettings().worldbook.enabled = wbChk.checked;
            saveSettings();
            log(`读取角色世界书：${wbChk.checked ? '开' : '关'}`);
            renderPanel();
        });
        wbBox.appendChild(wbChk);
        wbBox.appendChild(el('span', null, '读取角色世界书'));
        page.appendChild(wbBox);

        const wbBook = getCharacterBookName();
        const wbHint = el('div', 'eo-hint');
        if (!wbBook) {
            wbHint.textContent = '当前角色未绑定世界书，此项无效';
        } else if (s.worldbook && s.worldbook.enabled === false) {
            wbHint.textContent = `已关闭，生成时不带「${wbBook}」的任何设定`;
        } else {
            wbHint.textContent = `将带入「${wbBook}」的常驻条目（蓝灯），`
                + '自动剔除 shujuku 导出表、变量格式说明、本扩展事件条目与 EJS 条件模板';
        }
        page.appendChild(wbHint);

        const wbCapRow = el('div', 'eo-row');
        wbCapRow.appendChild(el('label', null, '设定字数上限'));
        const wbCap = el('input', 'eo-input');
        wbCap.type = 'number';
        wbCap.min = '0';
        wbCap.value = String((s.worldbook && s.worldbook.maxChars) || 0);
        wbCap.style.width = '86px';
        wbCap.addEventListener('change', () => {
            const v = Math.max(0, Number(wbCap.value) || 0);
            wbCap.value = String(v);
            getSettings().worldbook.maxChars = v;
            saveSettings();
        });
        wbCapRow.appendChild(wbCap);
        wbCapRow.appendChild(el('span', 'eo-hint', '字，0 = 不限'));
        page.appendChild(wbCapRow);

        // --- shujuku 接入诊断：记忆来源的子项 ---
        // 判定看「实际解析到的适配器」，不是看设置值：
        // 手动选 shujuku → 显示；自动模式下探测到 shujuku → 也显示；
        // 自动模式退到仅最近楼层 → 不显示（那时体检没有意义）
        if (resolved.adapter.id === 'shujuku-jiyao') {
            const sub = el('div', 'eo-sub');
            sub.appendChild(el('div', 'eo-sub-title', '└ shujuku 接入诊断'));
            sub.appendChild(el('div', 'eo-hint',
                s.memory.source === 'auto'
                    ? '自动模式下检测到 shujuku 正在使用，所以这里显示它的体检项：确认它当前用哪种填表模式、纪要表在哪、能不能解析出纪要。哪天自动模式不再命中 shujuku，这一项会自动消失。'
                    : '这段是专门给 shujuku 用的体检：确认它当前用哪种填表模式、纪要表在哪、能不能解析出纪要。它是「记忆来源选 shujuku」时才有的子项，切回别的来源就不显示。'));
            const diagBtn = el('button', 'eo-btn', '体检');
            const diagOut = el('div', 'eo-box');
            diagOut.style.display = 'none';
            diagBtn.addEventListener('click', () => {
                try {
                    diagOut.className = 'eo-box';
                    diagOut.textContent = diagnoseShujuku().join(String.fromCharCode(10));
                    diagOut.style.display = 'block';
                } catch (e) {
                    diagOut.className = 'eo-bad';
                    diagOut.textContent = '诊断失败：' + (e && e.message || e);
                    diagOut.style.display = 'block';
                }
            });
            const diagRow = el('div', 'eo-row');
            diagRow.appendChild(diagBtn);
            sub.appendChild(diagRow);
            sub.appendChild(diagOut);
            page.appendChild(sub);
        }

        // --- 打勾模式 ---
        const trSec = el('div', 'eo-sec eo-sec-inline');
        trSec.appendChild(el('span', null, '打勾模式'));
        const trHelp = el('span', 'eo-help', '?');
        trHelp.title = '「打勾」= 把大纲里的某个节点标成已达成。剧情推进到某个节点时，谁来判断、谁来点，就是这个模式决定的。';
        trHelp.addEventListener('click', (e) => {
            e.stopPropagation();
            const tip = el('div', 'eo-tip');
            tip.textContent = trHelp.title;
            const old = document.querySelector('.eo-tip');
            if (old) old.remove();
            if (trHelp.classList.contains('eo-help-on')) {
                trHelp.classList.remove('eo-help-on');
                return;
            }
            trHelp.classList.add('eo-help-on');
            trHelp.appendChild(tip);
        });
        trSec.appendChild(trHelp);
        page.appendChild(trSec);
        const trRow = el('div', 'eo-row');
        const trSel = el('select', 'eo-sel');
        for (const [k, label] of Object.entries(TRACKER_MODES)) {
            const o = el('option', null, label);
            o.value = k;
            trSel.appendChild(o);
        }
        trSel.value = s.tracker.mode;
        trSel.addEventListener('change', () => {
            getSettings().tracker.mode = trSel.value;
            saveSettings();
            log(`打勾模式已切换为「${TRACKER_MODES[trSel.value] || trSel.value}」`);
            renderPanel();
        });
        trRow.appendChild(trSel);
        page.appendChild(trRow);

        // 三档各占一行，换行显示，避免糊成一段
        const modeLines = {
            auto: '自动：盘点后模型自己判断碰没碰到节点，碰到就直接打勾。你什么都不用管。下面还能设每积累多少层楼自动盘点一次。勾错了点节点「撤销」即可，撤销过的节点以后不会再被自动勾上。',
            semi: '半自动：盘点后模型只给建议，列在盘点页顶部的「待确认的建议」里，节点标成 ◐。点「确认」才算打勾，点「忽略」就不算。适合想保留决定权、又不想自己逐条比对大纲的时候。',
            manual: '手动：模型完全不插手，节点全由你点。适合心里有数、想严格按自己的理解记录进度。',
        };
        const modeList = el('div', 'eo-modes');
        for (const k of ['auto', 'semi', 'manual']) {
            const item = el('div', 'eo-mode' + (s.tracker.mode === k ? ' eo-mode-active' : ''));
            const tag = el('span', 'eo-mode-tag', TRACKER_MODES[k]);
            item.appendChild(tag);
            item.appendChild(el('span', null, modeLines[k].replace(TRACKER_MODES[k] + '：', '')));
            modeList.appendChild(item);
        }
        page.appendChild(modeList);

        // 自动模式的子项：自动盘点的楼层间隔
        if (s.tracker.mode === 'auto') {
            const sub = el('div', 'eo-sub');
            sub.appendChild(el('div', 'eo-sub-title', '└ 自动检测间隔'));
            const afRow = el('div', 'eo-row');
            afRow.appendChild(el('label', null, '每'));
            const afIn = el('input', 'eo-input');
            afIn.type = 'number';
            afIn.min = '0';
            afIn.max = '200';
            afIn.value = String(s.tracker.autoEveryFloors);
            afIn.style.width = '76px';
            afIn.addEventListener('change', () => {
                const v = Math.max(0, Math.min(200, Number(afIn.value) || 0));
                afIn.value = String(v);
                getSettings().tracker.autoEveryFloors = v;
                saveSettings();
                renderPanel();
            });
            afRow.appendChild(afIn);
            afRow.appendChild(el('span', 'eo-hint', '层楼自动盘点一次'));
            sub.appendChild(afRow);

            if (getCurrentEvent()) {
                const cur = countFloors();
                const base = Number(getCurrentEvent().floorBase);
                const since = Number.isFinite(base) ? Math.max(0, cur - base) : 0;
                const every = Math.max(0, Number(s.tracker.autoEveryFloors) || 0);
                const line = el('div', 'eo-hint',
                    every > 0
                        ? `当前对话共 ${cur} 层，距上次盘点已过 ${since} 层，还差 ${Math.max(0, every - since)} 层触发下一次自动盘点。`
                        : `当前对话共 ${cur} 层。填 0 即关闭自动盘点，只在你手动点「开始盘点」时才跑。`);
                sub.appendChild(line);
            }
            sub.appendChild(el('div', 'eo-hint',
                '楼层按「玩家楼 + AI 楼」合计，系统消息不算。基点在新建事件和每次盘点成功后归零重计。触发时机是每收到一条新回复后自动检查，攒够间隔就自己跑一次盘点；填 0 则完全关闭自动盘点。'));

            // 手动触发一次
            const afBtn = el('button', 'eo-btn eo-primary', '现在盘点一次');
            afBtn.addEventListener('click', async () => {
                try {
                    afBtn.disabled = true;
                    afBtn.textContent = '盘点中…';
                    await runInventory();
                    renderPanel();
                } catch (e) {
                    afBtn.disabled = false;
                    afBtn.textContent = '现在盘点一次';
                    alert('盘点失败：' + (e && e.message || e));
                }
            });
            const afRow2 = el('div', 'eo-row');
            afRow2.appendChild(afBtn);
            sub.appendChild(afRow2);
            page.appendChild(sub);
        }

        page.appendChild(el('div', 'eo-hint',
            '无论哪一档，已触发的节点都会写进世界书条目，供模型下一轮参考。'));

        // --- shujuku 诊断已上移到「记忆来源」子项（见上） ---

        // --- 保留数量 ---
        const retSec = el('div', 'eo-sec eo-sec-inline');
        retSec.appendChild(el('span', null, '历史保留'));
        const retHelp = el('span', 'eo-help', '?');
        retHelp.title = '事件完结或废弃后，事件卡不会立刻消失，而是留在这里当历史。这两个数字是分别保留多少条：超出上限时按结束时间从旧到新删掉最老的。进行中的事件永远不会被清掉。';
        retHelp.addEventListener('click', (e) => {
            e.stopPropagation();
            const old = document.querySelector('.eo-tip');
            if (old) old.remove();
            if (retHelp.classList.contains('eo-help-on')) {
                retHelp.classList.remove('eo-help-on');
                return;
            }
            retHelp.classList.add('eo-help-on');
            const tip = el('div', 'eo-tip');
            tip.textContent = retHelp.title;
            retHelp.appendChild(tip);
        });
        retSec.appendChild(retHelp);
        page.appendChild(retSec);
        const retRow = el('div', 'eo-row');
        retRow.appendChild(el('label', null, '完结'));
        const inDone = el('input', 'eo-input');
        inDone.type = 'number';
        inDone.min = '1';
        inDone.max = '100';
        inDone.value = String(s.retention.completed);
        inDone.style.width = '76px';
        inDone.addEventListener('change', () => {
            const v = Math.max(1, Math.min(100, Number(inDone.value) || 20));
            inDone.value = String(v);
            getSettings().retention.completed = v;
            saveSettings();
        });
        retRow.appendChild(inDone);
        retRow.appendChild(el('span', 'eo-hint', '废弃'));
        const inAban = el('input', 'eo-input');
        inAban.type = 'number';
        inAban.min = '1';
        inAban.max = '50';
        inAban.value = String(s.retention.abandoned);
        inAban.style.width = '76px';
        inAban.addEventListener('change', () => {
            const v = Math.max(1, Math.min(50, Number(inAban.value) || 3));
            inAban.value = String(v);
            getSettings().retention.abandoned = v;
            saveSettings();
        });
        retRow.appendChild(inAban);
        page.appendChild(retRow);

        // --- 界面 ---
        page.appendChild(el('div', 'eo-sec', '界面'));
        const fabRow = el('div', 'eo-row');
        fabRow.appendChild(el('label', null, '悬浮窗'));
        const fabChk = el('input');
        fabChk.type = 'checkbox';
        fabChk.checked = !!s.ui.floatingEnabled;
        fabChk.addEventListener('change', () => {
            getSettings().ui.floatingEnabled = fabChk.checked;
            saveSettings();
            ensureFab();
        });
        fabRow.appendChild(fabChk);
        fabRow.appendChild(el('span', 'eo-hint', '关闭后仍可从扩展菜单打开'));
        page.appendChild(fabRow);

        // 调试日志开关：打开后 debug 级日志才会被收集
        const dbgRow = el('div', 'eo-row');
        dbgRow.appendChild(el('label', null, '调试日志'));
        const dbgChk = el('input');
        dbgChk.type = 'checkbox';
        dbgChk.checked = !!s.debug;
        dbgChk.addEventListener('change', () => {
            getSettings().debug = dbgChk.checked;
            saveSettings();
            debug(`调试日志已${dbgChk.checked ? '开启' : '关闭'}`);
            renderPanel();
        });
        dbgRow.appendChild(dbgChk);
        dbgRow.appendChild(el('span', 'eo-hint', '开启后记录每一步的细节，排障时用；平时建议关掉，免得刷屏'));
        page.appendChild(dbgRow);

        // --- 世界书自检 ---
        page.appendChild(el('div', 'eo-sec', '世界书'));
        const bookRow = el('div', 'eo-row');
        const btnCheck = el('button', 'eo-btn', '自检世界书');
        const checkOut = el('div', 'eo-hint');
        btnCheck.addEventListener('click', async () => {
            btnCheck.disabled = true;
            checkOut.className = 'eo-hint';
            checkOut.textContent = '读取中…';
            try {
                const target = (getCurrentEvent() || {}).worldBook || getCharacterBookName();
                if (!target) throw new Error('该角色未绑定世界书');
                const mine = await listEventEntries(target);
                const data = await readWorldBook(target);
                const total = Object.keys((data && data.entries) || {}).length;
                let foreignExport = 0;
                for (const entry of Object.values((data && data.entries) || {})) {
                    if (String(entry && entry.comment || '').startsWith(SHUJUKU_EXPORT_PREFIX)) foreignExport++;
                }
                checkOut.className = 'eo-ok';
                checkOut.textContent = [
                    `世界书：${target}`,
                    `总条目：${total}`,
                    `本扩展条目：${mine.length}`,
                    `shujuku 导出条目：${foreignExport}`,
                    mine.length ? `明细：${mine.map(m => `${m.uid}(${m.contentLength}字)`).join('、')}` : '明细：无',
                ].join('\n');
            } catch (e) {
                checkOut.className = 'eo-bad';
                checkOut.textContent = '读取失败：' + (e && e.message || e);
            } finally { btnCheck.disabled = false; }
        });
        bookRow.appendChild(btnCheck);

        const btnTest = el('button', 'eo-btn', '写入测试');
        const TEST_MARK = '测试条目（可删）';
        const btnClean = el('button', 'eo-btn', '删除测试');

        btnTest.addEventListener('click', async () => {
            btnTest.disabled = true;
            checkOut.className = 'eo-hint';
            checkOut.textContent = '写入中…';
            try {
                const target = (getCurrentEvent() || {}).worldBook || getCharacterBookName();
                if (!target) throw new Error('该角色未绑定世界书');
                const content = `〔事件大纲｜写入自测｜${new Date().toISOString()}〕\n测试条目，确认无损写入后请点删除。`;
                const r = await upsertEventEntry(target, content, `${ENTRY_PREFIX}${TEST_MARK}`, null);
                checkOut.className = 'eo-ok';
                checkOut.textContent = `写入成功，uid=${r.uid}。其余条目内容校验通过。`;
            } catch (e) {
                checkOut.className = 'eo-bad';
                checkOut.textContent = '写入失败：' + (e && e.message || e);
            } finally { btnTest.disabled = false; }
        });

        btnClean.addEventListener('click', async () => {
            btnClean.disabled = true;
            checkOut.className = 'eo-hint';
            checkOut.textContent = '删除中…';
            try {
                const target = (getCurrentEvent() || {}).worldBook || getCharacterBookName();
                if (!target) throw new Error('该角色未绑定世界书');
                const data = await readWorldBook(target);
                const targets = Object.entries((data && data.entries) || {})
                    .filter(([, e]) => String(e && e.comment || '') === `${ENTRY_PREFIX}${TEST_MARK}`)
                    .map(([uid]) => uid);
                if (!targets.length) {
                    checkOut.className = 'eo-hint';
                    checkOut.textContent = '没有找到测试条目。';
                    return;
                }
                for (const uid of targets) await deleteEventEntry(target, uid);
                checkOut.className = 'eo-ok';
                checkOut.textContent = `已删除 ${targets.length} 条测试条目。`;
            } catch (e) {
                checkOut.className = 'eo-bad';
                checkOut.textContent = '删除失败：' + (e && e.message || e);
            } finally { btnClean.disabled = false; }
        });

        bookRow.appendChild(btnTest);
        bookRow.appendChild(btnClean);
        page.appendChild(bookRow);
        page.appendChild(checkOut);

        const foot = el('div', 'eo-hint', `扩展 v${VERSION}｜日志前缀 ${LOG_PREFIX}`);
        foot.style.marginTop = '14px';
        page.appendChild(foot);
    }

    // ==================== 6. 设置面板入口 ====================

    function addMenuButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById('eo_menu_item')) return;
        const item = document.createElement('div');
        item.id = 'eo_menu_item';
        item.className = 'extension_container interactable';
        item.tabIndex = 0;
        item.innerHTML = '<div class="list-group-item flex-container flexGap5 interactable" tabindex="0">'
            + '<div class="fa-solid fa-list-check extensionsMenuExtensionButton"></div>'
            + '<span>事件大纲</span></div>';
        item.addEventListener('click', () => togglePanel(true));
        menu.appendChild(item);
    }

    // ==================== 7. 入口 ====================

    function init() {
        const context = ctx();
        if (!context) {
            warn('未取到上下文，扩展未初始化');
            return;
        }
        getSettings();
        injectStyle();

        const start = () => {
            ensureFab();
            ensurePanel();
            addMenuButton();
            log(`v${VERSION} 已加载`);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }

        // 菜单按钮可能晚于本扩展渲染
        const timer = setInterval(() => {
            addMenuButton();
            if (document.getElementById('eo_menu_item')) clearInterval(timer);
        }, 1500);
        setTimeout(() => clearInterval(timer), 30000);

        try {
            context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
                if (panelEl && panelEl.classList.contains('eo-open')) renderPanel();
            });
        } catch (e) {
            warn('事件绑定失败', e);
        }

        // 每次 AI 回复落地（玩家楼 + AI 楼各算一层）就检查一次自动盘点
        try {
            context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, () => {
                scheduleAutoInventoryCheck();
            });
            context.eventSource.on(context.eventTypes.GENERATION_ENDED, () => {
                scheduleAutoInventoryCheck();
            });
        } catch (e) {
            warn('自动盘点事件绑定失败', e);
        }
    }

    // 自动盘点：消息事件触发后延迟检查，避免和酒馆自身的渲染抢时序
    let autoCheckTimer = null;
    let autoRunning = false;

    function scheduleAutoInventoryCheck() {
        if (autoCheckTimer) clearTimeout(autoCheckTimer);
        autoCheckTimer = setTimeout(() => {
            autoCheckTimer = null;
            checkAutoInventory().catch(e => warn('自动盘点检查失败', e));
        }, 1200);
    }

    async function checkAutoInventory() {
        if (autoRunning) return;
        const hit = shouldAutoInventory();
        if (!hit) return;
        autoRunning = true;
        try {
            log(`自动盘点触发：距上次盘点已过 ${hit.since} 层（阈值 ${hit.every} 层）`);
            await runInventory();
            log('自动盘点完成');
            if (panelEl && panelEl.classList.contains('eo-open')) renderPanel();
        } catch (e) {
            error('自动盘点失败：' + (e && e.message || e));
        } finally {
            autoRunning = false;
        }
    }

    // 暴露少量调试接口
    window.EventOutline = {
        version: VERSION,
        getSettings,
        resolveAdapter,
        detectShujukuMode,
        listEventEntries,
        getCharacterBookName,
        collectSheetsFromChat,
    };

    init();
})();
