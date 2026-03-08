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
    const LS_USER_NAME   = 'c1t_user_name';
    const LS_ACCENT      = 'c1t_accent';
    const LS_LAST_BADGE_COUNT       = 'c1t_last_badge_count';
    const LS_LAST_VOCAB_MILESTONE   = 'c1t_last_vocab_milestone';
    const GIST_FILENAME             = 'c1-english-tracker-data.json';

    // ── Configurable constants ───────────────────────────────
    const DEFAULT_ACCENT              = 'purple';
    const WORD_ROTATION_INTERVAL_MS   = 10000;   // rotate word every 10 seconds
    const CONFETTI_STAGGER_MS         = 500;      // max stagger delay for confetti particles
    const SESSION_SHORT_THRESHOLD     = 10;       // ≤10 min → "every minute counts" toast
    const SESSION_LONG_THRESHOLD      = 45;       // ≥45 min → "champion" toast
    const TOPIC_COMPLETION_THRESHOLD  = 60;       // minutes to mark a topic as done

    // ── Module-scoped timeout IDs (avoid polluting window) ───
    let reminderTimeoutId = null;
    let weeklySummaryTimeoutId = null;
    let rotatingWordInterval = null;

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
    function showToast(msg, duration = 3500, type = '') {
        const el = document.getElementById('toast');
        el.textContent = msg;
        el.className = 'toast' + (type ? ' toast-' + type : '');
        el.style.display = 'block';
        el.style.opacity = '1';
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => { el.style.display = 'none'; el.style.opacity = '1'; }, 300);
        }, duration);
    }

    // ── Time-based greeting ───────────────────────────────────
    function getTimeGreeting() {
        const hour = new Date().getHours();
        const name = localStorage.getItem(LS_USER_NAME) || '';
        const namePart = name ? `, ${name}` : '';
        if (hour >= 5  && hour < 12) return `🌅 Morning focus${namePart}! Ready to level up?`;
        if (hour >= 12 && hour < 18) return `☀️ Afternoon session${namePart} — you've got this!`;
        if (hour >= 18 && hour < 22) return `🌆 Evening study${namePart} — dedication pays off!`;
        return `🌙 Night owl${namePart} — C1 awaits!`;
    }

    function updateGreeting(streakCurrent) {
        const el = document.getElementById('time-greeting');
        if (!el) return;
        let html = `<span>${getTimeGreeting()}</span>`;
        // Streak approaching milestone hint - derive from STREAK_MILESTONES
        for (const m of Object.keys(STREAK_MILESTONES).map(Number).sort((a, b) => a - b)) {
            if (streakCurrent === m - 1) {
                html += `<span class="greeting-streak-hint">🔥 One more day for a ${m}-day streak!</span>`;
                break;
            }
        }
        el.innerHTML = html;
    }

    // ── Confetti ─────────────────────────────────────────────
    function triggerConfetti(count = 60) {
        const container = document.getElementById('confetti-container');
        if (!container) return;
        const colors = ['#7c6eff','#00e5b8','#ff4d6d','#ffcc47','#38bdf8','#a78bfa','#ff8c42'];
        const W = window.innerWidth;
        const H = window.innerHeight;

        for (let i = 0; i < count; i++) {
            const p = document.createElement('div');
            p.className = 'confetti-particle';
            const size = 5 + Math.random() * 8;
            const isCircle = Math.random() > 0.5;
            p.style.cssText = [
                `width:${size}px`,
                `height:${size}px`,
                `background:${colors[Math.floor(Math.random() * colors.length)]}`,
                `border-radius:${isCircle ? '50%' : '2px'}`,
                `left:${20 + Math.random() * 60}%`,
                `top:0`,
                `position:absolute`,
            ].join(';');
            container.appendChild(p);

            const startX = (0.2 + Math.random() * 0.6) * W;
            let posX   = startX;
            let posY   = -10;
            let velX   = (Math.random() - 0.5) * 6;
            let velY   = -(5 + Math.random() * 8);
            let alpha  = 1;
            let rot    = Math.random() * 360;
            let rotV   = (Math.random() - 0.5) * 12;
            let frame  = 0;

            function animate() {
                frame++;
                velY += 0.25;
                velX *= 0.99;
                posX  += velX;
                posY  += velY;
                rot   += rotV;
                alpha -= 0.012;
                if (alpha <= 0 || posY > H + 20 || frame > 200) { p.remove(); return; }
                p.style.transform = `translate(${posX - startX}px, ${posY}px) rotate(${rot}deg)`;
                p.style.opacity   = alpha;
                requestAnimationFrame(animate);
            }
            setTimeout(() => requestAnimationFrame(animate), Math.random() * CONFETTI_STAGGER_MS);
        }
    }

    // ── Milestone celebration ─────────────────────────────────
    const STREAK_MILESTONES = {
        7:  { icon: '🎊', title: 'Week Warrior!',    desc: '7 consecutive days of studying — incredible consistency!' },
        14: { icon: '🏆', title: 'Two-Week Master!', desc: '14 days straight! You\'re building a real C1 habit.' },
        30: { icon: '🎇', title: 'Monthly Legend!',  desc: '30 days — a whole month of dedicated study! Extraordinary!' },
        60: { icon: '🌟', title: '2 Months Strong!', desc: '60 days without stopping. You are an absolute champion!' },
        90: { icon: '🏅', title: 'C1 Warrior!',      desc: '90 days! This level of commitment will get you to C1. Epic!' },
    };

    function showMilestoneCelebration(streak) {
        const def = STREAK_MILESTONES[streak];
        if (!def) return;
        const overlay = document.getElementById('milestone-overlay');
        if (!overlay) return;
        document.getElementById('milestone-icon').textContent  = def.icon;
        document.getElementById('milestone-title').textContent = def.title;
        document.getElementById('milestone-desc').textContent  = def.desc;
        overlay.style.display = 'flex';
        triggerConfetti(120);
    }

    // ── Count-up animation ────────────────────────────────────
    function animateCountUp(el, targetStr, duration = 900) {
        if (!el) return;
        const target = parseFloat(targetStr);
        if (isNaN(target) || target === 0) { el.textContent = targetStr; return; }
        const isFloat  = targetStr.includes('.');
        const decimals = isFloat ? (targetStr.split('.')[1] || '').length : 0;
        const start = performance.now();
        el.classList.add('counting');

        function step(now) {
            const elapsed  = now - start;
            const progress = Math.min(elapsed / duration, 1);
            const eased    = 1 - Math.pow(1 - progress, 3); // easeOutCubic
            const current  = target * eased;
            el.textContent = isFloat ? current.toFixed(decimals) : Math.floor(current).toString();
            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                el.textContent = targetStr;
                el.classList.remove('counting');
            }
        }
        requestAnimationFrame(step);
    }

    // ── Ripple effect on buttons ─────────────────────────────
    function addRipple(btn, e) {
        const rect   = btn.getBoundingClientRect();
        const size   = Math.max(rect.width, rect.height);
        const x      = (e.clientX - rect.left) - size / 2;
        const y      = (e.clientY - rect.top)  - size / 2;
        const ripple = document.createElement('span');
        ripple.className  = 'btn-ripple';
        ripple.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
        btn.appendChild(ripple);
        ripple.addEventListener('animationend', () => ripple.remove());
    }

    // ── Random word widget ────────────────────────────────────
    let rotatingWordIndex = 0;

    function renderRandomWord() {
        const section = document.getElementById('word-of-moment');
        if (!section) return;
        const vocab = loadVocabulary();
        if (!vocab.length) { section.style.display = 'none'; return; }
        section.style.display = '';

        const content = document.getElementById('rotating-word-content');
        if (!content) return;

        function showWord(idx) {
            const w = vocab[idx % vocab.length];
            const html = `
                <div class="rotating-word-text">${escapeHtml(w.word)}</div>
                <div class="rotating-word-category">${escapeHtml(w.category || '')} · ${w.difficulty || 'C1'}</div>
                <div class="rotating-word-def">${escapeHtml(w.definition || '')}</div>
            `;
            content.classList.remove('fade-in');
            content.classList.add('fade-out');
            setTimeout(() => {
                content.innerHTML = html;
                content.classList.remove('fade-out');
                content.classList.add('fade-in');
            }, 500);
        }

        showWord(rotatingWordIndex);

        clearInterval(rotatingWordInterval);
        rotatingWordInterval = setInterval(() => {
            rotatingWordIndex = (rotatingWordIndex + 1) % vocab.length;
            showWord(rotatingWordIndex);
        }, WORD_ROTATION_INTERVAL_MS);
    }

    // ── Accent colour picker ─────────────────────────────────
    function applyAccent(accent) {
        document.body.classList.remove('accent-blue', 'accent-green', 'accent-orange');
        if (accent && accent !== DEFAULT_ACCENT) {
            document.body.classList.add('accent-' + accent);
        }
        // Update active dot
        document.querySelectorAll('.accent-dot').forEach(dot => {
            dot.classList.toggle('active', dot.dataset.accent === accent);
        });
        localStorage.setItem(LS_ACCENT, accent);
    }

    function initAccentColors() {
        const saved = localStorage.getItem(LS_ACCENT) || DEFAULT_ACCENT;
        applyAccent(saved);
        document.getElementById('accent-picker')?.addEventListener('click', (e) => {
            const dot = e.target.closest('.accent-dot');
            if (dot) applyAccent(dot.dataset.accent);
        });
    }

    // ── Name personalisation ─────────────────────────────────
    function updateNameDisplay() {
        const name = localStorage.getItem(LS_USER_NAME) || '';
        const el   = document.getElementById('user-name-display');
        if (el) el.textContent = name ? `👤 ${name}` : '👤 Set name';
    }

    function initNamePersonalization() {
        updateNameDisplay();

        const btnEdit   = document.getElementById('btn-edit-name');
        const editRow   = document.getElementById('name-edit-row');
        const nameInput = document.getElementById('name-input');
        const btnSave   = document.getElementById('btn-save-name');
        const btnCancel = document.getElementById('btn-cancel-name');

        if (!btnEdit) return;

        btnEdit.addEventListener('click', () => {
            nameInput.value = localStorage.getItem(LS_USER_NAME) || '';
            editRow.style.display = '';
            nameInput.focus();
        });

        function saveName() {
            const v = nameInput.value.trim();
            if (v) localStorage.setItem(LS_USER_NAME, v);
            else   localStorage.removeItem(LS_USER_NAME);
            editRow.style.display = 'none';
            updateNameDisplay();
            updateGreeting(calcStreaks(loadSessions()).current);
            showToast(v ? `👋 Hello, ${v}!` : 'Name cleared.', 2500, 'success');
        }

        btnSave.addEventListener('click', saveName);
        btnCancel.addEventListener('click', () => { editRow.style.display = 'none'; });
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveName();
            if (e.key === 'Escape') { editRow.style.display = 'none'; }
        });
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
        animateCountUp(document.getElementById('stat-total-hours'), (totalMins / 60).toFixed(1));
        animateCountUp(document.getElementById('stat-sessions'), sessions.length.toString());

        const { current, best } = calcStreaks(sessions);
        animateCountUp(document.getElementById('stat-best-streak'), best.toString());
        animateCountUp(document.getElementById('current-streak'), current.toString());

        // Streak flame animation
        const flame = document.getElementById('streak-flame');
        if (flame) flame.classList.toggle('streak-zero', current === 0);

        // This week
        const weekStart = getWeekLabel(todayStr());
        const weekMins = sessions
            .filter(s => getWeekLabel(s.date) === weekStart)
            .reduce((s, x) => s + (x.duration || 0), 0);
        animateCountUp(document.getElementById('stat-this-week'), (weekMins / 60).toFixed(1));
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

        // Badge progress hints for session-count and hour-count badges
        const totalMins   = sessions.reduce((a, x) => a + x.duration, 0);
        const totalHours  = totalMins / 60;
        const { best: bestStreak } = calcStreaks(sessions);

        function getProgress(def) {
            switch (def.id) {
                case 'first_session': return { done: sessions.length, goal: 1 };
                case 'streak_3':     return { done: bestStreak, goal: 3 };
                case 'streak_7':     return { done: bestStreak, goal: 7 };
                case 'streak_30':    return { done: bestStreak, goal: 30 };
                case 'one_hour':     return { done: sessions.filter(x => x.duration >= 60).length, goal: 1 };
                case 'ten_hours':    return { done: Math.floor(totalHours), goal: 10 };
                case 'fifty_hours':  return { done: Math.floor(totalHours), goal: 50 };
                default:             return null;
            }
        }

        const prevCount = parseInt(localStorage.getItem(LS_LAST_BADGE_COUNT) || '0', 10);

        for (const def of BADGE_DEFS) {
            const earned = def.check(sessions);
            const el = document.createElement('div');
            el.className = 'badge' + (earned ? ' earned' : ' locked');

            let extraHtml = '';
            if (!earned) {
                const prog = getProgress(def);
                if (prog && prog.goal > 0) {
                    const pct = Math.min(100, (prog.done / prog.goal) * 100);
                    const remaining = prog.goal - prog.done;
                    extraHtml = `
                        <span class="badge-progress">${remaining} more to go</span>
                        <div class="badge-progress-bar">
                            <div class="badge-progress-fill" style="width:${pct}%"></div>
                        </div>`;
                }
            }

            el.innerHTML = `
                <span class="badge-icon">${def.icon}</span>
                <span class="badge-name">${def.name}</span>
                <span class="badge-desc">${def.desc}</span>
                ${extraHtml}
            `;
            grid.appendChild(el);
            if (earned) el.title = 'Earned! ' + def.desc;
        }

        // Store new count for next comparison
        const newCount = BADGE_DEFS.filter(b => b.check(sessions)).length;
        localStorage.setItem(LS_LAST_BADGE_COUNT, newCount);
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
            const pct  = Math.min(100, (mins / Math.max(maxMins, 120)) * 100);
            const done = mins >= TOPIC_COMPLETION_THRESHOLD; // topic is "done" if at least 60 min studied
            list.innerHTML += `
                <div class="course-item${done ? ' course-item-done' : ''}">
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
        updateGreeting(calcStreaks(sessions).current);
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
        renderRandomWord();
    }

    // ── Log session ──────────────────────────────────────────
    function logSession(data) {
        const prevSessions = loadSessions();
        const prevStreak   = calcStreaks(prevSessions).current;
        const prevBadgeCount = BADGE_DEFS.filter(b => b.check(prevSessions)).length;

        prevSessions.push({
            id:       Date.now() + Math.random(),
            date:     data.date,
            time:     data.time,
            topic:    data.topic,
            skill:    data.skill || 'General',
            duration: data.duration,
            notes:    data.notes,
        });
        saveSessions(prevSessions);
        const sessions = loadSessions(); // reload after save

        // Check for new badges
        const newBadgeCount = BADGE_DEFS.filter(b => b.check(sessions)).length;
        if (newBadgeCount > prevBadgeCount) {
            const newBadge = BADGE_DEFS.find(b => b.check(sessions) && !b.check(sessions.slice(0, -1)));
            if (newBadge) {
                setTimeout(() => {
                    showToast(`🏅 New achievement unlocked: "${newBadge.name}"!`, 5000, 'milestone');
                    // Animate the badge element
                    const badgeEls = document.querySelectorAll('.badge.earned');
                    if (badgeEls.length > 0) {
                        const lastEarned = Array.from(badgeEls).find(
                            el => el.querySelector('.badge-name')?.textContent === newBadge.name
                        );
                        if (lastEarned) lastEarned.classList.add('newly-earned');
                    }
                    triggerConfetti(60);
                }, 400);
            }
        }

        // Check for streak milestones
        const newStreak = calcStreaks(sessions).current;
        if (STREAK_MILESTONES[newStreak] && newStreak > prevStreak) {
            setTimeout(() => showMilestoneCelebration(newStreak), 600);
        }

        // Check vocabulary milestone (every 10 words)
        const vocab = loadVocabulary();
        const vocabCount = vocab.length;
        const lastMilestone = parseInt(localStorage.getItem(LS_LAST_VOCAB_MILESTONE) || '0', 10);
        const nextMilestone = Math.floor(vocabCount / 10) * 10;
        if (nextMilestone > 0 && nextMilestone > lastMilestone && vocabCount >= nextMilestone) {
            localStorage.setItem(LS_LAST_VOCAB_MILESTONE, nextMilestone);
            setTimeout(() => {
                showToast(`📖 Word Collector! You've got ${nextMilestone}+ words in your vocabulary hub! 🎉`, 5000, 'milestone');
            }, 1200);
        }

        renderAll();

        // Contextual toast message
        const dur = data.duration;
        const isNewStreak = newStreak > 0 && newStreak > prevStreak && data.date === todayStr();
        let toastMsg;
        if (dur >= SESSION_LONG_THRESHOLD) {
            toastMsg = `🏆 Champion! That's a solid ${dur}-minute session!`;
        } else if (dur <= SESSION_SHORT_THRESHOLD) {
            toastMsg = `✅ Perfect! Every minute counts — +${dur} min toward C1!`;
        } else {
            toastMsg = `🎯 Great job! +${dur} min toward C1!`;
        }
        if (isNewStreak && newStreak > 1) {
            toastMsg = `🔥 New streak! ${newStreak} days strong!`;
        }
        showToast(toastMsg, 3500, 'success');
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

        // Log session – with ripple effect
        const btnLog = document.getElementById('btn-log-session');
        btnLog.addEventListener('click', (e) => {
            addRipple(btnLog, e);
            const topic    = document.getElementById('topic-select').value;
            const skill    = document.getElementById('skill-select').value;
            const duration = parseInt(document.getElementById('session-duration').value, 10);
            const date     = document.getElementById('session-date').value;
            const time     = document.getElementById('session-time').value;
            const notes    = document.getElementById('session-notes').value.trim();

            if (!topic || !duration || duration < 1 || !date) {
                showToast('❗ Please fill in topic, duration and date.', 3000, 'error'); return;
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

        // Milestone overlay close
        const milestoneOverlay = document.getElementById('milestone-overlay');
        if (milestoneOverlay) {
            document.getElementById('btn-close-milestone')?.addEventListener('click', () => {
                milestoneOverlay.style.display = 'none';
            });
            milestoneOverlay.addEventListener('click', (e) => {
                if (e.target === milestoneOverlay) milestoneOverlay.style.display = 'none';
            });
        }

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
        renderRandomWord();

        // Vocabulary milestone check
        const vocabCount = v2.length;
        const lastMilestone = parseInt(localStorage.getItem(LS_LAST_VOCAB_MILESTONE) || '0', 10);
        const nextMilestone = Math.floor(vocabCount / 10) * 10;
        if (nextMilestone > 0 && nextMilestone > lastMilestone && vocabCount >= nextMilestone) {
            localStorage.setItem(LS_LAST_VOCAB_MILESTONE, nextMilestone);
            showToast(`📖 Word Collector! ${nextMilestone} words in your hub! 🎉`, 5000, 'milestone');
            triggerConfetti(50);
        }

        showToast(editId ? '✅ Word updated!' : `✅ "${escapeHtml(wordText)}" added to vocabulary!`, 3000, 'success');
    }


    async function init() {
        detectTimezone();
        initAccentColors();
        initNamePersonalization();
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

    // ── Scroll-reveal for cards ───────────────────────────────
    (function () {
        if (!('IntersectionObserver' in window)) {
            // Fallback: just show everything immediately
            document.querySelectorAll('.card').forEach(el => el.classList.add('revealed'));
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry, i) => {
                if (entry.isIntersecting) {
                    // Stagger the animation slightly
                    setTimeout(() => entry.target.classList.add('revealed'), i * 60);
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

        document.querySelectorAll('.card').forEach(card => observer.observe(card));
    }());

}());
