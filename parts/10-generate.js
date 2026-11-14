    // ==================== 9. 生成与解析 ====================

    /**
     * 发一次模型请求，外面套一层统一处理「超时」和「用户点放弃等待」。
     * 两条出路都必须让调用方的 finally 跑起来，否则 busy 不解除，界面一直转圈只能刷新页面。
     * 走酒馆 generateRaw 的那两种模式没法中断，只能等它自己回，所以放弃等待对它们只是先把界面放开。
     */
    function callModel(systemPrompt, prompt, prefill, overrideProfile) {
        // 2026-11-10 修（评审 P1-5 / P1-6）：
        //
        // 1) 登记必须在发起请求之前完成。原来它在下面几行之后才赋值，而 doCallModel 是同步进入的，
        //    它读 S.pendingRequest 去挂 controller 时拿到的还是上一轮的旧对象，
        //    「放弃等待」abort 的是已经结束的那次请求，正在跑的这次根本停不下来。
        //
        // 2) 超时原来只清定时器和置空，既不 reject 也不 abort，outer 永远悬着、调用方 await 卡死；
        //    界面上看着放开了，那个 Promise 却永远不会结束，进度条目也一直停在进行中。
        //    现在超时走 abortPendingRequest()：它 abort 直连请求，再调 giveUp() 让这里 reject。
        //    走酒馆 generateRaw 的两种模式没有取消接口，abort 是空操作，
        //    但 giveUp 照样让外层结束——调用方拿到「已放弃等待」，总比永远等着强，且说的实话。
        //
        // 写法：先把源头攥在一个对象里，giveUp 改写它的字段，S.pendingRequest 指向的就是它。
        // 这样无论谁先谁后，外面拿到的都是同一个引用，不会指向旧壳子。
        let settleReject = null;
        const pending = {
            controller: null,
            giveUp: () => { if (settleReject) settleReject(new Error('已放弃等待模型返回')); },
        };
        S.pendingRequest = pending;

        const outer = new Promise((resolve, reject) => {
            settleReject = reject;
            doCallModel(systemPrompt, prompt, overrideProfile, prefill).then(resolve, reject);
        });

        const limit = directTimeoutMs() + 60000;
        const timer = setTimeout(() => {
            if (S.pendingRequest === pending) {
                log(`模型请求超过 ${Math.round(limit / 1000)} 秒仍未收口，按放弃等待处理`);
                abortPendingRequest();
            }
        }, limit);
        function settle() {
            clearTimeout(timer);
            if (S.pendingRequest === pending) S.pendingRequest = null;
        }
        return outer.finally(settle);
    }

    /**
     * 真正发起请求。第三参 overrideProfile 只在「测试连接」这类场景用：
     * 指定这一次用哪套配置，不读也不改全局 activeProfileId。
     */
    function doCallModel(systemPrompt, prompt, overrideProfile, prefill) {
        const context = ctx();
        if (!context) {
            error('调用模型失败：取不到酒馆上下文');
            return Promise.reject(new Error('未取到酒馆上下文'));
        }
        const s = getSettings();
        const profile = overrideProfile
            || (s.apiProfiles || []).find(p => p.id === s.activeProfileId)
            || { id: 'main', name: '跟随酒馆主连接', mode: 'main' };
        const t0 = Date.now();
        debug(`调用模型：配置「${profile.name || profile.id}」（mode=${profile.mode || 'main'}），system ${String(systemPrompt).length} 字，prompt ${String(prompt).length} 字`);
        if (S.busy && S.progress.startedAt) {
            step(`请求模型（「${profile.name || profile.id}」，输入约 ${Math.round((String(systemPrompt).length + String(prompt).length) / 1000)} 千字）`);
        }

        const finish = (out) => {
            log(`模型返回：${String(out || '').length} 字，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
            if (S.busy && S.progress.startedAt) step(`模型已返回 ${String(out || '').length} 字`);
            return out;
        };
        const failed = (e) => {
            error(`调用模型失败（耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${e && e.message || e}`);
            if (S.busy && S.progress.startedAt) step(`模型调用失败：${(e && e.message) || e}`);
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
        // 只剩「跟随酒馆主连接」这一条走 generateRaw 的路：不指定连接源，也不指定模型，
        // 完全用酒馆当前选中的那套（2026-11-02 去掉了可指定连接源的旧档）
        return Promise.resolve(context.generateRaw({ prompt, systemPrompt, prefill: String(prefill || '') })).then(finish, failed);
    }

    /** 直连请求的超时时间：设置里配的优先，没配或配坏就用 3 分钟 */
    function directTimeoutMs() {
        const n = Number((getSettings().request || {}).timeoutMs);
        return Number.isFinite(n) && n >= 5000 ? n : 180000;
    }

    /**
     * 极简 YAML 解析（2026-11-02）：只覆盖「键: 值」和「键:」两种行。
     * 请求体这两段本来就是给人手填的简单结构，不需要完整 YAML 能力；
     * 解析失败只返回空对象，不抛错——填错不该让整次请求失败。
     */
    function parseFlatYaml(text) {
        const out = {};
        const lines = String(text || '').replace(/\r/g, '').split(NL);
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const idx = line.indexOf(':');
            if (idx <= 0) continue;
            const key = line.slice(0, idx).trim().replace(/^["']|["']$/g, '');
            let val = line.slice(idx + 1).trim();
            if (!key) continue;
            if (val === '') { out[key] = {}; continue; }
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            } else if (val === 'true') { out[key] = true; continue; }
            else if (val === 'false') { out[key] = false; continue; }
            else if (val === 'null' || val === '~') { out[key] = null; continue; }
            else if (/^-?\d+$/.test(val)) { out[key] = Number(val); continue; }
            else if (/^-?\d+\.\d+$/.test(val)) { out[key] = Number(val); continue; }
            else if (val.startsWith('[') && val.endsWith(']')) {
                const inner = val.slice(1, -1).trim();
                out[key] = inner ? inner.split(',').map(x => x.trim().replace(/^["']|["']$/g, '')) : [];
                continue;
            }
            out[key] = val;
        }
        return out;
    }

    /** 把 YAML 文本里的键合并进目标对象（同名覆盖） */
    function mergeYamlInto(target, text) {
        if (!text || !String(text).trim()) return target;
        const parsed = parseFlatYaml(text);
        for (const k of Object.keys(parsed)) target[k] = parsed[k];
        return target;
    }

    /** 按 YAML 文本里的键名从对象里删字段 */
    function excludeYamlKeys(target, text) {
        if (!text || !String(text).trim()) return target;
        for (const raw of String(text).replace(/\r/g, '').split(NL)) {
            // 一行一个键名是最好填的写法，不用写成 YAML 列表；带冒号的也认
            let line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            if (line.startsWith('- ')) line = line.slice(2).trim();
            const idx = line.indexOf(':');
            const key = (idx > 0 ? line.slice(0, idx) : line).trim().replace(/^["']|["']$/g, '');
            if (key) delete target[key];
        }
        return target;
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

        // 请求体三段（2026-11-02）：与酒馆里同名设置一个意思
        //   包含主体参数：往请求体里塞自定义字段，同名覆盖
        //   排除主体参数：按名字删字段
        //   包含请求标头：往请求头里塞自定义字段，同名覆盖
        const extraHeaders = {};
        mergeYamlInto(body, profile.includeBody);
        excludeYamlKeys(body, profile.excludeBody);
        mergeYamlInto(extraHeaders, profile.includeHeaders);

        // 以前这里没有任何超时：接口挂住就永远等下去，busy 不会解除，只能刷新页面
        const timeoutMs = directTimeoutMs();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        if (S.pendingRequest && controller) {
            S.pendingRequest.controller = controller;
            // 「放弃等待」按钮也走这里：abort 之后 fetch 会抛 AbortError
            const prevGiveUp = S.pendingRequest.giveUp;
            S.pendingRequest.giveUp = () => { prevGiveUp(); try { controller.abort(); } catch (e) { /* 忽略 */ } };
        }
        const timer = setTimeout(() => {
            if (controller) { try { controller.abort(); } catch (e) { /* 忽略 */ } }
        }, timeoutMs);

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: Object.assign({
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + profile.apiKey,
                }, extraHeaders),
                body: JSON.stringify(body),
                signal: controller ? controller.signal : undefined,
            });
        } catch (e) {
            if (e && (e.name === 'AbortError' || e.code === 20)) {
                throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒没有返回，已放弃`);
            }
            throw new Error(`无法连接 ${url}：${e && e.message || e}`);
        } finally {
            clearTimeout(timer);
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

    /**
     * 测试连接：发一条极短请求，返回结果文本供界面显示。
     * 以前这里收着 profile 却不用，内部读全局 activeProfileId，调用处只好临时改全局再改回来；
     * 测试期间点生成就会用测试配置去请求，白烧一次钱。现在直接用传进来的这套配置。
     */
    async function testProfile(profile) {
        const t0 = Date.now();
        const out = await callModel('你是一个连通性测试助手，只回一个字。', '只回复两个字：收到', undefined, profile);
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
        // 撞名的键收集在这里，解析完挂在返回对象上（不可枚举，不影响遍历与序列化）
        const duplicateKeys = [];

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

        // 键值切分：半角冒号与全角冒号都认（P1-11）。
        // 模型偶尔把分隔符写成「事件名：甲」，原来只找半角冒号，整行被跳过、最终解析成空对象，
        // 界面只报「外层键缺失」，根本看不出是写法没认。全角冒号后面允许没有空格。
        // 返回 null 表示这行不是键值行；否则给 {key, value}，value 已去掉首尾空白。
        const splitKeyValue = (text) => {
            const s = String(text || '');
            let idx = -1;
            let sepLen = 1;
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];
                if (ch === ':') { idx = i; sepLen = 1; break; }
                if (ch === '：') { idx = i; sepLen = 1; break; }
            }
            if (idx <= 0) return null;
            const key = s.slice(0, idx).trim();
            if (!key) return null;
            return { key, value: s.slice(idx + sepLen).trim() };
        };

        // 预扫描要分两段做，因为块标量（| 或 >）的正文在语义上是纯文本：
        // 里面的空行、以 # 开头的行都是内容，不是格式。
        // 原来的写法是先对所有行统一去注释、丢空行，之后再去找块标量区间——
        // 那时候正文已经被改成一行行了，保护等于没做（那段的注释说「要原样保留」，代码里没接）。
        // 现在先按原始行划出块标量区间，区间内原样收进 lines，区间外才走去注释与丢空行。
        const lines = [];

        // 块标量标记：| 或 >，可带 +/- 与数字
        const isBlockMarkerText = (v) => /^[|>][+-]?\d*$/.test(String(v || '').trim());
        // 一行是否是「键: |」或「键: >」这类块标量头（也认全角冒号）
        const blockHeaderOf = (rawText) => {
            const kv = splitKeyValue(rawText);
            if (!kv) return null;
            return isBlockMarkerText(kv.value) ? kv.value : null;
        };

        // 第一遍：逐行扫描，遇到块标量头就把后续所有比它更深的原始行原样收进来
        let scanIdx = 0;
        while (scanIdx < rawLines.length) {
            const raw = rawLines[scanIdx];
            const s = stripComment(raw);
            if (!s.trim()) { scanIdx++; continue; }
            const trimmed = s.trim();
            if (trimmed === '---' || trimmed === '...') { scanIdx++; continue; }

            const lineIndent = s.length - s.trimStart().length;
            lines.push({ indent: lineIndent, text: trimmed });

            // 这一行是块标量头吗？用去注释后的文本判断，避免把正文里的 # 当成注释处理
            const marker = blockHeaderOf(trimmed);
            scanIdx++;
            if (!marker) continue;

            // 块标量正文：后续所有缩进比头部更深的原始行，原样收（不去注释、不丢空行）
            // 空行的缩进不能瞎定：它要跟正文行一致，否则去公共缩进时会被算成最小缩进，
            // 结果是正文每行都被多切掉一截（真机上表现为整段前面多一个空格）。
            // 所以空行先存着，等遇到第一个真实正文行、拿到它的缩进后再补上。
            let pendingBlank = 0;
            while (scanIdx < rawLines.length) {
                const bodyRaw = rawLines[scanIdx];
                if (!bodyRaw.trim()) {
                    pendingBlank++;
                    scanIdx++;
                    continue;
                }
                const bodyIndent = bodyRaw.length - bodyRaw.trimStart().length;
                if (bodyIndent <= lineIndent) break;
                // 正文开始，把攒着的空行按这个缩进补进去
                while (pendingBlank > 0) {
                    lines.push({ indent: bodyIndent, text: '' });
                    pendingBlank--;
                }
                lines.push({ indent: bodyIndent, text: bodyRaw.trim() });
                scanIdx++;
            }
            // 去掉正文尾部多余的空行占位
            while (lines.length && lines[lines.length - 1].text === '' && lines[lines.length - 1].indent > lineIndent) {
                lines.pop();
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

                    // "- key: value" 形式，属于对象列表项（半角全角冒号都认）
                    const kvSplit = splitKeyValue(content);
                    const looksLikeKv = kvSplit !== null && !content.startsWith('"') && !content.startsWith("'");

                    if (looksLikeKv) {
                        const itemObj = {};
                        const key = kvSplit.key;
                        const valStr = kvSplit.value;
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
                            const subKv = splitKeyValue(sub.text);
                            if (!subKv) { pos++; continue; }
                            const k2 = subKv.key;
                            const v2 = subKv.value;
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
                const mapKv = splitKeyValue(line.text);
                if (!mapKv) { pos++; continue; }
                const key = mapKv.key;
                const valStr = mapKv.value;
                pos++;
                let value;
                if (valStr === '') {
                    const child = parseBlock(childIndent);
                    value = child === null ? null : child;
                } else if (isBlockMarker(valStr)) {
                    value = readBlockScalar(childIndent, String(valStr).trim());
                } else {
                    value = unquote(valStr);
                }

                // 同名键（2026-11-10 修）：模型偶尔把同一个键写两遍，例如两段 nodes。
                // 原来的做法是后一段直接盖掉前一段，前一段静默消失——用户只看到节点少了一半，
                // 界面不会报任何错，查起来无从下手。
                // 现在两段都留：数组与数组首尾接起来，其它情况把两段都收进数组（内容一个字不丢），
                // 同时把撞名的键记下来，由上层带进提示让用户看见。
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    const prev = obj[key];
                    if (Array.isArray(prev) && Array.isArray(value)) {
                        obj[key] = prev.concat(value);
                    } else if (Array.isArray(prev)) {
                        obj[key] = prev.concat([value]);
                    } else {
                        obj[key] = [prev, value];
                    }
                    duplicateKeys.push(key);
                } else {
                    obj[key] = value;
                }
            }
            return obj;
        }

        const root = parseBlock(-1);
        const out = root === null ? {} : root;
        // 撞名信息挂在返回对象上：不可枚举，JSON.stringify 与 Object.keys 都看不到，
        // 老调用方行为不变；需要的地方用 parseSimpleYaml.duplicatesOf() 读。
        if (duplicateKeys.length && out && typeof out === 'object') {
            try {
                Object.defineProperty(out, '__duplicateKeys', {
                    value: duplicateKeys.slice(),
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });
            } catch (e) { /* 极端情况下挂不上就算了，不影响解析结果 */ }
        }
        return out;
    }

    /** 取一份解析结果里撞过名的键（没有就返回空数组） */
    parseSimpleYaml.duplicatesOf = (obj) => {
        if (!obj || typeof obj !== 'object') return [];
        return Array.isArray(obj.__duplicateKeys) ? obj.__duplicateKeys.slice() : [];
    };

    // ---------- 结构规范化 ----------

    // 中文键 → 英文键。和 OUTLINE_KEY_LABEL 方向相反，但那张表是给显示用的、
    // 这里要处理的是模型把键写成中文的情况，所以单独维护，遇到新的再补。
    // 值冲突的（比如「内容」在 paths 里是 route、在 nodes 里是 info）不放在这张表，
    // 由 normalizeOutline 按上下文判断。
    const CN_TO_EN_KEY = {
        事件名: 'event_name', 事件简介: 'event_brief', 事件类型: 'event_type',
        核心真相: 'core_truth', 信息节点: 'nodes', 推理必需节点: 'min_nodes_for_deduction',
        参与角色: 'characters', 推进路径: 'paths', 禁止事项: 'forbidden',
        // 2026-11-05 M2 评审 5.4：内层整体收进 structure，模型若把这一层写成中文，
        // 不认的话内层会全部落空——让它落到 structure 上，后面照常校验。
        结构: 'structure', 事件结构: 'structure', 大纲结构: 'structure',
        嫌疑人: 'suspects', 不在场: 'alibi', 不在场证明: 'alibi', 谎言: 'lie', 他的谎言: 'lie',
        // 2026-11-05 M3：战斗内层键与子项的中文写法。
        // 同 结构→structure 那条：模型偶尔整套用中文键，只认英文会把这份输出判成空壳。
        敌方编制: 'enemy_forces', 敌人编制: 'enemy_forces', 敌方部队: 'enemy_forces',
        战斗目标: 'objectives', 目标: 'objectives',
        地形: 'terrain', 援军: 'reinforcements', 增援: 'reinforcements',
        撤退: 'retreat', 撤退条件: 'retreat', 伤亡: 'casualty', 伤亡与俘虏: 'casualty',
        事先准备: 'preparation', 战前准备: 'preparation', 准备: 'preparation',
        物资: 'supplies', 陷阱: 'traps', 情报: 'intel', 盟友: 'allies', 出发时间: 'depart_time',
        兵力: 'strength', 等级: 'level', 战术: 'tactic', 士气: 'morale',
        掩体: 'cover', 高低差: 'elevation', 狭窄处: 'chokepoint',
        波次: 'wave', 到达时间: 'arrive', 规模: 'size',
        // 2026-11-05 M4：阶段数组的中文写法
        阶段: 'phases', 阶段数组: 'phases',
        // 注意：不要写「目标: 'goal'」——「目标」已经映射到 objectives（战斗目标），
        // 这条若是再加一次，后写的会覆盖前面的，战斗的目标就被改名成 phases 里的 goal。
        阶段目标: 'goal', 入场: 'entry', 退场: 'exit', 可跳过: 'optional',
        避开条件: 'avoid_condition', 阶段性字段: 'fields',
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
        // danger 组的「失败后果」与 paths 里的「失败情形」本来就是两个键（failure / fail），
        // 2026-11-02 骨架统一成英文时把 danger 的写成 failure；旧稿里的中文写法照旧收在这里
        是否必经: 'must', 失败后果: 'failure', 失败情形: 'fail',
        时间压力: 'time_pressure', 危险程度: 'danger', 倒计时: 'countdown', 时长: 'duration',
        超时后果: 'timeout_result', 主类型: 'primary', 次类型: 'secondary',
        结果: 'outcomes', 大纲外走向: 'out_of_plan_paths', 必需节点: 'required_nodes',
        可跳过节点: 'optional_nodes', 风险: 'risk',
        拖延代价: 'delay_cost', 致死性: 'lethality', 容错率: 'tolerance', 威胁来源: 'threat_source',
        条件或代价: 'condition_or_cost', 标注: 'note', '知情者/关键人物': 'informants',
        // ---- 2026-11-02 补齐：显示表里已经有中文名、但这里没人指过来的键 ----
        // 这些中文模型偶尔还会写（旧提示词、或它自己发挥），不认就等于整段信息被丢掉。
        // 骨架已经统一成英文，这里是宽容度，不是鼓励。
        // 注意：只补「这里还没有的写法」。中文名撞车的（身份→identity、路径→path、
        // 步骤→step、化解方式→resolvable_by、触发词→keyword、掌握的信息→info_known 等）
        // 沿用原登记，别在这里重复，对象里重复的键会互相覆盖，反而改错目标。
        描述: 'desc', 说明: 'detail', 推进作用: 'thrust',
        内容: 'content', 隐藏信息: 'hidden',
        是否必需: 'required', 可否化解: 'resolvable', 为什么现在: 'why_now',
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
            // 2026-11-06 真机：phases[].fields[] 里的键是模型自己起的名字，不是固定字段名。
            // 真案例里同一段的三个键是「可用手段 / 时机窗口 / 代价」，
            // 前两个原样留着，只有「代价」撞上 CN_TO_EN_KEY 被改成了 cost——
            // 于是面板上同组三个键两个中文一个英文，看着就像内容对不上。
            // 自由格式的层一律不翻译：改它没有任何好处，只会让原文与展示不一致。
            if (ctx !== 'freeform' && !/^[A-Za-z_]/.test(rawKey)) {
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
            // 注意 freeform 不需要在这里再传：fields 的值是数组，
            // 数组分支会沿用上层上下文，元素自己就带着 freeform 往下走了。
            const childCtx = key === 'fields' ? 'freeform'
                : key === 'paths' ? 'path'
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
        return hoistOuterFromStructure(r.obj);
    }

    /**
     * 把误写进 structure 的外层键搬回外层（2026-11-06 真机）。
     *
     * 为什么要有这一步：选禁忌秘辛时模型把 forbidden 整块写进了 structure，
     * 外层就此缺一个必填键、判 ok=false，而且那六条禁止事项从状态卡和盘点提示词
     * 里都读不到（那两个地方只读外层），等于白写。prompt 里其实写着
     * 「structure 里不许出现外层键」，但几百行提示词里这一句约束不住。
     *
     * 只搬这一种情况，不做别的修复：
     *   - 外层已经有同名键时不覆盖，原样保留，structure 里那份留着不动（可能是内层真需要的）
     *   - contract 是可选外层键，一并搬
     *   - 事件名/简介/类型不碰：它们不太可能被写进 structure，真写了多半是模型认错了整体结构，
     *     那种情况该让它照实报错，而不是替它猜
     */
    function hoistOuterFromStructure(outline) {
        const o = (outline && typeof outline === 'object') ? outline : null;
        if (!o) return outline;
        const st = o.structure;
        if (!st || typeof st !== 'object' || Array.isArray(st)) return outline;
        // 只搬这几个：语义上明确属于外层、又最容易跟内层混淆的
        const MOVABLE = ['forbidden', 'time_pressure', 'danger', 'contract'];
        const moved = [];
        for (const k of MOVABLE) {
            if (o[k] !== undefined && o[k] !== null && o[k] !== '') continue;   // 外层已有，不动
            if (st[k] === undefined) continue;                                   // structure 里也没有
            o[k] = st[k];
            delete st[k];
            moved.push(k);
        }
        if (moved.length) {
            warn(`大纲外层键被写进了 structure，已搬回外层：${moved.join('、')}。`
                + 'prompt 里明确要求过「structure 里不许出现外层键」，模型没照做，这次替它归位。');
        }
        return o;
    }

    /**
     * 把 YAML 块外面的【中文段落】补回大纲（2026-11-06 真机）。
     *
     * 真实案例：战斗「独猎赤鬃」的模型输出，fence 内是完整 YAML，
     * fence 外又用中文写了三段——【推进路径】【推进所需最少信息节点编号】【参与角色】。
     * 那段占全文 18%（672 字），内容全是有用的，parseOutline 只取 fence 内，
     * 于是面板上「展示的大纲比原文少了一大截」，用户看着就是内容丢了。
     *
     * 为什么不干脆改 prompt 让它别写到外面：prompt 里本来就要求「用 YAML 输出，包含」这五项，
     * 模型仍然这么写过。几百行提示词里的一句约束不住，所以这里做兜底。
     *
     * 只补这三个键，且只在外层/内层都还没有这个键时补——模型自己写在 YAML 里的那份优先，
     * 不拿外面的文本去覆盖结构化数据。
     */
    function patchFromOutsideFence(outline, tailText) {
        const o = (outline && typeof outline === 'object') ? outline : null;
        const text = String(tailText || '');
        if (!o || !text.trim()) return outline;
        if (!o.structure || typeof o.structure !== 'object') return outline;

        // 按【标题】切段。注意两种写法都要吃：
        //   「【推进路径】\n- 必经：…」  标题独占一行
        //   「【推进所需最少信息节点编号】：1, 2, 5」  标题后面同一行就跟内容
        const segs = {};
        const lines2 = text.split('\n');
        let curKey = null;
        let buf = [];
        const flush = () => {
            if (curKey) segs[curKey] = (segs[curKey] || '') + buf.join('\n');
            buf = [];
        };
        for (const line of lines2) {
            const hm = line.match(/^\s*【([^】]{1,30})】\s*(.*)$/);
            if (hm) {
                flush();
                curKey = hm[1].trim();
                // 标题后面同一行还有内容时，当成这一段的第一行
                if (hm[2] && hm[2].replace(/[:：\s]/g, '')) buf.push(hm[2]);
            } else if (curKey) {
                buf.push(line);
            }
        }
        flush();

        const bullets = (s) => String(s || '').split('\n')
            .map(l => l.replace(/^\s*-\s*/, '').trim())
            .filter(l => l && !/^[（(]/.test(l));

        // 1. 推进所需最少信息节点编号 → structure.min_nodes_for_deduction
        const minKey = Object.keys(segs).find(k => k.includes('最少') && k.includes('节点'));
        if (minKey && !o.structure.min_nodes_for_deduction) {
            const nums = (segs[minKey].match(/\d+/g) || []).map(Number);
            if (nums.length) {
                o.structure.min_nodes_for_deduction = nums;
                debug(`fence 外补回最少信息节点：${nums.join('、')}`);
            }
        }

        // 2. 参与角色 → structure.characters
        const charKey = Object.keys(segs).find(k => k.includes('参与角色') || k.includes('角色'));
        if (charKey && !o.structure.characters) {
            const chars = {};
            let cur = null;
            for (const line of String(segs[charKey]).split('\n')) {
                const indent = (line.match(/^\s*/) || [''])[0].length;
                const t = line.replace(/^\s*-\s*/, '').trim();
                if (!t) continue;
                // 顶格（缩进少）是立场名，如「助力者：」「阻碍者：」
                if (indent <= 2 && /[:：]\s*$/.test(t) && !t.match(/^[（(]/)) {
                    const grp = t.replace(/[:：]\s*$/, '').trim();
                    // 2026-11-06 真机：模型输出里「助力者」的「助」字坏了（U+FFFD），
                    // 变成「��力者」。所以「助」写成可选：去掉这个字也认。
                    const clean = grp.replace(/\uFFFD/g, '');
                    cur = /力者|帮助|协助/.test(clean) && !/阻碍|阻挠/.test(clean) ? 'helpers'
                        : /阻碍|阻挠/.test(clean) ? 'obstructers'
                            : /知情|关键/.test(clean) ? 'informants'
                                : /幕后/.test(clean) ? 'behind_scenes' : null;
                    if (cur) chars[cur] = chars[cur] || [];
                    continue;
                }
                if (!cur) continue;
                // 「姓名（说明）」拆成 name 与说明。说明里可能还有括号，
                // 所以先找第一个左括号，再配到最后一个右括号，而不是非贪婪匹配到第一个右括号。
                const l = t.indexOf('（') >= 0 ? t.indexOf('（') : t.indexOf('(');
                let item;
                if (l > 0) {
                    const closeCh = t[l] === '（' ? '）' : ')';
                    const r2 = t.lastIndexOf(closeCh);
                    item = r2 > l
                        ? { name: t.slice(0, l).trim(), note: t.slice(l + 1, r2).trim() }
                        : { name: t };
                } else {
                    item = { name: t };
                }
                if (item.name) chars[cur].push(item);
            }
            if (Object.keys(chars).length) {
                o.structure.characters = chars;
                const n = Object.values(chars).reduce((a, b) => a + b.length, 0);
                debug(`fence 外补回参与角色：${n} 人，分组 ${Object.keys(chars).join('、')}`);
            }
        }

        // 3. 推进路径 → structure.paths（只在完全没解析出 paths 时补）
        const pathKey = Object.keys(segs).find(k => k.includes('推进路径') || k.includes('路径'));
        if (pathKey && !(o.structure.paths && o.structure.paths.length)) {
            const lines = bullets(segs[pathKey]);
            const must = [];
            const skip = [];
            const risk = [];
            for (const l of lines) {
                const nums = (l.match(/\d+/g) || []).map(Number);
                if (!nums.length) { risk.push(l); continue; }
                if (/必经/.test(l)) must.push(...nums);
                else if (/可跳过|跳过/.test(l)) skip.push(...nums);
                else risk.push(l);
            }
            // 补成 paths 数组而不是另开一个键：面板、世界书、盘点提示词读的都是 paths，
            // 另开的键没人渲染，补回来也看不见。
            // 每号节点一步，must 与 risk 的文字并进 route/fail——这几行本来就是
            // 「哪些必经、哪些可跳过、失败什么后果」，与 paths 的字段语义对得上。
            //
            // 失败后果那几行是整场的描述，不属于某一个节点。原样抄给每一步，
            // 面板上就是同一段长文字重复 8 遍，比丢掉还难看。所以只挂在最后一步上，
            // 并写明这是整体说明。
            const riskText = risk.length
                ? risk.join('；').replace(/；+$/, '')
                : '';
            const numsAll = [];
            for (const n of must.concat(skip)) if (!numsAll.includes(n)) numsAll.push(n);
            numsAll.sort((a, b) => a - b);
            if (numsAll.length) {
                o.structure.paths = numsAll.map((n, i) => ({
                    step: i + 1,
                    node: n,
                    route: must.includes(n) ? '必经' : '可跳过',
                    // 整体失败说明只在最后一步给一次
                    ...(riskText && i === numsAll.length - 1
                        ? { fail: `（整体失败后果）${riskText}` } : {}),
                    source: '大纲块外补充',
                }));
                debug(`fence 外补回推进路径：${numsAll.length} 步，`
                    + `必经 ${must.length} 个、可跳过 ${skip.length} 个`);
            } else if (risk.length) {
                // 一个节点号都没有时没法结成步进，退回到一段原文备注
                o.structure.paths = [{ step: 1, route: riskText, source: '大纲块外补充' }];
                debug('fence 外补回推进路径：无节点号，按整段备注保留');
            }
        }
        return o;
    }

    function parseOutline(raw) {
        const block = extractCodeBlock(raw, 'yaml') || extractCodeBlock(raw) || raw;
        // 2026-11-06 真机：模型有时把「推进路径/最少信息节点/参与角色」写在 YAML 块外面。
        // 那部分占全文近两成，只取 fence 内等于把它们全丢了。这里留一份尾巴给补丁解析。
        const tailText = (() => {
            const s = String(raw || '');
            const a = s.indexOf('```');
            if (a < 0) return '';
            const b = s.indexOf('```', a + 3);
            return b < 0 ? '' : s.slice(b + 3);
        })();
        // 模型时不时把个别键写成中文（step 是英文、内容/风险 是中文），
        // 这里统一规范化成英文，后面所有代码只面对一套键名，不用到处写 p['内容'] 兼容
        //
        // 2026-11-10（批 2 同名键那条补完）：撞名的键要在规范化之前取走。
        // 撞名信息挂在解析结果的不可枚举属性上，normalizeOutline 会造新对象，
        // 一过这一手就没了——原来定义好的 parseSimpleYaml.duplicatesOf 全文零调用，
        // 「两段 nodes 拼起来不丢内容」是做到了，但用户永远看不到「模型写重复了」。
        // 方案要求的是「要么合并，要么解析时就报错提示」，所以这里必须接上。
        const rawParsed = parseSimpleYaml(block);
        const dupKeys = (parseSimpleYaml.duplicatesOf ? parseSimpleYaml.duplicatesOf(rawParsed) : []);
        const parsed = patchFromOutsideFence(normalizeOutline(rawParsed), tailText);
        // 撞名的键稍后并进 quality.warnings（quality 在下面几行才算出来）
        const hasYaml = !!extractCodeBlock(raw, 'yaml');
        // 2026-11-05 M2 评审：nodes 在 structure 里，按顶层读会恒为 0，
        // 下面那句 error「没有解析出任何信息节点」每次生成都会误报。
        const nodeCount = innerNodesOf(parsed).length;
        const keys = Object.keys(parsed || {});
        const quality = checkOutlineQuality(parsed);
        // 撞名的键进结构检查的 warnings（2026-11-10 批 2 补完）：
        // 详情页那条警示会说清是哪个键被写了两次，而不是只让用户看到「节点少了一半」却不知道原因。
        if (dupKeys.length) {
            quality.warnings = (quality.warnings || []).concat(
                dupKeys.map(k => `模型把键「${k}」写了不止一次，两段内容已合并保留，请核对是否重复或冲突`));
        }

        debug(`大纲解析：原文 ${String(raw || '').length} 字，YAML 块${hasYaml ? '命中' : '未命中（整段兜底）'}，`
            + `顶层键 ${keys.length} 个：${keys.join('、') || '无'}，节点 ${nodeCount} 个`);
        if (dupKeys.length) {
            warn(`大纲里有键被写了不止一次：${dupKeys.join('、')}。两段内容已合并保留，请在详情页核对是否重复`);
        }
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
     * 检查大纲结构是否完整。返回 {ok, missing[], warnings[], summary, drift, mainType}。
     * 这里只判断，不修复——解析器出错时要让用户立刻看见，而不是静默降级。
     *
     * 2026-11-05 一期 M1：按定稿 §9 拆成两层。
     *   外层（missing）：event_name / event_brief / event_type / time_pressure / danger /
     *                     forbidden / structure，缺了就算失败、要重试。所有类型一样。
     *   内层（warnings）：按主类型取该类型的内层键，缺了只警告，不判失败。
     *                     战斗事件没有 core_truth 是正常的，不能拿案件的尺子去量。
     *
     * 拆之前的老版本把 core_truth / nodes / min_nodes_for_deduction / characters
     * 当无条件必查，等于逼着每一种事件都长成案件——这正是这次改造要治的病。
     * 现在这些留在内层，只有主类型是案件推理时才当作该看的字段。
     */
    function checkOutlineQuality(parsed) {
        return checkOutlineQualityFor(parsed, null);
    }

    /** 同上，但显式指定主类型（生成时拿得到用户选的那个，解析后从 event_type.primary 也能读） */
    // ---------- 阶段数组（2026-11-05 M4，定稿 1N）----------
    // structure.phases 描述「这个多段事件由哪几段组成」，最多 3 段。
    // 口径（2026-11-05 危晓定）：主类型那套完整字段仍在 structure 顶层，
    // phases 里每段只写精简字段——不把每段都做成完整骨架，否则 prompt 会膨胀数倍。
    // phases 本身可选：单段事件不写，多段事件才写。
    const OUTLINE_MAX_STAGES = 3;
    const OUTLINE_STAGE_KEYS = ['type', 'goal', 'entry', 'exit', 'optional', 'avoid_condition', 'fields'];

    /**
     * 校验阶段数组。返回 { warnings, count }。
     *
     * 为什么单独成函数而不是塞进 checkOutlineQualityFor：
     * 阶段数组是跨类型的东西（案件、战斗都能是多段的），与主类型无关，
     * 塞进去会让那个函数再长一截，也不好在渲染层复用同一个口径。
     *
     * 只进 warnings 不进 missing：与内层的口径一致（硬外层、软内层），
     * 阶段写得不好不该让整份大纲作废，但要让用户看见。
     */
    function checkOutlineStages(outline) {
        const warnings = [];
        const raw = innerField(outline, 'phases');
        if (raw === undefined || raw === null) return { warnings, count: 0 };
        if (!Array.isArray(raw)) {
            warnings.push('阶段数组（phases）不是列表');
            return { warnings, count: 0 };
        }
        const count = raw.length;
        if (!count) return { warnings, count: 0 };

        // 超过 3 段说明这个事件太大：定稿要求拆成事件链，不该硬塞进一个事件
        if (count > OUTLINE_MAX_STAGES) {
            warnings.push(`阶段数组有 ${count} 段，超过上限 ${OUTLINE_MAX_STAGES} 段`
                + '（事件太大，应当拆成事件链，而不是塞进一个事件的阶段）');
        }

        raw.forEach((st, i) => {
            const n = i + 1;
            if (!st || typeof st !== 'object') {
                warnings.push(`第 ${n} 段不是对象`);
                return;
            }
            // entry / exit 是定稿里的硬要求：一段没有入口和出口，就说不清这一段从哪开始到哪结束
            if (!String(st.entry == null ? '' : st.entry).trim()) {
                warnings.push(`第 ${n} 段没写入场（entry）`);
            }
            if (!String(st.exit == null ? '' : st.exit).trim()) {
                warnings.push(`第 ${n} 段没写退场（exit）`);
            }
            // optional 为 true 表示这一段可以跳过，那就要说清「什么情况下才跳过」
            const isOptional = st.optional === true || String(st.optional).toLowerCase() === 'true'
                || st.optional === '是' || st.optional === '可跳过';
            if (isOptional && !String(st.avoid_condition == null ? '' : st.avoid_condition).trim()) {
                warnings.push(`第 ${n} 段标为可跳过，但没写避开条件（avoid_condition）`);
            }
        });

        return { warnings, count };
    }

    function checkOutlineQualityFor(parsed, mainTypeHint) {
        const o = parsed || {};
        const missing = [];    // 外层：硬校验，缺了就失败
        const warnings = [];   // 内层：软校验，缺了只提示

        // 主类型：优先用调用方给的（用户选的那个），其次读输出里的 event_type.primary。
        // 两边都拿不到时不回落到案件——那会让「模型没写类型」看起来像「模型漏了案件字段」，
        // 报出一堆 core_truth / nodes 的提示，把人往错的方向指。这种情况只留空，
        // 由外层那条「event_type.primary 是空的」去报，内层就不查了。
        const typeNode = o.event_type;
        const typeFromOutput = (typeNode && typeof typeNode === 'object')
            ? String(typeNode.primary || '').trim() : '';
        const mainType = String(mainTypeHint || '').trim() || typeFromOutput || '';

        // ---------- 外层：硬校验 ----------
        const isEmpty = v => v == null || v === ''
            || (Array.isArray(v) && !v.length)
            || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

        // 内层取值先定义，外层检查 structure 时要用它：
        // 内层字段只从 structure 里取，不回落顶层——老事件（扁平形状）的内层读不出来，
        // 这是 2026-11-05 定死的口径：不做兼容、不做兜底、不做只读降级。
        const structRaw = o.structure;
        const struct = (structRaw && typeof structRaw === 'object' && !Array.isArray(structRaw))
            ? structRaw : {};

        for (const k of OUTLINE_OUTER_REQUIRED) {
            if (isEmpty(o[k])) missing.push(`外层键 ${k} 缺失或为空`);
        }
        // 2026-11-05 危晓裁定：旧事件兼容性不考虑，这里原来有一段「顶层出现了内层键就
        // 当作 structure 已经在（只是扁的）」的豁免，已删除。老形状现在如实判缺 structure。
        // 事件类型还要求 primary 具体写了东西，光有一个空对象不算
        if (o.event_type && typeof o.event_type === 'object' && !String(typeNode.primary || '').trim()) {
            missing.push('事件类型（event_type.primary）是空的');
        }

        // ---------- 内层：按主类型的软校验 ----------
        // 2026-11-05 M2 评审：这里原来自己写了一份「structure 优先、顶层兜底」，
        // 与 buildStateCard 那份各写一遍。收成 innerField/innerNodesOf 一份，免得日后两边漂移。
        const innerVal = k => innerField(o, k);
        const nodesRaw = innerVal('nodes');
        const nodes = Array.isArray(nodesRaw) ? nodesRaw : null;

        const innerSpec = innerKeysOf(mainType);
        if (!mainType) {
            // 类型压根没写出来。外层那条「event_type.primary 是空的」已经报了，
            // 这里不再追着内层说「骨架没做」，否则同一件事报两遍、还指向错的方向。
        } else if (!innerSpec.known) {
            // 当前实现下这条分支不可达：任何非空主类型都会解析到内置类型或「其他」，
            // 后者恒有内层键（innerKeysOf 对「其他」返回 known:true）。保留它仅作防御，
            // 万一将来有类型缺 spec，这里报出来而不是拿别的类型字段硬套。
            warnings.push(`主类型「${mainType}」的内层骨架还没做，本次不校验内层结构`);
        } else {
            for (const k of innerSpec.required) {
                if (isEmpty(innerVal(k))) {
                    warnings.push(`内层字段 ${k} 缺失或为空（主类型「${mainType}」该有）`);
                }
            }

            // M6.2（2026-11-07）：必需性之外，再按 spec 声明的 kind 查取值。
            // 以前这类检查散在各处手写（比如战斗的 objectives 有没有 fail），
            // 现在统一问 kindValueProblems：枚举取值不合法、整数超范围、列表条目数不够，都由它报。
            // 空值不在这里管——上面那条必需性检查已经报过了，不重复。
            const spec = specOfType(mainType);
            if (spec) {
                for (const grp of ['required', 'optional']) {
                    for (const [k, meta] of Object.entries(spec[grp] || {})) {
                        const v = innerVal(k);
                        if (isEmpty(v)) continue;
                        for (const p of kindValueProblems(meta, v, `内层字段 ${k}`)) warnings.push(p);
                        // M6.4（2026-11-07）：map 的子键检查——多余子键、缺必需子键、子键形态不对。
                        // 以前 keys 只是一串名字，写了没人读，于是「该有哪几个子键」全靠提示词，
                        // 模型漏了也没人发现。
                        for (const p of mapKeyProblems(meta, v, `内层字段 ${k}`)) warnings.push(p);
                        // 列表元素里的子键也按各自 kind 查（如 nodes[].type 的枚举）
                        if (meta && meta.item && Array.isArray(v)) {
                            v.forEach((el, i) => {
                                if (!el || typeof el !== 'object') return;
                                for (const [ik, im] of Object.entries(meta.item)) {
                                    if (el[ik] == null || el[ik] === '') continue;
                                    for (const p of kindValueProblems(im, el[ik], `第 ${i + 1} 条的 ${ik}`)) {
                                        warnings.push(p);
                                    }
                                }
                            });
                        }
                    }
                }
            }
        }

        // 战斗的战前准备（2026-11-06 M3 补）：文档要求「要么五项都写，要么整块不写」。
        // 之前这句话只写在 prompt 里，模型只写两项也不会报任何问题——
        // 只写物资不写出发时间，等于没写准备，但界面上看起来是齐的。
        // 现在补上校验：写了 preparation 就得五项齐全，整个不写则不算错
        // （遭遇战、伏击没有准备阶段，那是正常的）。
        if (mainType === '战斗冲突') {
            const prep = innerVal('preparation');
            if (prep && typeof prep === 'object' && !Array.isArray(prep) && Object.keys(prep).length) {
                const prepKeys = ['supplies', 'traps', 'intel', 'allies', 'depart_time'];
                const lack = prepKeys.filter(k => {
                    const v = prep[k];
                    return v == null || (typeof v === 'string' && !v.trim());
                });
                if (lack.length && lack.length < prepKeys.length) {
                    // 一项都没有 = 整块没写，不算错；写了一部分才是问题
                    warnings.push(`战前准备写了 ${prepKeys.length - lack.length} 项，`
                        + `缺 ${lack.map(k => labelOf(k)).join('、')}；五项要么都写、要么整块不写`);
                }
            }

            // enemy_forces 里混进非敌人（2026-11-06 真机）。
            // 模型找不到第三个敌人时，会把「夜里的岔道与浅沟」这种地形塞进来，
            // level 和 morale 填「不适用」凑够四项——界面上一眼看上去是三条敌人编制，
            // 实际有一条不是敌人，算「敌我态势」时会把它当战斗力算进去。
            // 只警告不判失败：判断「这算不算敌人」有模糊地带（比如陷阱阵、有主的地雷区），
            // 让用户自己看一眼比让程序硬判更靠谱。
            const efRaw = innerVal('enemy_forces');
            const efList = Array.isArray(efRaw) ? efRaw
                : (efRaw && typeof efRaw === 'object' ? Object.values(efRaw) : []);
            const suspect = [];
            for (const e of efList) {
                if (!e || typeof e !== 'object') continue;
                const na = ['strength', 'level', 'tactic', 'morale'].some(k => {
                    const v = e[k];
                    if (typeof v !== 'string') return false;
                    // 「不适用」「无」「-」「—」这类都算没填实话
                    return /^(不适用|无|没有|-|—)$/.test(v.trim());
                });
                if (na) suspect.push(String(e.name || '(未命名)'));
            }
            if (suspect.length) {
                warnings.push(`敌方编制里「${suspect.join('、')}」的字段填了「不适用」之类，`
                    + '多半是地形/天气被当成敌人写进来了——那些该写进 terrain，enemy_forces 只放会主动对抗的东西');
            }
        }

        // 案件特有的几条细查，只在主类型是案件时做
        if (mainType === '案件推理') {
            if (!nodes) warnings.push('信息节点（nodes）缺失或不是列表');
            else if (!nodes.length) warnings.push('信息节点（nodes）是空列表');
            else {
                const badId = nodes.filter(n => nodeId(n) == null);
                if (badId.length) warnings.push(`${badId.length} 个节点没有编号`);
                const noInfo = nodes.filter(n => !nodeText(n));
                if (noInfo.length) warnings.push(`${noInfo.length} 个节点没有内容`);
            }

            // suspects（2026-11-05 M2）：定稿 §5 要求每个嫌疑人有动机/不在场/谎言三件事。
            // 缺了照样只警告不判失败——案件也可能一个嫌疑人都不列，那是设计选择不是错误。
            const suspects = innerVal('suspects');
            if (suspects && typeof suspects === 'object') {
                const list = Array.isArray(suspects) ? suspects : Object.values(suspects).flat();
                const people = list.filter(x => x && typeof x === 'object');
                for (const p of people) {
                    const who = String(p.name || '（未命名）');
                    if (!p.motive) warnings.push(`嫌疑人「${who}」没写动机（motive）`);
                    if (!p.alibi) warnings.push(`嫌疑人「${who}」没写不在场（alibi）`);
                    if (!p.lie) warnings.push(`嫌疑人「${who}」没写谎言（lie）`);
                }
            }
        }

        // 2026-11-05 M4：阶段数组的校验并进来。
        // 放在最后，前面的内层警告顺序不变（已有一批断言按顺序取第一条）。
        const stageCheck = checkOutlineStages(o);
        // M6.6 / M6.3（2026-11-06）：跨层撞键与引用完整性。
        // 放在阶段检查之后，保持既有警告的顺序不变（一批断言按顺序取第一条）。
        if (mainType) {
            for (const w of crossLayerKeyWarnings(o, mainType)) warnings.push(w);
            for (const w of refIntegrityWarnings(o, mainType)) warnings.push(w);
        }
        for (const w of stageCheck.warnings) warnings.push(w);

        const minNodes = innerVal('min_nodes_for_deduction');
        const chars = innerVal('characters');
        const nodeN = nodes ? nodes.length : 0;
        const charN = (chars && typeof chars === 'object')
            ? Object.values(chars).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0) : 0;
        // 「内层待补」只数内层的，不把阶段数组的问题算进去——那是另一回事，
        // 混在一起会让「内层待补 3 项」看不出到底是骨架缺字段还是阶段写错了。
        const innerWarnN = warnings.length - stageCheck.warnings.length;
        // 摘要按类型说（2026-11-06）：原来一律写「节点 N 个、角色 N 人、推理必需节点 N 个」，
        // 战斗事件没这三样，打出来就是「节点 0 个、角色 0 人、推理必需节点 0 个」三条噪声，
        // 看着像大纲缺东西，实际是这句话问错了类型。战斗改说目标与准备状况。
        const outerN = OUTLINE_OUTER_KEYS.filter(k => o[k] !== undefined).length;
        const topN = Object.keys(o).length;
        let mid = `节点 ${nodeN} 个、角色 ${charN} 人、`
            + `推理必需节点 ${Array.isArray(minNodes) ? minNodes.length : 0} 个`;
        if (mainType === '战斗冲突') {
            const objsN = (() => { const v = innerField(o, 'objectives'); return Array.isArray(v) ? v.length : 0; })();
            const prep = innerField(o, 'preparation');
            const prepN = (prep && typeof prep === 'object' && !Array.isArray(prep))
                ? Object.keys(prep).length : 0;
            mid = `战斗目标 ${objsN} 个` + (prepN ? `、战前准备 ${prepN} 项` : '、无战前准备');
        } else if (!nodeN && !charN && !(Array.isArray(minNodes) && minNodes.length)) {
            // 既无节点也无角色：不是案件，就别报案件的三项计数
            mid = '';
        }
        const summary = `主类型「${mainType || '未写'}」、外层键 ${outerN} 个、`
            + (mid ? mid + '、' : '')
            + `顶层键 ${topN} 个`
            + (stageCheck.count ? `、阶段 ${stageCheck.count} 段` : '')
            + (innerWarnN ? `、内层待补 ${innerWarnN} 项` : '');

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
        const pathsArr = Array.isArray(innerVal('paths')) ? innerVal('paths') : [];
        const samplePath = pathsArr.find(p => p && typeof p === 'object') || null;
        if (samplePath && !pick(samplePath, ['route'])) drift.push('路径正文没用 route');
        if (samplePath && !pick(samplePath, ['must'])) drift.push('必经标记没用 must');

        return { ok: missing.length === 0, missing, warnings, summary, drift, mainType };
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

