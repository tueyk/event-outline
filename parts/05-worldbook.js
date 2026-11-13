    // ==================== 4. 世界书 ====================

    let writeChain = S.writeChain; // 引用指向 S，值统一存 S

    function withWriteLock(fn) {
        const run = S.writeChain.then(fn, fn);
        S.writeChain = run.catch(() => { });
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

    /**
     * 事件条目的世界书顺序值。设置里改的就是这个数（默认 200，见 DEFAULT_SETTINGS.worldbook.entryOrder）。
     * order 越大越靠前：列表按它排，↑Char 那一组也按它决定谁先拼进提示词。
     * 取值不合法（不是数字、越界）时退回 200，别让一条坏设置把条目写进 queue 外面。
     */
    function eventOrderValue() {
        const v = Number((getSettings().worldbook || {}).entryOrder);
        if (!Number.isFinite(v)) return DEFAULT_ENTRY_ORDER;
        return Math.min(MAX_ENTRY_ORDER, Math.max(0, Math.round(v)));
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
            order: eventOrderValue(),
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
     * 写入或更新事件条目。返回 {uid}
     * 只在 entries 里新增/更新 ▸事件｜ 前缀条目，其余严格不动。
     *
     * 2026-11-02 去掉了「写前快照」：那份快照写进 sessionStorage 之后全文没有任何读取路径，
     * 整本世界书（实测这一本 2.7MB 量级）每写一次就多占一份配额，key 还永不清理，
     * 配额一满就静默失败。真正在保护外部条目的是下面的写后校验（foreignBefore/verifyForeignEntriesUnchanged），
     * 它逐条比对本次改动之外的所有条目，比一份没人读的快照更能兜住问题。
     */
    async function upsertEventEntry(bookName, content, comment, existingUid, event) {
        return withWriteLock(async () => {
            const data = await readWorldBook(bookName);
            if (!data || !data.entries) throw new Error('世界书数据无效');

            const foreignBefore = snapshotForeignEntries(data);
            let uid = existingUid;

            // 传了事件对象就重新定位：世界书可能被别的插件重排过 uid，
            // 记下的编号未必还指着自己那条，照着旧编号写会覆盖别人的条目。
            //
            // 2026-11-10 修（评审 P1-8）：记下的编号认不出来时，原来会把 existingUid 原样留着，
            // 后面只要那个编号上还是一条 ▸事件 条目，就照样覆盖写入——那条可能是别人的。
            // 认不出来就该老老实实当新增：多一条看得见、删得掉；顶掉别人的条目是静默丢内容。
            if (event) {
                const found = findEventEntryUid(data, event);
                if (found != null) {
                    if (String(found) !== String(existingUid)) {
                        warn(`事件「${event.name}」的条目位置变了：记录 uid=${existingUid}，实际 uid=${found}，按实际位置写入`);
                    }
                    uid = found;
                } else {
                    if (existingUid != null) {
                        warn(`事件「${event.name}」的记录 uid=${existingUid} 已认不出来（名字或对话对不上），本次按新增处理，不覆盖那个编号上的内容`);
                    }
                    uid = null;
                }
            }
            // 那几项用户可能在酒馆界面里手动调过，扩展没资格覆盖。
            const wantOrder = eventOrderValue();
            for (const [k, e] of Object.entries(data.entries)) {
                if (!e || !String(e.comment || '').startsWith(ENTRY_PREFIX)) continue;
                if (Number(e.order) !== wantOrder) {
                    debug(`事件条目 uid=${k} 的顺序 ${e.order} → ${wantOrder}`);
                    e.order = wantOrder;
                }
            }

            let wasUpdate = false;
            if (uid != null && data.entries[uid] &&
                String(data.entries[uid].comment || '').startsWith(ENTRY_PREFIX)) {
                data.entries[uid].content = content;
                data.entries[uid].comment = comment;
                data.entries[uid].constant = true;
                wasUpdate = true;
            } else {
                uid = nextUid(data);
                data.entries[uid] = buildEntry(uid, content, comment);
            }

            await writeWorldBook(bookName, data);
            // 更新还是新增，看实际走了哪条路，不看传进来的值：
            // 传了记录但认不出来时会按新增走，那时说「更新」是错的。
            log(`世界书已写入「${bookName}」：${wasUpdate ? '更新' : '新增'}条目 uid=${uid}，正文 ${String(content).length} 字`);
            debug(`世界书写入明细：条目总数 ${Object.keys(data.entries).length}，本次改动 uid=${uid}`);

            // 回读校验
            const after = await readWorldBook(bookName);
            const check = verifyForeignEntriesUnchanged(foreignBefore, after);
            if (!check.ok) {
                // 明细（含 uid）只进日志；界面上说「有别的条目被改动」就够，uid 用户不认识
                error(`世界书写后校验失败：${check.reason}`);
                // 2026-11-10 修（评审 P1-9）：抛出前把 uid 挂到错误上。
                // 内容这时已经真的写进世界书了，说「已中止」是假的——它没中止，是写完了才发现别处被动了。
                // 挂上 uid 让调用方能记账：不记的话，这本书里留着一条内容正确、
                // 扩展却不知道属于谁的事件条目，下次采用会在旁边再写一条重复的。
                const err = new Error('世界书写后校验失败：有其他条目内容被改动。本次内容已写入世界书，请先刷新页面检查再决定是否保留');
                err.uid = uid;
                err.written = true;
                throw err;
            }
            if (!after.entries[uid] || String(after.entries[uid].content || '') !== String(content)) {
                error(`世界书回读内容不一致：uid=${uid}，期望 ${String(content).length} 字，实际 ${String((after.entries[uid] || {}).content || '').length} 字`);
                const err = new Error('世界书回读内容不一致：条目已写入，但内容与预期不符，请刷新页面核对');
                err.uid = uid;
                err.written = true;
                throw err;
            }

            return { uid };
        });
    }

    /**
     * 删除路径的唯一实现。定位、复核、删除三步必须在同一把锁里：
     * 先读出来找 uid、再另起一次写，中间隔着一次 await，别人动了世界书就可能删错条目。
     * 2026-11-10 修（评审 P1-8 / 本方案第 10 项）：
     *   - 传了 event 时按名字+对话现查，并且再复核一次 commentMatchesEvent——
     *     findEventEntryUid 的判定口径可能与删除要求不同，删之前必须确认它就是自己那条；
     *   - 只传 uid 时（测试条目清理）按 uid 删，仍校验 ▸事件 前缀。
     */
    async function deleteEventEntryLocked(bookName, uidOrEvent) {
        return withWriteLock(async () => {
            const data = await readWorldBook(bookName);
            if (!data || !data.entries) throw new Error('世界书数据无效');

            let uid;
            let expectedEvent = null;
            if (uidOrEvent && typeof uidOrEvent === 'object') {
                const event = uidOrEvent;
                const found = findEventEntryUid(data, event);
                if (found == null) {
                    warn(`事件「${event.name}」在世界书里找不到对应条目，跳过删除`);
                    return { deleted: false, reason: '条目不存在' };
                }
                if (String(event.entryUid) !== String(found)) {
                    warn(`事件「${event.name}」的条目位置与记录不符：记录 uid=${event.entryUid}，实际 uid=${found}，按实际位置删除`);
                }
                uid = found;
                expectedEvent = event;
            } else {
                uid = uidOrEvent;
            }

            const entry = data.entries[uid];
            if (!entry) {
                warn(`删除条目 uid=${uid} 时发现它已不存在，可能已被别处删过`);
                return { deleted: false, reason: '条目不存在' };
            }
            if (!String(entry.comment || '').startsWith(ENTRY_PREFIX)) {
                error(`拒绝删除 uid=${uid}：注释「${entry.comment}」不是本扩展创建的条目`);
                throw new Error('拒绝删除：该条目不是本扩展创建的');
            }
            if (!String(entry.comment || '').startsWith(ENTRY_PREFIX)) {
                error(`拒绝删除 uid=${uid}：注释「${entry.comment}」不是本扩展创建的条目`);
                throw new Error('拒绝删除：该条目不是本扩展创建的');
            }
            // 复核这一条到底是不是它自己的（评审原第 8 条要求）。
            // 注意判定口径要和 findEventEntryUid 一致：那个函数允许两种命中——
            //   · 事件名 + chatId 都对上；或
            //   · 条目极老、没写 chatId，靠事件名唯一认出（它的第 4 步）。
            // 所以这里不能一律要求 chatId 匹配：那就把「名字对、没写 chatId」的老条目判成别人，
            // 永远删不掉，收尾后它留在世界书里没人认领。
            // 只在明确对不上时拒绝：名字不同，或双方都写了 chatId 却不是同一个。
            if (expectedEvent) {
                const cName = commentNameOf(entry.comment);
                const nameOk = !expectedEvent.name || cName === String(expectedEvent.name);
                const entryChat = (String(entry.comment || '').match(/chatId=([^｜|]*)/) || [])[1];
                const wantChat = expectedEvent.chatId == null ? '' : String(expectedEvent.chatId);
                const chatOk = !entryChat || !wantChat || String(entryChat).trim() === wantChat;
                if (!nameOk || !chatOk) {
                    error(`拒绝删除 uid=${uid}：条目注释「${entry.comment}」与事件「${expectedEvent.name}」对不上（${!nameOk ? '名字不同' : '对话不同'}）`);
                    throw new Error('拒绝删除：世界书里这一条不是该事件的条目');
                }
            }

            const foreignBefore = snapshotForeignEntries(data);
            const beforeCount = Object.keys(data.entries).length;
            delete data.entries[uid];
            await writeWorldBook(bookName, data);
            const after = await readWorldBook(bookName);
            if (after && after.entries && after.entries[uid]) {
                // 写回成功但条目还在，说明这次删除没落盘，不能报成功
                error(`删除回读校验失败：uid=${uid} 写入后仍然存在，删除未生效`);
                throw new Error('删除后回读校验失败：条目仍在世界书里，请刷新页面确认');
            }
            const check = verifyForeignEntriesUnchanged(foreignBefore, after);
            if (!check.ok) {
                error(`删除后校验失败：${check.reason}`);
                throw new Error('删除后校验失败：有其他条目内容被改动，已中止本次删除');
            }
            log(`世界书已删除事件条目 uid=${uid}，退回 ${Object.keys(foreignBefore).length} 条外部条目（总条目 ${beforeCount} → ${Object.keys((after && after.entries) || {}).length}）`);
            return { deleted: true };
        });
    }

    /** 按 uid 删本扩展的条目（测试条目清理等）。 */
    async function deleteEventEntry(bookName, uid) {
        return deleteEventEntryLocked(bookName, uid);
    }

    /**
     * 删掉某个事件在世界书里的条目，位置由 findEventEntryUid 现查，
     * 不信 event.entryUid——它可能已经被别的插件重排成了别人的编号。
     * 定位与删除在同一把锁内完成，见 deleteEventEntryLocked。
     */
    async function deleteEventEntryForEvent(bookName, event) {
        return deleteEventEntryLocked(bookName, event);
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


    /**
     * 2026-11-10 批 3 第 17 项：当前对话的可读标识。
     *
     * 事件存档存在 chatMetadata 里，天然跟着对话走——换对话不会串数据。
     * 但面板上写「进行中：某某事件」时没说这事件是哪段对话里开的，
     * 用户从别的对话切回来、或者开了两个窗口，就看不出手里这个事件的出处。
     * 长期口径已定（裁定一）为「新增数据一律按对话隔离」，这一条是不改结构前提下先给出的可见性。
     *
     * 返回形如 { id, label }：id 是 chatId 原值，label 是给人看的短名。
     * 拿不到就返回 { id:'', label:'未知对话' }，不抛异常——面板不能因为这个挂掉。
     */
    function currentChatTag() {
        const context = ctx();
        if (!context) return { id: '', label: '未知对话' };
        const id = context.chatId == null ? '' : String(context.chatId);
        // 优先角色名 + 文件名：ST 的 chatId 是一串不透明的标识，单看它用户认不出是哪个对话
        const chars = context.characters || [];
        const chid = context.characterId;
        const chName = (chid != null && chars[chid] && (chars[chid].name || '')) || '';
        // fileName 形如「角色名 - 2026-11-10@20时30分.jsonl」，只去扩展名、不去时间戳：
        // 用正则切时间戳依赖文件名的具体格式，ST 换个写法就切错，宁可多显示一段也不切坏。
        // 拿到角色名与文件名就用「角色名 · 文件名」，缺一个时用另一个，都没有就退回归档 id 末 6 位。
        const chatFile = String(context.chatMetadata && context.chatMetadata.file_name || '');
        let label;
        if (chName && chatFile) label = `${chName} · ${chatFile.replace(/\.jsonl?$/i, '')}`;
        else if (chName) label = chName;
        else if (chatFile) label = chatFile.replace(/\.jsonl?$/i, '');
        else label = id ? `对话 ${id.slice(-6)}` : '当前对话';
        return { id, label };
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
        //
        // 2026-11-10 删掉了一条猜测规则：原来是「当前对话下只有一条事件条目就认它」。
        // 它让整条链采用时后一个节点顶掉前一个——第一个节点新增条目拿到 uid，
        // 第二个节点名字对不上，却因为「当前对话只有这一条」被认成自己，写进去把第一个覆盖了。
        // 实机现场：三节点链采用完，三个事件的 entryUid 全是 607，书里只剩最后一个节点。
        //
        // 可以安全去掉的理由：
        //   - 改名只发生在编辑待选事件时（保存大纲那一步），那时还是待选状态，
        //     世界里根本没有它的条目，不存在「条目在、名字变了」需要靠猜来认领的情形；
        //   - 真有 uid 记录时由上面第 1 条规则处理，它会校验名字与 chatId；
        //   - 实在认不出来就按新增处理。多出一条条目看得见、删得掉；
        //     顶掉别的条目是静默丢内容。两者代价不对称，宁可新增。

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
                + '生成结果很可能与世界观不符，请检查世界书是否存在，或酒馆本身是否连得上');
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

