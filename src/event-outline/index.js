/* 事件大纲 / 状态盘点 扩展
 * 单文件，按分区组织。无构建步骤，不使用 import。
 * 分区：0 常量 1 上下文 2 存储 3 世界书 4 适配器 5 界面 6 设置 7 入口
 */
(function () {
    'use strict';

    const MODULE = 'event_outline';
    const VERSION = '0.1.0';
    const ENTRY_PREFIX = '▸事件｜';
    const LOG_PREFIX = '[事件大纲]';

    // ==================== 0. 常量 ====================

    const DEFAULT_SETTINGS = {
        version: 1,
        apiProfiles: [
            { id: 'main', name: '跟随酒馆主连接', mode: 'main' },
        ],
        activeProfileId: 'main',
        ui: {
            floatingEnabled: true,
            floatingPos: { anchor: { x: 4, y: 40 }, dock: 'left' },
        },
        tracker: { mode: 'auto' },
        retention: { completed: 20, abandoned: 3 },
        memory: {
            source: 'auto',
            recentFloors: 15,
            jiyaoOverviewMax: 60,
            jiyaoRecentRows: 30,
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

    function log(...args) {
        console.log(LOG_PREFIX, ...args);
    }

    function warn(...args) {
        console.warn(LOG_PREFIX, ...args);
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
        return Object.values(m.events).sort((a, b) =>
            String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }

    function getCurrentEvent() {
        const m = getMeta();
        if (!m || !m.currentEventId) return null;
        return m.events[m.currentEventId] || null;
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

            // 回读校验
            const after = await readWorldBook(bookName);
            const check = verifyForeignEntriesUnchanged(foreignBefore, after);
            if (!check.ok) {
                throw new Error(`世界书写后校验失败：${check.reason}`);
            }
            if (!after.entries[uid] || String(after.entries[uid].content || '') !== String(content)) {
                throw new Error('世界书写后回读内容不一致');
            }

            return { uid, snapshotKey };
        });
    }

    async function deleteEventEntry(bookName, uid) {
        return withWriteLock(async () => {
            const data = await readWorldBook(bookName);
            if (!data || !data.entries) throw new Error('世界书数据无效');
            const entry = data.entries[uid];
            if (!entry) return { deleted: false, reason: '条目不存在' };
            if (!String(entry.comment || '').startsWith(ENTRY_PREFIX)) {
                throw new Error('拒绝删除：该条目不是本扩展创建的');
            }
            const foreignBefore = snapshotForeignEntries(data);
            delete data.entries[uid];
            await writeWorldBook(bookName, data);
            const after = await readWorldBook(bookName);
            const check = verifyForeignEntriesUnchanged(foreignBefore, after);
            if (!check.ok) throw new Error(`删除后校验失败：${check.reason}`);
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
                                result.set(op.sheetKey, op.sheet);
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
        if (!Array.isArray(content) || content.length < 2) return [];
        const header = content[0].map(x => String(x || '').trim());
        const idx = name => header.findIndex(h => h.includes(name));
        const iCode = idx('编码');
        const iSpan = idx('时间跨度');
        const iSum = idx('概览');
        const iText = idx('纪要');

        const rows = [];
        for (let i = 1; i < content.length; i++) {
            const r = content[i];
            if (!Array.isArray(r)) continue;
            const code = String(r[iCode >= 0 ? iCode : 1] || '').trim();
            if (!code) continue;
            rows.push({
                code,
                span: String(r[iSpan >= 0 ? iSpan : 2] || '').trim(),
                summary: String(r[iSum >= 0 ? iSum : 3] || '').trim(),
                text: String(r[iText >= 0 ? iText : 4] || '').trim(),
            });
        }
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

    function resolveAdapter() {
        const s = getSettings();
        const wanted = s.memory.source || 'auto';
        if (wanted !== 'auto') {
            const a = ADAPTERS.find(x => x.id === wanted);
            if (a && a.detect()) return { adapter: a, degraded: false };
            const fallback = ADAPTERS.find(x => x.id === 'recent-floors');
            return { adapter: fallback, degraded: true, wanted };
        }
        const hits = ADAPTERS.filter(a => a.detect()).sort((x, y) => x.priority - y.priority);
        return { adapter: hits[0] || ADAPTERS[ADAPTERS.length - 1], degraded: false };
    }

    // ==================== 8. OOC 词与偏好 ====================

    // 原文存档：运维/VPS/酒馆/OOC词-伊瑟利亚-兰开斯特-事件大纲与状态盘点.md
    // 第 12-45 行 = 大纲词，51-63 行 = 盘点词。此处为改良版，差异见设计文档。

    const PREF_AUTO_NEW = '根据当前情况自行设定';

    const PREF_GROUPS = [
        {
            key: 'commissionLevel',
            label: '委托等级',
            options: [PREF_AUTO_NEW, '按照具体事件难度自行设定', '村中琐事', '城镇委托', '王国要务', '禁忌事件'],
        },
        {
            key: 'clueSufficiency',
            label: '线索充足度',
            group: '推理难度',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '充足（信息基本给全）', '够用（需主动串联）', '稀缺（有缺漏，需验证或外部求助）'],
        },
        {
            key: 'misleadingStrength',
            label: '误导强度',
            group: '推理难度',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '无', '轻度（1 个可排除的误导）', '中度（1-2 个需排除法的误导）', '重度（误导与真线索混杂，需交叉验证）'],
        },
        {
            key: 'hiddenSegments',
            label: '隐藏环节',
            group: '推理难度',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '无（线性可解）', '1 个需推理补全的环节', '2 个需推理补全的环节', '需玩家自行提出关键假设才能推进'],
        },
        {
            key: 'infoPresentation',
            label: '信息呈现',
            group: '推理难度',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '直给（NPC/物证直接说明）', '间接（需从对话或环境推断）', '隐晦（需组合多条信息才能得出）'],
        },
        {
            key: 'lethality',
            label: '致死性',
            group: '危险程度',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '无', '低（极端错误才可能死）', '中（部分节点可致死）', '高（多处节点可致死）'],
        },
        {
            key: 'failureConsequence',
            label: '失败后果',
            group: '危险程度',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '仅损失机会', '受伤或被俘', '失去关键物品或盟友', '不可逆的惨重损失'],
        },
        {
            key: 'tolerance',
            label: '容错率',
            group: '危险程度',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '高（可反复试错）', '中（有限次试错）', '低（一次关键失误即走向坏结局）'],
        },
        {
            key: 'threatSource',
            label: '威胁来源',
            group: '危险程度',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '环境', '敌对角色', '时间', '自身状态（如中毒、受伤）', '多重叠加'],
        },
        {
            key: 'timePressure',
            label: '倒计时',
            group: '时间压力',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '无', '隐藏（存在但玩家不直接看到剩余时间）', '可见（明确显示剩余时间）'],
        },
        {
            key: 'timeDuration',
            label: '时长',
            group: '时间压力',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '宽松（远超所需）', '适中（需规划但有余量）', '紧张（几乎不容浪费）'],
        },
        {
            key: 'timeoutConsequence',
            label: '超时后果',
            group: '时间压力',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '无', '损失机会或信息', '事件走向坏结局', '角色死亡或不可逆损失'],
        },
        {
            key: 'procrastinationCost',
            label: '拖延代价',
            group: '时间压力',
            options: [PREF_AUTO_NEW, '按照委托等级或具体事件难度自行设定', '无', '持续损耗（如资源、体力、NPC 耐心）', '阶段性恶化（每过一段触发一次恶化事件）'],
        },
    ];

    function defaultPrefs() {
        const p = {};
        for (const g of PREF_GROUPS) p[g.key] = PREF_AUTO_NEW;
        p.extra = '无';
        return p;
    }

    function buildPrefsBlock(prefs) {
        const lines = ['【体验偏好（已在界面选定，直接采用，不要再询问）】'];
        let curGroup = null;
        for (const g of PREF_GROUPS) {
            if (g.group && g.group !== curGroup) {
                curGroup = g.group;
                lines.push(`- ${g.group}：`);
            }
            const v = prefs[g.key] || PREF_AUTO_NEW;
            const indent = g.group ? '  · ' : '- ';
            lines.push(`${indent}${g.label}：${v}`);
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

    function buildOutlinePrompt(eventName, prefs) {
        return [
            `OOC: 暂停扮演。为即将开始的【${eventName}】生成完整结构大纲，用 YAML 输出，包含：`,
            '1. 事件类型与核心真相：判断本事件属于哪类（案件/谈判/探险/危机/社交博弈/其他），写出核心真相或隐情（仅记录，后续不得直接透露）',
            '2. 信息节点清单：按发现顺序列 5-8 条，每条含编号（从 1 开始）、类型（物证/证言/环境/时间线/关系）、触发关键词、指向的信息或后果',
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
            '输出格式：只输出一个 YAML 代码块，顶层键为 event_type / core_truth / nodes / min_nodes_for_deduction / characters / paths / forbidden。',
        ].join('\n');
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
                const id = n.id != null ? n.id : n.index;
                const mark = triggered.has(Number(id)) ? '已触发' : '未触发';
                lines.push(` ${id}. ${n.type || ''}${n.desc || n.info || n.content || ''} —— ${mark}`
                    + (n.keyword || n.keywords ? `（触发词：${n.keyword || n.keywords}）` : ''));
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
        const out = {
            stateCard: buildStateCard(event),
            jiyaoList: '',
            jiyaoDetail: '',
            recentChat: '',
            adapterId: resolved.adapter.id,
        };

        // 第二层：记忆召回
        if (resolved.adapter.id === 'shujuku-jiyao' && resolved.adapter.rows) {
            try {
                const rows = resolved.adapter.rows();
                const mode = resolved.adapter.mode ? resolved.adapter.mode() : null;
                const recentRows = Math.max(1, Number(s.memory.jiyaoRecentRows) || 30);

                if (mode === 'llm' && rows.length > recentRows) {
                    // 点名模式：先给概览清单
                    const head = rows.slice(0, Math.max(1, Number(s.memory.jiyaoOverviewMax) || 60));
                    out.jiyaoList = head.map(r => `${r.code}｜${r.span}｜${r.summary}`).join('\n');
                    out.jiyaoDetail = '';
                } else {
                    // 固定窗口：直接给最近 N 条正文
                    const tail = rows.slice(-recentRows);
                    out.jiyaoList = '';
                    out.jiyaoDetail = tail.map(r => `${r.code}｜${r.span}\n${r.text}`).join('\n\n');
                }
            } catch (e) {
                warn('纪要读取失败，降级为纯楼层', e);
            }
        }

        // 第三层：最近楼层
        const floors = Math.max(1, Number(s.memory.recentFloors) || 15);
        out.recentChat = await collectRecentFloors(floors);
        return out;
    }

    // ==================== 10. 生成与解析 ====================

    async function callModel(systemPrompt, prompt) {
        const context = ctx();
        if (!context || !context.generateRaw) throw new Error('generateRaw 不可用');
        const s = getSettings();
        const profile = (s.apiProfiles || []).find(p => p.id === s.activeProfileId) || { mode: 'main' };
        const params = {
            prompt,
            systemPrompt,
            api: profile.mode === 'custom' ? (profile.api || 'openai') : null,
        };
        if (profile.mode === 'custom' && profile.model) params.model = profile.model;
        return await context.generateRaw(params);
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

        // 找某层第一个真实子节点类型，决定容器是 map 还是 list
        let pos = 0;

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
        return { parsed: parsed || {}, raw: String(raw || ''), fromFallback: !extractCodeBlock(raw, 'yaml') };
    }

    function parseInventory(raw) {
        const jsonText = extractCodeBlock(raw, 'json');
        let structured = null;
        if (jsonText) {
            try {
                structured = JSON.parse(jsonText);
            } catch (e) {
                // 尝试修补常见错误
                try {
                    structured = JSON.parse(jsonText.replace(/,\s*([}\]])/g, '$1'));
                } catch (e2) {
                    warn('盘点 JSON 解析失败', e2);
                }
            }
        }
        return { structured, raw: String(raw || '') };
    }

    // ==================== 11. 事件流程 ====================

    let busy = false;

    function setBusy(on) {
        busy = on;
        if (panelEl) {
            const b = panelEl.querySelector('#eo_busy');
            if (b) b.style.display = on ? 'block' : 'none';
        }
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
            const systemPrompt = buildOutlineSystemPrompt();
            const prompt = buildOutlinePrompt(eventName, prefs);
            const raw = await callModel(systemPrompt, prompt);
            const { parsed, raw: rawText } = parseOutline(raw);

            const id = genEventId();
            const meta = getMeta();
            const event = {
                id,
                name: eventName,
                status: 'active',
                createdAt: new Date().toISOString(),
                closedAt: null,
                chatId: context.chatId,
                worldBook: book,
                entryUid: null,
                entryVersion: 1,
                prefs: Object.assign({}, prefs),
                outline: parsed,
                outlineRaw: rawText,
                tracker: {
                    triggeredNodes: [],
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
            setBusy(false);
        }
    }

    async function runInventory() {
        const event = getCurrentEvent();
        if (!event) throw new Error('当前没有进行中的事件');
        if (event.status !== 'active') throw new Error('该事件已结束');

        setBusy(true);
        try {
            const parts = await gatherContext(event);
            const systemPrompt = buildInventorySystemPrompt();
            const prompt = buildInventoryPrompt(parts);
            const raw = await callModel(systemPrompt, prompt);
            const { structured, raw: rawText } = parseInventory(raw);

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

                for (const n of (Array.isArray(structured.triggeredNodes) ? structured.triggeredNodes : [])) {
                    const num = Number(n);
                    if (!Number.isFinite(num)) continue;
                    if (vetoed.has(num)) continue;
                    if (mode === 'manual') continue;
                    if (mode === 'semi') continue; // 半自动：等用户确认
                    if (!triggered.has(num)) {
                        triggered.add(num);
                        t.autoCommitted.push({ node: num, at: record.at, round });
                    }
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

            saveMeta();
            return { record, event };
        } finally {
            setBusy(false);
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
        for (const e of done.slice(limitDone)) delete meta.events[e.id];

        const ab = pick('abandoned');
        const limitAb = Math.max(1, Number(s.retention.abandoned) || 3);
        for (const e of ab.slice(limitAb)) delete meta.events[e.id];
    }

    function toggleNode(nodeId) {
        const event = getCurrentEvent();
        if (!event) return;
        const triggered = new Set(event.tracker.triggeredNodes || []);
        const vetoed = new Set(event.tracker.nodeVetoed || []);
        const id = Number(nodeId);
        if (triggered.has(id)) {
            triggered.delete(id);
            vetoed.add(id);
        } else {
            triggered.add(id);
            vetoed.delete(id);
        }
        event.tracker.triggeredNodes = Array.from(triggered).sort((a, b) => a - b);
        event.tracker.nodeVetoed = Array.from(vetoed).sort((a, b) => a - b);
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
            b.addEventListener('click', () => {
                activeTab = t.key;
                renderPanel();
            });
            tabBar.appendChild(b);
        }
        body.appendChild(tabBar);

        const page = el('div', 'eo-page');
        body.appendChild(page);

        if (activeTab === 'gen') renderGenPage(page);
        else if (activeTab === 'inv') renderInvPage(page);
        else if (activeTab === 'log') renderLogPage(page);
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

            // 大纲原文折叠
            if (ev.outlineRaw) {
                const det = el('details', 'eo-details');
                const sum = el('summary', null, '大纲原文（点击展开）');
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
        nameInput.placeholder = '如：石桥镇失踪案';
        nameRow.appendChild(nameInput);
        page.appendChild(nameRow);

        // 偏好：默认折叠
        const prefs = defaultPrefs();
        const det = el('details', 'eo-details');
        det.appendChild(el('summary', null, `体验偏好（${PREF_GROUPS.length} 项，默认全部「${PREF_AUTO_NEW}」）`));

        let curGroup = null;
        for (const g of PREF_GROUPS) {
            if (g.group && g.group !== curGroup) {
                curGroup = g.group;
                det.appendChild(el('div', 'eo-subsec', `【${g.group}】`));
            }
            const row = el('div', 'eo-row');
            const lb = el('label', null, g.label);
            lb.style.minWidth = '92px';
            row.appendChild(lb);
            const sel = el('select', 'eo-sel');
            sel.style.flex = '1';
            for (const opt of g.options) {
                const o = el('option', null, opt);
                o.value = opt;
                sel.appendChild(o);
            }
            sel.value = PREF_AUTO_NEW;
            sel.addEventListener('change', () => { prefs[g.key] = sel.value; });
            row.appendChild(sel);
            det.appendChild(row);
        }

        const extraRow = el('div', 'eo-row');
        extraRow.appendChild(el('label', null, '额外要求'));
        const extraInput = el('input', 'eo-input');
        extraInput.type = 'text';
        extraInput.value = '无';
        extraInput.style.flex = '1';
        extraRow.appendChild(extraInput);
        det.appendChild(extraRow);
        page.appendChild(det);

        // 上下文预览
        const ctxBox = el('div', 'eo-box eo-ctx-preview');
        ctxBox.textContent = '正在统计上下文…';
        page.appendChild(ctxBox);
        refreshCtxPreview(ctxBox);

        const opOut = el('div', 'eo-hint');
        const goRow = el('div', 'eo-row');
        const btnGo = el('button', 'eo-btn eo-primary', '开始生成大纲');
        btnGo.addEventListener('click', async () => {
            const name = String(nameInput.value || '').trim();
            if (!name) { opOut.className = 'eo-bad'; opOut.textContent = '请填写事件名'; return; }
            prefs.extra = String(extraInput.value || '无').trim() || '无';
            btnGo.disabled = true;
            opOut.className = 'eo-hint';
            opOut.textContent = '正在生成大纲，请稍候…';
            try {
                const event = await createEvent(name, prefs);
                opOut.className = 'eo-ok';
                opOut.textContent = `已生成：${event.name}，世界书条目 uid=${event.entryUid}`;
                activeTab = 'gen';
                renderPanel();
            } catch (e) {
                opOut.className = 'eo-bad';
                opOut.textContent = '生成失败：' + (e && e.message || e);
                warn(e);
            } finally { btnGo.disabled = false; }
        });
        goRow.appendChild(btnGo);
        page.appendChild(goRow);
        page.appendChild(opOut);
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
        btnInv.addEventListener('click', async () => {
            btnInv.disabled = true;
            opOut.className = 'eo-hint';
            opOut.textContent = '正在盘点…';
            try {
                const r = await runInventory();
                opOut.className = 'eo-ok';
                opOut.textContent = `第 ${r.record.round} 次盘点完成，已更新世界书条目 uid=${r.event.entryUid}`;
                renderPanel();
            } catch (e) {
                opOut.className = 'eo-bad';
                opOut.textContent = '盘点失败：' + (e && e.message || e);
                warn(e);
            } finally { btnInv.disabled = false; }
        });
        row.appendChild(btnInv);

        const mode = getSettings().tracker.mode;
        row.appendChild(el('span', 'eo-hint', `打勾模式：${TRACKER_MODES[mode] || mode}`));
        page.appendChild(row);
        page.appendChild(opOut);

        // 节点进度
        const nodes = (ev.outline && ev.outline.nodes) || [];
        if (Array.isArray(nodes) && nodes.length) {
            const triggered = new Set(ev.tracker.triggeredNodes || []);
            page.appendChild(el('div', 'eo-sec', `节点进度（${triggered.size}/${nodes.length}，点击切换）`));
            const nb = el('div', 'eo-box');
            for (const n of nodes) {
                const id = Number(n.id != null ? n.id : n.index);
                const on = triggered.has(id);
                const line = el('div', 'eo-node' + (on ? ' eo-node-on' : ''));
                line.textContent = `${on ? '☑' : '☐'} ${id}. ${n.type || ''} ${n.desc || n.info || n.content || ''}`
                    + (n.keyword || n.keywords ? `（${n.keyword || n.keywords}）` : '');
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

    function renderLogPage(page) {
        const ev = getCurrentEvent();
        if (!ev) {
            page.appendChild(el('div', 'eo-hint', '当前没有进行中的事件，没有可观察的日志。'));
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
        const offPath = t.offPathBranches || [];
        lines.push(`大纲外路径：${offPath.length ? offPath.map(o => `【大纲外】${o.desc}`).join('；') : '无'}`);
        if (offPath.some(o => o.reason)) {
            lines.push('　理由：' + offPath.filter(o => o.reason).map(o => o.reason).join('；'));
        }
        page.appendChild(el('div', 'eo-sec', '当前状态'));
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
        const apiRow = el('div', 'eo-row');
        apiRow.appendChild(el('label', null, '使用配置'));
        const apiSel = el('select', 'eo-sel');
        for (const p of s.apiProfiles) {
            const o = el('option', null, p.name);
            o.value = p.id;
            apiSel.appendChild(o);
        }
        apiSel.value = s.activeProfileId;
        apiSel.addEventListener('change', () => {
            getSettings().activeProfileId = apiSel.value;
            saveSettings();
            renderPanel();
        });
        apiRow.appendChild(apiSel);
        page.appendChild(apiRow);
        page.appendChild(el('div', 'eo-hint', '目前只有「跟随酒馆主连接」。单独配置与多套配置档在后续版本加入。'));

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

        // --- 打勾模式 ---
        page.appendChild(el('div', 'eo-sec', '打勾模式'));
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
        });
        trRow.appendChild(trSel);
        page.appendChild(trRow);
        const modeHint = {
            auto: '自动：盘点后模型判定触发节点并自动打勾。',
            semi: '半自动：模型给出建议，由你点击确认才打勾。',
            manual: '手动：完全由你点击节点切换，模型建议只作参考。',
        };
        page.appendChild(el('div', 'eo-hint', modeHint[s.tracker.mode] || ''));

        // --- shujuku 诊断 ---
        page.appendChild(el('div', 'eo-sec', 'shujuku 接入诊断'));
        const diagBtn = el('button', 'eo-btn', '体检');
        const diagOut = el('div', 'eo-box');
        diagOut.style.display = 'none';
        diagBtn.addEventListener('click', () => {
            try {
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
        page.appendChild(diagRow);
        page.appendChild(diagOut);

        // --- 保留数量 ---
        page.appendChild(el('div', 'eo-sec', '历史保留'));
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
