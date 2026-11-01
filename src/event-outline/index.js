/* 事件大纲 / 状态盘点 扩展
 * 单文件，按分区组织。无构建步骤，不使用 import。
 * 分区：0 常量 1 上下文 2 存储 3 世界书 4 适配器 5 界面 6 设置 7 入口
 */
(function () {
    'use strict';

    const MODULE = 'event_outline';
    const VERSION = '0.1.2';
    const ENTRY_PREFIX = '▸事件｜';
    // 待选事件最多留几个：生成不再直接写世界书，草稿得有个上限
    const MAX_DRAFTS = 3;
    const LOG_PREFIX = '[事件大纲]';
    // 换行符常量：正则里的字面换行在编辑路径里容易被吃掉，统一走这个
    const NL = String.fromCharCode(10);

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
        preset: {
            // 自定义难度档位。空数组 = 用内置默认档（日常琐事/小麻烦/正经事件/重大危机/生死关头）
            difficultyLevels: [],
        },
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
        // 旧事件卡的偏好字段（commissionLevel 等）迁移到新结构
        if (event.prefs) normalizePrefs(event.prefs);
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
    async function upsertEventEntry(bookName, content, comment, existingUid, event) {
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

            // 传了事件对象就重新定位：世界书可能被别的插件重排过 uid，
            // 记下的编号未必还指着自己那条，照着旧编号写会覆盖别人的条目。
            if (event) {
                const found = findEventEntryUid(data, event);
                if (found != null && String(found) !== String(existingUid)) {
                    warn(`事件「${event.name}」的条目位置变了：记录 uid=${existingUid}，实际 uid=${found}，按实际位置写入`);
                    uid = found;
                } else if (found != null) {
                    uid = found;
                }
            }

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

    /**
     * 删掉某个事件在世界书里的条目，位置由 findEventEntryUid 现查，
     * 不信 event.entryUid——它可能已经被别的插件重排成了别人的编号。
     */
    async function deleteEventEntryForEvent(bookName, event) {
        const data = await readWorldBook(bookName);
        const found = findEventEntryUid(data, event);
        if (found == null) {
            warn(`事件「${event.name}」在世界书里找不到对应条目，跳过删除`);
            return { deleted: false, reason: '条目不存在' };
        }
        if (String(event.entryUid) !== String(found)) {
            warn(`事件「${event.name}」的条目位置与记录不符：记录 uid=${event.entryUid}，实际 uid=${found}，按实际位置删除`);
        }
        return deleteEventEntry(bookName, found);
    }

    /**
     * 校正事件卡里记的世界书条目位置。
     * 世界书被别的插件整本重写后，entryUid 会指到别人身上，
     * 这里读一次世界书，把每个进行中/待选事件的 uid 纠正回真实位置。
     * 只改本地事件卡，不动世界书内容。
     */
    async function healEntryUids() {
        const meta = getMeta();
        if (!meta || !meta.events) return 0;
        const books = new Set();
        for (const ev of Object.values(meta.events)) {
            if (ev && ev.worldBook && ev.entryUid != null) books.add(ev.worldBook);
        }
        if (!books.size) return 0;

        let fixed = 0;
        for (const book of books) {
            let data;
            try {
                data = await readWorldBook(book);
            } catch (e) {
                warn(`校正条目位置时读取世界书「${book}」失败`, e);
                continue;
            }
            if (!data || !data.entries) continue;
            for (const ev of Object.values(meta.events)) {
                if (!ev || ev.worldBook !== book || ev.entryUid == null) continue;
                const found = findEventEntryUid(data, ev);
                if (found != null && String(found) !== String(ev.entryUid)) {
                    log(`事件「${ev.name}」的条目位置已校正：uid ${ev.entryUid} → ${found}`);
                    ev.entryUid = found;
                    fixed++;
                }
            }
        }
        if (fixed) saveMeta();
        return fixed;
    }

    /** 列出当前世界书里本扩展的条目 */    async function listEventEntries(bookName) {
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

    /**
     * 在已读出的世界书数据里，给一个事件找到它的条目，返回 uid（找不到返回 null）。
     *
     * 为什么不能只信 event.entryUid：世界书是别的东西也能整本重写的，
     * shujuku 这类插件导入条目时会重排 uid，我们记下的编号就指到别人身上去了。
     * 2026-10-31 真实发生过一次：事件记的 uid=49 后来成了 shujuku 的纪要条目，
     * 真正的大纲被挤到 51，下次盘点就会去改别人的条目。
     *
     * 查找按可信度依次降级：
     *   1. 记下的 uid 还在，且注释确实是这个事件的（前缀 + 名字 + chatId 都对得上）
     *   2. 按注释里的 chatId + 事件名精确匹配（uid 被重排过）
     *   3. 按注释里的 chatId 匹配（事件改过名）
     *   4. 只有前缀 + chatId 对不上时，退回名字匹配（极老的条目可能没写 chatId）
     */
    function findEventEntryUid(data, event) {
        const entries = (data && data.entries) || {};
        const name = String(event && event.name || '');
        const chatId = String(event && event.chatId || '');

        // 1. 记下的 uid 仍然有效
        if (event && event.entryUid != null) {
            const hit = entries[event.entryUid];
            if (hit && commentMatchesEvent(hit.comment, name, chatId)) {
                return String(event.entryUid);
            }
        }

        const mine = [];
        for (const [uid, entry] of Object.entries(entries)) {
            const comment = String(entry && entry.comment || '');
            if (comment.startsWith(ENTRY_PREFIX)) mine.push({ uid, comment });
        }

        // 2. chatId + 事件名都命中
        if (chatId && name) {
            const exact = mine.find(m => m.comment.includes(`chatId=${chatId}`) &&
                commentNameOf(m.comment) === name);
            if (exact) return exact.uid;
        }

        // 3. 只有 chatId 命中（事件可能改过名）
        if (chatId) {
            const byChat = mine.filter(m => m.comment.includes(`chatId=${chatId}`));
            if (byChat.length === 1) return byChat[0].uid;
        }

        // 4. 退回名字匹配，仅当恰好一条且它没带别的 chatId（极老的条目可能没写 chatId）
        if (name) {
            const byName = mine.filter(m => commentNameOf(m.comment) === name &&
                !m.comment.includes('chatId='));
            if (byName.length === 1) return byName[0].uid;
        }

        return null;
    }

    function commentMatchesEvent(comment, name, chatId) {
        const c = String(comment || '');
        if (!c.startsWith(ENTRY_PREFIX)) return false;
        if (name && commentNameOf(c) !== name) return false;
        if (chatId && !c.includes(`chatId=${chatId}`)) return false;
        return !!(name || chatId);
    }

    /**
     * 从条目注释里取出事件名。
     * 格式是 `▸事件｜<名字>｜chatId=<对话>`；最早的条目只写了 `▸事件｜<名字>`，
     * 没有第二个分隔符，所以遇到「｜」取第一段，遇不到就整段当名字。
     */
    function commentNameOf(comment) {
        const c = String(comment || '');
        if (!c.startsWith(ENTRY_PREFIX)) return '';
        const rest = c.slice(ENTRY_PREFIX.length);
        const bar = rest.indexOf('｜');
        return bar < 0 ? rest : rest.slice(0, bar);
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
            // shujuku 有数据却选不到时，多半是时序问题：表格写在 AI 回复楼里，
            // 那一轮回复还没落盘就读，自然扫不到。把这点说出来，免得以为是配置错了
            const shujuku = ADAPTERS.find(a => a.id === 'shujuku-jiyao');
            if (picked.id !== 'shujuku-jiyao' && shujuku && !hits.some(a => a.id === 'shujuku-jiyao')) {
                const sheets = collectSheetsFromChat();
                const hint = sheets.size
                    ? `扫到 ${sheets.size} 张表但没有纪要表可用`
                    : '当前楼层里没有任何 shujuku 表格数据';
                warn(`记忆来源：shujuku 纪要本次未检测到（${hint}），已退回最近楼层。`
                    + '如果主对话确实在用 shujuku，可能是那一轮 AI 回复还没把表格写进楼层，等回复完成或硬刷页面后重试');
            }
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

    // 原文存档：事务/运维/酒馆/OOC词-伊瑟利亚-兰开斯特-事件大纲与状态盘点.md
    // 第 12-45 行 = 大纲词，51-63 行 = 盘点词。此处为改良版，差异见设计文档。

    const PREF_AUTO_NEW = '根据当前情况自行设定';

    /**
     * 难度等级的默认档位。
     * 旧的「村中琐事/城镇委托/王国要务/禁忌事件」绑死了奇幻中世纪，换世界观就不合用，
     * 所以改成描述「这件事本身有多难、多危险」的通用档，任何题材都套得上。
     * 用户可以在设置里整组替换成自己角色卡自带的分级。
     */
    const DEFAULT_DIFFICULTY_LEVELS = [
        '日常琐事',
        '小麻烦',
        '正经事件',
        '重大危机',
        '生死关头',
    ];

    // 子项的「交还给上层」选项：难度等级没选时按当前剧情判断，
    // 选了难度等级就改成按那个等级推导
    const PREF_AUTO_BY_LEVEL = '根据难度等级自行设定';
    const PREF_AUTO_BY_NONE = '根据当前情况自行设定';

    /** 当前生效的难度档位列表（用户可在设置里自定义，为空则用内置默认） */
    function getDifficultyLevels() {
        const s = getSettings();
        const custom = (s.preset && Array.isArray(s.preset.difficultyLevels)) ? s.preset.difficultyLevels : null;
        const list = (custom || []).map(x => String(x || '').trim()).filter(Boolean);
        return list.length ? list : DEFAULT_DIFFICULTY_LEVELS.slice();
    }

    /** 某个子项此刻该用哪句「自行设定」文案 */
    function autoByText(prefs) {
        const lv = String((prefs && prefs.difficultyLevel) || '').trim();
        const hasLevel = lv && lv !== PREF_AUTO_NEW;
        return hasLevel ? PREF_AUTO_BY_LEVEL : PREF_AUTO_BY_NONE;
    }

    /**
     * 旧档位名到新默认档位的映射。
     * 旧版本叫「委托等级」，档位是村中琐事/城镇委托/王国要务/禁忌事件，
     * 已存进事件卡的 prefs.commissionLevel 里。改档位体系后不能把旧值丢掉，
     * 按量级对到新档，用户回看旧事件时不至于变成空白。
     */
    const LEGACY_LEVEL_MAP = {
        '村中琐事': '日常琐事',
        '城镇委托': '小麻烦',
        '王国要务': '重大危机',
        '禁忌事件': '生死关头',
    };

    /**
     * 把事件卡里的旧字段迁到新结构。
     * 只做一次性读取时的补齐，不改写已存在的字段。
     */
    function normalizePrefs(prefs) {
        if (!prefs || typeof prefs !== 'object') return prefs;
        if (!prefs.difficultyLevel && prefs.commissionLevel) {
            const old = String(prefs.commissionLevel).trim();
            prefs.difficultyLevel = LEGACY_LEVEL_MAP[old] || old || PREF_AUTO_NEW;
            debug(`偏好迁移：旧字段 commissionLevel「${old}」-> difficultyLevel「${prefs.difficultyLevel}」`);
        }
        // 旧的「根据委托等级自行设定」文案统一换成新说法
        for (const g of PREF_GROUPS) {
            const v = prefs[g.key];
            if (typeof v === 'string' && v.indexOf('委托等级') >= 0) {
                prefs[g.key] = v.replace(/委托等级/g, '难度等级');
            }
        }
        // 容错率/失败后果/超时后果改过文案，按下标逐字段迁移。
        // 不能全局替换：「高/中/低」在致死性里同样合法，混淆会改错值
        const subMap = {
            tolerance: { '高': '高（可多次试错）', '中': '中（两次）', '低': '低（一次即定局）' },
            failureConsequence: { '不可逆的惨重损失': '无法挽回的损失' },
            timeoutConsequence: { '角色死亡或不可逆损失': '局势不可逆转' },
        };
        for (const [k, m] of Object.entries(subMap)) {
            const v = prefs[k];
            if (typeof v === 'string' && m[v]) {
                debug(`偏好迁移：${k}「${v}」-> 「${m[v]}」`);
                prefs[k] = m[v];
            }
        }
        return prefs;
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
            key: 'difficultyLevel',
            label: '难度等级',
            // 选项来自设置里的自定义档位，这里留空由界面动态填充
            options: [],
            dynamic: 'difficulty',
            desc: '这次事件整体的强度档位。选定后，凡是写着「根据难度等级自行设定」的项，都会按这个等级成套推导。',
        },
        {
            key: 'nodeCount',
            label: '节点数量',
            // 影响盘点负担：节点越多，打勾越费事
            desc: '信息节点大致几个。数量多推理更绵密，但盘点时要逐个勾选，负担也更大',
            options: [SUB_AUTO, '少（4-6 个）', '中（7-9 个）', '多（10-14 个）'],
        },
        {
            key: 'castScale',
            label: '参与者规模',
            // 和大纲里的「参与角色」直接对应
            desc: '这次事件牵扯多少人。人多线多，但每个角色的戏份会被摊薄',
            options: [SUB_AUTO, '少数（主角加 1-2 人）', '适中（3-5 人）', '庞大（6 人以上或牵扯势力）'],
        },
        {
            key: 'pacingStructure',
            label: '节奏结构',
            desc: '事件怎么推进。单点突破最快收束，并行多线最能撑开篇幅',
            options: [SUB_AUTO, '单点突破（找到关键即结束）', '多层递进（逐层揭开）', '并行多线（几条线索交替）'],
        },
        {
            key: 'linkPrevious',
            label: '与前事关联',
            // 承接上一个事件遗留的线索，还是完全独立
            desc: '是否接续之前的剧情线索。承接能把废物料再用起来，但要求前面的伏笔还在',
            options: [SUB_AUTO, '完全独立', '承接已有线索', '主动留下后续伏笔'],
        },
        {
            key: 'clueSufficiency',
            label: '线索充足度',
            group: '推理难度',
            desc: '给你的线索够不够。稀缺意味着要靠推理和追问补齐，充足则是关键信息摆在明面上。',
            options: [SUB_AUTO, '充足', '够用', '稀缺'],
        },
        {
            key: 'misleadingStrength',
            label: '误导强度',
            group: '推理难度',
            desc: '有多少信息是故意误导你的。强度越高，越容易出现看似合理但方向错的线索。',
            options: [SUB_AUTO, '无', '轻度', '中度', '重度'],
        },
        {
            key: 'hiddenSegments',
            label: '隐藏环节',
            group: '推理难度',
            desc: '有多少环节不主动告诉你，需要你自己想到。设成需要自行提出关键假设时，事件可能整段藏在你的推断里。',
            options: [SUB_AUTO, '无', '1 个', '2 个', '需玩家自行提出关键假设'],
        },
        {
            key: 'infoPresentation',
            label: '信息呈现',
            group: '推理难度',
            desc: '信息以什么方式呈现。直给是明说，间接要你自己串，隐晦则藏在细节里、可能被忽略。',
            options: [SUB_AUTO, '直给', '间接', '隐晦'],
        },
        {
            key: 'lethality',
            label: '致死性',
            group: '危险程度',
            // 只回答「有多大可能丢命」，后果轻重交给 failureConsequence，
            // 否则两项会互相加强，模型容易理解成「要特别狠」
            desc: '只表示致命风险大小，具体后果看「失败后果」，两项不要叠加理解',
            options: [SUB_AUTO, '无', '低', '中', '高'],
        },
        {
            key: 'failureConsequence',
            label: '失败后果',
            group: '危险程度',
            // 定性取代价，不再重复写「致死」，那是 lethal 的事
            desc: '失误一次要付出什么代价，按严重程度递增；「无法挽回」与致死的区别在于人是活的、但事情废了',
            options: [SUB_AUTO, '仅损失机会', '受伤或被俘', '失去关键物品或盟友', '无法挽回的损失'],
        },
        {
            key: 'tolerance',
            label: '容错率',
            group: '危险程度',
            // 管次数，不管后果轻重：同一个后果可以给三次机会，也可以只给一次
            desc: '允许犯几次错，与后果轻重无关；同一个后果可以给多次机会，也可以一次就废',
            options: [SUB_AUTO, '高（可多次试错）', '中（两次）', '低（一次即定局）'],
        },
        {
            key: 'threatSource',
            label: '威胁来源',
            group: '危险程度',
            desc: '危险从哪来。选多重叠加时，环境、人和时间会同时施压，局势更难控。',
            options: [SUB_AUTO, '环境', '敌对角色', '时间', '自身状态', '多重叠加'],
        },
        {
            key: 'timePressure',
            label: '倒计时',
            group: '时间压力',
            // 只回答「玩家知不知道有个期限」这一个问题，与紧迫感无关；
            // 紧迫感是下面的「时长」，两者不要叠加理解
            desc: '玩家知不知道这件事必须在某个时间点前做完。与紧迫感无关，紧迫感看下面的「时长」',
            options: [SUB_AUTO, '没有硬期限', '有期限但不知道', '有期限且明确知道'],
        },
        {
            key: 'timeDuration',
            label: '时长',
            group: '时间压力',
            // 只回答「节奏有多赶」，与有没有期限无关
            desc: '事件的紧迫感：节奏是宽松还是步步紧逼。与有没有期限无关，期限看上面的「倒计时」',
            options: [SUB_AUTO, '宽松', '适中', '紧张'],
        },
        {
            key: 'timeoutConsequence',
            label: '超时后果',
            group: '时间压力',
            // 只描述「时间耗尽」这一种触发条件下的结局，与「失误」分开；
            // 不再提供「角色死亡」，那种分量的后果交给致死性与失败后果表达
            desc: '仅指时间耗尽时的结局，与失误造成的后果分开表述；不要与致死性叠加',
            options: [SUB_AUTO, '无', '损失机会或信息', '事件走向坏结局', '局势不可逆转'],
        },
        {
            key: 'procrastinationCost',
            label: '拖延代价',
            group: '时间压力',
            desc: '不推进事件的代价。持续损耗是慢慢变糟，阶段性恶化则过一阵会明显坏一截。',
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
        // 值用当前正确的「自行设定」文案（难度等级定了就是「根据难度等级自行设定」）
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
                { key: 'easy', label: '大致·安全', desc: '不会死，错了只损失机会，可以反复试',
                  values: { lethality: '无', failureConsequence: '仅损失机会', tolerance: '高（可多次试错）', threatSource: '环境' } },
                { key: 'normal', label: '大致·常规', desc: '致死风险低，错了受伤或被俘，允许两次',
                  values: { lethality: '低', failureConsequence: '受伤或被俘', tolerance: '中（两次）', threatSource: '敌对角色' } },
                { key: 'hard', label: '大致·凶险', desc: '致死风险中，错了失去关键物品或盟友，一次即定局',
                  values: { lethality: '中', failureConsequence: '失去关键物品或盟友', tolerance: '低（一次即定局）', threatSource: '多重叠加' } },
                { key: 'brutal', label: '大致·致命', desc: '致死风险高，错了就无法挽回，一次即定局',
                  values: { lethality: '高', failureConsequence: '无法挽回的损失', tolerance: '低（一次即定局）', threatSource: '多重叠加' } },
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
                { key: 'brutal', label: '大致·绝命', desc: '隐藏倒计时叠加极度紧张，错过就无法逆转',
                  values: { timePressure: '隐藏', timeDuration: '紧张', timeoutConsequence: '局势不可逆转', procrastinationCost: '阶段性恶化' } },
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
    // 事件名单独存：它不在 prefs 里，但「重置为默认」也要一起清掉
    let draftName = '';

    /**
     * 生成页表单的落盘（2026-11-01）。
     * 以前这些只活在模块级变量里：刷新页面、切走再切回、关掉浏览器就全没了，
     * 填了半天的偏好和框架提示白填。现在每填一格就写进扩展设置（服务端存盘），
     * 打开面板时读回来接着填。
     *
     * 生命周期只有三个出口会清：
     *   1. 点「重置为默认」；
     *   2. 点「采用」待选事件（说明这一套已经用掉了）；
     *   3. 生成成功后自动清掉（已有的既定行为，保持不动）。
     * 注意：这里只在存盘数据里保留，用户主动清空某个格子时按空值存，不做"空值即默认"的兜底。
     */
    function loadGenForm() {
        const s = getSettings();
        const f = s.genForm || {};
        return {
            name: String(f.name || ''),
            goal: String(f.goal || ''),
            promptHint: String(f.promptHint || ''),
            extra: f.extra == null ? '' : String(f.extra),
            prefs: (f.prefs && typeof f.prefs === 'object')
                ? Object.assign(defaultPrefs(), f.prefs)
                : (f.extra != null || f.goal || f.promptHint
                    ? Object.assign(defaultPrefs(), { goal: f.goal, promptHint: f.promptHint, extra: f.extra })
                    : null),
            groupModes: (f.groupModes && typeof f.groupModes === 'object') ? Object.assign({}, f.groupModes) : null,
        };
    }

    function persistGenForm() {
        const s = getSettings();
        s.genForm = {
            name: draftName || '',
            goal: (draftPrefs && draftPrefs.goal) || '',
            promptHint: (draftPrefs && draftPrefs.promptHint) || '',
            extra: (draftPrefs && draftPrefs.extra != null) ? draftPrefs.extra : '',
            prefs: draftPrefs ? Object.assign({}, draftPrefs) : null,
            groupModes: draftGroupModes ? Object.assign({}, draftGroupModes) : null,
        };
        saveSettings();
    }

    /** 清掉落盘的生成页表单（重置 / 采用时调） */
    function clearGenForm() {
        const s = getSettings();
        s.genForm = null;
        saveSettings();
    }

    function getDraftPrefs() {
        if (!draftPrefs) {
            const saved = loadGenForm();
            draftPrefs = saved.prefs || defaultPrefs();
            if (!draftName && saved.name) draftName = saved.name;
        }
        return draftPrefs;
    }

    function getGroupModes() {
        if (!draftGroupModes) {
            // 先看存盘的，用户上次选的粗细程度刷新后要还在
            const saved = loadGenForm();
            if (saved.groupModes) draftGroupModes = Object.assign({}, saved.groupModes);
        }
        if (!draftGroupModes) {
            draftGroupModes = {};
            for (const name of Object.keys(PREF_PRESETS)) draftGroupModes[name] = 'rough';
        }
        for (const name of Object.keys(PREF_PRESETS)) {
            if (!draftGroupModes[name]) draftGroupModes[name] = 'rough';
        }
        return draftGroupModes;
    }

    /** 生成成功后清掉草稿，下次进来是全新的一份 */
    function resetDraftPrefs() {
        draftPrefs = null;
        draftGroupModes = null;
        draftName = '';
        clearGenForm();
    }

    /**
     * 采用待选事件时清空生成页表单（2026-11-01 危晓要求）。
     * 他给的规矩是：填好的配置只在两个动作后消失 —— 点「重置为默认」，或点「采用」。
     * 采用说明这一套设置已经落地成事件，下次该重新想。
     */
    function clearGenFormOnAdopt() {
        draftPrefs = null;
        draftGroupModes = null;
        draftName = '';
        clearGenForm();
        log('待选事件已采用，生成页配置已清空');
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
        const lv = String(prefs.difficultyLevel || '').trim();
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
                v = `根据难度等级「${lv}」自行设定`;
            }
            const indent = g.group ? '  · ' : '- ';
            lines.push(`${indent}${g.label}：${v}`);
        }
        if (useByLevel) {
            lines.push(`说明：难度等级已定为「${lv}」，凡写「根据难度等级自行设定」的子项，请按该等级应有的难度、危险程度与时间压力成套推导，同一组内要互相匹配。`);
        } else {
            lines.push('说明：难度等级未指定，凡写「根据当前情况自行设定」的子项，请结合当前剧情阶段与该角色所处处境，自己配一套合理的取值。');
        }
        // 危险与时间两组各有一处容易叠着理解的地方，明确划界，
        // 否则三项都往「重」的方向选时，模型会把它们相加，输出过度狠辣的事件
        lines.push('语义边界（重要）：',
            '「致死性」只表示丢命的可能性大小，「失败后果」表示失误一次的代价，',
            '「容错率」只表示允许错几次，三者各自独立，不要叠加理解——',
            '容错率低不等于后果更重，超时后果也只作用于时间耗尽这一种情况，不是第二次惩罚。',
            '按各自字面分别落实，不要因为它们同时偏重就进一步加重事件。');
        lines.push('「倒计时」只表示玩家知不知道存在期限，「时长」只表示节奏紧迫感，两者也互相独立：',
            '可以有明确期限但节奏舒缓，也可以没有期限却步步紧逼。');
        // 形态类选项：直接决定大纲的结构尺寸，模型要照此生成而不是自行发挥
        const shape = [];
        if (prefs.nodeCount && prefs.nodeCount !== PREF_AUTO_NEW) shape.push(`信息节点数量按「${prefs.nodeCount}」，输出的 nodes 数组长度要落在这个区间`);
        if (prefs.castScale && prefs.castScale !== PREF_AUTO_NEW) shape.push(`参与者规模按「${prefs.castScale}」，characters 里的角色数量与之相称`);
        if (prefs.pacingStructure && prefs.pacingStructure !== PREF_AUTO_NEW) shape.push(`节奏结构按「${prefs.pacingStructure}」，paths 的组织方式要体现这种结构`);
        if (prefs.linkPrevious && prefs.linkPrevious !== PREF_AUTO_NEW) {
            const v = prefs.linkPrevious;
            if (v === '完全独立') shape.push('本事件与之前的线索完全独立，不要引用其他事件的内容');
            else if (v === '承接已有线索') shape.push('本事件承接之前遗留的线索，把【当前剧情】里已有的伏笔接起来');
            else shape.push('本事件在解决自身问题的同时，要为后续留下可用的伏笔，写进 forbidden 或 paths');
        }
        if (shape.length) {
            lines.push('事件形态（已在界面选定，按此生成，不要自行改动规模）：');
            for (const s of shape) lines.push('  · ' + s);
        }
        // 次类型：没选就让模型自己配
        if (subs.length) {
            lines.push(`- 次类型：${subs.join('、')}（次要性质可以混入，但要围绕主类型展开，不要喧宾夺主）`);
        } else {
            lines.push('- 次类型：未指定，请按主类型与当前剧情自行搭配 1-3 个次要性质');
        }
        lines.push(`- 额外要求：${prefs.extra || '无'}`);
        // 用户手填的两项：目的（想达成什么）与提示词（大致框架）。填了就当硬约束
        const goal = String(prefs.goal || '').trim();
        if (goal) {
            lines.push('');
            lines.push('【事件目的（用户亲手填写，必须围绕它设计）】');
            lines.push(goal);
            lines.push('说明：这是用户希望这个事件最终达成的目标。核心真相、信息节点与推进路径都要服务于它，');
            lines.push('但不要把它直白写进大纲让玩家一眼看穿，仍要经由信息节点逐步展开。');
        }
        const hint = String(prefs.promptHint || '').trim();
        if (hint) {
            lines.push('');
            lines.push('【事件框架提示（用户亲手填写的想法，尽量采纳）】');
            lines.push(hint);
            lines.push('说明：这是用户自己构思的大致框架或想要的桥段。能融进结构就融进去；');
            lines.push('与公平性、信息节点可获得性冲突时，优先保证结构完整，再尽量保留用户的意图。');
        }
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
            '【字段名必须逐字照用】下面这份骨架列出了每个键的确切拼写。',
            '键名一律用英文小写加下划线，不许改写成中文、不许自造同义词、不许增减层级。',
            '只有尖括号里的内容要你填，其余照抄。',
            '',
            '```yaml',
            'event_name: <事件名>',
            'event_brief: <一句话简介>',
            'event_type:',
            '  主类型: <案件推理|谈判交涉|探险探索|生存危机|社交博弈|战斗冲突|日常委托|禁忌秘辛>',
            '  次类型: [<最多3个>]',
            'core_truth: |',
            '  <多层真相，逐条列>',
            'nodes:',
            '  - id: 1',
            '    type: <物证|证言|环境|时间线|关系>',
            '    trigger: <触发条件>',
            '    info: <指向的信息或后果>',
            '    refute_by: [<可选，误导项填节点编号>]',
            'min_nodes_for_deduction: [<推理必需的节点编号>]',
            'characters:',
            '  助力者:',
            '    - name: <角色名>',
            '      identity: <身份>',
            '      motive: <动机，各人不同>',
            '      cost: <条件或代价，无则填 无>',
            '  阻碍者:',
            '    - name: <角色名>',
            '      identity: <身份>',
            '      reason: <阻碍理由>',
            '      resolvable_by: <化解方式>',
            '  知情者:',
            '    - name: <角色名>',
            '      info_known: <掌握的信息>',
            '  幕后方:',
            '    - name: <角色名或势力>',
            '      reveal: forbidden',
            '      exposure_path: <暴露路径>',
            'paths:',
            '  - step: 1',
            '    node: <对应节点编号，纯数字>',
            '    route: <这一步发生什么>',
            '    must: <必经|可跳过>',
            '    risk: <无|低|中|高>',
            '    fail: <失败后果>',
            'time_pressure:',
            '  倒计时: <描述>',
            '  时长: <描述>',
            '  超时后果: <描述>',
            '  拖延代价: <描述>',
            'danger:',
            '  致死性: <描述>',
            '  失败后果: <描述>',
            '  容错率: <描述>',
            '  威胁来源: <描述>',
            'forbidden:',
            '  - <禁止事项>',
            '```',
            '',
            '【大纲外路径】的写法：与普通路径同结构，但 step 填 "【大纲外】"，并多加一个 why: <为什么现在会出现这条路径>。',
            '【一致性】nodes 的 id 必须从 1 连续编号；paths 里的 node 只能引用已列出的节点编号；',
            'min_nodes_for_deduction、refute_by 里的编号同样只能引用已列出的节点。',
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
            temperature: Number.isFinite(Number(profile.temperature)) ? Number(profile.temperature) : 0.7,
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

    // ---------- 结构规范化 ----------

    // 中文键 → 英文键。和 OUTLINE_KEY_LABEL 方向相反，但那张表是给显示用的、
    // 这里要处理的是模型把键写成中文的情况，所以单独维护，遇到新的再补。
    // 值冲突的（比如「内容」在 paths 里是 route、在 nodes 里是 info）不放在这张表，
    // 由 normalizeOutline 按上下文判断。
    const CN_TO_EN_KEY = {
        事件名: 'event_name', 事件简介: 'event_brief', 事件类型: 'event_type',
        核心真相: 'core_truth', 信息节点: 'nodes', 推理必需节点: 'min_nodes_for_deduction',
        参与角色: 'characters', 推进路径: 'paths', 禁止事项: 'forbidden',
        助力者: 'helpers', 阻碍者: 'obstructers', 知情者: 'informants', 幕后方: 'behind_scenes',
        名称: 'name', 名字: 'name', 角色名: 'name', 姓名: 'name',
        身份: 'identity', 职衔: 'identity', 动机: 'motive', 动机类型: 'motive_type',
        动机详述: 'motive_detail', 条件与代价: 'condition_or_cost', 条件: 'condition',
        代价: 'cost', 备注: 'note', 理由: 'reason', 阻碍理由: 'reason',
        化解方式: 'resolvable_by', 掌握信息: 'info_known', 掌握的信息: 'info_known',
        掌握: 'info_known', 知道什么: 'knows', 不肯说的: 'wont_tell', 获取限制: 'how_to_get',
        获取方式: 'how_to_get', 揭示条件: 'reveal', 暴露路径: 'exposure_path', 暴露方式: 'exposure_path',
        暴露: 'exposure_path', 知情者关键人物: 'informants',
        编号: 'id', 类型: 'type', 触发条件: 'trigger', 触发词: 'keyword', 触发时机: 'trigger',
        信息内容: 'info', 指向信息: 'info', 后果: 'consequence', 可被节点推翻: 'refute_by',
        可推翻: 'refute_by', 是否误导: 'is_misleading', 类别: 'kind',
        步骤: 'step', 对应节点: 'node', 对应节点编号: 'node', 路径正文: 'route',
        是否必经: 'must', 失败后果: 'fail', 失败情形: 'fail',
        时间压力: 'time_pressure', 危险程度: 'danger', 倒计时: 'countdown', 时长: 'duration',
        超时后果: 'timeout_result', 主类型: 'primary', 次类型: 'secondary',
        结果: 'outcomes', 大纲外走向: 'out_of_plan_paths', 必需节点: 'required_nodes',
        可跳过节点: 'optional_nodes', 风险: 'risk',
        拖延代价: 'delay_cost', 致死性: 'lethality', 容错率: 'tolerance', 威胁来源: 'threat_source',
        条件或代价: 'condition_or_cost', 标注: 'note', '知情者/关键人物': 'informants',
    };

    // 「节点」这个词在 paths 里模型常用来写「必经/可跳过」，在别处才是编号。
    // 这正是中文键最麻烦的地方：同名不同义，只能看上下文。
    const MUST_WORDS = /必经|可跳过|可选|跳过|必须|optional|required/i;
    const NODE_REF = /^\s*(\d+|\[(?:\s*\d+\s*,?\s*)*\])\s*$/;

    /**
     * 把解析结果里的中文键就地规范化成英文键，返回 {obj, renamed, lost}。
     * renamed 是改掉的键数（用来在日志里记一笔「模型又没按格式来」），
     * lost 是同名冲突被合并掉的信息。
     */
    function normalizeKeys(obj, ctx) {
        if (Array.isArray(obj)) {
            // 数组元素沿用上层上下文（角色数组成员、节点数组成员都靠这个），
            // 并且要收拢元素里的改名数与冲突，否则统计不到、冲突也不记日志
            let n = 0;
            const lost = [];
            for (let i = 0; i < obj.length; i++) {
                const r = normalizeKeys(obj[i], ctx);
                obj[i] = r.obj;
                n += r.renamed;
                lost.push(...r.lost);
            }
            return { obj, renamed: n, lost };
        }
        if (!obj || typeof obj !== 'object') return { obj, renamed: 0, lost: [] };

        let renamed = 0;
        const lost = [];
        const out = {};

        for (const [rawKey, val] of Object.entries(obj)) {
            let key = rawKey;
            if (!/^[A-Za-z_]/.test(rawKey)) {
                // 中文键：先看是不是 paths 里那个「节点: 必经」的特殊情况
                if (ctx === 'path' && (rawKey === '节点' || rawKey === '必经')) {
                    const sv = String(val == null ? '' : val).trim();
                    if (MUST_WORDS.test(sv) && !NODE_REF.test(sv)) {
                        key = 'must';
                    } else {
                        key = 'node';
                    }
                } else if (ctx === 'node' && (rawKey === '内容' || rawKey === '正文')) {
                    key = 'info';
                } else if (rawKey === '内容' || rawKey === '正文') {
                    key = 'route';
                } else {
                    // 长句子不是键名（正文里带全角冒号时会被误当键），原样留着
                    key = rawKey.length <= 12 ? (CN_TO_EN_KEY[rawKey] || rawKey) : rawKey;
                }
                if (key !== rawKey) renamed++;
            }

            // 子层级的上下文，决定「内容」「节点」这些多义键怎么解释。
            // 注意：不管什么键都要往下递归，否则 event_type / characters / time_pressure
            // 这些层级里的中文键会被漏掉（2026-11-01 实测踩到）。
            const SIDE_KEYS = ['helpers', 'obstructers', 'informants', 'behind_scenes',
                'blockers', '助力者', '阻碍者', '知情者', '幕后方'];
            const childCtx = key === 'paths' ? 'path'
                : key === 'nodes' ? 'node'
                : SIDE_KEYS.includes(key) ? 'character'
                : (ctx === 'path' || ctx === 'node') ? ctx
                : 'plain';

            let value = val;
            if (val && typeof val === 'object') {
                const r = normalizeKeys(val, childCtx);
                value = r.obj;
                renamed += r.renamed;
                lost.push(...r.lost);
            }

            if (Object.prototype.hasOwnProperty.call(out, key)) {
                // 同一个键中英文都写了（比如 node 和 对应节点），留先出现的那个
                lost.push(rawKey);
                continue;
            }
            out[key] = value;
        }
        return { obj: out, renamed, lost };
    }

    /** 规范化整份大纲：中文键转英文，冲突的记日志 */
    function normalizeOutline(parsed) {
        if (!parsed || typeof parsed !== 'object') return parsed;
        // 角色立场那几个键下面是数组，数组元素各自规范化
        const r = normalizeKeys(parsed, null);
        if (r.renamed || r.lost.length) {
            debug(`大纲键名规范化：改掉中文键 ${r.renamed} 个`
                + (r.lost.length ? `，同名冲突合并 ${r.lost.length} 个（${r.lost.join('、')}）` : ''));
        }
        return r.obj;
    }

    function parseOutline(raw) {
        const block = extractCodeBlock(raw, 'yaml') || extractCodeBlock(raw) || raw;
        // 模型时不时把个别键写成中文（step 是英文、内容/风险 是中文），
        // 这里统一规范化成英文，后面所有代码只面对一套键名，不用到处写 p['内容'] 兼容
        const parsed = normalizeOutline(parseSimpleYaml(block));
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

        // 字段名漂移检查：prompt 里给了固定骨架，模型偶尔仍会自造键。
        // 这里不算失败（渲染层有容错，还能显示），但要在日志里点出来，
        // 否则容错名单越加越多，没人知道模型到底有没有照规矩写
        const drift = [];
        const pick = (obj, keys) => keys.find(k => obj && obj[k] != null && obj[k] !== '');
        const sampleChar = (() => {
            if (!chars || typeof chars !== 'object') return null;
            for (const list of Object.values(chars)) {
                if (Array.isArray(list) && list.length) return list[0];
            }
            return null;
        })();
        if (sampleChar && !pick(sampleChar, ['name'])) {
            drift.push('角色名没用 name');
        }
        const sampleNode = nodes && nodes.length ? nodes[0] : null;
        if (sampleNode && !pick(sampleNode, ['info'])) drift.push('节点内容没用 info');
        const pathsArr = Array.isArray(o.paths) ? o.paths : [];
        const samplePath = pathsArr.find(p => p && typeof p === 'object') || null;
        if (samplePath && !pick(samplePath, ['route'])) drift.push('路径正文没用 route');
        if (samplePath && !pick(samplePath, ['must'])) drift.push('必经标记没用 must');

        return { ok: missing.length === 0, missing, summary, drift };
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
    // 忙碌提示文案随操作变：废弃/完结是本地操作，不该显示「正在请求模型」
    let busyText = '处理中…';

    /**
     * 切换忙碌状态。
     * @param on 是否忙碌
     * @param keepProgress 结束时是否保留进度列表（生成/盘点用）
     * @param text 忙碌提示文案。不传就沿用上一次的，避免文案互相覆盖
     */
    function setBusy(on, keepProgress, text) {
        busy = on;
        if (text) busyText = text;
        if (panelEl) {
            const b = panelEl.querySelector('#eo_busy');
            if (b) {
                if (text) b.textContent = text;
                b.style.display = on ? 'block' : 'none';
            }
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
        reveal_condition: '揭示条件',
        exposure_path: '暴露路径',
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
                const main = et.primary || et.main || et['主类型'] || '';
                const subs = Array.isArray(et.secondary) ? et.secondary
                    : (Array.isArray(et.sub) ? et.sub
                    : (Array.isArray(et['次类型']) ? et['次类型'] : []));
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

        const paths = Array.isArray(outline.paths) ? outline.paths : [];
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

        // 时间压力与危险程度：这两块以前只写不显示，用户看不到模型对难度的判断
        const dumpGroup = (obj, title) => {
            if (!obj || typeof obj !== 'object') return;
            const entries = Object.entries(obj).filter(([, v]) => v != null && String(v).trim());
            if (!entries.length) return;
            lines.push('');
            lines.push(`${title}：`);
            for (const [k, v] of entries) {
                lines.push(`  ${k}：${Array.isArray(v) ? v.join('、') : String(v).trim()}`);
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

        setBusy(true, false, '正在生成大纲，请稍候…');
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
            // 模型没按骨架写字段名时点一句，方便判断是不是 prompt 需要再加压
            if (quality && quality.drift && quality.drift.length) {
                warn(`字段名没有按骨架输出：${quality.drift.join('；')}（渲染层有容错，仍可正常显示）`);
            }
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
                // 新事件先落成待选草稿：不写世界书、不设为当前事件。
                // 用户点「采用」之后才真正生效，避免反复重生成时来回写删世界书
                status: 'draft',
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

            // 只存成待选草稿，不写世界书。
            // 用户看到满意后点「采用」才走 commitDraft，那时才写条目、设为当前事件
            const list = Object.values(meta.events).filter(e => e && e.status === 'draft');
            if (list.length >= MAX_DRAFTS) {
                // 满了就丢最早的，免得草稿无限堆积
                list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
                const drop = list[0];
                delete meta.events[drop.id];
                log(`待选事件已有 ${MAX_DRAFTS} 个，挤掉最早的「${drop.name}」`);
            }
            meta.events[id] = event;
            saveMeta();
            return event;
        } finally {
            setBusy(false, true);
        }
    }

    /**
     * 采用一个待选事件：写世界书条目、设为当前事件。
     * 生成和写入分开，就是为了反复重生成时不弄脏世界书。
     */
    async function commitDraft(id) {
        const meta = getMeta();
        const event = meta.events[id];
        if (!event) throw new Error('找不到这个待选事件');
        if (event.status !== 'draft') throw new Error('这个事件不是待选状态');

        const cur = getCurrentEvent();
        if (cur) {
            throw new Error(`「${cur.name}」还在进行中，请先完结或废弃它，再采用新的待选事件`);
        }

        setBusy(true, false, '正在采用事件并写入世界书…');
        try {
            const book = event.worldBook || getCharacterBookName();
            if (!book) throw new Error('当前角色未绑定世界书');
            const content = buildEntryContent(event, 0);
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
            meta.currentEventId = id;
            saveMeta();
            // 采用即视为这套生成设置已经用掉，清空表单（危晓 2026-11-01 的规矩）
            clearGenFormOnAdopt();
            log(`已采用事件「${event.name}」，世界书条目 uid=${res.uid}`);
            return event;
        } finally {
            setBusy(false, true);
        }
    }

    /** 丢掉一个待选事件（没写过世界书，删掉数据就行） */
    function discardDraft(id) {
        const meta = getMeta();
        const event = meta.events[id];
        if (!event || event.status !== 'draft') return false;
        delete meta.events[id];
        saveMeta();
        log(`已丢弃待选事件「${event.name}」`);
        return true;
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
            const n = Array.isArray(r.parsed.nodes) ? r.parsed.nodes.length : 0;
            if (!n) {
                fatal.push('一个信息节点都没有解析出来，多半是 nodes 下面的缩进或破折号被改坏了');
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

    /** 结构自检：与 parseOutline 的 quality 保持同一套口径，供表单保存后使用 */
    function checkOutlineShape(outline) {
        const missing = [];
        const o = outline || {};
        if (!o.event_name) missing.push('事件名');
        if (!o.nodes || !o.nodes.length) missing.push('信息节点');
        if (!o.core_truth) missing.push('核心真相');
        return { ok: missing.length === 0, missing, summary: missing.length ? '' : '结构完整', drift: [] };
    }

    /**
     * 大纲引用自检：节点编号是否连续、路径与角色是否引用了不存在的节点。
     * 只做检查不做修正 —— 编号跳号未必是错，但多半是手改时漏删了别处引用。
     */
    function checkOutlineRefs(outline) {
        if (!outline || typeof outline !== 'object') return [];
        const issues = [];
        const nodes = Array.isArray(outline.nodes) ? outline.nodes : [];
        const ids = nodes.map(n => Number(nodeId(n))).filter(n => Number.isFinite(n));
        for (let i = 1; i <= ids.length; i++) {
            if (!ids.includes(i)) { issues.push(`节点编号从 1 到 ${ids.length} 之间缺 ${i}`); break; }
        }
        const dup = ids.filter((n, i) => ids.indexOf(n) !== i);
        if (dup.length) issues.push(`节点编号重复：${[...new Set(dup)].join('、')}`);
        if (!nodes.length) issues.push('没有识别到任何信息节点');

        const idSet = new Set(ids);
        (Array.isArray(outline.paths) ? outline.paths : []).forEach((s, i) => {
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

    async function runInventory() {
        const event = getCurrentEvent();
        if (!event) throw new Error('当前没有进行中的事件');
        if (event.status !== 'active') throw new Error('该事件已结束');

        setBusy(true, false, '正在盘点事件状态，请稍候…');
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
                event,
            );
            if (String(event.entryUid) !== String(res.uid)) {
                // 位置被纠正过，同步回事件卡，避免下次又按旧编号找
                event.entryUid = res.uid;
            }
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
        // 废弃/完结是纯本地操作：删世界书条目、改状态、清历史，不碰模型
        setBusy(true, false, abandoned ? '正在废弃事件并清理世界书条目…' : '正在完结事件并清理世界书条目…');
        try {
            if (event.entryUid != null || event.worldBook) {
                // 位置现查，不用 event.entryUid —— 世界书可能被重排过
                const book = event.worldBook || getCharacterBookName();
                if (book) await deleteEventEntryForEvent(book, event);
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
#eo_panel.eo-open{display:flex;}
/* 整页只由浏览器窗口滚动，页面里不再出现第二条滚动条（2026-11-02 危晓定）：
   面板从左上角全宽铺开、高度随内容生长，.eo-body 只负责排版，不做内部滚动出卷轴 */
#eo_panel{position:fixed;left:0;top:0;right:0;z-index:30001;display:none;flex-direction:column;
  width:100%;height:auto;min-height:100vh;min-height:100dvh;
  background:#fffdf7;border:0;border-radius:0;box-shadow:none;overflow:visible;
  font-size:14px;color:#3c2f14;}
#eo_panel .eo-body{max-width:1100px;width:100%;margin:0 auto;padding:16px 20px 48px;
  overflow:visible;}
.eo-box{max-height:none;overflow:visible;}
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
  /* 页面交给浏览器窗口滚，标题栏和标签栏跟着吸在窗口顶上，往下翻也能关面板、切页签 */
  position:sticky;top:0;z-index:50;
  background:linear-gradient(160deg,#fff3d6,#f5d080);border-bottom:1px solid rgba(184,134,11,.4);}
.eo-title{font-weight:700;flex:1;}
.eo-close{cursor:pointer;padding:4px 12px;border-radius:8px;background:rgba(255,255,255,.55);font-size:15px;}
.eo-close:hover{background:rgba(255,255,255,.85);}
.eo-body{padding:12px;overflow:visible;flex:1;}
.eo-row{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;}
.eo-row>label{min-width:78px;color:#6b5424;}
.eo-btn{padding:5px 12px;border-radius:8px;border:1px solid rgba(184,134,11,.5);
  background:#fff8e6;cursor:pointer;color:#5a3e0b;font-size:13px;}
.eo-btn:hover{background:#fdeec4;}
.eo-btn:disabled{opacity:.5;cursor:not-allowed;}
.eo-btn.eo-primary{background:#f0c464;border-color:#b8860b;font-weight:600;}
/* 待选事件的操作按钮（采用/丢弃）：默认不高亮，只有按住的那一下亮，松开就灭。
   采用不再用 eo-primary 常亮——列表里好几个草稿时，常亮的按钮容易让人以为是当前选中 */
.eo-btn.eo-press:active{background:#f0c464;border-color:#b8860b;font-weight:600;}
/* 看大纲/编辑：开关类按钮，开着高亮、关掉回原样 */
.eo-btn.eo-on{background:#f5d080;border-color:#b8860b;color:#4a3200;font-weight:700;}
.eo-box{border:1px solid rgba(184,134,11,.32);border-radius:9px;padding:9px 10px;
  background:#fffaf0;margin-bottom:9px;white-space:pre-wrap;word-break:break-word;
  max-height:none;overflow:visible;line-height:1.55;}
.eo-hint{color:#8a7333;font-size:12px;line-height:1.5;}
/* 大纲正文：保留换行与缩进，不加高度上限（大纲本来就有几百行，截断反而看不到全貌） */
.eo-outline-text{white-space:pre-wrap;word-break:break-word;line-height:1.7;
  font-size:13px;color:#3c2f14;background:#fffdf7;border:1px solid rgba(184,134,11,.28);
  border-radius:9px;padding:10px 12px;margin-bottom:10px;}
/* 子项语义说明：紧跟在对应下拉框下面，小一号、更淡 */
.eo-subdesc{font-size:11px;color:#9b8a5e;margin:-2px 0 6px 8px;}
.eo-warn{color:#a35c00;background:#fff3d6;border:1px solid #e6c37a;
  border-radius:8px;padding:7px 9px;margin-bottom:9px;font-size:12px;}
.eo-ok{color:#2c6e2c;}
.eo-bad{color:#a11;font-size:12px;}
.eo-bad-box{color:#8b0000;background:#fdecea;border:1px solid #e7a9a3;
  border-radius:8px;padding:8px 10px;margin-bottom:9px;font-size:12px;line-height:1.6;}
select.eo-sel{padding:4px 8px;border-radius:7px;border:1px solid rgba(184,134,11,.45);
  background:#fffdf7;color:#3c2f14;font-size:13px;}
/* 待选事件：列表式排布，每一项带采用/丢弃/展示大纲/编辑
   按钮样式（2026-11-02 危晓定）：采用、丢弃平时不高亮，按住那一下才亮；
   展示大纲、编辑是开关，开着常亮、点一次收起就灭 */
.eo-drafts{display:flex;flex-direction:column;gap:8px;margin:6px 0 10px;}
.eo-draft{background:#fffdf7;border:1px solid rgba(184,134,11,.35);border-radius:8px;
  padding:8px 10px;}
.eo-draft-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;}
.eo-draft-name{font-weight:700;color:#6b5424;font-size:13px;}
.eo-draft-meta{font-size:11px;color:#9b8a5e;}
.eo-draft-brief{font-size:12px;color:#5a4a2a;line-height:1.6;margin:4px 0 6px;}
.eo-draft-body{margin-top:8px;border-top:1px dashed rgba(184,134,11,.3);padding-top:8px;}
/* 草稿编辑：中文表单，一格一格填，不用看 YAML */
.eo-draft-edit .eo-form-sec{font-weight:600;color:#6b5424;font-size:13px;margin:12px 0 6px;
  border-bottom:1px solid rgba(184,134,11,.25);padding-bottom:4px;}
.eo-draft-edit .eo-list{display:flex;flex-direction:column;gap:8px;}
.eo-formcard{background:#fffaf0;border:1px solid rgba(184,134,11,.3);border-radius:8px;padding:8px 10px;}
.eo-formcard-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;}
.eo-formcard-title{font-weight:700;color:#6b5424;font-size:12px;flex:1;min-width:60px;}
.eo-draft-edit .eo-field{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;}
.eo-draft-edit .eo-field-label{flex:0 0 96px;font-size:12px;color:#7a6431;padding-top:6px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eo-draft-edit .eo-field .eo-input{margin-bottom:0;font-size:13px;}
.eo-draft-edit .eo-field .eo-textarea{min-height:42px;}
.eo-btn.eo-sm{padding:3px 9px;font-size:12px;}
.eo-extra-keys summary{font-size:11px;color:#9b8a5e;cursor:pointer;margin:4px 0;}
/* YAML 编辑框用等宽字，行号对齐、编号一眼能看出跳没跳 */
.eo-draft-yaml{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12px;
  white-space:pre;overflow:visible;line-height:1.5;min-height:160px;}
.eo-draft-edit label,.eo-draft-edit .eo-label{font-size:12px;color:#7a6431;white-space:nowrap;}
.eo-draft-edit .eo-sec-inline{margin-top:6px;}
.eo-sec{border-top:1px dashed rgba(184,134,11,.35);margin:10px 0 6px;padding-top:8px;
  font-weight:600;color:#6b5424;}

/* 标签栏 */
.eo-tabs{display:flex;gap:4px;border-bottom:1px solid rgba(184,134,11,.35);
  margin-bottom:14px;position:sticky;top:49px;background:#fffdf7;z-index:40;padding-top:4px;}
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
.eo-details .eo-box{max-height:none;}
.eo-subsec{margin:12px 0 4px;color:#8a6a1e;font-weight:600;font-size:12px;}

/* 输入 */
.eo-input{padding:6px 10px;border-radius:8px;border:1px solid rgba(184,134,11,.45);
  background:#fffdf7;color:#3c2f14;font-size:13px;flex:1;min-width:0;}
.eo-input:focus{outline:2px solid rgba(184,134,11,.28);outline-offset:0;}
.eo-textarea{width:100%;box-sizing:border-box;resize:vertical;line-height:1.6;
  font-family:inherit;margin-bottom:9px;}
/* 大纲原文编辑框：整份 YAML 直接改。
   底色和字色必须显式给——只挂 eo-textarea 不挂 eo-input 时是浏览器默认的深灰底白字，
   对着这份米黄界面像块补丁（2026-11-01 实测踩到）。等宽字是为了让缩进对齐看得出来。 */
.eo-outline-editor{
  background:#fffdf7;color:#3c2f14;
  border:1px solid rgba(184,134,11,.35);border-radius:9px;
  padding:10px 12px;margin-bottom:6px;
  font-family:ui-monospace,Consolas,"Courier New",monospace;
  font-size:12.5px;line-height:1.65;
  white-space:pre;overflow:visible;tab-size:2;min-height:320px;
}
.eo-outline-editor:focus{outline:2px solid rgba(184,134,11,.28);outline-offset:0;
  border-color:rgba(184,134,11,.6);}
.eo-editor-stat{color:#9b8a5e;font-size:12px;margin:0 0 8px;}
.eo-editor-dirty{color:#b8860b;font-weight:600;}

/* 节点行 */
.eo-node{padding:4px 6px;cursor:pointer;border-radius:6px;line-height:1.55;}
.eo-node:hover{background:#fff3d6;}
.eo-node-on{color:#2c6e2c;font-weight:600;}
.eo-node-suggest{color:#8a5a00;background:#fff6e0;}
.eo-suggest{display:flex;align-items:center;gap:8px;padding:3px 4px;border-bottom:1px dashed #e6d7b0;}
.eo-suggest span{flex:1;}

/* 运行日志框：自己滚动，进来就停在最新一条 */
.eo-logbox{max-height:none;overflow:visible;}

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
/* 偏好项里的问号在行内偏右，提示框改成从问号正下方向右展开，
   否则 260px 的框会顶出面板右缘 */
.eo-help-inline .eo-tip{left:-6px;top:20px;}
/* 重置按钮旁边的问号：按钮外侧留白，点它只弹说明，不会误触重置 */
.eo-reset-row{display:flex;align-items:center;gap:8px;}

/* 打勾模式：三档各占一行 */
.eo-modes{display:flex;flex-direction:column;gap:5px;margin:4px 0;}
.eo-mode{display:flex;gap:8px;align-items:flex-start;padding:5px 8px;border-radius:6px;
  background:#fdf8ec;font-size:12px;line-height:1.6;color:#5a4a2a;}
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
<div class="eo-busy" id="eo_busy">处理中…</div>
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
        if (open) {
            renderPanel();
            // 每次打开面板顺手校正一次条目位置，世界书被重排过也能自动纠正
            healEntryUids().then(n => { if (n) renderPanel(); })
                .catch(e => warn('校正条目位置失败', e));
        }
    }

    function el(tag, cls, text) {
        const d = document.createElement(tag);
        if (cls) d.className = cls;
        if (text !== undefined) d.textContent = text;
        return d;
    }

    let activeTab = 'gen';
    // 正在编辑的待选事件 id；非空时该草稿展开成原文编辑框
    let editingDraftId = null;
    // 编辑框里的临时值：展开时从事件卡拷一份，取消或换一个草稿就丢
    let draftEditBuf = null;
    // 上一次保存的自检警告（节点编号 / 引用对不上），显示在当前草稿下方
    let draftEditIssues = null;

    /** 展开编辑时把大纲原文拷进编辑缓冲，之后只在缓冲上改，取消就不影响事件卡 */
    function makeDraftEditBuf(d) {
        const raw = String((d && d.outlineRaw) || '').trim();
        // 原文丢了（极老的卡）才从结构重建一份，正常永远走上面这条
        const text = raw || outlineToYaml((d && d.outline) || {});
        // 两步预处理，都只为好认好改，不改变落盘内容：
        //   1. 模型给的原文外面套着 yaml 代码围栏，只留里面的正文
        //   2. 英文键换成中文键（event_name → 事件名），缩进不动
        const stripped = stripCodeFence(text);
        const shown = keysToChinese(stripped.text);
        return {
            // 编辑框里显示的中文键版本
            text: shown.text,
            // 每行原本用的英文键，保存时按它还原，避免 role/identity 这类多对一的键被改写
            backMap: shown.backMap,
            // 打开时的样子，用来判断「有没有改过」
            original: shown.text,
            // 打开时有没有围栏，保存时照原样包回去
            fenced: stripped.fenced,
            rebuilt: !raw,
        };
    }

    /**
     * 拆掉 ```yaml 代码围栏，返回 {text, fenced}。
     * 只有整段被一对围栏完整包住才算，中间夹着围栏的（极罕见）原样不动。
     */
    function stripCodeFence(raw) {
        const s = String(raw || '');
        const m = s.match(/^\s*```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[ \t]*\r?\n?[ \t]*$/);
        if (!m) return { text: s, fenced: false };
        return { text: m[1], fenced: true };
    }

    /** 保存时把围栏包回去，保证 outlineRaw 与模型原输出保持同一种形态 */

    // ---------- 键名中英互转 ----------

    /** 中文键 → 英文键。同一中文对应多个英文键时取第一个登记的 */
    const CN_KEY_TO_EN = (() => {
        const m = {};
        for (const [en, cn] of Object.entries(OUTLINE_KEY_LABEL)) {
            if (!m[cn]) m[cn] = en;
        }
        return m;
    })();

    /**
     * 把大纲文本里的英文键换成中文，给编辑框显示用。
     * 只换行首的「键:」和「- 键:」这种键位，值里的英文（比如节点类型 testimony）不动。
     * 缩进原样保留，所以换键名不影响 YAML 结构。
     */
    // 转成中文后会显示成「助力者:」这样的键，转回时靠 backMap 还原成原稿的写法，
    // 所以这几个立场键也照转，不用特意保留英文。
    const KEEP_AS_IS = new Set();

    /**
     * 把大纲文本里的英文键换成中文，给编辑框显示用。
     * 只换行首的「键:」和「- 键:」这种键位，值里的英文（比如节点类型 testimony）不动。
     * 缩进原样保留，所以换键名不影响 YAML 结构。
     *
     * 多个英文键可能共用一个中文名（role / identity 都是「身份」），
     * 为了转回时能对上原稿，这里把每行原来用的英文键记在返回值里。
     */
    function keysToChinese(text) {
        const backMap = [];
        const out = String(text == null ? '' : text).split(NL).map((line) => {
            // 键名可以是英文也可以是中文（模型经常直接写中文键），两种都要认出来
            const m = line.match(/^(\s*(?:-\s+)?)([^\s:][^:]*?)(\s*:)([\s\S]*)$/);
            if (!m) { backMap.push(null); return line; }
            const key = m[2].trim();
            // 本来就是中文键：记下来，保存时原样保留，别翻成英文
            if (!/^[A-Za-z_]/.test(key)) { backMap.push('__CN__'); return line; }
            const cn = OUTLINE_KEY_LABEL[key];
            if (!cn || KEEP_AS_IS.has(key)) { backMap.push(null); return line; }
            backMap.push(key);
            return m[1] + cn + m[3] + m[4];
        }).join(NL);
        return { text: out, backMap };
    }

    /**
     * 保存前把中文键换回英文键，解析器和世界书只认英文。
     * 传了 backMap 就优先还原成该行原本用的英文键，保证多对一的键（role/identity）不被改写。
     */
    function keysToEnglish(text, backMap) {
        const lines = String(text == null ? '' : text).split(NL);
        return lines.map((line, idx) => {
            const m = line.match(/^(\s*(?:-\s+)?)([^\s:][^:]*?)(\s*:)([\s\S]*)$/);
            if (!m) return line;
            const name = m[2].trim();
            if (SIDE_CN.has(name)) return line;
            // 模型原稿里本来就是中文键，别翻成英文
            if (Array.isArray(backMap) && backMap[idx] === '__CN__') return line;
            // 这一行没改过键名，且原来就有英文键，直接还原成原来那个
            const orig = Array.isArray(backMap) ? backMap[idx] : null;
            if (orig && OUTLINE_KEY_LABEL[orig] === name) {
                return m[1] + orig + m[3] + m[4];
            }
            const en = CN_KEY_TO_EN[name];
            return en ? m[1] + en + m[3] + m[4] : line;
        }).join(NL);
    }
    /** 数一数还剩多少英文开头的键（中文换不回去的那种），保存后提示用 */
    function countEnglishKeys(text) {
        let n = 0;
        for (const line of String(text == null ? '' : text).split(String.fromCharCode(10))) {
            const m = line.match(/^\s*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/);
            if (m) n++;
        }
        return n;
    }
    function wrapCodeFence(text, fenced) {
        const body = String(text == null ? '' : text);
        return fenced ? '```yaml\n' + body.replace(/\s+$/, '') + '\n```' : body;
    }

    /**
     * 草稿编辑框：整份大纲摊成一个可改的文本框，像改文档一样直接编辑。
     *
     * 不再拆成表单逐格填 —— 大纲几百行，按字段拆会拆散编号与引用的上下文，
     * 而改一句话、调一个编号这种动作本来就该在原文上做。
     *
     * 编辑缓冲只在内存里，取消就丢；点保存才写回事件卡，且不碰世界书。
     * 整个函数包一层 try：渲染一旦抛错，不能把整个待选列表拖成空白页。
     */
    function renderDraftEditor(d) {
        try {
            return buildDraftEditor(d);
        } catch (e) {
            error('渲染草稿编辑框失败：', e);
            const box = el('div', 'eo-draft-body eo-draft-edit');
            const bad = el('div', 'eo-bad-box', '⚠ 编辑框没渲染出来：' + (e && e.message || e)
                + '。点「编辑」退出，详情见日志页「错误」档。');
            box.appendChild(bad);
            return box;
        }
    }

    function buildDraftEditor(d) {
        const buf = draftEditBuf || makeDraftEditBuf(d);
        draftEditBuf = buf;
        const wrap = el('div', 'eo-draft-body eo-draft-edit');

        wrap.appendChild(el('div', 'eo-hint', '直接改下面的文字，像改文档一样。改完点「保存编辑」，'
            + '只作用于这份待选草稿，不碰世界书。格式改坏了会拒绝保存并告诉你哪儿坏了。'));

        if (buf.rebuilt) {
            wrap.appendChild(el('div', 'eo-warn', '这份草稿没存下原文，下面是从结构重建的，可能和当初生成的略有出入。'));
        }

        // ---------- 编辑区 ----------
        const ta = document.createElement('textarea');
        ta.className = 'eo-textarea eo-outline-editor';
        ta.spellcheck = false;
        ta.value = buf.text;
        ta.rows = 24;
        ta.addEventListener('input', () => { buf.text = ta.value; syncDirty(); });
        // Tab 键插两个空格，而不是跳走焦点 —— 大纲是缩进敏感的 YAML
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const s = ta.selectionStart, t = ta.selectionEnd;
                ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(t);
                ta.selectionStart = ta.selectionEnd = s + 2;
                buf.text = ta.value;
                syncDirty();
            }
        });
        wrap.appendChild(ta);

        // 行数 / 字数 / 是否改过，随时可见
        const stat = el('div', 'eo-hint eo-editor-stat');
        const paintStat = () => {
            const text = buf.text || '';
            const ls = text ? text.split('\n').length : 0;
            const changed = text !== buf.original;
            stat.textContent = ls + ' 行 · ' + text.length + ' 字' + (changed ? ' · 有未保存的改动' : '');
            stat.className = 'eo-hint eo-editor-stat' + (changed ? ' eo-editor-dirty' : '');
        };
        paintStat();
        ta.addEventListener('input', paintStat);        wrap.appendChild(stat);

        // ---------- 工具行 ----------
        // 按钮组按需重画：改了字就把尾部按钮换成提示条，免得「保存编辑」躲在编辑框外面看不见
        const tail = el('div', null);
        let warned = null;

        const btnCheck = el('button', 'eo-btn', '检查格式');
        btnCheck.type = 'button';
        btnCheck.addEventListener('click', () => {
            const r = checkEditedRaw(wrapCodeFence(keysToEnglish(buf.text, buf.backMap), buf.fenced));
            draftEditIssues = r.issues.length ? r.issues : null;
            renderPanel();
            if (!r.ok) log('格式检查未通过：' + r.fatal.join('；'));
            else if (!r.issues.length) log('格式检查通过，没有发现问题');
            else log('格式检查通过，但有 ' + r.issues.length + ' 条提醒');
        });

        const btnRebuild = el('button', 'eo-btn', '从结构重建');
        btnRebuild.type = 'button';
        btnRebuild.addEventListener('click', () => {
            if (!confirm('用事件卡里已保存的结构重新生成文本？当前框里的改动会丢。')) return;
            const rebuilt = keysToChinese(stripCodeFence(outlineToYaml(d.outline || {})).text);
            buf.text = rebuilt.text;
            buf.backMap = rebuilt.backMap;
            buf.original = rebuilt.text;
            pendingDraftEditDirty = false;
            renderPanel();
            log('已按结构重建编辑框内容');
        });

        const toolRow = el('div', 'eo-row');
        toolRow.appendChild(btnCheck);
        toolRow.appendChild(btnRebuild);
        wrap.appendChild(toolRow);

        const paintWarn = () => {
            if (warned) { warned.remove(); warned = null; }
            if (draftEditIssues && draftEditIssues.length) {
                warned = el('div', 'eo-warn', '格式提醒：' + draftEditIssues.join('；')
                    + '。这类问题不阻断保存，但节点跟踪可能对不上，建议修一下。');
                if (tail.parentNode) tail.parentNode.insertBefore(warned, tail);
                else wrap.appendChild(warned);
            }
        };

        const paintTail = () => {
            tail.textContent = '';
            const btnRow = el('div', 'eo-row');
            if (pendingDraftEditDirty) {
                // 正在改：底部按钮收回，只留一句提醒——改完再回来才有「保存编辑」
                btnRow.appendChild(el('div', 'eo-hint eo-editor-dirty',
                    '有未保存的改动。翻到编辑框底部就能「保存编辑」，或点上面的「编辑」放弃并关掉。'));
                tail.appendChild(btnRow);
                return;
            }
            const btnSave = el('button', 'eo-btn eo-primary', '保存编辑');
            btnSave.type = 'button';
            btnSave.addEventListener('click', () => {
                try {
                    const res = saveDraftEdit(d.id, {
                        // 编辑框里是中文键，落盘前换回英文键——解析器和世界书只认英文
                        raw: wrapCodeFence(keysToEnglish(buf.text, buf.backMap), buf.fenced),
                    });
                    draftEditIssues = res.issues && res.issues.length ? res.issues : null;
                    discardPendingEdit();
                    previewDraftId = d.id;
                    renderPanel();
                } catch (e) {
                    // 格式硬错：不保存、不退出编辑，把原文留在框里让人接着改
                    error('保存草稿编辑失败：', e);
                    draftEditIssues = [String(e && e.message || e)];
                    renderPanel();
                }
            });
            btnRow.appendChild(btnSave);

            const btnCancel = el('button', 'eo-btn', '取消');
            btnCancel.type = 'button';
            btnCancel.addEventListener('click', () => {
                if (buf.text !== buf.original && !confirm('放弃这次编辑？改动不会保存。')) return;
                discardPendingEdit();
                renderPanel();
            });
            btnRow.appendChild(btnCancel);

            // 没改动时只留「完成」：看完了就关，不用翻回去点「编辑」
            if (buf.text === buf.original) {
                const btnDone = el('button', 'eo-btn', '完成');
                btnDone.type = 'button';
                btnDone.addEventListener('click', () => {
                    discardPendingEdit();
                    renderPanel();
                });
                btnRow.appendChild(btnDone);
            }
            tail.appendChild(btnRow);
        };

        // 状态一变就重画尾部：有改动才出现「保存编辑」，改回原样又收回去
        const syncDirty = () => {
            const now = buf.text !== buf.original;
            if (now === pendingDraftEditDirty) return;
            pendingDraftEditDirty = now;
            paintTail();
            paintStat();
        };
        paintWarn();
        paintTail();
        wrap.appendChild(tail);
        return wrap;
    }

    /**
     * 只检查不保存：返回 { ok, fatal[], issues[] }。
     * fatal 是格式坏到没法解析的硬错，issues 是编号跳号、引用不存在之类可继续的软错。
     */
    function checkEditedRaw(text) {
        const raw = String(text || '');
        if (!raw.trim()) return { ok: false, fatal: ['内容为空'], issues: [] };
        let parsed = null;
        try {
            parsed = parseOutline(raw).parsed;
        } catch (e) {
            return { ok: false, fatal: ['解析时抛出异常：' + (e && e.message || e)], issues: [] };
        }
        if (!parsed || typeof parsed !== 'object' || !Object.keys(parsed).length) {
            return { ok: false, fatal: ['解析不出任何字段，这份内容不是合法的 YAML'], issues: [] };
        }
        // 与 saveDraftEdit 同一口径：没有信息节点也算硬错，否则存下去是空壳
        const n = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
        if (!n) {
            return { ok: false, fatal: ['一个信息节点都没有解析出来，多半是 nodes 下面的缩进或破折号被改坏了'], issues: [] };
        }
        return { ok: true, fatal: [], issues: checkOutlineRefs(parsed) };
    }

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

        // 面板重建后按钮和提示都是新造的，按当前 busy 状态恢复，否则切页回来就像没在忙
        if (busy) {
            const bb = panelEl.querySelector('#eo_busy');
            if (bb) {
                bb.textContent = busyText;
                bb.style.display = 'block';
            }
        }

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

    // ---------- 问号说明气泡（生成页与设置页共用） ----------

    /** 关掉当前打开的所有说明气泡，同时摘掉全局监听 */
    function closeAllTips() {
        for (const tip of document.querySelectorAll('.eo-tip')) tip.remove();
        for (const on of document.querySelectorAll('.eo-help-on')) on.classList.remove('eo-help-on');
        document.removeEventListener('click', onDocClickClose, true);
        document.removeEventListener('keydown', onEscClose, true);
    }

    function onDocClickClose(ev) {
        // 点问号本身不在这里处理，交给它自己的 click，
        // 否则同一个点击会先关再开，看起来像没反应
        if (ev.target && ev.target.closest && ev.target.closest('.eo-help')) return;
        closeAllTips();
    }

    function onEscClose(ev) {
        if (ev.key === 'Escape') closeAllTips();
    }

    /**
     * 小问号：点一下展开说明，点别处或按 Esc 收起。
     * 说明文字存在 title 里，方便直接读取。
     */
    function attachHelp(host, text, inline) {
        const h = el('span', inline ? 'eo-help eo-help-inline' : 'eo-help', '?');
        h.title = text;
        h.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOn = h.classList.contains('eo-help-on');
            closeAllTips();
            if (wasOn) return;
            h.classList.add('eo-help-on');
            const tip = el('div', 'eo-tip');
            tip.textContent = text;
            h.appendChild(tip);
            // 延到下一轮再加监听，否则本次点击会立刻把它自己关掉。
            // 捕获阶段挂，点面板任意位置都能收到
            setTimeout(() => {
                document.addEventListener('click', onDocClickClose, true);
                document.addEventListener('keydown', onEscClose, true);
            }, 0);
        });
        host.appendChild(h);
        return h;
    }

    // ---------- 页：生成事件 ----------

    // 当前展开预览的待选事件 id；跨重渲染保留，没展开就是 null
    let previewDraftId = null;

    /* ---------- 草稿编辑框的「正在改」状态（2026-11-02）----------
       「编辑」按钮不随开合改文案，一直是「编辑」，开关只能靠高亮 + 编辑框底部的「完成」。
       所以编辑框一改字就把编辑框下面那组按钮（保存编辑/取消/完成）换成提示条，
       免得保存按钮躲在屏幕外面看不见。这个状态是模块级的：renderPanel 重建 DOM 也不会丢。 */
    let pendingDraftEditDirty = false;

    function discardPendingEdit() {
        editingDraftId = null;
        draftEditBuf = null;
        draftEditIssues = null;
        pendingDraftEditDirty = false;
    }

    /** 编辑框开着、但还没改动：直接关，不用问 */
    function closeDraftEditor() {
        if (pendingDraftEditDirty) {
            if (!confirm('这份草稿还有没保存的改动，关掉就丢了。继续？')) return;
        }
        discardPendingEdit();
    }

    function renderGenPage(page) {
        const ev = getCurrentEvent();

        const statusBox = el('div', 'eo-box');
        const draftN = Object.values(getMeta().events).filter(e => e && e.status === 'draft').length;
        statusBox.textContent = ev
            ? `进行中：${ev.name}\n开始于 ${String(ev.createdAt || '').slice(0, 19)}\n世界书：${ev.worldBook}　条目 uid=${ev.entryUid}`
                + (draftN ? `\n另有 ${draftN} 个待选事件等你决定` : '')
            : (draftN
                ? `当前没有进行中的事件。上方有 ${draftN} 个待选事件，点「采用」即可开始；也可以继续生成新的来比较。`
                : '当前没有进行中的事件。填好下面的事件名和偏好即可开始。生成后先进待选，满意再采用。');
        page.appendChild(statusBox);

        // --- 待选事件 ---
        // 生成只产出待选，不写世界书；点「采用」才真正生效。
        // 这样反复重生成不会来回写删世界书条目
        const drafts = Object.values(getMeta().events)
            .filter(e => e && e.status === 'draft')
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        if (drafts.length) {
            const dHead = el('div', 'eo-sec eo-sec-inline');
            dHead.appendChild(el('span', null, `待选事件（${drafts.length}/${MAX_DRAFTS}）`));
            attachHelp(dHead, '生成后先放在这里，不写世界书、不设为当前事件。看看满意就点「采用」，'
                + '不满意就点「丢弃」，或者调一调偏好再生成一个来比较。最多同时保留 '
                + MAX_DRAFTS + ' 个，超出时最早的会被挤掉。');
            page.appendChild(dHead);

            const draftBox = el('div', 'eo-drafts');
            for (const d of drafts) {
                const item = el('div', 'eo-draft');
                const head = el('div', 'eo-draft-head');
                head.appendChild(el('span', 'eo-draft-name', d.name));
                const n = (d.outline && d.outline.nodes || []).length;
                const c = Object.keys((d.outline && d.outline.characters) || {}).length;
                const meta = [];
                meta.push(`${n} 个节点`);
                if (c) meta.push(`${c} 类角色`);
                if (d.autoNamed) meta.push('自动命名');
                head.appendChild(el('span', 'eo-draft-meta', meta.join('　')));
                item.appendChild(head);

                if (d.brief) item.appendChild(el('div', 'eo-draft-brief', d.brief));

                const acts = el('div', 'eo-row');
                const btnUse = el('button', 'eo-btn eo-press', '采用');
                btnUse.type = 'button';
                btnUse.addEventListener('click', async () => {
                    btnUse.disabled = true;
                    btnUse.textContent = '正在采用…';
                    try {
                        await commitDraft(d.id);
                        activeTab = 'gen';
                        renderPanel();
                    } catch (e) {
                        error('采用待选事件失败：', e);
                        btnUse.disabled = false;
                        btnUse.textContent = '采用';
                        alert('采用失败：' + (e && e.message || e));
                    }
                });
                acts.appendChild(btnUse);

                const btnDrop = el('button', 'eo-btn eo-press', '丢弃');
                btnDrop.type = 'button';
                btnDrop.addEventListener('click', () => {
                    if (!confirm(`丢弃待选事件「${d.name}」？它还没写进世界书，丢弃不会留下任何东西。`)) return;
                    discardDraft(d.id);
                    renderPanel();
                });
                acts.appendChild(btnDrop);

                // 看大纲 / 编辑是开关：开着就常亮，再点一次收起、灯灭（2026-11-02 危晓定）
                const btnLook = el('button', 'eo-btn' + (previewDraftId === d.id ? ' eo-on' : ''), '展示大纲');
                btnLook.type = 'button';
                btnLook.addEventListener('click', () => {
                    if (pendingDraftEditDirty) {
                        if (!confirm('正在编辑的这份还有没保存的改动，切走会丢掉。继续？')) return;
                        discardPendingEdit();
                    }
                    previewDraftId = previewDraftId === d.id ? null : d.id;
                    // 收起预览等于收起这张草稿，正在编辑它也一并退出
                    if (previewDraftId === null) { editingDraftId = null; draftEditBuf = null; }
                    renderPanel();
                });
                acts.appendChild(btnLook);

                const btnEdit = el('button', 'eo-btn' + (editingDraftId === d.id ? ' eo-on' : ''), '编辑');
                btnEdit.type = 'button';
                btnEdit.addEventListener('click', () => {
                    if (editingDraftId === d.id) {
                        closeDraftEditor();
                    } else {
                        // 从别的草稿的编辑框切过来：有未保存改动先问一句，别悄悄丢
                        if (pendingDraftEditDirty
                            && !confirm('另一份草稿还有没保存的改动，切走会丢掉。继续？')) return;
                        discardPendingEdit();
                        editingDraftId = d.id;
                        draftEditBuf = makeDraftEditBuf(d);
                        draftEditIssues = null;
                        previewDraftId = d.id;
                    }
                    renderPanel();
                });
                acts.appendChild(btnEdit);
                item.appendChild(acts);

                if (editingDraftId === d.id) {
                    item.appendChild(renderDraftEditor(d));
                    draftBox.appendChild(item);
                    // 这里用 continue 不是 return：return 会跳出整个 for，
                    // 后面的草稿全被丢掉，界面看起来就是「一片空白」（2026-11-01 实测踩到）
                    continue;
                }

                // 展开时才渲染大纲正文，避免一屏堆几百行
                if (previewDraftId === d.id) {
                    const body = el('div', 'eo-draft-body');
                    const q = d.parseQuality;
                    if (q && !q.ok) {
                        const bad = el('div', 'eo-bad-box');
                        bad.textContent = '⚠ 这份大纲结构不完整：' + q.missing.join('；');
                        body.appendChild(bad);
                    }
                    const txt = el('div', 'eo-outline-text');
                    txt.textContent = renderOutlineText(d.outline);
                    body.appendChild(txt);
                    item.appendChild(body);
                }
                draftBox.appendChild(item);
            }
            page.appendChild(draftBox);
        }

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
                    + '。节点进度将无法正常跟踪。可把当前事件废弃后在生成页重新生成，或到日志页查看模型原始输出。';
                page.appendChild(bad);
            }
            const outlineText = renderOutlineText(ev.outline);
            if (outlineText) {
                const det = el('details', 'eo-details');
                det.open = true;
                det.appendChild(el('summary', null, '事件大纲'));
                // 用 outline-text 而不是 eo-box：后者有 220px 高度上限，
                // 大纲几百行会被压在一条小滚动条里，看起来就像没有排版
                const ob = el('div', 'eo-outline-text');
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
            // 不再 return：待选机制允许在事件进行中继续生成新的来比较，
            // 只是「采用」时要先把当前这件事收掉
            page.appendChild(el('div', 'eo-sec', '再生成一个待选'));
        }

        // --- 新建事件表单 ---
        page.appendChild(el('div', 'eo-sec', '事件'));
        const nameRow = el('div', 'eo-row');
        nameRow.appendChild(el('label', null, '事件名'));
        const nameInput = el('input', 'eo-input');
        nameInput.type = 'text';
        nameInput.placeholder = '例如：东方快车谋杀案';
        // 事件名也存进草稿，这样「重置为默认」能把它一起清掉
        nameInput.value = draftName || '';
        nameInput.addEventListener('input', () => { draftName = nameInput.value; persistGenForm(); });
        // 切走或刷新前的最后一道保险：输入法组字中可能没触发 input，失焦时再存一次
        nameInput.addEventListener('change', persistGenForm);
        nameRow.appendChild(nameInput);
        page.appendChild(nameRow);
        page.appendChild(el('div', 'eo-hint',
            '事件名可以留空。留空时模型会读当前剧情，自己起一个 4-12 字的事件名。想自己起就填这里。'));

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
        mainSel.addEventListener('change', () => { prefs.eventMainType = mainSel.value; persistGenForm(); });
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
                persistGenForm();
            });
            subBox.appendChild(b);
        }
        subWrap.appendChild(subBox);
        page.appendChild(subWrap);
        paintCounter();
        page.appendChild(counter);

        // 事件目的与框架提示放在体验偏好之前：这两个是「想要什么」，
        // 偏好是「多难多险」，先想清楚要什么再调强度，顺序才对
        page.appendChild(el('div', 'eo-sec eo-sec-inline', '事件目的'));
        page.appendChild(el('div', 'eo-hint',
            '你想让这个事件最终达成什么。留空则由模型按当前剧情自行判断。填了会成为硬约束，大纲会围绕它展开。'));
        const goalInput = el('textarea', 'eo-input eo-textarea');
        goalInput.rows = 3;
        goalInput.placeholder = '例如：让玩家在最终揭开前，逐步发现车上的乘客都与同一桩旧案有关，并理解他们为何共同动手';
        goalInput.value = prefs.goal || '';
        goalInput.addEventListener('input', () => { prefs.goal = goalInput.value; persistGenForm(); });
        goalInput.addEventListener('change', persistGenForm);
        page.appendChild(goalInput);

        page.appendChild(el('div', 'eo-sec eo-sec-inline', '事件框架提示'));
        page.appendChild(el('div', 'eo-hint',
            '你自己构思的大致框架、想要的桥段或细节。留空则完全由模型设计。填了会尽量采纳。'));
        const hintInput = el('textarea', 'eo-input eo-textarea');
        hintInput.rows = 4;
        hintInput.placeholder = '例如：开场列车遭遇暴雪被困，死者身中十二刀；中途每个乘客的证词都互相印证却彼此矛盾；结尾靠一枚被烧焦的信纸残片把所有人的旧案串起来';
        hintInput.value = prefs.promptHint || '';
        hintInput.addEventListener('input', () => { prefs.promptHint = hintInput.value; persistGenForm(); });
        hintInput.addEventListener('change', persistGenForm);
        page.appendChild(hintInput);

        page.appendChild(el('div', 'eo-sec', '体验偏好'));
        page.appendChild(el('div', 'eo-hint',
            '这里是「这次想玩什么样的体验」，会原样写进生成大纲的提示词，模型按你的选择决定难度和危险程度。不确定选哪个的，留着「根据当前情况自行设定」就行，模型会自己配一套合理的。'));

        // 单项下拉（大致模式下的档位、详细模式下的子项都用它）
        function makeSelect(row, labelText, options, current, onChange, desc) {
            const lab = el('label', null, labelText);
            lab.style.minWidth = '92px';
            row.appendChild(lab);
            // 有说明就挂个问号，跟在标签后头；没说明就什么都不加
            if (desc) {
                attachHelp(lab, desc, true);
                lab.style.display = 'flex';
                lab.style.alignItems = 'center';
                lab.style.gap = '4px';
                // 问号占位置，最小宽度放开，避免标签被挤或被撑宽
                lab.style.minWidth = 'auto';
                lab.style.flex = '0 0 auto';
            }
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
                    },
                    `选一个粗档位，把本组 ${items.length} 个子项一次定好。各个子项之间是独立的，`
                    + '档位只是替你批量填好，想单独调哪一项切到「详细」就行。');
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
                    (v) => { prefs[g.key] = v; },
                    g.desc);
                body.appendChild(row);
            }
        }

        let curGroup = null;
        // 各组内容区的重绘函数，供难度等级变化时统一刷新「自行设定」文案
        const groupPainters = {};
        function repaintAllGroups() {
            for (const name of Object.keys(groupPainters)) {
                try { groupPainters[name](); } catch (e) { warn('重绘偏好分组失败：' + name, e); }
            }
        }
        for (const g of PREF_GROUPS) {
            const isGrouped = !!g.group && !!PREF_PRESETS[g.group];

            if (!isGrouped) {
                // 独立项：直接一行（难度等级在这里，选项来自设置里的自定义档位）
                const opts = g.dynamic === 'difficulty'
                    ? [PREF_AUTO_NEW].concat(getDifficultyLevels())
                    // 独立项里也有带 SUB_AUTO 占位的（节点数量等），
                    // 不换掉的话下拉框会直接显示成 __eo_sub_auto__
                    : (g.options || []).map(o => (o === SUB_AUTO ? autoByText(prefs) : o));
                const row = el('div', 'eo-row');
                makeSelect(row, g.label,
                    opts.map(o => ({ value: o, label: o })),
                    // 历史值可能是另一句「自行设定」文案，归一化后选中
                    opts.includes(prefs[g.key]) ? prefs[g.key] : (opts[0] || PREF_AUTO_NEW),
                    (v) => {
                        prefs[g.key] = v;
                        // 难度等级变了，下面各组的「自行设定」文案要跟着变
                        if (g.key === 'difficultyLevel') repaintAllGroups();
                    },
                    g.desc);
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
                        persistGenForm();
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
                // 登记，供难度等级切换时刷新文案（重绘内容区，折叠壳不动）
                groupPainters[g.group] = () => paintGroup(g.group, body, hintSpan);
            }
        }

        const extraRow = el('div', 'eo-row');
        extraRow.appendChild(el('label', null, '额外要求'));
        const extraInput = el('input', 'eo-input');
        extraInput.type = 'text';
        extraInput.value = prefs.extra || '无';
        extraInput.addEventListener('input', () => { prefs.extra = extraInput.value; persistGenForm(); });
        extraInput.addEventListener('change', persistGenForm);
        extraInput.style.flex = '1';
        extraRow.appendChild(extraInput);
        page.appendChild(extraRow);

        // 重置按钮：把上面这一整套选项拨回默认，不动待选区
        // 问号放在按钮外面（2026-11-01 危晓要求）：按钮的点击区只负责重置，
        // 别让「看说明」和「一键清空」挤在一块儿容易误点
        const rstRow = el('div', 'eo-row eo-reset-row');
        const btnReset = el('button', 'eo-btn', '重置为默认');
        btnReset.type = 'button';
        btnReset.addEventListener('click', () => {
            if (!confirm('把上面所有选项重置为默认？已生成的待选事件不受影响。')) return;
            resetDraftPrefs();
            log('生成页选项已重置为默认');
            renderPanel();
        });
        rstRow.appendChild(btnReset);
        attachHelp(rstRow, '把事件名、事件目的、框架提示、额外要求和全部体验偏好拨回默认值。'
            + '已经生成的待选事件不受影响，它们各自记着自己生成时的那份设置。', true);
        page.appendChild(rstRow);

        // 上下文预览
        // 这里原本会列出「记忆来源 / 最近楼层 / 世界书 / 纪要」四行统计，
        // 但生成时真正用了哪些上下文，日志页有更准确的一份，这块只是重复占地方，已移除

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
            prefs.goal = String(goalInput.value || '').trim();
            prefs.promptHint = String(hintInput.value || '').trim();
            if (prefs.goal) log(`本次生成带事件目的（${prefs.goal.length} 字）：${prefs.goal.slice(0, 40)}${prefs.goal.length > 40 ? '…' : ''}`);
            if (prefs.promptHint) log(`本次生成带框架提示（${prefs.promptHint.length} 字）`);
            btnGo.disabled = true;
            btnGo.textContent = '正在生成…';
            opOut.className = 'eo-hint';
            opOut.textContent = '正在生成大纲，请稍候…';
            try {
                const event = await createEvent(name, prefs);
                const nodeN = (event.outline && event.outline.nodes || []).length;
                log(`生成大纲成功：${event.name}，节点 ${nodeN} 个，已放入待选，未写世界书`);
                // 刻意不重置偏好：生成出待选之后，下面那套选项要停在刚才用的那份，
                // 方便在此基础上微调后再生成一个来比较。想回默认就点「重置为默认」
                opOut.className = 'eo-ok';
                opOut.textContent = `已生成「${event.name}」（${nodeN} 个节点），已放入上方待选。看看满意就点「采用」写入世界书，不满意可以直接再生成一个。`;
                previewDraftId = event.id;
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

    // 设置页里处于展开状态的配置档 id。面板重建会重造 DOM，
    // 放在这里才能跨重渲染保留，不然改个选项就自己折回去
    const openProfiles = new Set();

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
            // 重建面板时恢复展开状态：切换方式会触发 renderPanel，
            // 不记住的话刚展开的配置会自己折回去，用户还得再点一次
            box.open = openProfiles.has(p.id);
            box.addEventListener('toggle', () => {
                if (box.open) openProfiles.add(p.id); else openProfiles.delete(p.id);
            });
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
                    tIn.value = String(Number.isFinite(Number(p.temperature)) ? Number(p.temperature) : 0.7);
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
                        openProfiles.delete(p.id);
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
                temperature: 0.7,
                maxTokens: 0,
            });
            saveSettings();
            // 新建即展开，用户点完就能直接填，不用再点一下
            openProfiles.add(id);
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

        // 世界书字数上限：超了会截断后面的条目，用户必须能自己调
        const wcRow = el('div', 'eo-row');
        wcRow.appendChild(el('label', null, '世界书字数上限'));
        const wcIn = el('input', 'eo-input');
        wcIn.type = 'number';
        wcIn.min = '1000';
        wcIn.step = '1000';
        wcIn.value = String((s.worldbook && s.worldbook.maxChars) || 30000);
        wcIn.style.flex = '0 0 110px';
        wcIn.addEventListener('change', () => {
            const n = Math.max(1000, Number(wcIn.value) || 30000);
            getSettings().worldbook.maxChars = n;
            wcIn.value = String(n);
            saveSettings();
            log(`世界书字数上限已设为 ${n} 字`);
        });
        wcRow.appendChild(wcIn);
        wcRow.appendChild(el('span', 'eo-hint', '字。超出会截断后面的条目'));
        page.appendChild(wcRow);

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
        attachHelp(trSec, '「打勾」= 把大纲里的某个节点标成已达成。剧情推进到某个节点时，谁来判断、谁来点，就是这个模式决定的。');
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
            // 三档只做说明，不标「当前」：上面那个下拉框已经写着当前选的是哪档，
            // 再在说明里标一次等于同一件事说两遍（2026-11-01 危晓要求删掉）
            const item = el('div', 'eo-mode');
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
        attachHelp(retSec, '事件完结或废弃后，事件卡不会立刻消失，而是留在这里当历史。这两个数字是分别保留多少条：超出上限时按结束时间从旧到新删掉最老的。进行中的事件永远不会被清掉。');
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
                log(`世界书自检：${target}，总条目 ${total}，本扩展 ${mine.length} 条，shujuku 导出 ${foreignExport} 条`);
            } catch (e) {
                checkOut.className = 'eo-bad';
                checkOut.textContent = '读取失败：' + (e && e.message || e);
                error('世界书自检失败：', e);
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
                log(`世界书写入测试成功：${target}，uid=${r.uid}`);
            } catch (e) {
                checkOut.className = 'eo-bad';
                checkOut.textContent = '写入失败：' + (e && e.message || e);
                error('世界书写入测试失败：', e);
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
                    log(`删除测试条目：${target} 里没有找到测试条目`);
                    return;
                }
                for (const uid of targets) await deleteEventEntry(target, uid);
                checkOut.className = 'eo-ok';
                checkOut.textContent = `已删除 ${targets.length} 条测试条目。`;
                log(`已删除世界书测试条目 ${targets.length} 条：${targets.join('、')}`);
            } catch (e) {
                checkOut.className = 'eo-bad';
                checkOut.textContent = '删除失败：' + (e && e.message || e);
                error('删除世界书测试条目失败：', e);
            } finally { btnClean.disabled = false; }
        });

        bookRow.appendChild(btnTest);
        bookRow.appendChild(btnClean);
        page.appendChild(bookRow);

        // --- 难度档位 ---
        page.appendChild(el('div', 'eo-sec', '难度档位'));
        page.appendChild(el('div', 'eo-hint',
            '生成事件时「难度等级」下拉里可选的档位。留空则使用内置默认档：'
            + DEFAULT_DIFFICULTY_LEVELS.join(' / ')
            + '。如果你的角色卡自带一套分级（比如从 F 到 SSS、或「见习/正式/精英」），在这里整组填成你卡里的说法即可。'));
        const lvInput = el('textarea', 'eo-input eo-textarea');
        lvInput.rows = 5;
        lvInput.placeholder = '每行一个档位，从低到高。例如：\nF 级\nE 级\nD 级\nC 级\nB 级';
        const custom = (s.preset && Array.isArray(s.preset.difficultyLevels)) ? s.preset.difficultyLevels : [];
        lvInput.value = custom.join('\n');
        page.appendChild(lvInput);

        const lvRow = el('div', 'eo-row');
        const btnLvSave = el('button', 'eo-btn eo-primary', '保存档位');
        const btnLvReset = el('button', 'eo-btn', '恢复默认');
        const lvOut = el('div', 'eo-hint');
        btnLvSave.addEventListener('click', () => {
            const list = String(lvInput.value || '').split('\n')
                .map(x => x.trim()).filter(Boolean);
            // 去重但保留顺序
            const seen = new Set();
            const clean = [];
            for (const x of list) { if (!seen.has(x)) { seen.add(x); clean.push(x); } }
            getSettings().preset.difficultyLevels = clean;
            saveSettings();
            lvOut.className = 'eo-ok';
            lvOut.textContent = clean.length
                ? `已保存 ${clean.length} 个档位：${clean.join(' / ')}`
                : '已清空，将使用内置默认档位';
            log(`难度档位已更新：${clean.length ? clean.join(' / ') : '（恢复默认）'}`);
        });
        btnLvReset.addEventListener('click', () => {
            lvInput.value = '';
            getSettings().preset.difficultyLevels = [];
            saveSettings();
            lvOut.className = 'eo-ok';
            lvOut.textContent = '已恢复默认档位：' + DEFAULT_DIFFICULTY_LEVELS.join(' / ');
            log('难度档位已恢复默认');
        });
        lvRow.appendChild(btnLvSave);
        lvRow.appendChild(btnLvReset);
        page.appendChild(lvRow);
        page.appendChild(lvOut);
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
                healEntryUids().catch(e => warn('校正条目位置失败', e));
                if (panelEl && panelEl.classList.contains('eo-open')) renderPanel();
            });
        } catch (e) {
            warn('事件绑定失败', e);
        }

        // 每次 AI 回复落地（玩家楼 + AI 楼各算一层）就检查一次自动盘点
        try {
            context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, () => {
                scheduleAutoInventoryCheck();
                // shujuku 把表格写进楼里的时机比 MESSAGE_RECEIVED 晚，
                // 立刻重绘会读到还没有表格的楼层，导致记忆来源判定成「最近楼层」。
                // 延后再绘一次，让判定跑在数据落盘之后
                setTimeout(() => {
                    lastAdapterSig = null;  // 强制重判，否则去重会跳过这次变化
                    if (panelEl && panelEl.classList.contains('eo-open')) renderPanel();
                }, 1500);
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
        findEventEntryUid,
        commentMatchesEvent,
        getCharacterBookName,
        collectSheetsFromChat,
    };

    init();
})();
