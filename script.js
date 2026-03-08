/* =====================================================
   C1 English Tracker – Main Script
   ===================================================== */

(function () {
    'use strict';

    // ── Storage helpers ──────────────────────────────────────
    const LS_SESSIONS    = 'c1t_sessions';
    const LS_REMINDER    = 'c1t_reminder';
    const LS_TIMER_START = 'c1t_timer_start';
    const LS_GH_TOKEN    = 'c1t_gh_token';
    const LS_GH_GIST_ID  = 'c1t_gh_gist_id';
    const LS_EMAIL_CFG   = 'c1t_email_cfg';
    const GIST_FILENAME  = 'c1-english-tracker-data.json';

    // ── Module-scoped timeout IDs (avoid polluting window) ───
    let reminderTimeoutId = null;
    let weeklySummaryTimeoutId = null;

    // ── Duration helper ──────────────────────────────────────
    function formatDuration(mins) {
        const m = Math.floor(mins);
        return `${Math.floor(m / 60)}h ${m % 60}m`;
    }

    function loadSessions() {
        try { return JSON.parse(localStorage.getItem(LS_SESSIONS)) || []; }
        catch { return []; }
    }

    function saveSessions(sessions) {
        localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions));
        syncToGist(); // async – fire and forget
    }

    function loadReminder() {
        try { return JSON.parse(localStorage.getItem(LS_REMINDER)) || {}; }
        catch { return {}; }
    }

    function saveReminder(cfg) {
        localStorage.setItem(LS_REMINDER, JSON.stringify(cfg));
    }

    function loadEmailCfg() {
        try { return JSON.parse(localStorage.getItem(LS_EMAIL_CFG)) || {}; }
        catch { return {}; }
    }

    function saveEmailCfg(cfg) {
        localStorage.setItem(LS_EMAIL_CFG, JSON.stringify(cfg));
    }

    // ── Timezone detection ───────────────────────────────────
    function detectTimezone() {
        try {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            document.getElementById('timezone-display').textContent = '🌐 ' + tz;
            return tz;
        } catch {
            document.getElementById('timezone-display').textContent = '🌐 Timezone unknown';
            return 'UTC';
        }
    }

    // ── Toast ────────────────────────────────────────────────
    let toastTimeout;
    function showToast(msg, duration = 3000) {
        const el = document.getElementById('toast');
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => { el.style.display = 'none'; }, duration);
    }

    // ── Date helpers ─────────────────────────────────────────
    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    function formatDate(str) {
        const d = new Date(str + 'T00:00:00');
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function getWeekLabel(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const mon = new Date(d.setDate(diff));
        return mon.toISOString().slice(0, 10);
    }

    function weekRangeLabel(weekStart) {
        const s = new Date(weekStart + 'T00:00:00');
        const e = new Date(s); e.setDate(e.getDate() + 6);
        const fmt = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return fmt(s) + ' – ' + fmt(e);
    }

    // ── Level system ─────────────────────────────────────────
    const LEVELS = [
        { label: 'Beginner',     icon: '🌱', minHrs: 0,   nextHrs: 10  },
        { label: 'Elementary',   icon: '📖', minHrs: 10,  nextHrs: 25  },
        { label: 'Pre-Intermediate', icon: '✏️', minHrs: 25, nextHrs: 50 },
        { label: 'Intermediate', icon: '🧠', minHrs: 50,  nextHrs: 100 },
        { label: 'Upper-Intermediate', icon: '🚀', minHrs: 100, nextHrs: 175 },
        { label: 'Advanced',     icon: '⭐', minHrs: 175, nextHrs: 300 },
        { label: 'C1 Master',    icon: '🏆', minHrs: 300, nextHrs: null },
    ];

    function getLevel(totalHrs) {
        let lv = LEVELS[0];
        for (const l of LEVELS) {
            if (totalHrs >= l.minHrs) lv = l;
        }
        return lv;
    }

    function updateLevelUI(sessions) {
        const totalMins = sessions.reduce((s, x) => s + (x.duration || 0), 0);
        const totalHrs = totalMins / 60;
        const lv = getLevel(totalHrs);
        document.getElementById('level-label').textContent = lv.label;
        document.getElementById('level-icon').textContent  = lv.icon;
        if (lv.nextHrs) {
            const pct = Math.min(100, ((totalHrs - lv.minHrs) / (lv.nextHrs - lv.minHrs)) * 100);
            document.getElementById('level-progress-fill').style.width = pct + '%';
            const remaining = Math.max(0, lv.nextHrs - totalHrs).toFixed(1);
            document.getElementById('level-progress-text').textContent =
                `${(totalHrs - lv.minHrs).toFixed(1)} / ${(lv.nextHrs - lv.minHrs).toFixed(1)} hrs to next level`;
        } else {
            document.getElementById('level-progress-fill').style.width = '100%';
            document.getElementById('level-progress-text').textContent = '🎉 Max level reached!';
        }
    }

    // ── Streak calculation ───────────────────────────────────
    function calcStreaks(sessions) {
        const daySet = new Set(sessions.map(s => s.date));
        const days = Array.from(daySet).sort();
        if (!days.length) return { current: 0, best: 0 };

        let best = 1, cur = 1;
        for (let i = 1; i < days.length; i++) {
            const prev = new Date(days[i - 1] + 'T00:00:00');
            const curr = new Date(days[i]     + 'T00:00:00');
            const diff = (curr - prev) / 86400000;
            if (diff === 1) { cur++; best = Math.max(best, cur); }
            else cur = 1;
        }

        // check if streak includes today
        const today = todayStr();
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        const lastDay = days[days.length - 1];
        let current = 0;
        if (lastDay === today || lastDay === yesterdayStr) {
            current = 1;
            for (let i = days.length - 2; i >= 0; i--) {
                const a = new Date(days[i + 1] + 'T00:00:00');
                const b = new Date(days[i]     + 'T00:00:00');
                if ((a - b) / 86400000 === 1) current++;
                else break;
            }
        }
        return { current, best: Math.max(best, current) };
    }

    // ── Streak calendar render ───────────────────────────────
    function renderStreakCalendar(sessions) {
        // Build a map: date → total minutes
        const dayMap = {};
        for (const s of sessions) {
            dayMap[s.date] = (dayMap[s.date] || 0) + (s.duration || 0);
        }

        const container = document.getElementById('streak-calendar');
        container.innerHTML = '';

        const today = new Date();
        const start = new Date(today);
        start.setDate(start.getDate() - 181); // ~6 months

        for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().slice(0, 10);
            const mins = dayMap[dateStr] || 0;
            let lv = 'lv0';
            if (mins > 0   && mins < 30) lv = 'lv1';
            else if (mins >= 30 && mins < 60)  lv = 'lv2';
            else if (mins >= 60 && mins < 120) lv = 'lv3';
            else if (mins >= 120) lv = 'lv4';

            const cell = document.createElement('div');
            cell.className = 'streak-day ' + lv;
            const tip = mins > 0
                ? `${formatDate(dateStr)}: ${formatDuration(mins)}`
                : formatDate(dateStr) + ': No study';
            cell.setAttribute('data-tip', tip);
            container.appendChild(cell);
        }
    }

    // ── Time-of-day analysis (native Canvas 2D) ──────────────
    function renderTodChart(sessions) {
        const buckets = new Array(24).fill(0);
        for (const s of sessions) {
            if (!s.time) continue;
            const hr = parseInt(s.time.split(':')[0], 10);
            if (hr >= 0 && hr < 24) buckets[hr] += s.duration || 0;
        }

        const maxMins = Math.max(...buckets, 1);
        const bestHr  = buckets.indexOf(Math.max(...buckets));

        if (Math.max(...buckets) > 0) {
            const ampm = bestHr < 12 ? 'AM' : 'PM';
            const h = (bestHr % 12) || 12;
            document.getElementById('tod-insight').textContent =
                `📈 You study best around ${h}:00 ${ampm} (${Math.round(buckets[bestHr])} min total). Keep it up!`;
        } else {
            document.getElementById('tod-insight').textContent =
                'No data yet – log your first session to see when you study best!';
        }

        const canvas = document.getElementById('todChart');
        const ctx    = canvas.getContext('2d');
        const W = canvas.width  = canvas.offsetWidth  || 600;
        const H = canvas.height = 180;
        ctx.clearRect(0, 0, W, H);

        const padL = 36, padR = 10, padT = 10, padB = 28;
        const chartW = W - padL - padR;
        const chartH = H - padT - padB;
        const barW = Math.max(2, (chartW / 24) - 2);

        // Grid lines
        ctx.strokeStyle = '#2e3347';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = padT + chartH - (i / 4) * chartH;
            ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
            ctx.fillStyle = '#8a8fa8';
            ctx.font = '10px sans-serif';
            ctx.fillText(Math.round((maxMins * i) / 4), 2, y + 4);
        }

        // Bars
        for (let i = 0; i < 24; i++) {
            const x = padL + (i / 24) * chartW + 1;
            const barH = (buckets[i] / maxMins) * chartH;
            const y = padT + chartH - barH;
            ctx.fillStyle = (i === bestHr && buckets[i] > 0) ? '#00d4aa' : '#6c63ff88';
            ctx.beginPath();
            const r = 3;
            ctx.roundRect
                ? ctx.roundRect(x, y, barW, barH, [r, r, 0, 0])
                : ctx.rect(x, y, barW, barH);
            ctx.fill();
        }

        // X-axis labels (every 3 hours)
        ctx.fillStyle = '#8a8fa8';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        for (let i = 0; i < 24; i += 3) {
            const x = padL + (i / 24) * chartW + barW / 2 + 1;
            const label = i === 0 ? '12A' : i < 12 ? `${i}A` : i === 12 ? '12P' : `${i - 12}P`;
            ctx.fillText(label, x, H - 6);
        }
    }

    // ── Stats ────────────────────────────────────────────────
    function updateStats(sessions) {
        const totalMins = sessions.reduce((s, x) => s + (x.duration || 0), 0);
        document.getElementById('stat-total-hours').textContent = (totalMins / 60).toFixed(1);
        document.getElementById('stat-sessions').textContent = sessions.length;

        const { current, best } = calcStreaks(sessions);
        document.getElementById('stat-best-streak').textContent = best;
        document.getElementById('current-streak').textContent = current;

        // This week
        const weekStart = getWeekLabel(todayStr());
        const weekMins = sessions
            .filter(s => getWeekLabel(s.date) === weekStart)
            .reduce((s, x) => s + (x.duration || 0), 0);
        document.getElementById('stat-this-week').textContent = (weekMins / 60).toFixed(1);
    }

    // ── Badges ───────────────────────────────────────────────
    const BADGE_DEFS = [
        {
            id: 'first_session',
            icon: '🎉',
            name: 'First Step',
            desc: 'Log your first session',
            check: (s) => s.length >= 1,
        },
        {
            id: 'streak_3',
            icon: '🔥',
            name: '3-Day Streak',
            desc: '3 consecutive study days',
            check: (s) => calcStreaks(s).best >= 3,
        },
        {
            id: 'streak_7',
            icon: '🌟',
            name: '7-Day Streak',
            desc: '7 consecutive study days',
            check: (s) => calcStreaks(s).best >= 7,
        },
        {
            id: 'streak_30',
            icon: '🏅',
            name: '30-Day Streak',
            desc: '30 consecutive study days',
            check: (s) => calcStreaks(s).best >= 30,
        },
        {
            id: 'one_hour',
            icon: '⏰',
            name: '1hr Session',
            desc: 'A single session ≥ 60 min',
            check: (s) => s.some(x => x.duration >= 60),
        },
        {
            id: 'ten_hours',
            icon: '📚',
            name: '10 Hours',
            desc: '10 total hours studied',
            check: (s) => s.reduce((a, x) => a + x.duration, 0) >= 600,
        },
        {
            id: 'fifty_hours',
            icon: '🧠',
            name: '50 Hours',
            desc: '50 total hours studied',
            check: (s) => s.reduce((a, x) => a + x.duration, 0) >= 3000,
        },
        {
            id: 'all_topics',
            icon: '🎓',
            name: 'All Topics',
            desc: 'Study all 16 course topics',
            check: (s) => {
                const topics = new Set(s.map(x => x.topic));
                const all = [
                    'Sentence Stress','Word Stress','Intonation','Connected Speech','Weak Vowels',
                    'Irregular Plurals','Difficult Consonants','Phrasal Verbs','Collocations',
                    'Idioms','Advanced Grammar','Business English','Academic Writing',
                    'Presentation Skills','Debate Techniques','Accent Reduction',
                ];
                return all.every(t => topics.has(t));
            },
        },
        {
            id: 'early_bird',
            icon: '🌅',
            name: 'Early Bird',
            desc: '5 sessions before 8 AM',
            check: (s) => s.filter(x => x.time && parseInt(x.time, 10) < 8).length >= 5,
        },
        {
            id: 'night_owl',
            icon: '🦉',
            name: 'Night Owl',
            desc: '5 sessions after 10 PM',
            check: (s) => s.filter(x => x.time && parseInt(x.time, 10) >= 22).length >= 5,
        },
    ];

    function renderBadges(sessions) {
        const grid = document.getElementById('badges-grid');
        grid.innerHTML = '';
        for (const def of BADGE_DEFS) {
            const earned = def.check(sessions);
            const el = document.createElement('div');
            el.className = 'badge' + (earned ? ' earned' : ' locked');
            el.innerHTML = `
                <span class="badge-icon">${def.icon}</span>
                <span class="badge-name">${def.name}</span>
                <span class="badge-desc">${def.desc}</span>
            `;
            grid.appendChild(el);
            if (earned) el.title = 'Earned! ' + def.desc;
        }
    }

    // ── Course map progress ───────────────────────────────────
    const TOPICS = [
        'Sentence Stress','Word Stress','Intonation','Connected Speech','Weak Vowels',
        'Irregular Plurals','Difficult Consonants','Phrasal Verbs','Collocations',
        'Idioms','Advanced Grammar','Business English','Academic Writing',
        'Presentation Skills','Debate Techniques','Accent Reduction',
    ];

    function renderCourseMap(sessions) {
        const topicMins = {};
        for (const t of TOPICS) topicMins[t] = 0;
        for (const s of sessions) {
            if (topicMins[s.topic] !== undefined) topicMins[s.topic] += s.duration || 0;
        }

        const maxMins = Math.max(...Object.values(topicMins), 1);
        const list = document.getElementById('course-progress-list');
        list.innerHTML = '';

        for (const t of TOPICS) {
            const mins = topicMins[t];
            const pct = Math.min(100, (mins / Math.max(maxMins, 120)) * 100);
            list.innerHTML += `
                <div class="course-item">
                    <span class="course-item-label">${t}</span>
                    <div class="course-bar-wrap">
                        <div class="course-bar-fill" style="width:${pct}%"></div>
                    </div>
                    <span class="course-minutes">${mins >= 60 ? formatDuration(mins) : mins + ' m'}</span>
                </div>`;
        }
    }

    // ── Weekly leaderboard ───────────────────────────────────
    function renderLeaderboard(sessions) {
        const weekMap = {};
        for (const s of sessions) {
            const wk = getWeekLabel(s.date);
            if (!weekMap[wk]) weekMap[wk] = { sessions: 0, mins: 0, dayMap: {} };
            weekMap[wk].sessions++;
            weekMap[wk].mins += s.duration || 0;
            weekMap[wk].dayMap[s.date] = (weekMap[wk].dayMap[s.date] || 0) + (s.duration || 0);
        }

        const weeks = Object.keys(weekMap).sort().reverse().slice(0, 12);
        const sorted = [...weeks].sort((a, b) => weekMap[b].mins - weekMap[a].mins);

        const tbody = document.getElementById('leaderboard-body');
        tbody.innerHTML = '';

        if (!weeks.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">No weeks logged yet.</td></tr>';
            return;
        }

        for (const wk of weeks) {
            const d = weekMap[wk];
            const rank = sorted.indexOf(wk) + 1;
            const bestDayMins = Math.max(...Object.values(d.dayMap));
            const bestDayDate = Object.keys(d.dayMap).find(k => d.dayMap[k] === bestDayMins);

            const rankClass = rank <= 3 ? `r${rank}` : 'r-other';
            const tr = document.createElement('tr');
            if (rank <= 3) tr.className = `rank-${rank}`;
            tr.innerHTML = `
                <td>${weekRangeLabel(wk)}</td>
                <td>${d.sessions}</td>
                <td>${(d.mins / 60).toFixed(1)}</td>
                <td>${bestDayDate ? formatDate(bestDayDate) + ` (${formatDuration(bestDayMins)})` : '–'}</td>
                <td><span class="rank-badge ${rankClass}">#${rank}</span></td>
            `;
            tbody.appendChild(tr);
        }
    }

    // ── Study log table ──────────────────────────────────────
    let currentSearch = '';

    function renderLogTable(sessions) {
        const q = currentSearch.toLowerCase();
        const filtered = q
            ? sessions.filter(s =>
                s.topic.toLowerCase().includes(q) ||
                (s.notes || '').toLowerCase().includes(q) ||
                s.date.includes(q))
            : sessions;

        const sorted = [...filtered].sort((a, b) => {
            const cmp = b.date.localeCompare(a.date);
            return cmp !== 0 ? cmp : (b.time || '').localeCompare(a.time || '');
        });

        const tbody = document.getElementById('log-body');
        const empty = document.getElementById('log-empty');
        tbody.innerHTML = '';

        if (!sorted.length) {
            empty.style.display = 'block';
            return;
        }
        empty.style.display = 'none';

        for (const s of sorted) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDate(s.date)}</td>
                <td>${s.time || '–'}</td>
                <td>${s.topic}</td>
                <td>${formatDuration(s.duration)}</td>
                <td>${s.notes ? s.notes.slice(0, 60) + (s.notes.length > 60 ? '…' : '') : '–'}</td>
                <td><button class="delete-btn" data-id="${s.id}" title="Delete">🗑</button></td>
            `;
            tbody.appendChild(tr);
        }
    }

    // ── Full render ──────────────────────────────────────────
    function renderAll() {
        const sessions = loadSessions();
        updateStats(sessions);
        updateLevelUI(sessions);
        renderStreakCalendar(sessions);
        renderTodChart(sessions);
        renderBadges(sessions);
        renderCourseMap(sessions);
        renderLeaderboard(sessions);
        renderLogTable(sessions);
    }

    // ── Log session ──────────────────────────────────────────
    function logSession(data) {
        const sessions = loadSessions();
        sessions.push({
            id:       Date.now() + Math.random(),
            date:     data.date,
            time:     data.time,
            topic:    data.topic,
            duration: data.duration,
            notes:    data.notes,
        });
        saveSessions(sessions);

        // check new badges
        const prevBadgeCount = BADGE_DEFS.filter(b => b.check(sessions.slice(0, -1))).length;
        const newBadgeCount  = BADGE_DEFS.filter(b => b.check(sessions)).length;
        if (newBadgeCount > prevBadgeCount) {
            const newBadge = BADGE_DEFS.find(b => b.check(sessions) && !b.check(sessions.slice(0, -1)));
            if (newBadge) showToast(`🏅 New achievement: ${newBadge.name}!`, 5000);
        }

        renderAll();
        showToast('✅ Session logged!');
    }

    // ── Live timer ───────────────────────────────────────────
    let timerInterval = null;

    function startTimer() {
        const startMs = Date.now();
        localStorage.setItem(LS_TIMER_START, startMs);
        document.getElementById('live-timer-display').style.display = 'flex';
        document.getElementById('btn-live-timer').disabled = true;

        timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startMs) / 1000);
            const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
            const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            document.getElementById('timer-value').textContent = `${h}:${m}:${s}`;
        }, 1000);
    }

    function stopTimer() {
        const startMs = parseInt(localStorage.getItem(LS_TIMER_START) || '0', 10);
        clearInterval(timerInterval);
        timerInterval = null;
        localStorage.removeItem(LS_TIMER_START);
        document.getElementById('live-timer-display').style.display = 'none';
        document.getElementById('btn-live-timer').disabled = false;
        document.getElementById('timer-value').textContent = '00:00:00';

        if (!startMs) return;
        const mins = Math.max(1, Math.round((Date.now() - startMs) / 60000));
        document.getElementById('session-duration').value = mins;
        showToast(`⏱ Timer stopped: ${mins} min. Review & click "Log Session".`);
    }

    // ── Smart reminders ──────────────────────────────────────
    function getBestStudyHour(sessions) {
        if (!sessions.length) return 9;
        const buckets = new Array(24).fill(0);
        for (const s of sessions) {
            if (!s.time) continue;
            const hr = parseInt(s.time.split(':')[0], 10);
            if (hr >= 0 && hr < 24) buckets[hr] += s.duration || 0;
        }
        return buckets.indexOf(Math.max(...buckets));
    }

    async function requestNotificationPermission() {
        if (!('Notification' in window)) return false;
        if (Notification.permission === 'granted') return true;
        const result = await Notification.requestPermission();
        return result === 'granted';
    }

    function scheduleReminder(cfg) {
        // Clear existing scheduled alarm (use a timestamp check)
        const now = new Date();
        const [hr, min] = cfg.time.split(':').map(Number);
        const next = new Date(now);
        next.setHours(hr, min, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);

        const msUntil = next - now;
        clearTimeout(reminderTimeoutId);
        reminderTimeoutId = setTimeout(() => {
            const streakMsg = `Keep your ${calcStreaks(loadSessions()).current}-day streak alive! 🔥`;
            if (Notification.permission === 'granted') {
                const notifOpts = {
                    body: `Time to study! Your scheduled session is due. ${streakMsg}`,
                    icon: '',
                };
                // Use Service Worker notification when available for better mobile support
                if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.ready.then((reg) => {
                        reg.showNotification('C1 English Tracker 📚', notifOpts);
                    }).catch(() => {
                        new Notification('C1 English Tracker 📚', notifOpts);
                    });
                } else {
                    new Notification('C1 English Tracker 📚', notifOpts);
                }
            }
            // Also send email notification if configured
            sendEmailNotification('daily');
            // re-schedule for next day
            scheduleReminder(cfg);
        }, msUntil);
    }

    function scheduleWeeklySummary() {
        const now = new Date();
        const next = new Date(now);
        // Next Sunday at 09:00
        const daysUntilSun = (7 - now.getDay()) % 7 || 7;
        next.setDate(next.getDate() + daysUntilSun);
        next.setHours(9, 0, 0, 0);
        const msUntil = next - now;

        clearTimeout(weeklySummaryTimeoutId);
        weeklySummaryTimeoutId = setTimeout(() => {
            const sessions = loadSessions();
            const wk = getWeekLabel(todayStr());
            const wkSessions = sessions.filter(s => getWeekLabel(s.date) === wk);
            const wkMins = wkSessions.reduce((a, x) => a + x.duration, 0);
            const notifBody = `This week: ${wkSessions.length} sessions, ${(wkMins / 60).toFixed(1)} hours. ${
                calcStreaks(sessions).current > 0 ? `🔥 ${calcStreaks(sessions).current}-day streak!` : 'Start a new streak tomorrow!'}`;

            if (Notification.permission === 'granted') {
                const notifOpts = { body: notifBody };
                if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.ready.then((reg) => {
                        reg.showNotification('📊 Weekly Study Summary', notifOpts);
                    }).catch(() => {
                        new Notification('📊 Weekly Study Summary', notifOpts);
                    });
                } else {
                    new Notification('📊 Weekly Study Summary', notifOpts);
                }
            }
            // Also send weekly email if configured
            sendEmailNotification('weekly');
            scheduleWeeklySummary();
        }, msUntil);
    }

    function applyReminderSettings() {
        const cfg = loadReminder();
        if (cfg.enabled && cfg.time) scheduleReminder(cfg);
        if (cfg.weekly) scheduleWeeklySummary();
    }

    // ── EmailJS notifications ────────────────────────────────
    let emailjsInitialised = false;

    function initEmailJS(publicKey) {
        if (typeof emailjs === 'undefined') {
            console.warn('[C1 Tracker] EmailJS SDK not loaded – email notifications unavailable');
            return false;
        }
        if (!publicKey) return false;
        try {
            emailjs.init({ publicKey });
            emailjsInitialised = true;
            return true;
        } catch (err) {
            console.warn('[C1 Tracker] EmailJS init error:', err);
            return false;
        }
    }

    async function sendEmailNotification(type, overrideStatus) {
        const cfg = loadEmailCfg();
        if (!cfg.enabled || !cfg.email || !cfg.publicKey || !cfg.serviceId || !cfg.templateId) return;
        if (!emailjsInitialised && !initEmailJS(cfg.publicKey)) return;

        const sessions = loadSessions();
        const { current } = calcStreaks(sessions);

        let subject, message;
        if (type === 'weekly') {
            const wk = getWeekLabel(todayStr());
            const wkSessions = sessions.filter(s => getWeekLabel(s.date) === wk);
            const wkMins = wkSessions.reduce((a, x) => a + x.duration, 0);
            subject = '📊 Weekly C1 Study Summary';
            message = `Your weekly study summary:\n\n` +
                `• Sessions this week: ${wkSessions.length}\n` +
                `• Time studied: ${(wkMins / 60).toFixed(1)} hours\n` +
                `• Current streak: ${current > 0 ? `🔥 ${current} days` : 'No active streak'}\n\n` +
                `Keep up the great work! Open your tracker to log today's session.`;
        } else {
            subject = '📚 C1 English Study Reminder';
            message = `Time to study! Your scheduled session is due.\n\n` +
                `• Current streak: ${current > 0 ? `🔥 ${current} days — keep it alive!` : 'Start a new streak today!'}\n` +
                `• Total sessions: ${sessions.length}\n\n` +
                `Open your C1 English Tracker to log your session.`;
        }

        try {
            await emailjs.send(cfg.serviceId, cfg.templateId, {
                to_email: cfg.email,
                subject,
                message,
            });
            if (overrideStatus) overrideStatus('✅ Email sent!', 'ok');
        } catch (err) {
            console.warn('[C1 Tracker] Email send error:', err);
            if (overrideStatus) overrideStatus(`❌ Email failed: ${err.text || err.message || 'unknown error'}`, 'error');
        }
    }

    function applyEmailJSInit() {
        const cfg = loadEmailCfg();
        if (cfg.enabled && cfg.publicKey) initEmailJS(cfg.publicKey);
    }

    // ── PDF export (print-based, no external deps) ───────────
    function downloadPDF() {
        const sessions = loadSessions();
        if (!sessions.length) { showToast('No sessions to export.'); return; }

        const totalMins = sessions.reduce((s, x) => s + x.duration, 0);
        const { current, best } = calcStreaks(sessions);
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const sorted = [...sessions].sort((a, b) => b.date.localeCompare(a.date));

        const rows = sorted.map(s => `
            <tr>
                <td>${formatDate(s.date)}</td>
                <td>${s.time || '–'}</td>
                <td>${s.topic}</td>
                <td>${formatDuration(s.duration)}</td>
                <td>${(s.notes || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>
            </tr>`).join('');

        const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>C1 English Study Report</title>
<style>
  body { font-family: sans-serif; font-size: 12px; color: #111; padding: 24px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .meta { color: #555; font-size: 11px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #6c63ff; color: #fff; padding: 7px 10px; text-align: left; font-size: 11px; }
  td { padding: 6px 10px; border-bottom: 1px solid #ddd; font-size: 11px; }
  tr:nth-child(even) td { background: #f5f5ff; }
  @media print { body { padding: 0; } }
</style>
</head><body>
<h1>C1 English Tracker – Study Report</h1>
<div class="meta">
  Generated: ${new Date().toLocaleDateString()} | Timezone: ${tz}<br>
  Total hours: ${(totalMins / 60).toFixed(1)} | Sessions: ${sessions.length} | Best streak: ${best} days
</div>
<table>
  <thead><tr><th>Date</th><th>Time</th><th>Topic</th><th>Duration</th><th>Notes</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;

        const win = window.open('', '_blank');
        if (!win) { showToast('❌ Pop-up blocked. Allow pop-ups to export PDF.'); return; }
        win.document.write(html);
        win.document.close();
        win.focus();
        setTimeout(() => { win.print(); }, 500);
        showToast('📄 Print dialog opened – save as PDF!');
    }

    // ── GitHub Gist Sync ─────────────────────────────────────
    function ghToken()  { return localStorage.getItem(LS_GH_TOKEN) || ''; }
    function ghGistId() { return localStorage.getItem(LS_GH_GIST_ID) || ''; }

    function setSyncStatus(status) {
        const el = document.getElementById('sync-status');
        if (!el) return;
        const MAP = {
            syncing: { text: '⟳ Syncing…',    cls: 'sync-syncing' },
            synced:  { text: '✓ Synced',        cls: 'sync-ok'     },
            error:   { text: '✗ Sync failed',   cls: 'sync-error'  },
            none:    { text: '○ Not synced',     cls: 'sync-none'   },
        };
        const s = MAP[status] || MAP.none;
        el.textContent = s.text;
        el.className   = 'sync-status ' + s.cls;
    }

    // Find an existing gist that contains our file, or create a new private one.
    async function findOrCreateGist(token) {
        const headers = {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
        };
        // Search existing gists (up to 100)
        const listRes = await fetch('https://api.github.com/gists?per_page=100', { headers });
        if (!listRes.ok) throw new Error(`GitHub API error ${listRes.status}: ${await listRes.text()}`);
        const gists = await listRes.json();
        const found = gists.find(g => Object.prototype.hasOwnProperty.call(g.files, GIST_FILENAME));
        if (found) return found.id;

        // Create a new private gist
        const createRes = await fetch('https://api.github.com/gists', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description: 'C1 English Tracker – Study Progress',
                public: false,
                files: {
                    [GIST_FILENAME]: {
                        content: JSON.stringify({ sessions: [], version: 2, createdAt: new Date().toISOString() }, null, 2),
                    },
                },
            }),
        });
        if (!createRes.ok) throw new Error(`Create gist failed ${createRes.status}: ${await createRes.text()}`);
        const newGist = await createRes.json();
        return newGist.id;
    }

    // Push current local sessions to the Gist.
    async function syncToGist() {
        const token  = ghToken();
        const gistId = ghGistId();
        if (!token || !gistId) return;

        setSyncStatus('syncing');
        try {
            const sessions = loadSessions();
            const payload  = { sessions, version: 2, updatedAt: new Date().toISOString() };
            const res = await fetch(`https://api.github.com/gists/${gistId}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(payload, null, 2) } } }),
            });
            if (!res.ok) throw new Error(`PATCH gist failed ${res.status}`);
            setSyncStatus('synced');
        } catch (err) {
            setSyncStatus('error');
            console.error('[C1 Tracker] GitHub sync error:', err);
        }
    }

    // Pull sessions from the Gist and merge (Gist wins if it has more sessions).
    async function loadFromGist() {
        const token  = ghToken();
        const gistId = ghGistId();
        if (!token || !gistId) return false;

        setSyncStatus('syncing');
        try {
            const res = await fetch(`https://api.github.com/gists/${gistId}`, {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                },
            });
            if (!res.ok) throw new Error(`GET gist failed ${res.status}`);
            const gist   = await res.json();
            const file   = gist.files[GIST_FILENAME];
            if (!file || !file.content) return false;

            const data = JSON.parse(file.content);
            if (Array.isArray(data.sessions)) {
                // Merge: keep the dataset with more entries (or use Gist if equal)
                const local = loadSessions();
                if (data.sessions.length >= local.length) {
                    localStorage.setItem(LS_SESSIONS, JSON.stringify(data.sessions));
                }
            }
            setSyncStatus('synced');
            return true;
        } catch (err) {
            setSyncStatus('error');
            console.error('[C1 Tracker] GitHub load error:', err);
            return false;
        }
    }

    // Update the modal UI to reflect connected/disconnected state.
    function refreshGithubModalUI() {
        const token  = ghToken();
        const gistId = ghGistId();
        const connected = !!(token && gistId);

        const info     = document.getElementById('gh-connected-info');
        const form     = document.getElementById('gh-setup-form');
        const linkEl   = document.getElementById('gh-gist-link');
        const btnConn  = document.getElementById('btn-gh-connect');
        const btnPull  = document.getElementById('btn-gh-pull');
        const btnDisc  = document.getElementById('btn-gh-disconnect');

        if (connected) {
            info.style.display   = 'flex';
            form.style.display   = 'none';
            btnConn.style.display = 'none';
            btnPull.style.display = 'inline-flex';
            btnDisc.style.display = 'inline-flex';
            linkEl.href = `https://gist.github.com/${gistId}`;
        } else {
            info.style.display   = 'none';
            form.style.display   = 'block';
            btnConn.style.display = 'inline-flex';
            btnPull.style.display = 'none';
            btnDisc.style.display = 'none';
        }
    }

    function showGhModalStatus(msg, type /* 'ok'|'error'|'info' */) {
        const el = document.getElementById('gh-modal-status');
        el.textContent = msg;
        el.className   = `gh-modal-status status-${type}`;
        el.style.display = 'block';
    }

    // ── Cloud backup: export / import ────────────────────────
    function exportBackup() {
        const data = {
            version: 1,
            exportedAt: new Date().toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            sessions: loadSessions(),
            reminder: loadReminder(),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `c1-tracker-backup-${todayStr()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('☁ Backup exported!');
    }

    function importBackup(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (!Array.isArray(data.sessions)) throw new Error('Invalid format');
                saveSessions(data.sessions);
                if (data.reminder) saveReminder(data.reminder);
                renderAll();
                showToast(`📥 Imported ${data.sessions.length} sessions!`);
            } catch {
                showToast('❌ Import failed: invalid file.');
            }
        };
        reader.readAsText(file);
    }

    // ── Event listeners ──────────────────────────────────────
    function initEventListeners() {
        // Pre-fill date/time
        const dateInput = document.getElementById('session-date');
        const timeInput = document.getElementById('session-time');
        dateInput.value = todayStr();
        const now = new Date();
        timeInput.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        // Log session
        document.getElementById('btn-log-session').addEventListener('click', () => {
            const topic    = document.getElementById('topic-select').value;
            const duration = parseInt(document.getElementById('session-duration').value, 10);
            const date     = document.getElementById('session-date').value;
            const time     = document.getElementById('session-time').value;
            const notes    = document.getElementById('session-notes').value.trim();

            if (!topic || !duration || duration < 1 || !date) {
                showToast('❗ Please fill in topic, duration and date.'); return;
            }
            logSession({ topic, duration, date, time, notes });

            document.getElementById('session-duration').value = '';
            document.getElementById('session-notes').value = '';
            document.getElementById('session-date').value = todayStr();
        });

        // Live timer
        document.getElementById('btn-live-timer').addEventListener('click', startTimer);
        document.getElementById('btn-stop-timer').addEventListener('click', stopTimer);

        // Delete session
        document.getElementById('log-body').addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-btn')) {
                const id = parseFloat(e.target.dataset.id);
                const sessions = loadSessions().filter(s => s.id !== id);
                saveSessions(sessions);
                renderAll();
                showToast('🗑 Session deleted.');
            }
        });

        // Search
        document.getElementById('log-search').addEventListener('input', (e) => {
            currentSearch = e.target.value;
            renderLogTable(loadSessions());
        });

        // PDF
        document.getElementById('btn-pdf').addEventListener('click', downloadPDF);

        // Backup export
        document.getElementById('btn-backup-export').addEventListener('click', exportBackup);

        // Backup import
        document.getElementById('btn-backup-import').addEventListener('click', () => {
            document.getElementById('import-file').click();
        });
        document.getElementById('import-file').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) importBackup(file);
            e.target.value = '';
        });

        // Reminder modal
        document.getElementById('btn-reminder').addEventListener('click', () => {
            const cfg = loadReminder();
            document.getElementById('reminder-time').value = cfg.time || '09:00';
            document.getElementById('reminder-smart').checked = !!cfg.smart;
            document.getElementById('reminder-weekly').checked = !!cfg.weekly;

            // Pre-fill email config
            const emailCfg = loadEmailCfg();
            document.getElementById('email-notif-enabled').checked = !!emailCfg.enabled;
            document.getElementById('email-notif-fields').style.display = emailCfg.enabled ? 'block' : 'none';
            document.getElementById('email-notif-address').value = emailCfg.email || '';
            document.getElementById('emailjs-public-key').value = emailCfg.publicKey || '';
            document.getElementById('emailjs-service-id').value = emailCfg.serviceId || '';
            document.getElementById('emailjs-template-id').value = emailCfg.templateId || '';

            document.getElementById('reminder-status').textContent = '';
            document.getElementById('test-email-status').textContent = '';
            document.getElementById('reminder-modal').style.display = 'flex';
        });

        function closeReminderModal() {
            document.getElementById('reminder-modal').style.display = 'none';
        }
        document.getElementById('btn-close-reminder').addEventListener('click', closeReminderModal);
        document.getElementById('btn-close-reminder-x').addEventListener('click', closeReminderModal);
        document.getElementById('reminder-modal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('reminder-modal')) closeReminderModal();
        });

        document.getElementById('reminder-smart').addEventListener('change', function () {
            if (this.checked) {
                const sessions = loadSessions();
                const hr = getBestStudyHour(sessions);
                document.getElementById('reminder-time').value =
                    `${String(hr).padStart(2, '0')}:00`;
            }
        });

        // Toggle email fields visibility
        document.getElementById('email-notif-enabled').addEventListener('change', function () {
            document.getElementById('email-notif-fields').style.display = this.checked ? 'block' : 'none';
        });

        // Show/hide EmailJS public key
        document.getElementById('btn-toggle-emailjs-key').addEventListener('click', () => {
            const inp = document.getElementById('emailjs-public-key');
            inp.type = inp.type === 'password' ? 'text' : 'password';
        });

        // Test email button
        document.getElementById('btn-test-email').addEventListener('click', async () => {
            const publicKey  = document.getElementById('emailjs-public-key').value.trim();
            const serviceId  = document.getElementById('emailjs-service-id').value.trim();
            const templateId = document.getElementById('emailjs-template-id').value.trim();
            const email      = document.getElementById('email-notif-address').value.trim();

            const statusEl = document.getElementById('test-email-status');
            if (!email || !publicKey || !serviceId || !templateId) {
                statusEl.textContent = '❗ Fill in all email fields first.';
                statusEl.className = 'test-email-status status-error';
                return;
            }

            // Temporarily save and init to allow the test send
            const tempCfg = { enabled: true, email, publicKey, serviceId, templateId };
            saveEmailCfg(tempCfg);
            emailjsInitialised = false; // force re-init with new key
            statusEl.textContent = '📤 Sending…';
            statusEl.className = 'test-email-status';

            await sendEmailNotification('daily', (msg, type) => {
                statusEl.textContent = msg;
                statusEl.className = `test-email-status status-${type}`;
            });
        });

        document.getElementById('btn-save-reminder').addEventListener('click', async () => {
            const time   = document.getElementById('reminder-time').value;
            const smart  = document.getElementById('reminder-smart').checked;
            const weekly = document.getElementById('reminder-weekly').checked;

            const granted = await requestNotificationPermission();
            if (!granted) {
                document.getElementById('reminder-status').textContent =
                    '❌ Notification permission denied. Enable it in your browser settings.';
                return;
            }

            const cfg = { enabled: true, time, smart, weekly };
            saveReminder(cfg);
            scheduleReminder(cfg);
            if (weekly) scheduleWeeklySummary();

            // Save email config
            const emailEnabled  = document.getElementById('email-notif-enabled').checked;
            const emailAddress  = document.getElementById('email-notif-address').value.trim();
            const ejsPublicKey  = document.getElementById('emailjs-public-key').value.trim();
            const ejsServiceId  = document.getElementById('emailjs-service-id').value.trim();
            const ejsTemplateId = document.getElementById('emailjs-template-id').value.trim();

            const emailCfg = {
                enabled:    emailEnabled,
                email:      emailAddress,
                publicKey:  ejsPublicKey,
                serviceId:  ejsServiceId,
                templateId: ejsTemplateId,
            };
            saveEmailCfg(emailCfg);
            if (emailEnabled && ejsPublicKey) {
                emailjsInitialised = false;
                initEmailJS(ejsPublicKey);
            }

            let statusMsg = `✅ Browser reminder set for ${time} daily${weekly ? ' + weekly summary' : ''}.`;
            if (emailEnabled && emailAddress) statusMsg += ` Email notifications enabled for ${emailAddress}.`;
            document.getElementById('reminder-status').textContent = statusMsg;

            setTimeout(() => {
                closeReminderModal();
            }, 2000);
        });

        // GitHub Sync modal
        const ghModal = document.getElementById('github-modal');

        function openGithubModal() {
            refreshGithubModalUI();
            // Pre-fill token field if already stored
            const stored = ghToken();
            const tokenInput = document.getElementById('gh-token');
            if (stored) tokenInput.value = stored;
            const statusEl = document.getElementById('gh-modal-status');
            statusEl.style.display = 'none';
            ghModal.style.display = 'flex';
        }

        function closeGithubModal() {
            ghModal.style.display = 'none';
        }

        document.getElementById('btn-github-sync').addEventListener('click', openGithubModal);
        document.getElementById('btn-close-github').addEventListener('click', closeGithubModal);
        document.getElementById('btn-close-github-x').addEventListener('click', closeGithubModal);
        ghModal.addEventListener('click', (e) => {
            if (e.target === ghModal) closeGithubModal();
        });

        // Show/hide PAT
        document.getElementById('btn-toggle-token').addEventListener('click', () => {
            const inp = document.getElementById('gh-token');
            inp.type = inp.type === 'password' ? 'text' : 'password';
        });

        // Connect & Sync
        document.getElementById('btn-gh-connect').addEventListener('click', async () => {
            const token = document.getElementById('gh-token').value.trim();
            if (!token) { showGhModalStatus('❗ Please enter your Personal Access Token.', 'error'); return; }

            showGhModalStatus('🔄 Connecting to GitHub…', 'info');
            document.getElementById('btn-gh-connect').disabled = true;
            try {
                const gistId = await findOrCreateGist(token);
                localStorage.setItem(LS_GH_TOKEN, token);
                localStorage.setItem(LS_GH_GIST_ID, gistId);

                // Initial pull so existing Gist data is not lost
                const loaded = await loadFromGist();
                if (loaded) renderAll();

                // Push current local data
                await syncToGist();

                showGhModalStatus('✅ Connected! Your progress is now syncing to GitHub.', 'ok');
                refreshGithubModalUI();
                showToast('✅ GitHub Sync connected!');
            } catch (err) {
                showGhModalStatus(`❌ ${err.message}`, 'error');
                console.error('[C1 Tracker] Connect error:', err);
            } finally {
                document.getElementById('btn-gh-connect').disabled = false;
            }
        });

        // Pull from GitHub
        document.getElementById('btn-gh-pull').addEventListener('click', async () => {
            showGhModalStatus('⬇ Pulling latest data from GitHub…', 'info');
            document.getElementById('btn-gh-pull').disabled = true;
            try {
                const loaded = await loadFromGist();
                if (loaded) {
                    renderAll();
                    showGhModalStatus('✅ Data pulled and updated!', 'ok');
                    showToast('⬇ Progress pulled from GitHub!');
                } else {
                    showGhModalStatus('⚠ No data found in Gist.', 'error');
                }
            } catch (err) {
                showGhModalStatus(`❌ ${err.message}`, 'error');
            } finally {
                document.getElementById('btn-gh-pull').disabled = false;
            }
        });

        // Disconnect
        document.getElementById('btn-gh-disconnect').addEventListener('click', () => {
            if (!confirm('Disconnect GitHub Sync? Your local data will not be deleted.')) return;
            localStorage.removeItem(LS_GH_TOKEN);
            localStorage.removeItem(LS_GH_GIST_ID);
            setSyncStatus('none');
            refreshGithubModalUI();
            showGhModalStatus('Disconnected from GitHub Sync.', 'info');
            showToast('Disconnected from GitHub Sync.');
        });
    }

    // ── Bootstrap ────────────────────────────────────────────
    async function init() {
        detectTimezone();
        registerServiceWorker();
        initEventListeners();
        renderAll();
        applyReminderSettings();
        applyEmailJSInit();

        // If GitHub sync is configured, pull latest data on startup
        if (ghToken() && ghGistId()) {
            try {
                const pulled = await loadFromGist();
                if (pulled) renderAll(); // re-render with potentially updated data
            } catch (e) {
                // Non-fatal: local data is still usable
                console.warn('[C1 Tracker] Startup Gist pull failed:', e);
            }
        }
    }

    // ── Service Worker registration ──────────────────────────
    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('./sw.js').catch((err) => {
            console.warn('[C1 Tracker] Service Worker registration failed:', err);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

}());
