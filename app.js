/* ============================================
   버티컬 배드민턴 매칭 시스템 v2
   ============================================
   매칭 규칙:
   1. 급수 차이 최소화 (비슷한 급수끼리 우선)
   2. 여자A 1명일 때: 남자 B~D와 3:1 매칭 허용
   3. 남복/여복 우선, 혼복 동적 조절
   4. 순수 대기자 기반 · 대기열 최대 2게임
   5. 8게임 이상 쉬지 않도록 강제 배정
   6. 같은 4명 조합 반복 방지 · 게임수 균등 (점수 기반)
   ============================================ */

const CONFIG = {
    SHEET_ID: '13a8PaYF_DtxtqjIx9ByWOMDZAZjIMJNXWjQP21RpM-U',
    SHEET_TAB: '참가자',
    GAME_LOG_TAB: '게임매칭',
    APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwpV9oleWJ8uLDD7u86k60sl6FyFeOQv0HwlygbhqUp7F6OSNsk9E58b79C10Of-q3Z/exec',
    DEFAULT_COURTS: 3,
    LV: { A:5, B:4, C:3, D:2, E:1 },
    // 여자A 3:1 예외: 여자A 2명 미만일 때 남자 B~D와 3:1 허용
    FEMALE_A_31_MIN_MALE: 'B',  // 남자 최고급수 (A는 빡세니 B부터)
    FEMALE_A_31_MAX_MALE: 'D',  // 남자 최저급수
    MAX_REST: 8,
    // 자동 매칭 대기열 최대 게임 수
    MAX_QUEUE: 2,

    // 최소 N게임 이내 같은 4인 조합 반복 금지
    MIN_NO_REPEAT: 5,
    // 혼복 동적 패널티 기본값 (남복/여복 우선)
    MIXED_PENALTY_BASE: 60,
    // 혼복 목표 비율 (0.15 = 약 15%, 7게임 중 1게임)
    MIXED_TARGET_RATIO: 0.15,
    // 최대 게임수 차이 제한 (이 이상 차이나면 매칭 제외)
    MAX_GAME_DIFF: 2,
};

const S = {
    players: [],
    courts: [],
    queue: [],
    matchType: 'auto',
    selectedIds: [],
    sheetMembers: [],
    matchHistory: [],   // 과거 매칭 조합 기록 (Set of sorted id strings)
    gameTypeHistory: [], // 게임 타입 히스토리 (남복/여복/혼복 비율 추적)
    matchCounter: 0,    // 총 매칭 횟수 (비율 계산용)
    gameLog: [],        // 완료된 게임 기록 [{gameNum, type, court, teamA:[{name,level,gender}], teamB:[...], duration, time}]
    _cid:0, _pid:0, _gid:0,
    timers: {},
};

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const genId = p => `${p}_${++S[`_${p[0]}id`]}`;
const lvVal = lv => CONFIG.LV[lv] || 0;



/**
 * 여자A 3:1 예외 체크
 * 조건: 여자A가 전체에서 2명 미만 + 남3여1 구성 + 여자가 A급 + 남자가 B~D 범위
 */
function isFemaleA31Exception(four) {
    const males = four.filter(p => p.gender === '남');
    const females = four.filter(p => p.gender === '여');
    
    // 3:1 구성인지 (남3여1)
    if (males.length !== 3 || females.length !== 1) return false;
    
    const female = females[0];
    // 여자가 A급인지
    if (female.level !== 'A') return false;
    
    // 전체 여자A가 2명 미만인지
    const totalFemaleA = S.players.filter(p => p.gender === '여' && p.level === 'A' && (p.status === 'waiting' || p.status === 'playing')).length;
    if (totalFemaleA >= 2) return false;
    
    // 남자 급수 범위 체크: B~D (A는 빡셈, E는 너무 차이남)
    const minMaleLv = CONFIG.LV[CONFIG.FEMALE_A_31_MIN_MALE]; // B=4
    const maxMaleLv = CONFIG.LV[CONFIG.FEMALE_A_31_MAX_MALE]; // D=2
    const allMalesInRange = males.every(p => {
        const lv = CONFIG.LV[p.level];
        return lv >= maxMaleLv && lv <= minMaleLv; // D(2) ~ B(4)
    });
    
    return allMalesInRange;
}



// ============ UTIL ============
function toast(msg, type='info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toastBox').appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

function fmtTime(sec) {
    return `${Math.floor(sec/60).toString().padStart(2,'0')}:${(sec%60).toString().padStart(2,'0')}`;
}

function updateDate() {
    const d = new Date(), days = ['일','월','화','수','목','금','토'];
    $('#currentDate').textContent = `${d.getFullYear()}.${(d.getMonth()+1).toString().padStart(2,'0')}.${d.getDate().toString().padStart(2,'0')} (${days[d.getDay()]})`;
}

function closeModal(id) { $(`#${id}`).classList.remove('show'); }

// 매칭 기록용 키 생성 (4명 id 정렬)
function matchKey(ids) { return [...ids].sort().join(','); }

// ============ GOOGLE SHEETS ============
function parseCSV(text) {
    const rows = [];
    for (const line of text.split('\n')) {
        let row = [], cell = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') { if (inQ && line[i+1] === '"') { cell += '"'; i++; } else inQ = !inQ; }
            else if (ch === ',' && !inQ) { row.push(cell.trim()); cell = ''; }
            else cell += ch;
        }
        row.push(cell.trim().replace(/\r$/, ''));
        if (row.some(c => c)) rows.push(row);
    }
    return rows;
}

async function fetchSheet() {
    // JSONP first (works on file://)
    for (const tab of [CONFIG.SHEET_TAB, '']) {
        try {
            const data = await fetchJSONP(tab);
            if (data?.length >= 2) return data;
        } catch {}
    }
    // Fallback: CSV fetch
    for (const url of [
        `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(CONFIG.SHEET_TAB)}`,
        `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:csv`,
        `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/export?format=csv`,
    ]) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const t = await res.text();
            if (t.startsWith('<!') || t.startsWith('<html')) continue;
            const p = parseCSV(t);
            if (p?.length >= 2) return p;
        } catch {}
    }
    toast('시트 불러오기 실패. 공유 설정 확인', 'err');
    return null;
}

function fetchJSONP(tab) {
    return new Promise((resolve, reject) => {
        const cb = '_cb_' + Date.now();
        const to = setTimeout(() => { delete window[cb]; sc.remove(); reject(new Error('timeout')); }, 8000);
        window[cb] = function(r) {
            clearTimeout(to); delete window[cb]; sc.remove();
            if (!r?.table) { reject(new Error('no table')); return; }
            const cols = r.table.cols.map(c => c.label || '');
            const rows = r.table.rows.map(row => row.c.map(c => (c?.v != null) ? String(c.v).trim() : ''));
            resolve(cols.some(c => c) ? [cols, ...rows] : rows);
        };
        let url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=responseHandler:${cb}`;
        if (tab) url += `&sheet=${encodeURIComponent(tab)}`;
        const sc = document.createElement('script');
        sc.src = url;
        sc.onerror = () => { clearTimeout(to); delete window[cb]; sc.remove(); reject(new Error('load fail')); };
        document.head.appendChild(sc);
    });
}

async function loadFromSheet() {
    $('#modalSheet').classList.add('show');
    const el = $('#sheetList');
    el.innerHTML = '<div class="loader"><div class="spin"></div><span>불러오는 중...</span></div>';
    const data = await fetchSheet();
    if (!data || data.length < 2) {
        el.innerHTML = '<div class="loader"><span>데이터를 불러올 수 없습니다.<br>시트 공유 설정을 확인하세요.</span></div>';
        return;
    }
    const members = data.slice(1).map(r => ({ name:(r[0]||'').trim(), gender:(r[1]||'').trim(), level:(r[2]||'C').trim().toUpperCase() })).filter(m => m.name && m.gender);
    // 가나다순 정렬
    members.sort((a,b) => a.name.localeCompare(b.name, 'ko'));
    S.sheetMembers = members;
    const existing = new Set(S.players.map(p => p.name));
    el.innerHTML = members.map((m,i) => `
        <div class="sheet-item ${existing.has(m.name)?'checked':''}" data-idx="${i}">
            <div class="cbox"></div>
            <span class="level-dot ${m.level}"></span>
            <span style="font-weight:700;font-size:.9rem;flex:1">${m.name}</span>
            <span class="pc-lv lv-${m.level}" style="font-size:.62rem;padding:1px 5px">${m.level}</span>
            <span style="font-size:.72rem;color:var(--txt3);font-weight:600">${m.gender}</span>
        </div>
    `).join('');
    el.querySelectorAll('.sheet-item').forEach(e => e.addEventListener('click', () => e.classList.toggle('checked')));
}

function confirmImport() {
    let count = 0;
    const existing = new Set(S.players.map(p => p.name));
    $$('#sheetList .sheet-item.checked').forEach(el => {
        const m = S.sheetMembers[+el.dataset.idx];
        if (m && !existing.has(m.name)) {
            S.players.push({ id:genId('player'), name:m.name, level:m.level, gender:m.gender, status:'waiting', gameCount:0, restCount:0, selected:false, shuttle:false });
            existing.add(m.name); count++;
        }
    });
    closeModal('modalSheet'); renderAll(); toast(`${count}명 추가됨`, 'ok');
}

// ============ ATTENDANCE ============
function showSaveModal() {
    const played = S.players.filter(p => p.gameCount > 0);
    if (!played.length) { toast('게임 참여 인원이 없습니다.', 'err'); return; }
    const d = new Date();
    const ds = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
    $('#saveDesc').textContent = `${ds} 참석 ${played.length}명의 출석을 저장합니다.`;
    $('#attChips').innerHTML = played.map(p => `<span class="att-chip">${p.name} (${p.gameCount}게임)</span>`).join('');
    $('#modalSave').classList.add('show');
}

async function confirmSave() {
    const played = S.players.filter(p => p.gameCount > 0);
    const d = new Date();
    const ds = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
    if (!CONFIG.APPS_SCRIPT_URL) {
        console.log('=== 출석 ===', ds);
        played.forEach(p => console.log(`${p.name}|${p.level}|${p.gender}|${p.gameCount}게임`));
        toast('Apps Script URL 미설정. 콘솔에 기록됨.', 'info');
    } else {
        try {
            await fetch(CONFIG.APPS_SCRIPT_URL, { method:'POST', mode:'no-cors', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'saveAttendance',date:ds,players:played.map(p=>({name:p.name,level:p.level,gender:p.gender,gameCount:p.gameCount}))}) });
            toast('출석 저장 완료!', 'ok');
        } catch { toast('저장 실패', 'err'); }
    }
    closeModal('modalSave');
}

// ============ COURTS ============
function initCourts() {
    for (let i = 1; i <= CONFIG.DEFAULT_COURTS; i++)
        S.courts.push({ id:genId('court'), name:`코트 ${i}`, game:null });
}

function addCourt() {
    const n = S.courts.length + 1;
    S.courts.push({ id:genId('court'), name:`코트 ${n}`, game:null });
    renderAll(); toast(`코트 ${n} 추가`, 'ok');
}

function removeCourt(cid) {
    const c = S.courts.find(x => x.id === cid);
    if (c?.game) { toast('게임중 코트는 삭제 불가', 'err'); return; }
    S.courts = S.courts.filter(x => x.id !== cid);
    if (S.timers[cid]) { clearInterval(S.timers[cid]); delete S.timers[cid]; }
    renderAll();
}

function startGame(cid) {
    const court = S.courts.find(x => x.id === cid);
    if (!court || court.game || !S.queue.length) return;

    // 대기열에서 시작 가능한 게임 찾기 (모든 선수가 playing이 아닌 게임)
    let gameIdx = -1;
    for (let i = 0; i < S.queue.length; i++) {
        const g = S.queue[i];
        const allReady = [...g.teamA, ...g.teamB].every(pid => {
            const p = S.players.find(x => x.id === pid);
            return p && p.status !== 'playing';
        });
        if (allReady) { gameIdx = i; break; }
    }

    if (gameIdx === -1) {
        toast('대기 게임의 선수가 아직 게임중입니다. 현재 게임을 먼저 종료하세요.', 'err');
        return;
    }

    // 해당 게임을 큐에서 꺼내기
    const g = S.queue.splice(gameIdx, 1)[0];
    court.game = { teamA:g.teamA, teamB:g.teamB, type:g.type, startTime:Date.now(), elapsed:0 };
    [...g.teamA,...g.teamB].forEach(pid => {
        const p = S.players.find(x => x.id === pid);
        if (p) { p.status = 'playing'; p.selected = false; }
    });
    S.selectedIds = S.selectedIds.filter(id => !g.teamA.includes(id) && !g.teamB.includes(id));
    S.timers[cid] = setInterval(() => {
        if (court.game) {
            court.game.elapsed = Math.floor((Date.now() - court.game.startTime) / 1000);
            const el = document.querySelector(`[data-timer="${cid}"]`);
            if (el) el.textContent = fmtTime(court.game.elapsed);
        }
    }, 1000);
    renderAll(); toast(`${court.name} 게임 시작!`, 'ok');
}

function endGame(cid) {
    const court = S.courts.find(x => x.id === cid);
    if (!court?.game) return;
    clearInterval(S.timers[cid]); delete S.timers[cid];

    const pInfo = pid => {
        const p = S.players.find(x => x.id === pid);
        return p ? { name:p.name, level:p.level, gender:p.gender } : { name:'?', level:'?', gender:'?' };
    };

    // 게임 기록 저장
    S.gameLog.push({
        gameNum: S.gameLog.length + 1,
        type: court.game.type,
        court: court.name,
        teamA: court.game.teamA.map(pInfo),
        teamB: court.game.teamB.map(pInfo),
        duration: court.game.elapsed,
        time: new Date().toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'}),
    });

    const playedIds = [...court.game.teamA, ...court.game.teamB];
    playedIds.forEach(pid => {
        const p = S.players.find(x => x.id === pid);
        if (p) { p.status = 'waiting'; p.gameCount++; p.restCount = 0; }
    });
    // 안 나간 사람 restCount++
    const playedSet = new Set(playedIds);
    S.players.forEach(p => {
        if (!playedSet.has(p.id) && (p.status === 'waiting')) p.restCount++;
    });
    court.game = null;
    renderAll(); toast(`${court.name} 게임 종료`, 'info');
}

/** 게임 취소 (삭제): 게임수 증가 없이 선수를 대기로 복귀 */
function cancelGame(cid) {
    const court = S.courts.find(x => x.id === cid);
    if (!court?.game) return;
    if (!confirm(`${court.name} 게임을 취소하시겠습니까?\n(게임수에 반영되지 않습니다)`)) return;
    clearInterval(S.timers[cid]); delete S.timers[cid];
    const playedIds = [...court.game.teamA, ...court.game.teamB];
    playedIds.forEach(pid => {
        const p = S.players.find(x => x.id === pid);
        if (p) { p.status = 'waiting'; }
    });
    court.game = null;
    renderAll(); toast(`${court.name} 게임 취소됨 (기록 미반영)`, 'info');
}

function autoAssign() {
    while (S.queue.length > 0) {
        const empty = S.courts.find(c => !c.game);
        if (!empty) break;
        startGame(empty.id);
    }
}

// ============ PLAYER MANAGEMENT ============
function addManual() {
    const name = $('#inpName').value.trim();
    if (!name) { toast('이름을 입력하세요', 'err'); return; }
    if (S.players.some(p => p.name === name)) { toast('이미 등록된 이름', 'err'); return; }
    S.players.push({ id:genId('player'), name, level:$('#inpLevel').value, gender:$('#inpGender').value, status:'waiting', gameCount:0, restCount:0, selected:false, shuttle:false });
    $('#inpName').value = '';
    closeModal('modalAdd'); renderAll(); toast(`${name} 추가됨`, 'ok');
}

function removePlayer(pid) {
    const p = S.players.find(x => x.id === pid);
    if (p?.status === 'playing') { toast('게임중 삭제 불가', 'err'); return; }
    S.players = S.players.filter(x => x.id !== pid);
    S.selectedIds = S.selectedIds.filter(x => x !== pid);
    renderAll();
}

function toggleShuttle(pid, evt) {
    evt.stopPropagation();
    const p = S.players.find(x => x.id === pid);
    if (!p) return;
    p.shuttle = !p.shuttle;
    renderPlayers();
    toast(`${p.name} 셔틀콕 ${p.shuttle ? '제출 ✅' : '미제출'}`, 'info');
}

function toggleSelect(pid) {
    const p = S.players.find(x => x.id === pid);
    if (!p || p.status === 'playing' || p.status === 'late') return;
    if (p.status === 'resting') p.status = 'waiting';
    p.selected = !p.selected;
    if (p.selected) S.selectedIds.push(pid);
    else S.selectedIds = S.selectedIds.filter(x => x !== pid);
    renderPlayers(); renderPreview();
}

function clearSelection() {
    S.selectedIds.forEach(id => { const p = S.players.find(x => x.id === id); if (p) p.selected = false; });
    S.selectedIds = [];
    renderPlayers(); renderPreview();
}

// ---- STATUS DROPDOWN ----
let dropdownTarget = null;
function showStatusDropdown(pid, evt) {
    evt.stopPropagation();
    const p = S.players.find(x => x.id === pid);
    if (!p || p.status === 'playing') return;
    dropdownTarget = pid;
    const dd = $('#statusDropdown');
    const rect = evt.target.getBoundingClientRect();
    dd.style.top = (rect.bottom + 4) + 'px';
    dd.style.left = Math.min(rect.left, window.innerWidth - 120) + 'px';
    dd.classList.add('show');
}

function changeStatus(newStatus) {
    if (!dropdownTarget) return;
    const p = S.players.find(x => x.id === dropdownTarget);
    if (p && p.status !== 'playing') {
        p.status = newStatus;
        if (newStatus === 'late' || newStatus === 'resting') {
            p.selected = false;
            S.selectedIds = S.selectedIds.filter(id => id !== p.id);
        }
        renderAll();
        toast(`${p.name} → ${newStatus === 'waiting' ? '대기' : newStatus === 'resting' ? '휴식' : '늦참'}`, 'info');
    }
    $('#statusDropdown').classList.remove('show');
    dropdownTarget = null;
}

/** select 드롭다운에서 직접 상태 변경 */
function changeStatusDirect(pid, newStatus) {
    const p = S.players.find(x => x.id === pid);
    if (!p || p.status === 'playing') return;
    p.status = newStatus;
    if (newStatus === 'late' || newStatus === 'resting') {
        p.selected = false;
        S.selectedIds = S.selectedIds.filter(id => id !== p.id);
    }
    renderAll();
    toast(`${p.name} → ${newStatus === 'waiting' ? '대기' : newStatus === 'resting' ? '휴식' : '늦참'}`, 'info');
}

// ============ MATCHING ENGINE ============
function isValidGender(players) {
    const m = players.filter(p => p.gender === '남').length;
    const f = players.filter(p => p.gender === '여').length;
    
    // 4:0 또는 2:2는 항상 OK
    if (m === 4 || f === 4 || (m === 2 && f === 2)) return true;
    
    // 3:1 → 기본적으로 금지, 단 여자A 예외
    if ((m === 3 && f === 1) || (m === 1 && f === 3)) {
        return isFemaleA31Exception(players);
    }
    
    return false;
}

function getGameType(players) {
    const m = players.filter(p => p.gender === '남').length;
    const f = players.filter(p => p.gender === '여').length;
    if (m === 4) return '남복';
    if (f === 4) return '여복';
    if (m === 2 && f === 2) return '혼복';
    if (m === 3 && f === 1) return '혼합'; // 여자A 3:1 예외
    return '혼합';
}

function bestSplit(four) {
    const combos = [[[0,1],[2,3]], [[0,2],[1,3]], [[0,3],[1,2]]];
    let best = null, bestDiff = Infinity;
    const type = getGameType(four);
    for (const [aI, bI] of combos) {
        const tA = aI.map(i => four[i]), tB = bI.map(i => four[i]);
        if (type === '혼복') {
            if (tA.filter(p => p.gender === '남').length !== 1) continue;
        }
        // 혼합(3:1): 여자가 한쪽 팀에 포함되도록
        if (type === '혼합') {
            const fInA = tA.filter(p => p.gender === '여').length;
            const fInB = tB.filter(p => p.gender === '여').length;
            if (fInA !== 1 && fInB !== 1) continue; // 여자가 한쪽에 1명
        }
        const diff = Math.abs(tA.reduce((s,p) => s+lvVal(p.level),0) - tB.reduce((s,p) => s+lvVal(p.level),0));
        if (diff < bestDiff) { bestDiff = diff; best = { teamA:tA, teamB:tB, diff }; }
    }
    return best || { teamA:[four[0],four[3]], teamB:[four[1],four[2]], diff:99 };
}

/** Fisher-Yates 셔플 */
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function sortPriority(arr) {
    // 먼저 셔플해서 동일 조건 내 무작위성 보장
    return shuffle(arr).sort((a,b) => {
        // 1) 오래 쉰 사람 우선
        if (b.restCount !== a.restCount) return b.restCount - a.restCount;
        // 2) 게임 적은 사람 우선
        if (a.gameCount !== b.gameCount) return a.gameCount - b.gameCount;
        return 0; // 동일 조건 → 셔플 순서 유지 (무작위)
    });
}

/**
 * 매칭 가능 인원:
 * - 코트에서 게임중인 인원 제외
 * - 대기열에 이미 있는 인원 제외
 * - late, resting 제외
 * → 순수하게 "아무것도 안 하고 있는" 대기자만
 */
function getAvailable() {
    // 대기열에 있는 인원
    const inQueue = new Set();
    S.queue.forEach(g => { g.teamA.forEach(id => inQueue.add(id)); g.teamB.forEach(id => inQueue.add(id)); });

    // 코트에서 게임중인 인원
    const inCourt = new Set();
    S.courts.forEach(c => {
        if (c.game) {
            c.game.teamA.forEach(id => inCourt.add(id));
            c.game.teamB.forEach(id => inCourt.add(id));
        }
    });

    return S.players.filter(p =>
        p.status === 'waiting' &&
        !inQueue.has(p.id) &&
        !inCourt.has(p.id)
    );
}

/**
 * 활성 플레이어(waiting/playing/대기열) 중 최소 게임수
 * late/resting 제외하여 공정한 기준
 */
function getMinGameCount() {
    const active = S.players.filter(p => p.status === 'waiting' || p.status === 'playing');
    if (active.length === 0) return 0;
    return Math.min(...active.map(p => p.gameCount));
}

/**
 * 매칭에 참여하지 않은 대기자 중 최대 restCount 확인
 * 8게임 이상 쉰 사람이 있으면 urgentPlayers 반환
 */
function getUrgentPlayers(pool) {
    return pool.filter(p => p.restCount >= CONFIG.MAX_REST);
}

// 게임수 균등: 강제 차단 대신 scoreCombo의 gameCountPenalty로 자연 조절
// filterByGameCount 제거 → 풀에서 빼지 않아 매칭 끊김 방지

/** 대기중인 사람만 */
function getWaitingOnly() {
    const inQueue = new Set();
    S.queue.forEach(g => { g.teamA.forEach(id => inQueue.add(id)); g.teamB.forEach(id => inQueue.add(id)); });

    return S.players.filter(p => p.status === 'waiting' && !inQueue.has(p.id));
}

/**
 * 파트너 히스토리: 두 사람이 같은 게임에 몇 번 있었는지
 */
function pairCount(id1, id2) {
    let count = 0;
    for (const key of S.matchHistory) {
        const ids = key.split(',');
        if (ids.includes(id1) && ids.includes(id2)) count++;
    }
    return count;
}

/**
 * 4명 조합의 "신선도" 점수 (낮을수록 새로운 조합)
 */
function comboFreshness(four) {
    let total = 0;
    for (let i = 0; i < four.length; i++) {
        for (let j = i+1; j < four.length; j++) {
            total += pairCount(four[i].id, four[j].id);
        }
    }
    return total;
}

function isNewCombo(ids) {
    return !S.matchHistory.includes(matchKey(ids));
}

/**
 * 최근 N게임 이내에 같은 4인 조합이 있었는지 체크
 * 있으면 몇 게임 전인지 반환 (없으면 -1)
 */
function recentRepeatDistance(four) {
    const key = matchKey(four.map(p => p.id));
    const recent = S.matchHistory.slice(-CONFIG.MIN_NO_REPEAT);
    for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i] === key) return recent.length - i; // 1 = 직전, 2 = 2게임전...
    }
    return -1;
}



/**
 * 동적 혼복 패널티 계산
 * 남녀 인원 비율 + 최근 게임 타입 비율을 종합 판단
 * 
 * 원리:
 * - 남녀 균등(1:1) → 혼복 패널티 높음 (남복/여복 위주)
 * - 남녀 불균형(예: 12:8) → 혼복 패널티 낮아짐 (소수 성별 기회 보장)
 * - 최근 혼복 비율이 목표 초과 → 패널티 추가 상승
 * - 최근 혼복 비율이 목표 미만 → 패널티 추가 감소
 */
function getDynamicMixedPenalty() {
    // 1) 현재 가용 인원의 남녀 비율 파악
    const available = getAvailable();
    const mCount = available.filter(p => p.gender === '남').length;
    const fCount = available.filter(p => p.gender === '여').length;
    const total = mCount + fCount;

    if (total < 4) return CONFIG.MIXED_PENALTY_BASE;

    // 남녀 균형도: 0(완전 균등) ~ 1(한쪽만)
    const genderImbalance = Math.abs(mCount - fCount) / total;
    // 소수 성별이 4명 미만이면 남복/여복 자체가 불가
    const minGender = Math.min(mCount, fCount);

    // 2) 남녀 비율 기반 기본 패널티 결정
    let basePenalty;
    if (minGender < 4) {
        // 소수 성별 4명 미만 → 혼복 필수 (패널티 없음)
        basePenalty = 0;
    } else if (genderImbalance > 0.4) {
        // 심한 불균형 (예: 14:6) → 혼복 패널티 매우 낮게
        basePenalty = CONFIG.MIXED_PENALTY_BASE * 0.2;
    } else if (genderImbalance > 0.2) {
        // 약간 불균형 (예: 12:8) → 혼복 패널티 낮게
        basePenalty = CONFIG.MIXED_PENALTY_BASE * 0.5;
    } else {
        // 균등 (예: 10:10) → 혼복 패널티 높게 (남복/여복 위주)
        basePenalty = CONFIG.MIXED_PENALTY_BASE;
    }

    // 3) 최근 게임 타입 비율로 보정
    const history = S.gameTypeHistory || [];
    if (history.length >= 3) {
        const recent = history.slice(-10);
        const mixedRatio = recent.filter(t => t === '혼복').length / recent.length;
        const targetRatio = CONFIG.MIXED_TARGET_RATIO;

        if (mixedRatio < targetRatio * 0.3) {
            basePenalty *= 0;     // 혼복 너무 적음 → 패널티 제거
        } else if (mixedRatio < targetRatio) {
            basePenalty *= 0.5;   // 목표 미만 → 절반
        } else if (mixedRatio > targetRatio * 2) {
            basePenalty *= 2;     // 목표 초과 → 2배
        }
        // 목표 근처면 basePenalty 그대로
    }

    return basePenalty;
}

/**
 * 점수 계산: 낮을수록 좋은 매칭
 * 랜덤 노이즈를 추가해 동일 점수 조합 간 무작위성 보장
 */
function scoreCombo(four) {
    // (0) 최근 N게임 이내 동일 4인 조합 → 매우 큰 패널티
    const repeatDist = recentRepeatDistance(four);
    let repeatPenalty = 0;
    if (repeatDist > 0) {
        repeatPenalty = Math.max(500, 10000 - repeatDist * 1500);
    }

    // (1) 모든 후보가 순수 대기자이므로 playing 패널티 불필요
    const playingPenalty = 0;

    // (2) 급수 차이: 차이가 작을수록 좋음
    const lvls = four.map(p => CONFIG.LV[p.level] || 3);
    const lvSpread = Math.max(...lvls) - Math.min(...lvls);
    const tierScore = lvSpread * 12; // 급수 차이 1당 12점

    // (3) 혼복 동적 패널티: 최근 비율에 따라 자동 조절
    const mCount = four.filter(p => p.gender === '남').length;
    const fCount = four.filter(p => p.gender === '여').length;
    const mixedPenalty = (mCount === 2 && fCount === 2) ? getDynamicMixedPenalty() : 0;

    // (4) urgent 보너스 (오래 쉰 사람 포함 시 강력 감점)
    //     restCount가 MAX_REST 이상이면 반드시 우선 배정
    const urgentInFour = four.filter(p => p.restCount >= CONFIG.MAX_REST);
    const urgentScore = -urgentInFour.length * 100;
    //     추가: 쉰 횟수에 비례한 보너스 (많이 쉴수록 우선)
    const restBonus = -four.reduce((sum, p) => sum + p.restCount * 3, 0);

    // (5) 신선도 (같이 한 적 적은 조합 우선)
    const freshness = comboFreshness(four);

    // (6) 게임수 균등: 게임 많이 한 사람 포함하면 패널티
    const minGC = getMinGameCount();
    const gameCountPenalty = four.reduce((sum, p) => {
        const diff = p.gameCount - minGC;
        return sum + diff * 20; // 1게임 차이당 20점
    }, 0);

    // (7) 랜덤 노이즈: 동일 점수 조합 간 무작위 선택 (0~8)
    const noise = Math.random() * 8;

    return repeatPenalty + playingPenalty + tierScore + mixedPenalty
         + freshness * 5 + urgentScore + restBonus + gameCountPenalty + noise;
}

/**
 * 풀에서 최적의 4명 찾기
 * 강제 포함 선수가 있으면 반드시 포함시킨 상태에서 나머지를 찾음
 */
function findBestFour(pool, forcedPlayers) {
    if (pool.length < 4) return null;

    // 강제 포함 선수가 있으면 해당 선수 고정 + 나머지에서 보충
    if (forcedPlayers && forcedPlayers.length > 0) {
        return findBestFourWithForced(pool, forcedPlayers);
    }

    const sorted = sortPriority(pool); // 이미 셔플 포함
    const candidates = sorted.slice(0, Math.min(sorted.length, 16));

    let bestCombo = null;
    let bestScore = Infinity;

    const len = candidates.length;
    for (let a = 0; a < len - 3; a++) {
        for (let b = a+1; b < len - 2; b++) {
            for (let c = b+1; c < len - 1; c++) {
                for (let d = c+1; d < len; d++) {
                    const four = [candidates[a], candidates[b], candidates[c], candidates[d]];

                    if (!isValidGender(four)) continue;

                    const score = scoreCombo(four);
                    if (score < bestScore) {
                        bestScore = score;
                        bestCombo = four;
                    }
                }
            }
        }
    }

    return bestCombo;
}

/**
 * 강제 포함 선수(urgent)를 반드시 넣고 나머지를 최적으로 채움
 * forced: 1~3명, 나머지를 pool에서 보충
 */
function findBestFourWithForced(pool, forced) {
    const forcedIds = new Set(forced.map(p => p.id));
    const rest = pool.filter(p => !forcedIds.has(p.id));
    const need = 4 - forced.length; // 몇 명 더 필요한지

    if (rest.length < need) return null;

    const sorted = sortPriority(rest);
    const candidates = sorted.slice(0, Math.min(sorted.length, 14));

    let bestCombo = null;
    let bestScore = Infinity;

    if (need === 3) {
        for (let a = 0; a < candidates.length - 2; a++) {
            for (let b = a+1; b < candidates.length - 1; b++) {
                for (let c = b+1; c < candidates.length; c++) {
                    const four = [...forced, candidates[a], candidates[b], candidates[c]];
                    if (!isValidGender(four)) continue;
                    const score = scoreCombo(four);
                    if (score < bestScore) { bestScore = score; bestCombo = four; }
                }
            }
        }
    } else if (need === 2) {
        for (let a = 0; a < candidates.length - 1; a++) {
            for (let b = a+1; b < candidates.length; b++) {
                const four = [...forced, candidates[a], candidates[b]];
                if (!isValidGender(four)) continue;
                const score = scoreCombo(four);
                if (score < bestScore) { bestScore = score; bestCombo = four; }
            }
        }
    } else if (need === 1) {
        for (let a = 0; a < candidates.length; a++) {
            const four = [...forced, candidates[a]];
            if (!isValidGender(four)) continue;
            const score = scoreCombo(four);
            if (score < bestScore) { bestScore = score; bestCombo = four; }
        }
    } else {
        // need === 0, forced가 4명
        if (isValidGender(forced)) return forced;
        return null;
    }

    return bestCombo;
}

/**
 * 자동매칭: 전체 풀에서 scoreCombo 점수 기반 최적 매칭
 * 동적 혼복 패널티가 비율을 자동 조절
 */
function autoMatch() {
    const type = S.matchType;

    if (type === 'manual') {
        toast('수동 모드에서는 인원을 직접 선택하세요', 'info');
        return;
    }

    // 자동 매칭 대기열 제한 (수동은 제한 없음)
    if (S.queue.length >= CONFIG.MAX_QUEUE) {
        toast(`대기열 ${CONFIG.MAX_QUEUE}게임 초과! 추가는 수동 매칭으로`, 'info');
        return;
    }

    let pool = getAvailable();

    // 성별 필터 (남복/여복/혼복 모드)
    if (type === 'doubles_m') {
        pool = pool.filter(p => p.gender === '남');
    } else if (type === 'doubles_f') {
        pool = pool.filter(p => p.gender === '여');
    }

    if (pool.length < 4) {
        toast('매칭 가능 인원 4명 이상 필요', 'err'); return;
    }

    if (type === 'mixed') {
        const m = pool.filter(p => p.gender === '남').length;
        const f = pool.filter(p => p.gender === '여').length;
        if (m < 2 || f < 2) { toast('남녀 각 2명 이상 필요', 'err'); return; }
    }

    let four = null;

    if (type === 'auto') {
        // 8게임 이상 쉰 사람이 있으면 강제 포함
        const urgentList = pool.filter(p => p.restCount >= CONFIG.MAX_REST);
        if (urgentList.length > 0) {
            // urgent 최대 3명까지 강제 (4명이면 그대로)
            const forced = urgentList.slice(0, Math.min(urgentList.length, 3));
            four = findBestFour(pool, forced);
            // 강제 포함 실패 시 (성별 문제 등) 일반 매칭 시도
            if (!four) four = findBestFour(pool);
        } else {
            four = findBestFour(pool);
        }
    } else if (type === 'mixed') {
        four = pickMixed(pool);
    } else {
        four = findBestFour(pool);
    }

    if (!four) { toast('조건에 맞는 매칭이 없습니다', 'err'); return; }

    const gameType = getGameType(four);

    // 게임 타입 히스토리 추적
    if (!S.gameTypeHistory) S.gameTypeHistory = [];
    S.gameTypeHistory.push(gameType);


    const split = bestSplit(four);
    const allIds = four.map(p => p.id);
    S.matchHistory.push(matchKey(allIds));
    S.matchCounter++;

    // 게임중인 선수 포함 여부 알림
    const playingNames = four.filter(p => p.status === 'playing').map(p => p.name);
    if (playingNames.length > 0) {
        toast(`연속게임: ${playingNames.join(',')} (현재 게임 끝나면 시작)`, 'info');
    }

    addToQueue(split.teamA.map(p=>p.id), split.teamB.map(p=>p.id), gameType);
}

function pickMixed(pool) {
    const males = pool.filter(p => p.gender === '남');
    const females = pool.filter(p => p.gender === '여');
    if (males.length < 2 || females.length < 2) return null;

    const mPool = sortPriority(males).slice(0, 6);
    const fPool = sortPriority(females).slice(0, 6);

    let bestCombo = null, bestScore = Infinity;
    for (let m1 = 0; m1 < mPool.length; m1++) {
        for (let m2 = m1+1; m2 < mPool.length; m2++) {
            for (let f1 = 0; f1 < fPool.length; f1++) {
                for (let f2 = f1+1; f2 < fPool.length; f2++) {
                    const four = [mPool[m1], mPool[m2], fPool[f1], fPool[f2]];
                    const score = scoreCombo(four);
                    if (score < bestScore) { bestScore = score; bestCombo = four; }
                }
            }
        }
    }
    return bestCombo;
}

function manualMatch() {
    if (S.selectedIds.length !== 4) { toast('4명을 선택해주세요', 'err'); return; }
    const players = S.selectedIds.map(id => S.players.find(p => p.id === id)).filter(Boolean);
    const split = bestSplit(players);
    const allIds = players.map(p => p.id);
    S.matchHistory.push(matchKey(allIds));
    S.matchCounter++;
    addToQueue(split.teamA.map(p=>p.id), split.teamB.map(p=>p.id), getGameType(players));
    clearSelection();
}

function addToQueue(teamA, teamB, type) {
    S.queue.push({ id:genId('game'), teamA, teamB, type });
    renderAll(); toast(`${type} 대기열 추가`, 'ok');
}

function removeFromQueue(gid) { S.queue = S.queue.filter(g => g.id !== gid); renderAll(); }

// ============ RENDERING ============
function renderAll() { renderCourts(); renderPlayers(); renderQueue(); renderPreview(); }

function renderCourts() {
    const el = $('#courtsRow');
    const pN = id => S.players.find(p => p.id === id)?.name || '?';
    const pL = id => S.players.find(p => p.id === id)?.level || 'C';
    const pG = id => S.players.find(p => p.id === id)?.gender || '';

    el.innerHTML = S.courts.map(c => {
        const live = !!c.game;
        const typeClass = live ? `type-${c.game.type}` : '';
        return `
        <div class="court-card ${live?'active':''} ${typeClass}">
            <div class="court-top">
                <div style="display:flex;align-items:center;gap:10px">
                    <span class="court-name">${c.name}</span>
                    ${live?`<span class="court-timer" data-timer="${c.id}">${fmtTime(c.game.elapsed)}</span>`:''}
                </div>
                <div style="display:flex;align-items:center;gap:6px">
                    ${live?`<span class="court-status live">${c.game.type} 진행중</span>`:`<span class="court-status empty">대기</span>`}
                    ${!live?`<button class="btn-icon" onclick="removeCourt('${c.id}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`:''}
                </div>
            </div>
            <div class="court-body">
                ${live?`
                <div class="court-game">
                    <div class="court-team">${c.game.teamA.map(id=>`<div class="team-player"><span class="level-dot ${pL(id)}"></span><strong>${pN(id)}</strong> <span class="pc-lv lv-${pL(id)}" style="font-size:.6rem;padding:1px 5px">${pL(id)}</span></div>`).join('')}</div>
                    <div class="court-vs">VS</div>
                    <div class="court-team">${c.game.teamB.map(id=>`<div class="team-player"><span class="level-dot ${pL(id)}"></span><strong>${pN(id)}</strong> <span class="pc-lv lv-${pL(id)}" style="font-size:.6rem;padding:1px 5px">${pL(id)}</span></div>`).join('')}</div>
                </div>
                `:`<div class="court-empty">대기중</div>`}
            </div>
            <div class="court-foot">
                ${live
                    ?`<button class="btn btn-cancel" onclick="cancelGame('${c.id}')">❌ 취소</button><button class="btn btn-end" onclick="endGame('${c.id}')">🏁 종료</button>`
                    :`<button class="btn btn-start" onclick="startGame('${c.id}')" ${!S.queue.length?'disabled':''}>▶ 게임 시작</button>`}
            </div>
        </div>`;
    }).join('');
}

function renderPlayers() {
    const list = $('#playerList');
    const search = ($('#searchPlayer')?.value||'').toLowerCase();
    const filter = $('.chip.active')?.dataset.filter || 'all';

    let arr = S.players.filter(p => {
        if (search && !p.name.toLowerCase().includes(search)) return false;
        if (filter !== 'all' && p.status !== filter) return false;
        return true;
    });

    // 가나다순 정렬 (이름 우선), 같은 이름 내에서 급수순
    arr.sort((a,b) => {
        return a.name.localeCompare(b.name, 'ko');
    });

    if (!arr.length) {
        list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--txt3);font-size:.82rem">${S.players.length ? '조건에 맞는 인원 없음' : '📥 시트에서 회원을 불러오세요'}</div>`;
    } else {
        const header = `<div class="pr-header">
            <span class="h-name">이름</span>
            <span class="h-lv">급수</span>
            <span class="h-gender">성별</span>
            <span class="h-shuttle">콕</span>
            <span class="h-games">게임</span>
            <span class="h-rest">쉼</span>
            <span class="h-status">상태</span>
        </div>`;
        list.innerHTML = header + arr.map(p => {
            const genderCls = p.gender === '남' ? 'male' : 'female';
            const restVal = (p.status === 'waiting' || p.status === 'playing') ? p.restCount : '-';
            const restCls = (p.restCount >= CONFIG.MAX_REST && p.status === 'waiting') ? 'urgent' : '';
            return `
            <div class="pr ${p.selected?'selected':''} ${p.status} gender-${genderCls}" onclick="toggleSelect('${p.id}')">
                <span class="pr-name">${p.name}</span>
                <span class="pr-lv lv-${p.level}">${p.level}</span>
                <span class="pr-gender ${genderCls}">${p.gender}</span>
                <input type="checkbox" class="pr-shuttle" ${p.shuttle?'checked':''} onclick="event.stopPropagation();toggleShuttle('${p.id}',event)" title="셔틀콕 제출">
                <span class="pr-games${p.gameCount > 0 ? ' has-games' : ''}">${p.gameCount}</span>
                <span class="pr-rest ${restCls}">${restVal}쉼</span>
                <select class="pr-status-select" onclick="event.stopPropagation()" onchange="changeStatusDirect('${p.id}',this.value)">
                    <option value="waiting" ${p.status==='waiting'?'selected':''}>대기</option>
                    <option value="playing" ${p.status==='playing'?'selected':''} disabled>게임중</option>
                    <option value="resting" ${p.status==='resting'?'selected':''}>휴식</option>
                    <option value="late" ${p.status==='late'?'selected':''}>늦참</option>
                </select>
                ${p.status!=='playing'?`<button class="pr-del" onclick="event.stopPropagation();removePlayer('${p.id}')">×</button>`:''}
            </div>`;
        }).join('');
    }
    $('#waitingCount').textContent = S.players.filter(p => p.status === 'waiting').length;
}

function renderPreview() {
    const area = $('#previewArea');
    const count = S.selectedIds.length;

    if (count === 0) {
        area.innerHTML = `<div class="preview-empty"><p>대기 인원에서 4명 선택 또는<br>자동 매칭을 사용하세요</p></div>`;
        return;
    }
    if (count === 4) {
        const players = S.selectedIds.map(id => S.players.find(p => p.id === id)).filter(Boolean);
        const genderWarning = !isValidGender(players);
        const split = bestSplit(players);
        const type = getGameType(players);
        const sA = split.teamA.reduce((s,p)=>s+lvVal(p.level),0);
        const sB = split.teamB.reduce((s,p)=>s+lvVal(p.level),0);
        area.innerHTML = `
        <div class="preview-game" ${genderWarning ? 'style="border-color:var(--amber)"' : ''}>
            <span class="preview-label">다음 게임 미리보기</span>
            <span class="preview-type">${type}</span>
            ${genderWarning ? '<div style="color:var(--amber);font-size:.7rem;font-weight:600;margin-bottom:6px">⚠️ 3:1 성비 - 수동 매칭만 가능</div>' : ''}
            <div class="preview-teams">
                <div class="preview-team">
                    <div class="preview-team-label">TEAM A (${sA})</div>
                    ${split.teamA.map(p=>`<div class="team-player"><span class="lv lv-${p.level}"></span>${p.name} <span style="color:var(--txt3);font-size:.68rem">${p.level}</span></div>`).join('')}
                </div>
                <div class="preview-vs">VS</div>
                <div class="preview-team">
                    <div class="preview-team-label">TEAM B (${sB})</div>
                    ${split.teamB.map(p=>`<div class="team-player"><span class="lv lv-${p.level}"></span>${p.name} <span style="color:var(--txt3);font-size:.68rem">${p.level}</span></div>`).join('')}
                </div>
            </div>
            <div class="preview-actions">
                <button class="btn btn-ghost-sm" onclick="clearSelection()">취소</button>
                <button class="btn btn-primary-sm" onclick="manualMatch()">대기열 추가</button>
            </div>
        </div>`;
    } else {
        area.innerHTML = `<div class="preview-selecting"><span class="count">${count} / 4</span><p style="font-size:.78rem;color:var(--txt2)">${4-count}명 더 선택하세요</p></div>`;
    }
}

function renderQueue() {
    const list = $('#queueList');
    $('#queueCount').textContent = S.queue.length;

    const pCard = (id, isPlaying) => {
        const p = S.players.find(p=>p.id===id);
        if (!p) return '<span class="q-player">?</span>';
        const playIcon = (isPlaying || p.status === 'playing') ? ' 🎮' : '';
        const genderCls = p.gender === '남' ? 'male' : 'female';
        return `<span class="q-player ${genderCls}${p.status === 'playing' ? ' is-playing' : ''}">
            <span class="level-dot ${p.level}"></span>
            <span class="q-player-name">${p.name}${playIcon}</span>
            <span class="q-player-info">${p.level}/${p.gender}</span>
        </span>`;
    };

    if (!S.queue.length) { list.innerHTML = '<div class="queue-empty">예정된 게임이 없습니다</div>'; return; }

    list.innerHTML = S.queue.map((g,i) => {
        const allIds = [...g.teamA, ...g.teamB];
        const allReady = allIds.every(id => {
            const p = S.players.find(x => x.id === id);
            return p && p.status !== 'playing';
        });
        const statusCls = allReady ? 'ready' : 'waiting';
        const statusText = allReady ? '● 시작가능' : '⏳ 게임중 대기';

        return `
    <div class="q-game ${statusCls}">
        <div class="q-game-header">
            <span class="q-game-num">${i+1}</span>
            <span class="q-game-type type-${g.type}">${g.type}</span>
            <span class="q-game-status ${statusCls}">${statusText}</span>
            <button class="btn-icon" onclick="removeFromQueue('${g.id}')" title="대기열 삭제"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="q-game-body">
            <div class="q-team">
                ${g.teamA.map(id => pCard(id)).join('')}
            </div>
            <span class="q-vs">VS</span>
            <div class="q-team">
                ${g.teamB.map(id => pCard(id)).join('')}
            </div>
        </div>
    </div>`;
    }).join('');
}

// ============ GAME LOG ============
function showGameLog() {
    $('#modalGameLog').classList.add('show');
    renderGameLog();
}

function renderGameLog() {
    const summary = $('#logSummary');
    const list = $('#logList');
    const today = new Date().toLocaleDateString('ko-KR');

    // 통계
    const totalGames = S.gameLog.length;
    const uniquePlayers = new Set();
    S.gameLog.forEach(g => { [...g.teamA,...g.teamB].forEach(p => uniquePlayers.add(p.name)); });
    const typeCount = {};
    S.gameLog.forEach(g => { typeCount[g.type] = (typeCount[g.type]||0) + 1; });

    summary.innerHTML = `
        <div class="log-stat"><span class="log-stat-num">${totalGames}</span><span class="log-stat-label">총 게임</span></div>
        <div class="log-stat"><span class="log-stat-num">${uniquePlayers.size}</span><span class="log-stat-label">참여 인원</span></div>
        ${Object.entries(typeCount).map(([t,c]) => `<div class="log-stat"><span class="log-stat-num">${c}</span><span class="log-stat-label">${t}</span></div>`).join('')}
    `;

    if (!S.gameLog.length) {
        list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--txt3)">아직 완료된 게임이 없습니다</div>';
        return;
    }

    list.innerHTML = S.gameLog.map(g => `
        <div class="log-item">
            <div class="log-item-head">
                <div style="display:flex;gap:6px;align-items:center">
                    <span class="log-item-num">#${g.gameNum}</span>
                    <span class="log-item-type ${g.type}">${g.type}</span>
                    <span class="log-item-court">${g.court}</span>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                    <span class="log-item-time">⏱ ${fmtTime(g.duration)}</span>
                    <span class="log-item-time">${g.time}</span>
                </div>
            </div>
            <div class="log-teams">
                <div class="log-team">${g.teamA.map(p => `<span class="log-player"><span class="lv lv-${p.level}"></span>${p.name}(${p.level})</span>`).join('')}</div>
                <span class="log-vs">VS</span>
                <div class="log-team">${g.teamB.map(p => `<span class="log-player"><span class="lv lv-${p.level}"></span>${p.name}(${p.level})</span>`).join('')}</div>
            </div>
        </div>
    `).join('');
}

// 게임 기록을 구글시트(시트5)에 내보내기
let _exportingGames = false;
let _exportedGameNums = new Set(); // 이미 내보낸 게임번호
async function exportGamesToSheet() {
    if (_exportingGames) { toast('내보내기 진행중...', 'info'); return; }
    if (!S.gameLog.length) { toast('내보낼 게임 기록이 없습니다', 'err'); return; }

    // 아직 안 보낸 게임만 필터
    const newGames = S.gameLog.filter(g => !_exportedGameNums.has(g.gameNum));
    if (!newGames.length) { toast('이미 모든 게임이 내보내기 완료되었습니다', 'info'); return; }

    const today = new Date();
    const ds = `${today.getFullYear()}-${(today.getMonth()+1).toString().padStart(2,'0')}-${today.getDate().toString().padStart(2,'0')}`;

    if (!CONFIG.APPS_SCRIPT_URL) {
        console.log('=== 게임 기록 내보내기 ===');
        console.log('날짜:', ds);
        newGames.forEach(g => {
            const tA = g.teamA.map(p => `${p.name}(${p.level})`).join(', ');
            const tB = g.teamB.map(p => `${p.name}(${p.level})`).join(', ');
            console.log(`#${g.gameNum} | ${g.type} | ${g.court} | ${tA} vs ${tB} | ${fmtTime(g.duration)} | ${g.time}`);
        });
        toast('Apps Script URL 미설정. README를 참고하세요. (콘솔에 기록됨)', 'info');
        return;
    }

    _exportingGames = true;
    toast('📤 게임 기록 내보내는 중...', 'info');

    try {
        const payload = {
            action: 'saveGameLog',
            sheetTab: CONFIG.GAME_LOG_TAB,
            date: ds,
            games: newGames.map(g => ({
                gameNum: g.gameNum,
                type: g.type,
                court: g.court,
                teamA: g.teamA.map(p => p.name).join(', '),
                teamA_levels: g.teamA.map(p => p.level).join(', '),
                teamB: g.teamB.map(p => p.name).join(', '),
                teamB_levels: g.teamB.map(p => p.level).join(', '),
                duration: fmtTime(g.duration),
                time: g.time,
            }))
        };
        await fetch(CONFIG.APPS_SCRIPT_URL, { method:'POST', mode:'no-cors', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        // 내보낸 게임번호 기록
        newGames.forEach(g => _exportedGameNums.add(g.gameNum));
        toast(`✅ 게임 기록 ${newGames.length}건 시트 내보내기 완료!`, 'ok');
    } catch(e) {
        toast('❌ 게임 기록 내보내기 실패: ' + e.message, 'err');
    } finally {
        _exportingGames = false;
    }
}

// 출석 기록을 참가자 시트에 내보내기 (참석일자/참석수 업데이트)
let _exportingAttendance = false;
let _attendanceExported = false; // 오늘 출석 내보내기 완료 여부
async function exportAttendanceToSheet() {
    if (_exportingAttendance) { toast('내보내기 진행중...', 'info'); return; }
    if (_attendanceExported) {
        if (!confirm('이미 오늘 출석을 내보냈습니다. 다시 내보내시겠습니까?\n(중복 기록될 수 있습니다)')) return;
    }

    const played = S.players.filter(p => p.gameCount > 0);
    if (!played.length) { toast('참여 인원이 없습니다', 'err'); return; }
    const today = new Date();
    const ds = `${today.getFullYear()}-${(today.getMonth()+1).toString().padStart(2,'0')}-${today.getDate().toString().padStart(2,'0')}`;

    if (!CONFIG.APPS_SCRIPT_URL) {
        console.log('=== 출석 내보내기 ===');
        console.log('날짜:', ds);
        played.forEach(p => console.log(`${p.name} | ${p.gameCount}게임`));
        toast('Apps Script URL 미설정. README를 참고하세요. (콘솔에 기록됨)', 'info');
        return;
    }

    _exportingAttendance = true;
    toast('📤 출석 내보내는 중...', 'info');

    try {
        const payload = {
            action: 'updateAttendance',
            date: ds,
            players: played.map(p => ({ name:p.name, gameCount:p.gameCount }))
        };
        await fetch(CONFIG.APPS_SCRIPT_URL, { method:'POST', mode:'no-cors', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        _attendanceExported = true;
        toast(`✅ 출석 ${played.length}명 시트 내보내기 완료!`, 'ok');
    } catch(e) {
        toast('❌ 출석 내보내기 실패: ' + e.message, 'err');
    } finally {
        _exportingAttendance = false;
    }
}

// ============ PLAYER PANEL TOGGLE ============
function togglePlayerPanel() {
    const panel = $('#sectionRight');
    const btn = $('#btnTogglePlayers');
    panel.classList.toggle('collapsed');
    btn.textContent = panel.classList.contains('collapsed') ? '☰' : '✕';
}

// ============ EVENTS ============
function initEvents() {
    $('#btnLoadSheet').onclick = loadFromSheet;
    $('#btnSaveAttendance').onclick = showSaveModal;
    $('#btnGameLog').onclick = showGameLog;
    $('#btnExportGames').onclick = exportGamesToSheet;
    $('#btnExportAttendance').onclick = exportAttendanceToSheet;
    $('#btnAddCourt').onclick = addCourt;
    $('#btnSelectAll').onclick = () => $$('#sheetList .sheet-item').forEach(e => e.classList.add('checked'));
    $('#btnDeselectAll').onclick = () => $$('#sheetList .sheet-item').forEach(e => e.classList.remove('checked'));
    $('#btnConfirmImport').onclick = confirmImport;
    $('#btnAddManual').onclick = () => $('#modalAdd').classList.add('show');
    $('#btnConfirmAdd').onclick = addManual;
    $('#inpName').onkeydown = e => { if (e.key==='Enter') addManual(); };
    $('#btnConfirmSave').onclick = confirmSave;
    $('#btnAutoMatch').onclick = autoMatch;

    $$('.type-tab').forEach(btn => btn.onclick = () => {
        $$('.type-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        S.matchType = btn.dataset.type;
        // 수동 모드면 버튼 텍스트 변경
        $('#btnAutoMatch').textContent = btn.dataset.type === 'manual' ? '📝 선택 매칭' : '⚡ 자동 매칭';
        if (btn.dataset.type === 'manual') {
            $('#btnAutoMatch').onclick = manualMatch;
        } else {
            $('#btnAutoMatch').onclick = autoMatch;
        }
    });

    $$('.chip').forEach(c => c.onclick = () => {
        $$('.chip').forEach(x => x.classList.remove('active'));
        c.classList.add('active');
        renderPlayers();
    });

    $('#searchPlayer').oninput = renderPlayers;

    // 모달 닫기
    $$('.modal-bg').forEach(bg => bg.onclick = e => { if (e.target === bg) bg.classList.remove('show'); });
    document.onkeydown = e => { if (e.key==='Escape') { $$('.modal-bg.show').forEach(m => m.classList.remove('show')); $('#statusDropdown').classList.remove('show'); } };

    // Status dropdown items
    $$('.sd-item').forEach(item => item.onclick = () => changeStatus(item.dataset.status));

    // Click outside closes dropdown
    document.addEventListener('click', e => {
        if (!e.target.closest('.status-dropdown') && !e.target.closest('.p-status-btn')) {
            $('#statusDropdown').classList.remove('show');
        }
    });
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
    updateDate();
    initCourts();
    initEvents();
    renderAll();
});
