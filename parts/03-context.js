    // ==================== 2. 上下文 ====================

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
    let runtimeLog = S.runtimeLog; // 引用指向 S，值统一存 S
    // 未读错误数：日志页标签上挂红点用，点进日志页就清零
    let unreadErrors = S.unreadErrors; // 引用指向 S，值统一存 S

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
        S.runtimeLog.push({ at: hh + ':' + mi + ':' + ss, level, text });
        if (S.runtimeLog.length > RUNTIME_LOG_MAX) S.runtimeLog.splice(0, S.runtimeLog.length - RUNTIME_LOG_MAX);
    }

    function log(...args) {
        pushRuntimeLog('info', args);
        console.log(LOG_PREFIX, ...args);
    }

    function warn(...args) {
        pushRuntimeLog('warn', args);
        // 警告也算未读：结构缺失这类问题以前只落 warn，没人看见就等于没报
        S.unreadErrors++;
        console.warn(LOG_PREFIX, ...args);
    }

    function error(...args) {
        pushRuntimeLog('error', args);
        S.unreadErrors++;
        console.error(LOG_PREFIX, ...args);
    }

    function debug(...args) {
        pushRuntimeLog('debug', args);
        if (debugEnabled()) console.debug(LOG_PREFIX, ...args);
    }

