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
    const LS_VOCABULARY  = 'c1t_vocabulary';
    const LS_UPDATED_AT  = 'c1t_updated_at';
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
        localStorage.setItem(LS_UPDATED_AT, new Date().toISOString());
        syncToGist();    // async – fire and forget
        syncToServer(); // async – fire and forget
    }

    function loadReminder() {
        try { return JSON.parse(localStorage.getItem(LS_REMINDER)) || {}; }
        catch { return {}; }
    }

    function saveReminder(cfg) {
        localStorage.setItem(LS_REMINDER, JSON.stringify(cfg));
    }

    // ── Vocabulary helpers ────────────────────────────────────
    function loadVocabulary() {
        try { return JSON.parse(localStorage.getItem(LS_VOCABULARY)) || []; }
        catch { return []; }
    }

    function saveVocabulary(vocab) {
        localStorage.setItem(LS_VOCABULARY, JSON.stringify(vocab));
        localStorage.setItem(LS_UPDATED_AT, new Date().toISOString());
        syncToGist();    // async – fire and forget
        syncToServer(); // async – fire and forget
    }

    function genId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    /** SM-2 spaced repetition algorithm.
     *  quality: 0 (forgot) | 1 (hard) | 2 (good) | 3 (easy)
     *  Returns updated word object.
     */
    function sm2Update(word, quality) {
        let { easeFactor = 2.5, interval = 1, repetitions = 0 } = word;

        if (quality < 2) {
            // Failed recall – restart
            repetitions = 0;
            interval = 1;
        } else {
            if (repetitions === 0)      interval = 1;
            else if (repetitions === 1) interval = 6;
            else                        interval = Math.round(interval * easeFactor);
            repetitions++;
        }

        // Update ease factor (EF)
        easeFactor = easeFactor + (0.1 - (3 - quality) * (0.08 + (3 - quality) * 0.02));
        if (easeFactor < 1.3) easeFactor = 1.3;

        const nextReview = new Date();
        nextReview.setDate(nextReview.getDate() + interval);

        return {
            ...word,
            easeFactor: Math.round(easeFactor * 1000) / 1000,
            interval,
            repetitions,
            nextReview: nextReview.toISOString().slice(0, 10),
            lastReviewed: todayStr(),
        };
    }

    /** Returns the learning state label for a word. */
    function wordState(word) {
        if (!word.repetitions || word.repetitions === 0) return 'new';
        if (word.repetitions <= 2) return 'learning';
        if ((word.interval || 1) > 21) return 'mastered';
        return 'review';
    }

    /** True if the word is due for review today. */
    function isDueToday(word) {
        if (!word.nextReview) return true;  // never reviewed
        return word.nextReview <= todayStr();
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

    // ── Skill radar chart ────────────────────────────────────
    const SKILL_COLORS = {
        Reading:   '#7c6eff',
        Listening: '#00e5b8',
        Speaking:  '#ff5e7e',
        Writing:   '#ffcc47',
    };

    function calcSkillMins(sessions) {
        const skills = { Reading: 0, Listening: 0, Speaking: 0, Writing: 0 };
        for (const s of sessions) {
            if (s.skill && skills[s.skill] !== undefined) {
                skills[s.skill] += s.duration || 0;
            }
        }
        return skills;
    }

    function renderSkillRadar(sessions) {
        const skills = calcSkillMins(sessions);
        const total  = Object.values(skills).reduce((a, b) => a + b, 0);

        const insightEl = document.getElementById('skill-insight');
        if (total === 0) {
            insightEl.textContent = 'Select a skill type when logging sessions to track your Reading, Listening, Speaking & Writing balance.';
        } else {
            const sorted = Object.entries(skills).sort((a, b) => a[1] - b[1]);
            const weakest  = sorted[0][0];
            const strongest = sorted[sorted.length - 1][0];
            insightEl.textContent = `Strongest: ${strongest} · Needs work: ${weakest}. Keep practising all four skills for balanced C1 progress!`;
        }

        // Draw canvas radar
        const canvas = document.getElementById('radarChart');
        const size   = canvas.offsetWidth || 260;
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, size, size);

        const cx = size / 2;
        const cy = size / 2;
        const maxR = size * 0.38;

        const labels = ['Reading', 'Writing', 'Speaking', 'Listening'];
        const angles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]; // top, right, bottom, left

        const maxMins = Math.max(...Object.values(skills), 60);

        // Draw grid rings
        for (let r = 1; r <= 4; r++) {
            ctx.beginPath();
            for (let i = 0; i < 4; i++) {
                const rad = (maxR / 4) * r;
                const x = cx + rad * Math.cos(angles[i]);
                const y = cy + rad * Math.sin(angles[i]);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.strokeStyle = 'rgba(46,53,84,.7)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Draw axes
        for (let i = 0; i < 4; i++) {
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + maxR * Math.cos(angles[i]), cy + maxR * Math.sin(angles[i]));
            ctx.strokeStyle = 'rgba(46,53,84,.7)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Draw data polygon
        if (total > 0) {
            ctx.beginPath();
            for (let i = 0; i < 4; i++) {
                const val = skills[labels[i]];
                const rad = (val / maxMins) * maxR;
                const x = cx + rad * Math.cos(angles[i]);
                const y = cy + rad * Math.sin(angles[i]);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fillStyle = 'rgba(124,110,255,.18)';
            ctx.fill();
            ctx.strokeStyle = '#7c6eff';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Dots
            for (let i = 0; i < 4; i++) {
                const val = skills[labels[i]];
                const rad = (val / maxMins) * maxR;
                const x = cx + rad * Math.cos(angles[i]);
                const y = cy + rad * Math.sin(angles[i]);
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fillStyle = SKILL_COLORS[labels[i]];
                ctx.fill();
            }
        }

        // Labels
        ctx.font = `600 ${Math.round(size * 0.05)}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const labelOffset = maxR * 1.2;
        const labelPairs = [
            ['Reading',   cx,                    cy - labelOffset],
            ['Writing',   cx + labelOffset,       cy],
            ['Speaking',  cx,                    cy + labelOffset],
            ['Listening', cx - labelOffset,       cy],
        ];
        for (const [label, lx, ly] of labelPairs) {
            ctx.fillStyle = SKILL_COLORS[label];
            ctx.fillText(label, lx, ly);
        }

        // Skill bars
        const barsEl = document.getElementById('skill-bars');
        barsEl.innerHTML = '';
        for (const label of labels) {
            const mins = skills[label];
            const pct  = total > 0 ? Math.round((mins / Math.max(...Object.values(skills), 1)) * 100) : 0;
            const color = SKILL_COLORS[label];
            barsEl.innerHTML += `
                <div class="skill-bar-item">
                    <span class="skill-bar-label">${label}</span>
                    <div class="skill-bar-track">
                        <div class="skill-bar-fill" style="width:${pct}%;background:${color}"></div>
                    </div>
                    <span class="skill-bar-value">${mins >= 60 ? formatDuration(mins) : mins + 'm'}</span>
                </div>`;
        }
    }

    // ── Smart daily plan ─────────────────────────────────────
    function renderSmartPlan(sessions, vocab) {
        const el = document.getElementById('plan-content');
        el.innerHTML = '';

        const dueWords  = vocab.filter(isDueToday);
        const newWords  = vocab.filter(w => !w.repetitions || w.repetitions === 0);
        const skills    = calcSkillMins(sessions);
        const totalSkill = Object.values(skills).reduce((a, b) => a + b, 0);

        // Find weakest skill (among those with any data; otherwise first)
        let weakSkill = 'Speaking';
        if (totalSkill > 0) {
            weakSkill = Object.entries(skills).sort((a, b) => a[1] - b[1])[0][0];
        }

        const reviewCount = dueWords.length;
        const newGoal     = Math.min(newWords.length, 10);
        const estMins     = reviewCount * 1 + newGoal * 2 + 20;

        const items = [];

        if (reviewCount > 0) {
            items.push({
                icon: '🔁',
                title: `Review ${reviewCount} word${reviewCount !== 1 ? 's' : ''} due today`,
                desc: 'Spaced repetition keeps vocabulary fresh. Click "Start Review" in the Review Queue below.',
                tag: `<span class="plan-tag plan-tag--review">SM-2</span>`,
            });
        }

        if (newGoal > 0) {
            items.push({
                icon: '📖',
                title: `Learn ${newGoal} new word${newGoal !== 1 ? 's' : ''}`,
                desc: 'Add new vocabulary from today\'s reading or listening. Aim for C1-level words.',
                tag: `<span class="plan-tag plan-tag--new">New</span>`,
            });
        }

        items.push({
            icon: skillEmoji(weakSkill),
            title: `Focus on ${weakSkill} today`,
            desc: `${weakSkill} is your weakest skill. Spend at least 20 minutes on targeted ${weakSkill.toLowerCase()} practice.`,
            tag: `<span class="plan-tag plan-tag--weak">Needs work</span>`,
        });

        items.push({
            icon: '⏱',
            title: `Estimated study time: ~${estMins} minutes`,
            desc: `${reviewCount} vocab reviews + ${newGoal} new words + 20 min skill practice = a complete C1 session.`,
            tag: `<span class="plan-tag plan-tag--time">Today's goal</span>`,
        });

        for (const item of items) {
            el.innerHTML += `
                <div class="plan-item">
                    <div class="plan-icon">${item.icon}</div>
                    <div class="plan-text">
                        <div class="plan-title">${item.title} ${item.tag}</div>
                        <div class="plan-desc">${item.desc}</div>
                    </div>
                </div>`;
        }
    }

    function skillEmoji(skill) {
        const map = { Reading: '📖', Listening: '🎧', Speaking: '🗣', Writing: '✍️' };
        return map[skill] || '🎯';
    }

    // ── Vocabulary Hub ───────────────────────────────────────
    let vocabSearch = '';
    let vocabFilterCat = '';
    let vocabFilterState = '';

    function renderVocabHub(vocab) {
        // Stats
        const statsEl = document.getElementById('vocab-stats');
        const counts = { new: 0, learning: 0, review: 0, mastered: 0 };
        let dueCount = 0;
        for (const w of vocab) {
            counts[wordState(w)]++;
            if (isDueToday(w)) dueCount++;
        }
        statsEl.innerHTML = `
            <span class="vocab-stat-pill vocab-stat-pill--new">🆕 New: ${counts.new}</span>
            <span class="vocab-stat-pill vocab-stat-pill--learning">📝 Learning: ${counts.learning}</span>
            <span class="vocab-stat-pill vocab-stat-pill--review">🔄 Review: ${counts.review}</span>
            <span class="vocab-stat-pill vocab-stat-pill--mastered">✅ Mastered: ${counts.mastered}</span>
            <span class="vocab-stat-pill vocab-stat-pill--due">📅 Due today: ${dueCount}</span>
        `;

        // Filter
        const q = vocabSearch.toLowerCase();
        let filtered = vocab.filter(w => {
            const matchSearch = !q ||
                w.word.toLowerCase().includes(q) ||
                (w.definition || '').toLowerCase().includes(q) ||
                (w.example || '').toLowerCase().includes(q);
            const matchCat   = !vocabFilterCat   || w.category === vocabFilterCat;
            const matchState = !vocabFilterState || wordState(w) === vocabFilterState;
            return matchSearch && matchCat && matchState;
        });

        // Sort: due first, then by word
        filtered.sort((a, b) => {
            const aDue = isDueToday(a) ? 0 : 1;
            const bDue = isDueToday(b) ? 0 : 1;
            if (aDue !== bDue) return aDue - bDue;
            return a.word.localeCompare(b.word);
        });

        const listEl  = document.getElementById('vocab-list');
        const emptyEl = document.getElementById('vocab-empty');
        listEl.innerHTML = '';

        if (!filtered.length) {
            emptyEl.style.display = 'block';
            return;
        }
        emptyEl.style.display = 'none';

        for (const w of filtered) {
            const state = wordState(w);
            const due   = isDueToday(w);
            const nextReviewLabel = w.nextReview
                ? (due ? '📅 Due today' : `Next: ${formatDate(w.nextReview)}`)
                : '🆕 Never reviewed';

            listEl.innerHTML += `
                <div class="vocab-card vocab-card--${state}" data-id="${w.id}">
                    <div class="vocab-card-header">
                        <div>
                            <div class="vocab-word">${escapeHtml(w.word)}</div>
                            <div class="vocab-category">${escapeHtml(w.category || '')}</div>
                        </div>
                        <div class="vocab-meta">
                            <span class="vocab-diff-badge diff-${w.difficulty || 'C1'}">${w.difficulty || 'C1'}</span>
                            <span class="vocab-state-badge state-${state}">${state}</span>
                        </div>
                    </div>
                    ${w.pronunciation ? `<div class="vocab-pronunciation">${escapeHtml(w.pronunciation)}</div>` : ''}
                    <div class="vocab-definition">${escapeHtml(w.definition || '')}</div>
                    ${w.example ? `<div class="vocab-example">"${escapeHtml(w.example)}"</div>` : ''}
                    <div class="vocab-card-footer">
                        <span class="vocab-next-review ${due ? 'vocab-next-review--due' : ''}">${nextReviewLabel}</span>
                        <div class="vocab-card-actions">
                            <button class="vocab-edit-btn" data-id="${w.id}" title="Edit">✏️</button>
                            <button class="vocab-delete-btn" data-id="${w.id}" title="Delete">🗑</button>
                        </div>
                    </div>
                </div>`;
        }
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Review Queue ─────────────────────────────────────────
    let reviewQueue    = [];
    let reviewIndex    = 0;
    let reviewRevealed = false;

    function renderReviewQueue(vocab) {
        const due     = vocab.filter(isDueToday);
        const total   = vocab.length;
        const mastered = vocab.filter(w => wordState(w) === 'mastered').length;

        const summaryEl = document.getElementById('review-queue-summary');
        summaryEl.innerHTML = `
            <div class="rq-stat">
                <span class="rq-stat-value">${due.length}</span>
                <span class="rq-stat-label">Due Today</span>
            </div>
            <div class="rq-divider"></div>
            <div class="rq-stat">
                <span class="rq-stat-value">${total}</span>
                <span class="rq-stat-label">Total Words</span>
            </div>
            <div class="rq-divider"></div>
            <div class="rq-stat">
                <span class="rq-stat-value">${mastered}</span>
                <span class="rq-stat-label">Mastered</span>
            </div>
            ${due.length > 0
                ? `<button class="btn btn-primary rq-start-btn" id="btn-start-review">▶ Start Review (${due.length})</button>`
                : `<span class="rq-stat rq-start-btn" style="color:var(--accent2);font-weight:700;font-size:.87rem">✅ All caught up for today!</span>`}
        `;

        // Re-attach start button listener
        const startBtn = document.getElementById('btn-start-review');
        if (startBtn) {
            startBtn.addEventListener('click', () => startReviewSession(due));
        }
    }

    function startReviewSession(queue) {
        reviewQueue    = [...queue].sort(() => Math.random() - 0.5);
        reviewIndex    = 0;
        reviewRevealed = false;
        document.getElementById('review-flashcard').style.display = 'block';
        showFlashcard();
    }

    function showFlashcard() {
        if (reviewIndex >= reviewQueue.length) {
            // Session complete
            document.getElementById('review-flashcard').innerHTML = `
                <div class="fc-complete">
                    <div class="fc-complete-icon">🎉</div>
                    <div class="fc-complete-title">Review Complete!</div>
                    <div class="fc-complete-desc">
                        You reviewed ${reviewQueue.length} word${reviewQueue.length !== 1 ? 's' : ''} today.<br>
                        Great work — your vocabulary is getting stronger!
                    </div>
                </div>`;
            showToast(`✅ Review session complete! ${reviewQueue.length} words reviewed.`);
            renderReviewQueue(loadVocabulary());
            return;
        }

        const word = reviewQueue[reviewIndex];
        reviewRevealed = false;

        const pct = reviewIndex / reviewQueue.length * 100;
        document.getElementById('fc-progress-text').textContent = `${reviewIndex + 1} / ${reviewQueue.length}`;
        document.getElementById('fc-progress-fill').style.width = pct + '%';

        document.getElementById('fc-word').textContent       = word.word;
        document.getElementById('fc-category').textContent   = `${word.category || ''} · ${word.difficulty || 'C1'}`;
        document.getElementById('fc-definition').textContent = word.definition || '';
        document.getElementById('fc-example').textContent    = word.example ? `"${word.example}"` : '';
        document.getElementById('fc-pronunciation').textContent = word.pronunciation || '';

        document.getElementById('fc-definition').style.display    = 'none';
        document.getElementById('fc-example').style.display       = 'none';
        document.getElementById('fc-pronunciation').style.display = 'none';
        document.getElementById('fc-reveal-hint').style.display   = 'block';
        document.getElementById('fc-actions').style.display       = 'none';
    }

    function revealFlashcard() {
        if (reviewRevealed) return;
        reviewRevealed = true;

        const word = reviewQueue[reviewIndex];
        document.getElementById('fc-reveal-hint').style.display   = 'none';
        document.getElementById('fc-definition').style.display    = 'block';
        if (word.example)       document.getElementById('fc-example').style.display       = 'block';
        if (word.pronunciation) document.getElementById('fc-pronunciation').style.display = 'block';
        document.getElementById('fc-actions').style.display = 'flex';
    }

    function handleReviewResponse(quality) {
        const vocab  = loadVocabulary();
        const word   = reviewQueue[reviewIndex];
        const idx    = vocab.findIndex(w => w.id === word.id);
        if (idx !== -1) {
            vocab[idx] = sm2Update(vocab[idx], quality);
            saveVocabulary(vocab);
        }
        reviewIndex++;
        showFlashcard();
    }

    // ── Full render ──────────────────────────────────────────
    function renderAll() {
        const sessions = loadSessions();
        const vocab    = loadVocabulary();
        updateStats(sessions);
        updateLevelUI(sessions);
        renderStreakCalendar(sessions);
        renderTodChart(sessions);
        renderBadges(sessions);
        renderCourseMap(sessions);
        renderLeaderboard(sessions);
        renderLogTable(sessions);
        renderSkillRadar(sessions);
        renderSmartPlan(sessions, vocab);
        renderVocabHub(vocab);
        renderReviewQueue(vocab);
    }

    // ── Log session ──────────────────────────────────────────
    function logSession(data) {
        const sessions = loadSessions();
        sessions.push({
            id:       Date.now() + Math.random(),
            date:     data.date,
            time:     data.time,
            topic:    data.topic,
            skill:    data.skill || 'General',
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
            if (Notification.permission === 'granted') {
                new Notification('C1 English Tracker 📚', {
                    body: `Time to study! Your scheduled session is due. Keep your ${
                        calcStreaks(loadSessions()).current}-day streak alive! 🔥`,
                    icon: '',
                });
            }
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
            if (Notification.permission === 'granted') {
                new Notification('📊 Weekly Study Summary', {
                    body: `This week: ${wkSessions.length} sessions, ${(wkMins / 60).toFixed(1)} hours. ${
                        calcStreaks(sessions).current > 0 ? `🔥 ${calcStreaks(sessions).current}-day streak!` : 'Start a new streak tomorrow!'}`,
                });
            }
            scheduleWeeklySummary();
        }, msUntil);
    }

    function applyReminderSettings() {
        const cfg = loadReminder();
        if (cfg.enabled && cfg.time) scheduleReminder(cfg);
        if (cfg.weekly) scheduleWeeklySummary();
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

    // ── Server-side data sync ─────────────────────────────────
    async function syncToServer() {
        try {
            const sessions   = loadSessions();
            const vocabulary = loadVocabulary();
            const payload    = { sessions, vocabulary, version: 3, updatedAt: new Date().toISOString() };
            const res = await fetch('/api/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) throw new Error(`Server sync failed ${res.status}`);
        } catch (err) {
            // Non-fatal – local data is still usable
            console.warn('[C1 Tracker] Server sync error:', err);
        }
    }

    async function loadFromServer() {
        try {
            const res = await fetch('/api/data');
            if (!res.ok) throw new Error(`Server load failed ${res.status}`);
            const data = await res.json();
            if (!Array.isArray(data.sessions) && !Array.isArray(data.vocabulary)) return false;

            // Use the server data only when it is newer than what is in localStorage.
            // This ensures intentional local changes (e.g. deletions) are not overwritten
            // by a stale server copy when the previous sync failed.
            const serverTime = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
            const localTime  = localStorage.getItem(LS_UPDATED_AT)
                ? new Date(localStorage.getItem(LS_UPDATED_AT)).getTime()
                : 0;

            if (serverTime >= localTime) {
                if (Array.isArray(data.sessions)) {
                    localStorage.setItem(LS_SESSIONS, JSON.stringify(data.sessions));
                }
                if (Array.isArray(data.vocabulary)) {
                    localStorage.setItem(LS_VOCABULARY, JSON.stringify(data.vocabulary));
                }
                return true;
            }
            return false;
        } catch (err) {
            // Non-fatal – could be running as a plain static file (no server)
            console.warn('[C1 Tracker] Server load error:', err);
            return false;
        }
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
            const sessions    = loadSessions();
            const vocabulary  = loadVocabulary();
            const payload     = { sessions, vocabulary, version: 3, updatedAt: new Date().toISOString() };
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
            if (Array.isArray(data.vocabulary)) {
                const localVocab = loadVocabulary();
                if (data.vocabulary.length >= localVocab.length) {
                    localStorage.setItem(LS_VOCABULARY, JSON.stringify(data.vocabulary));
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
            version: 2,
            exportedAt: new Date().toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            sessions:   loadSessions(),
            vocabulary: loadVocabulary(),
            reminder:   loadReminder(),
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
                if (Array.isArray(data.vocabulary)) saveVocabulary(data.vocabulary);
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
            const skill    = document.getElementById('skill-select').value;
            const duration = parseInt(document.getElementById('session-duration').value, 10);
            const date     = document.getElementById('session-date').value;
            const time     = document.getElementById('session-time').value;
            const notes    = document.getElementById('session-notes').value.trim();

            if (!topic || !duration || duration < 1 || !date) {
                showToast('❗ Please fill in topic, duration and date.'); return;
            }
            logSession({ topic, skill, duration, date, time, notes });

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
            document.getElementById('reminder-modal').style.display = 'flex';
        });
        document.getElementById('btn-close-reminder').addEventListener('click', () => {
            document.getElementById('reminder-modal').style.display = 'none';
        });
        document.getElementById('reminder-modal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('reminder-modal'))
                document.getElementById('reminder-modal').style.display = 'none';
        });

        document.getElementById('reminder-smart').addEventListener('change', function () {
            if (this.checked) {
                const sessions = loadSessions();
                const hr = getBestStudyHour(sessions);
                document.getElementById('reminder-time').value =
                    `${String(hr).padStart(2, '0')}:00`;
            }
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

            document.getElementById('reminder-status').textContent =
                `✅ Reminder set for ${time} daily${weekly ? ' + weekly summary' : ''}.`;

            setTimeout(() => {
                document.getElementById('reminder-modal').style.display = 'none';
            }, 1500);
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

        // ── Vocabulary Hub ────────────────────────────────
        // Filters
        document.getElementById('vocab-search').addEventListener('input', (e) => {
            vocabSearch = e.target.value;
            renderVocabHub(loadVocabulary());
        });
        document.getElementById('vocab-filter-cat').addEventListener('change', (e) => {
            vocabFilterCat = e.target.value;
            renderVocabHub(loadVocabulary());
        });
        document.getElementById('vocab-filter-state').addEventListener('change', (e) => {
            vocabFilterState = e.target.value;
            renderVocabHub(loadVocabulary());
        });

        // Edit / delete via event delegation on vocab-list
        document.getElementById('vocab-list').addEventListener('click', (e) => {
            const editBtn   = e.target.closest('.vocab-edit-btn');
            const deleteBtn = e.target.closest('.vocab-delete-btn');

            if (editBtn) {
                const id = editBtn.dataset.id;
                const vocab = loadVocabulary();
                const word  = vocab.find(w => w.id === id);
                if (word) openWordModal(word);
            } else if (deleteBtn) {
                const id = deleteBtn.dataset.id;
                if (!confirm('Delete this word? This cannot be undone.')) return;
                const vocab = loadVocabulary().filter(w => w.id !== id);
                saveVocabulary(vocab);
                const v2 = loadVocabulary();
                renderVocabHub(v2);
                renderReviewQueue(v2);
                renderSmartPlan(loadSessions(), v2);
                showToast('🗑 Word deleted.');
            }
        });

        // Add word button
        document.getElementById('btn-add-word').addEventListener('click', () => openWordModal(null));

        // Word modal save
        document.getElementById('btn-save-word').addEventListener('click', saveWord);

        // Word modal close
        function closeWordModal() {
            document.getElementById('word-modal').style.display = 'none';
        }
        document.getElementById('btn-close-word').addEventListener('click', closeWordModal);
        document.getElementById('btn-close-word-x').addEventListener('click', closeWordModal);
        document.getElementById('word-modal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('word-modal')) closeWordModal();
        });

        // ── Flashcard review ──────────────────────────────
        document.getElementById('fc-card').addEventListener('click', revealFlashcard);
        document.getElementById('fc-btn-forgot').addEventListener('click', () => handleReviewResponse(0));
        document.getElementById('fc-btn-hard').addEventListener('click',   () => handleReviewResponse(1));
        document.getElementById('fc-btn-good').addEventListener('click',   () => handleReviewResponse(2));
        document.getElementById('fc-btn-easy').addEventListener('click',   () => handleReviewResponse(3));

        // Keyboard shortcuts for review
        document.addEventListener('keydown', (e) => {
            const fc = document.getElementById('review-flashcard');
            if (!fc || fc.style.display === 'none') return;
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                if (!reviewRevealed) revealFlashcard();
            } else if (e.key === '1') handleReviewResponse(0);
            else if (e.key === '2') handleReviewResponse(1);
            else if (e.key === '3') handleReviewResponse(2);
            else if (e.key === '4') handleReviewResponse(3);
        });
    }

    // ── Word modal helpers ────────────────────────────────────
    function openWordModal(word) {
        const modal = document.getElementById('word-modal');
        document.getElementById('word-modal-title').textContent = word ? '✏️ Edit Word' : '📖 Add New Word';
        document.getElementById('word-input').value       = word ? word.word         : '';
        document.getElementById('word-difficulty').value  = word ? (word.difficulty || 'C1') : 'C1';
        document.getElementById('word-category').value    = word ? (word.category    || 'Advanced Vocabulary') : 'Advanced Vocabulary';
        document.getElementById('word-pronunciation').value = word ? (word.pronunciation || '') : '';
        document.getElementById('word-definition').value  = word ? (word.definition  || '') : '';
        document.getElementById('word-example').value     = word ? (word.example     || '') : '';
        document.getElementById('word-edit-id').value     = word ? word.id : '';
        modal.style.display = 'flex';
        document.getElementById('word-input').focus();
    }

    function saveWord() {
        const wordText    = document.getElementById('word-input').value.trim();
        const definition  = document.getElementById('word-definition').value.trim();
        if (!wordText || !definition) {
            showToast('❗ Word and definition are required.'); return;
        }

        const difficulty    = document.getElementById('word-difficulty').value;
        const category      = document.getElementById('word-category').value;
        const pronunciation = document.getElementById('word-pronunciation').value.trim();
        const example       = document.getElementById('word-example').value.trim();
        const editId        = document.getElementById('word-edit-id').value;

        const vocab = loadVocabulary();
        if (editId) {
            // Edit existing
            const idx = vocab.findIndex(w => w.id === editId);
            if (idx !== -1) {
                vocab[idx] = { ...vocab[idx], word: wordText, definition, example, pronunciation, difficulty, category };
            }
        } else {
            // Add new
            vocab.push({
                id: genId(),
                word: wordText,
                definition,
                example,
                pronunciation,
                difficulty,
                category,
                easeFactor:   2.5,
                interval:     1,
                repetitions:  0,
                nextReview:   todayStr(),
                lastReviewed: null,
                createdAt:    todayStr(),
            });
        }

        saveVocabulary(vocab);
        document.getElementById('word-modal').style.display = 'none';
        const v2 = loadVocabulary();
        renderVocabHub(v2);
        renderReviewQueue(v2);
        renderSmartPlan(loadSessions(), v2);
        showToast(editId ? '✅ Word updated!' : `✅ "${wordText}" added to vocabulary!`);
    }


    async function init() {
        detectTimezone();
        initEventListeners();
        renderAll();
        applyReminderSettings();

        // Pull latest data from the server on startup (if running with a backend)
        try {
            const pulledFromServer = await loadFromServer();
            if (pulledFromServer) renderAll();
        } catch (e) {
            // Non-fatal: could be a plain static deployment with no server
            console.warn('[C1 Tracker] Startup server pull failed:', e);
        }

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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

}());
