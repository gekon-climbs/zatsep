import { loadState, saveState, flush, saveBackupCopy, backupBlob, parseBackup, requestPersist, isPersisted } from './store.js';
import * as L from './logic.js';

// При выпуске новой версии поменяй номер здесь и VERSION в sw.js.
const APP_VERSION = '1.0.0';

const { GRADES, STYLES, STYLE_ORDER } = L;
let state;
let swReg = null;
const ui = {
  tab: 'train', g: null, style: 'flash', attempts: 2, projectId: null, repeat: false,
  openSession: null, persisted: false, modal: null, form: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`; };
const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
};
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
};
const routes = (n) => `${n} ${plural(n, 'трасса', 'трассы', 'трасс')}`;

function gstyle(g) {
  const G = GRADES[g];
  return `background:${G.bg};color:${G.fg};${G.border ? `box-shadow:inset 0 0 0 1px ${G.border};` : ''}`;
}
const pill = (g, text) => `<span class="pill" style="${gstyle(g)}">${esc(text ?? GRADES[g].id)}</span>`;
const bar = (have, n, cls = '') => `<div class="bar ${cls}"><i style="width:${n ? Math.round((100 * Math.min(have, n)) / n) : 0}%"></i></div>`;

// Всплывашки идут по очереди, не больше двух на экране.
const toastQueue = [];
function toast(text) {
  toastQueue.push(text);
  pumpToasts();
}
function pumpToasts() {
  const box = $('#toasts');
  while (toastQueue.length && box.children.length < 2) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = toastQueue.shift();
    box.append(el);
    setTimeout(() => { el.remove(); pumpToasts(); }, 2200);
  }
}

// Отмечаем уже полученное без всплывашек (после импорта или смены звания вручную).
function syncSeen() {
  state.seen.ach = L.achievements(state).filter((a) => a.got).map((a) => a.id);
  state.seen.level = Math.max(state.seen.level, L.levelInfo(L.totalXP(state)).level);
}

// После каждого изменения: проверяем награды, сохраняем, перерисовываем.
function commit() {
  const now = Date.now();
  for (const g of L.checkRankUp(state, now)) toast(`🎉 Новое звание: ${GRADES[g].rank}!`);
  for (const goal of state.goals) {
    if (goal.doneAt) continue;
    const p = L.goalProgress(state, goal, now);
    if (p.done) {
      goal.doneAt = now;
      toast(`✅ Цель выполнена: ${p.text}${p.g != null ? ' ' + GRADES[p.g].id : ''}`);
    }
  }
  for (const a of L.achievements(state)) {
    if (a.got && !state.seen.ach.includes(a.id)) {
      state.seen.ach.push(a.id);
      toast(`${a.icon} Ачивка: ${a.title}`);
    }
  }
  const lv = L.levelInfo(L.totalXP(state)).level;
  if (lv > state.seen.level) {
    state.seen.level = lv;
    toast(`⭐ Уровень ${lv}!`);
  }
  saveState(state);
  render();
}

// ---------- Экран 1: тренировка ----------

function viewTrain() {
  const now = Date.now();
  const s = L.activeSession(state);
  const st = s ? L.sessionStats(state, s) : null;
  let h = `<div class="hdr"><h1>Тренировка</h1>${s ? '<span class="live"><i></i>идёт</span>' : '<button class="small" data-act="start">Начать сейчас</button>'}</div>`;
  h += s
    ? `<div class="sub">Начало ${fmtTime(s.start)} · <b id="timer">${fmtDur(now - s.start)}</b></div>`
    : '<div class="sub">Таймер запустится сам, когда запишешь первую трассу</div>';

  if (s) {
    h += `<div class="stats">
      <div class="stat"><b>${st.sends}</b><span>${plural(st.sends, 'трасса', 'трассы', 'трасс')}</span></div>
      <div class="stat"><b>${st.points}</b><span>очков</span></div>
      <div class="stat"><b>${st.maxG >= 0 ? GRADES[st.maxG].id : '—'}</b><span>макс</span></div></div>`;
    h += questCard(s);
  } else {
    h += backupReminder();
  }

  h += '<div class="lbl">1. Трасса</div><div class="grades">';
  GRADES.forEach((G, g) => {
    h += `<button class="gbtn ${ui.g === g ? 'sel' : ''}" style="${gstyle(g)}" data-act="grade" data-g="${g}">${G.id}</button>`;
  });
  h += '</div><div class="lbl">2. Как пролезла</div><div class="styles">';
  for (const k of STYLE_ORDER) {
    h += `<button class="sbtn ${k === 'fail' ? 'fail' : ''} ${ui.style === k ? 'sel' : ''}" data-act="style" data-s="${k}">${STYLES[k].label}</button>`;
  }
  h += `</div><div class="hint">${STYLES[ui.style].hint}</div>`;
  if (ui.style === 'redpoint' || ui.style === 'fail') {
    h += `<div class="stepper"><span class="t2">${ui.style === 'fail' ? 'Попыток сделала' : 'С какой попытки'}</span><div>
      <button data-act="dec">−</button><b>${ui.attempts}</b><button data-act="inc">+</button></div></div>`;
  }

  const active = state.projects.filter((p) => !p.sentAt);
  h += '<div class="lbl">Это проект?</div><div class="chips">';
  for (const p of active) {
    h += `<button class="chip ${ui.projectId === p.id ? 'sel' : ''}" data-act="pick-project" data-id="${p.id}">${pill(p.g)} ${esc(p.name)}</button>`;
  }
  h += '<button class="chip" data-act="new-project">+ Новый проект</button></div>';
  h += `<label class="chk"><input type="checkbox" data-act="repeat" ${ui.repeat ? 'checked' : ''}> Повтор: уже пролезала эту трассу раньше</label>`;

  if (ui.g == null) {
    h += '<button class="primary off" data-act="log">Выбери цвет трассы</button>';
  } else {
    const pts = L.points({ g: ui.g, style: ui.style });
    h += `<button class="primary" data-act="log">Записать${pts ? ' +' + pts : ''}</button>`;
  }

  if (s) {
    h += '<h2>Сегодня</h2><div class="card">';
    if (!st.climbs.length) h += '<div class="empty">Пока пусто. Первая трасса запустит прогресс!</div>';
    for (const c of [...st.climbs].reverse()) h += climbRow(c, true);
    h += '</div><button class="secondary" data-act="end">Завершить тренировку</button>';
  } else {
    const last = L.finishedSessions(state).slice(-1)[0];
    if (last) {
      const ls = L.sessionStats(state, last);
      h += `<h2>Прошлая тренировка</h2><div class="card"><div class="row"><span>${fmtDate(last.start)} · ${fmtDur((last.end || last.start) - last.start)}</span>
        <span>${routes(ls.sends)} · <span class="pts">${ls.points}</span></span></div></div>`;
    }
  }
  return h;
}

function climbRow(c, deletable) {
  const p = c.projectId ? state.projects.find((x) => x.id === c.projectId) : null;
  const extra = [];
  if (c.attempts > 1 || c.style === 'fail') extra.push(`${c.attempts} ${plural(c.attempts, 'попытка', 'попытки', 'попыток')}`);
  if (p) extra.push(`проект «${esc(p.name)}»`);
  if (c.repeat) extra.push('повтор');
  const pts = L.points(c);
  return `<div class="row"><span class="l">${pill(c.g)}<span>${STYLES[c.style].label}${extra.length ? ` <span class="muted">· ${extra.join(' · ')}</span>` : ''}</span></span>
    <span class="l"><span class="pts">${pts ? '+' + pts : ''}</span>${deletable ? `<button class="x" data-act="del-climb" data-id="${c.id}" aria-label="Удалить">×</button>` : ''}</span></div>`;
}

function questCard(s) {
  const items = L.questProgress(state, s);
  if (!items.length) return '';
  const done = items.every((q) => q.done);
  let h = `<div class="card quest"><div class="hdr"><b>Квест на тренировку</b><span class="muted">${done ? `выполнен, +${L.QUEST_BONUS}` : `бонус +${L.QUEST_BONUS}`}</span></div>`;
  for (const q of items) {
    h += `<div class="qi ${q.done ? 'done' : ''}"><span class="ck">${q.done ? '✅' : '⬜'}</span><span>${esc(q.text)}${q.g != null ? ' ' + pill(q.g) : ''}</span><span class="cnt">${q.have}/${q.n}</span></div>`;
  }
  return h + '</div>';
}

function backupReminder() {
  if (!state.climbs.length) return '';
  const days = state.lastBackupAt ? (Date.now() - state.lastBackupAt) / 864e5 : Infinity;
  if (days < 30) return '';
  return `<div class="banner warn">Давно не было резервной копии. <button class="small" data-act="export">Сохранить копию</button></div>`;
}

// ---------- Экран 2: прогресс ----------

function viewProgress() {
  const now = Date.now();
  const sessions = L.finishedSessions(state);
  let h = '<h1>Прогресс</h1>';
  if (!sessions.length) return h + '<div class="card empty" style="margin-top:12px">Здесь появятся графики после первой тренировки</div>';

  const last8 = sessions.slice(-8);
  const pts = last8.map((s) => L.sessionStats(state, s).points);
  const max = Math.max(...pts, 1);
  h += '<h2>Очки за тренировку</h2><div class="card"><div class="chart">';
  pts.forEach((p, i) => {
    h += `<div class="col ${i === pts.length - 1 ? 'last' : ''}"><b>${p}</b><i style="height:${Math.round((p / max) * 80)}%"></i></div>`;
  });
  h += '</div><div class="dates">' + last8.map((s) => `<span>${fmtDate(s.start)}</span>`).join('') + '</div>';
  const live = !last8[last8.length - 1].end;
  if (live && pts.length >= 2) {
    const a = pts[pts.length - 1], b = pts[pts.length - 2];
    h += a > b
      ? `<div class="banner ok">🔥 Уже обогнала прошлую тренировку на ${a - b} очков!</div>`
      : `<div class="banner info">До результата прошлой тренировки ещё ${b - a} очков</div>`;
  } else if (pts.length >= 2) {
    const a = pts[pts.length - 1], b = pts[pts.length - 2];
    const best = Math.max(...sessions.map((s) => L.sessionStats(state, s).points));
    const diff = b ? Math.round(((a - b) / b) * 100) : 100;
    if (a === best && a > 0) h += `<div class="banner ok">🏆 Рекорд! ${diff >= 0 ? '+' : ''}${diff}% к прошлой тренировке</div>`;
    else if (diff >= 0) h += `<div class="banner ok">${diff > 0 ? `+${diff}%` : 'Столько же'} к прошлой тренировке</div>`;
    else h += `<div class="banner info">${diff}% к прошлой тренировке. Бывает, главное, что пришла!</div>`;
  }
  h += '</div>';

  h += pyramidCard(now);

  const win = L.windowClimbs(state, now);
  h += `<h2>Процент успеха <span class="muted">${state.settings.windowWeeks} нед.</span></h2><div class="card">`;
  let any = false;
  GRADES.forEach((G, g) => {
    const r = L.successRate(state, g, now);
    if (!r.total) return;
    any = true;
    h += `<div class="rate">${pill(g)}${bar(r.sends, r.total)}<span>${r.sends}/${r.total} · ${Math.round(r.rate * 100)}%</span></div>`;
  });
  if (!any) h += '<div class="empty">Нет трасс за этот период</div>';
  h += '<div class="muted" style="margin-top:6px">Чтобы процент был честным, записывай и неудачные попытки («Не вышло»)</div></div>';

  if (win.length) {
    h += '<h2>Стиль прохождения</h2><div class="card"><div class="split">';
    for (const k of STYLE_ORDER) {
      const n = win.filter((c) => c.style === k).length;
      if (n) h += `<i style="width:${(100 * n) / win.length}%;background:${STYLES[k].color}"></i>`;
    }
    h += '</div><div class="legend">';
    for (const k of STYLE_ORDER) {
      const n = win.filter((c) => c.style === k).length;
      if (n) h += `<span><i style="background:${STYLES[k].color}"></i>${STYLES[k].label} ${Math.round((100 * n) / win.length)}%</span>`;
    }
    h += '</div></div>';
  }

  const allSends = state.climbs.filter(L.isSend);
  const maxG = allSends.length ? Math.max(...allSends.map((c) => c.g)) : -1;
  h += `<div class="grid2" style="margin-top:10px">
    <div class="mini"><span>Серия недель</span><b>${L.currentStreak(state, now)} 🔥</b></div>
    <div class="mini"><span>Всего пролезла</span><b>${routes(allSends.length)}</b></div>
    <div class="mini"><span>Лучшая тренировка</span><b>${Math.max(...sessions.map((s) => L.sessionStats(state, s).points))} очков</b></div>
    <div class="mini"><span>Самая сложная</span><b>${maxG >= 0 ? pill(maxG) : '—'}</b></div></div>`;

  h += '<h2>История</h2><div class="card">';
  for (const s of [...sessions].reverse()) {
    const st = L.sessionStats(state, s);
    const open = ui.openSession === s.id;
    h += `<div class="row" data-act="toggle-session" data-id="${s.id}" style="cursor:pointer"><span>${fmtDate(s.start)} · ${fmtTime(s.start)}${s.end ? '–' + fmtTime(s.end) : ' · идёт'}</span>
      <span>${routes(st.sends)} · <span class="pts">${st.points}</span> ${open ? '▴' : '▾'}</span></div>`;
    if (open) {
      h += '<div class="sessd">' + st.climbs.map((c) => climbRow(c, true)).join('');
      if (st.bonus) h += `<div class="row"><span>Бонус за квест</span><span class="pts">+${st.bonus}</span></div>`;
      h += `<button class="small danger" style="margin:8px 0" data-act="del-session" data-id="${s.id}">Удалить тренировку</button></div>`;
    }
  }
  return h + '</div>';
}

function pyramidCard(now) {
  const target = state.rank.g + 1;
  if (target >= GRADES.length) return '<h2>Пирамида</h2><div class="card empty">Ты на вершине! Все цвета покорены 🐐</div>';
  const p = L.pyramid(state, target, now);
  let h = `<h2><span>Пирамида до ${pill(target)}</span><span class="muted">${p.filled}/${p.total}</span></h2><div class="card">`;
  h += `<div class="muted">Разные трассы за последние ${state.settings.windowWeeks} недель, без повторов</div>`;
  for (const r of p.rows) {
    const G = GRADES[r.g];
    let slots = '';
    for (let i = 0; i < r.need; i++) {
      slots += i < r.have ? `<i style="background:${G.bg};${G.border ? `box-shadow:inset 0 0 0 1px ${G.border}` : ''}"></i>` : '<i class="e"></i>';
    }
    h += `<div class="py">${pill(r.g)}<div class="sl">${slots}</div><span class="n ${r.have >= r.need ? 'ok' : ''}">${Math.min(r.have, r.need)}/${r.need}</span></div>`;
  }
  const missing = [...p.rows].reverse().find((r) => r.have < r.need);
  if (!missing) h += '<div class="banner ok">Пирамида закрыта! Загляни в «Цели»: что осталось до нового звания</div>';
  else if (missing.g === target) h += `<div class="banner info">База готова. Пора штурмовать ${GRADES[target].color.toLowerCase()} трассы!</div>`;
  else h += `<div class="banner info">Ещё ${routes(missing.need - missing.have)} ${GRADES[missing.g].id}, и уровень пирамиды закрыт</div>`;
  return h + '</div>';
}

// ---------- Экран 3: цели ----------

function viewGoals() {
  const now = Date.now();
  const g = state.rank.g;
  const rc = L.rankConditions(state, now);
  const lv = L.levelInfo(L.totalXP(state));
  let h = '<h1>Цели и звание</h1><div class="card" style="margin-top:12px">';
  h += `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="pill rankpill" style="${gstyle(g)}">${GRADES[g].rank}</span>`;
  if (rc) h += `<span class="muted">→ ${GRADES[rc.next].rank}</span>`;
  h += '</div>';
  if (rc) {
    h += '<div style="margin-top:8px">';
    for (const c of rc.conds) h += `<div class="cond"><span>${c.done ? '✅' : '⬜'}</span><span>${c.text}</span><span class="cnt">${c.progress}</span></div>`;
    h += '</div>';
  }
  h += `<div class="hdr" style="margin-top:10px;font-size:13px"><span>Уровень ${lv.level}</span><span class="muted">${lv.cur} / ${lv.need} XP</span></div>${bar(lv.cur, lv.need, 'xp')}</div>`;

  h += '<h2>Все звания</h2><div class="card">';
  GRADES.forEach((G, i) => {
    const mark = i < g ? '✅' : i === g ? '<span class="muted">ты здесь</span>' : '';
    h += `<div class="row" style="${i > g ? 'color:var(--muted)' : ''}${i === g ? ';font-weight:600' : ''}"><span class="l">${pill(i)}${G.rank}</span><span>${mark}</span></div>`;
  });
  h += '</div>';

  const s = L.activeSession(state);
  h += '<h2>Квест</h2>';
  h += s ? questCard(s) : '<div class="card muted">Новый квест появится, когда начнёшь тренировку</div>';

  h += '<h2>Цели на сезон <button class="small" data-act="add-goal">+ Цель</button></h2><div class="card">';
  if (!state.goals.length) h += '<div class="empty">Поставь 2–3 цели на 6–10 недель: на цвет, на технику и на регулярность</div>';
  for (const goal of state.goals) {
    const p = L.goalProgress(state, goal, now);
    const done = !!goal.doneAt;
    h += `<div style="padding:7px 0"><div class="hdr"><span>${done ? '✅ ' : ''}${esc(p.text)}${p.g != null ? ' ' + pill(p.g) : ''}</span>
      <span class="l"><span class="muted">${done ? 'готово' : `${p.have}/${p.n}`}</span><button class="x" data-act="del-goal" data-id="${goal.id}" aria-label="Удалить">×</button></span></div>
      ${bar(done ? 1 : p.have, done ? 1 : p.n)}</div>`;
  }
  h += '</div>';

  h += '<h2>Проекты <button class="small" data-act="new-project">+ Проект</button></h2><div class="card">';
  if (!state.projects.length) h += '<div class="empty">Проект — трасса на цвет выше твоего, которую берёшь за несколько тренировок</div>';
  for (const p of [...state.projects].sort((a, b) => (a.sentAt ? 1 : 0) - (b.sentAt ? 1 : 0))) {
    const cl = state.climbs.filter((c) => c.projectId === p.id);
    const tries = cl.reduce((a, c) => a + c.attempts, 0);
    const sess = new Set(cl.map((c) => c.sessionId)).size;
    h += `<div class="row"><span class="l">${p.photo ? `<img class="thumb" src="${p.photo}" alt="">` : '<span class="thumb">🧗</span>'}
      <span>${pill(p.g)} ${esc(p.name)}<br><span class="muted">${p.sentAt ? `взят ${fmtDate(p.sentAt)} · ` : ''}${tries} ${plural(tries, 'попытка', 'попытки', 'попыток')} · ${sess} ${plural(sess, 'тренировка', 'тренировки', 'тренировок')}</span></span></span>
      <span>${p.sentAt ? '🎯' : ''}<button class="x" data-act="del-project" data-id="${p.id}" aria-label="Удалить">×</button></span></div>`;
  }
  h += '</div>';

  const ach = L.achievements(state);
  h += `<h2>Ачивки <span class="muted">${ach.filter((a) => a.got).length}/${ach.length}</span></h2><div class="card"><div class="ach">`;
  for (const a of ach) {
    h += `<div class="${a.got ? '' : 'off'}"><div class="ic" ${a.g != null && a.got ? `style="${gstyle(a.g)}"` : ''}>${a.icon}</div>${esc(a.title)}</div>`;
  }
  return h + '</div></div>';
}

// ---------- Экран 4: правила и данные ----------

function viewRules() {
  const ptsPills = GRADES.map((G, g) => pill(g, `${G.id}: ${G.base}`)).join(' ');
  return `<div class="rules"><h1>Как это работает</h1>
  <h3>🗺️ Тренировка по шагам</h3>
  <div class="step"><b>1</b><span>Разминка: 4–6 лёгких трасс на 2 цвета ниже твоего уровня</span></div>
  <div class="step"><b>2</b><span>Первые 30 минут, пока свежая: проект и трассы нового цвета</span></div>
  <div class="step"><b>3</b><span>Основная часть: трассы своего цвета, они заполняют пирамиду</span></div>
  <div class="step"><b>4</b><span>Финиш: пара лёгких трасс на технику, потом «Завершить тренировку»</span></div>
  <p>Таймер стартует с первой записанной трассы. Если забыла нажать «Завершить», тренировка закроется сама через ${state.settings.autoEndMin} минут после последней трассы.</p>

  <h3>⚡ Как пролезла</h3>
  <p><b>Онсайт</b> — с первой попытки, ничего не зная о трассе заранее: не смотрела, как лезут другие, без подсказок.</p>
  <p><b>Флэш</b> — с первой попытки, но с информацией: видела, как лезут другие, или подсказали.</p>
  <p><b>Рэдпоинт</b> — пролезла не с первой попытки (в этот день или после прошлых тренировок).</p>
  <p><b>Не вышло</b> — пробовала, но не пролезла. Очков не даёт, но нужна для процента успеха и учёта попыток на проекте.</p>

  <h3>🎯 Проект</h3>
  <p>Одна трасса на цвет выше твоего, которую не пролезть за один раз. Создай проект (можно с фото, чтобы не потерять трассу), выбирай его при записи попыток. Когда пролезешь — получишь ачивку и увидишь, сколько попыток и тренировок это заняло.</p>

  <h3>🔺 Пирамида 1–2–4–8</h3>
  <p>Перед новым цветом нужна база: 8 трасс на 3 цвета ниже, 4 — на 2 ниже, 2 — на 1 ниже и 1 трасса цели. Считаются разные трассы (без «повторов») за последние ${state.settings.windowWeeks} недель: трассы на скалодроме перекручивают, а форма без тренировок уходит.</p>

  <h3>🦎 Новое звание</h3>
  <p>Звание = цвет, который ты освоила. Чтобы получить следующее, нужно три условия: пирамида закрыта, пролезаешь не меньше половины трасс своего цвета (минимум ${L.MIN_TRIES_FOR_RATE} попытки) и 3 разные трассы нового цвета. Звание не отнимается.</p>

  <h3>🪙 Очки и уровни</h3>
  <p>За трассу: ${ptsPills}</p>
  <p>Онсайт ×2 · флэш ×1.5 · рэдпоинт ×1. Выполненный квест +${L.QUEST_BONUS}. Очки копятся в опыт: на уровень N нужно 100·N.</p>

  <h3>💾 Данные</h3>
  <p>Всё хранится только на этом телефоне. Обновления приложения данные не трогают, но раз в месяц сохраняй резервную копию: файл можно отправить себе в Telegram или на Google Диск.</p>
  <div class="card">
    <div class="row"><span>Резервная копия</span><span class="muted">${state.lastBackupAt ? 'последняя ' + fmtDate(state.lastBackupAt) : 'ещё не было'}</span></div>
    <div class="grid2" style="margin:8px 0 4px"><button class="small" data-act="export">Сохранить копию</button><button class="small" data-act="import">Восстановить</button></div>
    <div class="row"><span>Защита от очистки браузером</span>${ui.persisted ? '<span class="pts">включена</span>' : '<button class="small" data-act="persist">Включить</button>'}</div>
  </div>

  <h3>⚙️ Настройки</h3>
  <div class="card">
    <div class="lbl" style="margin-top:0">Моё звание (если уже лезешь выше белых)</div>
    <select data-act="set-rank">${GRADES.map((G, g) => `<option value="${g}" ${g === state.rank.g ? 'selected' : ''}>${G.id} — ${G.rank}</option>`).join('')}</select>
    <div class="lbl">Окно для пирамиды и процента успеха</div>
    <select data-act="set-window">${[4, 6, 8, 12].map((n) => `<option value="${n}" ${n === state.settings.windowWeeks ? 'selected' : ''}>${n} недель</option>`).join('')}</select>
    <div class="lbl">Автозавершение тренировки</div>
    <select data-act="set-autoend">${[20, 40, 60, 90].map((n) => `<option value="${n}" ${n === state.settings.autoEndMin ? 'selected' : ''}>через ${n} минут без трасс</option>`).join('')}</select>
  </div>
  <div class="row"><span class="muted">Версия ${APP_VERSION}</span><button class="small" data-act="check-update">Проверить обновление</button></div>
  </div>`;
}

// ---------- Модальные окна ----------

function projectForm() {
  const f = ui.form;
  let h = '<h1>Новый проект</h1><div class="lbl">Цвет</div><div class="grades">';
  GRADES.forEach((G, g) => {
    h += `<button class="gbtn ${f.g === g ? 'sel' : ''}" style="${gstyle(g)}" data-act="form-grade" data-g="${g}">${G.id}</button>`;
  });
  h += `</div><div class="lbl">Как узнать трассу</div><input type="text" id="pname" maxlength="40" placeholder="у окна, нависание" value="${esc(f.name || '')}">
    <div class="lbl">Фото (необязательно)</div>
    <label class="small" style="display:inline-flex;gap:8px;align-items:center">📷 ${f.photo ? 'Заменить фото' : 'Сфотографировать'}
      <input type="file" accept="image/*" capture="environment" data-act="photo" hidden></label>
    ${f.photo ? `<img src="${f.photo}" alt="" style="display:block;max-width:100%;max-height:200px;border-radius:10px;margin-top:8px">` : ''}
    <button class="primary" data-act="save-project">Создать проект</button><button class="secondary" data-act="close">Отмена</button>`;
  return h;
}

function goalForm() {
  const f = ui.form;
  let h = '<h1>Новая цель</h1><div class="chips">';
  for (const [k, label] of Object.entries(L.GOAL_TYPES)) {
    h += `<button class="chip ${f.type === k ? 'sel' : ''}" data-act="form-type" data-type="${k}">${label}</button>`;
  }
  h += '</div>';
  if (f.type !== 'weeks') {
    h += `<div class="lbl">${f.type === 'pyramid' ? 'До какого цвета' : 'Цвет (или сложнее)'}</div><div class="grades">`;
    GRADES.forEach((G, g) => {
      if (f.type === 'pyramid' && g === 0) return;
      h += `<button class="gbtn ${f.g === g ? 'sel' : ''}" style="${gstyle(g)}" data-act="form-grade" data-g="${g}">${G.id}</button>`;
    });
    h += '</div>';
  }
  if (f.type === 'sends') {
    h += '<div class="lbl">Стиль</div><div class="chips">';
    for (const [k, label] of Object.entries(L.GOAL_STYLES)) {
      h += `<button class="chip ${f.style === k ? 'sel' : ''}" data-act="form-style" data-style="${k}">${label}</button>`;
    }
    h += '</div>';
  }
  if (f.type !== 'pyramid') {
    h += `<div class="lbl">${f.type === 'weeks' ? 'Сколько недель' : 'Сколько трасс'}</div><input type="number" id="gn" min="1" max="200" value="${f.n}">`;
  }
  h += '<button class="primary" data-act="save-goal">Поставить цель</button><button class="secondary" data-act="close">Отмена</button>';
  return h;
}

function summaryModal(s) {
  const st = L.sessionStats(state, s);
  const all = L.finishedSessions(state);
  const idx = all.findIndex((x) => x.id === s.id);
  const prev = idx > 0 ? L.sessionStats(state, all[idx - 1]).points : null;
  let h = `<h1>Тренировка завершена 💪</h1><div class="stats">
    <div class="stat"><b>${st.sends}</b><span>${plural(st.sends, 'трасса', 'трассы', 'трасс')}</span></div>
    <div class="stat"><b>${st.points}</b><span>очков</span></div>
    <div class="stat"><b>${fmtDur(s.end - s.start)}</b><span>время</span></div></div>`;
  if (prev != null) {
    const diff = prev ? Math.round(((st.points - prev) / prev) * 100) : 100;
    h += `<div class="banner ${diff >= 0 ? 'ok' : 'info'}">${diff >= 0 ? '+' : ''}${diff}% очков к прошлой тренировке</div>`;
  }
  const q = L.questProgress(state, s);
  if (q.length) h += `<div class="banner ${st.bonus ? 'ok' : 'info'}">Квест: ${q.filter((x) => x.done).length} из ${q.length}${st.bonus ? `, бонус +${st.bonus}` : ''}</div>`;
  const rc = L.rankConditions(state, Date.now());
  if (rc) h += `<div class="banner info">До звания «${GRADES[rc.next].rank}»: ${rc.conds.filter((c) => c.done).length} из 3 условий</div>`;
  return h + '<button class="primary" data-act="close">Отлично!</button>';
}

function openModal(fn) {
  ui.modal = fn;
  renderModal();
}
function renderModal() {
  const m = $('#modal');
  if (!ui.modal) {
    m.classList.add('hidden');
    m.innerHTML = '';
    return;
  }
  m.innerHTML = `<div class="sheet">${ui.modal()}</div>`;
  m.classList.remove('hidden');
}
function closeModal() {
  ui.modal = null;
  ui.form = null;
  renderModal();
}

// ---------- Действия ----------

function startSession(now) {
  const s = { id: uid(), start: now, end: null, quest: L.makeQuest(state) };
  state.sessions.push(s);
  return s;
}

function compressImage(file, max = 640) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function exportData() {
  const name = `zatsep-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([backupBlob(state)], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Резервная копия Зацепа' });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw e;
  }
  state.lastBackupAt = Date.now();
  saveState(state);
  render();
  toast('Копия сохранена');
}

const actions = {
  tab(el) { ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  grade(el) {
    ui.g = +el.dataset.g;
    const p = state.projects.find((x) => x.id === ui.projectId);
    if (p && p.g !== ui.g) ui.projectId = null;
    render();
  },
  style(el) {
    ui.style = el.dataset.s;
    if (ui.style === 'redpoint') ui.attempts = Math.max(2, ui.attempts);
    render();
  },
  inc() { ui.attempts = Math.min(99, ui.attempts + 1); render(); },
  dec() { ui.attempts = Math.max(ui.style === 'redpoint' ? 2 : 1, ui.attempts - 1); render(); },
  'pick-project'(el) {
    const p = state.projects.find((x) => x.id === el.dataset.id);
    if (ui.projectId === p.id) ui.projectId = null;
    else {
      ui.projectId = p.id;
      ui.g = p.g;
      if (ui.style === 'onsight' || ui.style === 'flash') ui.style = 'fail';
    }
    render();
  },
  repeat(el) { ui.repeat = el.checked; },
  log() {
    if (ui.g == null) return toast('Сначала выбери цвет трассы');
    const now = Date.now();
    const s = L.activeSession(state) || startSession(now);
    const c = {
      id: uid(), sessionId: s.id, ts: now, g: ui.g, style: ui.style,
      attempts: ui.style === 'redpoint' || ui.style === 'fail' ? ui.attempts : 1,
      projectId: ui.projectId, repeat: ui.repeat,
    };
    state.climbs.push(c);
    if (c.projectId && L.isSend(c)) {
      const p = state.projects.find((x) => x.id === c.projectId);
      if (p && !p.sentAt) {
        p.sentAt = now;
        toast(`🎯 Проект «${p.name}» взят!`);
      }
    }
    const pts = L.points(c);
    toast(pts ? `+${pts} очков` : 'Попытка записана, в следующий раз получится!');
    ui.projectId = null;
    ui.repeat = false;
    ui.attempts = 2;
    commit();
  },
  'del-climb'(el) {
    if (!confirm('Удалить эту запись?')) return;
    const c = state.climbs.find((x) => x.id === el.dataset.id);
    state.climbs = state.climbs.filter((x) => x !== c);
    const s = state.sessions.find((x) => x.id === c.sessionId);
    if (s && s.end && !L.sessionClimbs(state, s.id).length) state.sessions = state.sessions.filter((x) => x !== s);
    if (c.projectId && L.isSend(c)) {
      const p = state.projects.find((x) => x.id === c.projectId);
      if (p && !state.climbs.some((x) => x.projectId === p.id && L.isSend(x))) p.sentAt = null;
    }
    commit();
  },
  start() { startSession(Date.now()); commit(); },
  end() {
    const s = L.activeSession(state);
    if (!L.sessionClimbs(state, s.id).length) {
      state.sessions = state.sessions.filter((x) => x !== s);
      commit();
      return;
    }
    s.end = Date.now();
    commit();
    openModal(() => summaryModal(s));
  },
  'toggle-session'(el) { ui.openSession = ui.openSession === el.dataset.id ? null : el.dataset.id; render(); },
  'del-session'(el) {
    if (!confirm('Удалить всю тренировку со всеми трассами?')) return;
    state.sessions = state.sessions.filter((x) => x.id !== el.dataset.id);
    state.climbs = state.climbs.filter((x) => x.sessionId !== el.dataset.id);
    commit();
  },
  'new-project'() {
    ui.form = { g: ui.g ?? Math.min(state.rank.g + 1, GRADES.length - 1), name: '', photo: null };
    openModal(projectForm);
  },
  'form-grade'(el) {
    const name = $('#pname');
    if (name) ui.form.name = name.value;
    ui.form.g = +el.dataset.g;
    renderModal();
  },
  'save-project'() {
    const name = $('#pname').value.trim() || `${GRADES[ui.form.g].color} трасса`;
    const p = { id: uid(), g: ui.form.g, name, photo: ui.form.photo, createdAt: Date.now(), sentAt: null };
    state.projects.push(p);
    if (ui.tab === 'train') {
      ui.projectId = p.id;
      ui.g = p.g;
      if (ui.style === 'onsight' || ui.style === 'flash') ui.style = 'fail';
    }
    closeModal();
    commit();
  },
  'del-project'(el) {
    if (!confirm('Удалить проект? Записанные трассы останутся.')) return;
    state.projects = state.projects.filter((x) => x.id !== el.dataset.id);
    state.climbs.forEach((c) => { if (c.projectId === el.dataset.id) c.projectId = null; });
    commit();
  },
  'add-goal'() {
    ui.form = { type: 'pyramid', g: Math.min(state.rank.g + 1, GRADES.length - 1), style: 'any', n: 5 };
    openModal(goalForm);
  },
  'form-type'(el) {
    ui.form.type = el.dataset.type;
    ui.form.n = ui.form.type === 'weeks' ? 8 : 5;
    if (ui.form.type === 'pyramid' && ui.form.g === 0) ui.form.g = 1;
    renderModal();
  },
  'form-style'(el) { ui.form.style = el.dataset.style; renderModal(); },
  'save-goal'() {
    const f = ui.form;
    const n = Math.max(1, Math.min(200, parseInt(($('#gn') || {}).value, 10) || f.n));
    state.goals.push({ id: uid(), type: f.type, g: f.type === 'weeks' ? null : f.g, style: f.style, n, createdAt: Date.now(), doneAt: null });
    closeModal();
    commit();
  },
  'del-goal'(el) {
    if (!confirm('Удалить цель?')) return;
    state.goals = state.goals.filter((x) => x.id !== el.dataset.id);
    commit();
  },
  close() { closeModal(); },
  export() { exportData().catch((e) => toast('Не получилось: ' + e.message)); },
  import() { $('#import-file').click(); },
  async persist() {
    ui.persisted = await requestPersist();
    toast(ui.persisted ? 'Защита включена' : 'Браузер пока не разрешил. Установи приложение на главный экран и попробуй снова');
    render();
  },
  'check-update'() {
    if (!swReg) return toast('Обновления работают только в установленной версии');
    swReg.update().then(() => toast(swReg.waiting ? 'Есть обновление!' : 'У тебя последняя версия'));
  },
};

const changeActions = {
  async photo(el) {
    const file = el.files[0];
    if (!file) return;
    ui.form.name = $('#pname').value;
    ui.form.photo = await compressImage(file);
    renderModal();
  },
  'set-rank'(el) {
    state.rank.g = +el.value;
    state.rank.history.push({ g: state.rank.g, at: Date.now(), manual: true });
    syncSeen();
    commit();
  },
  'set-window'(el) { state.settings.windowWeeks = +el.value; commit(); },
  'set-autoend'(el) { state.settings.autoEndMin = +el.value; commit(); },
};

async function importFile(file) {
  try {
    const next = parseBackup(await file.text());
    const n = next.climbs.length;
    if (!confirm(`В копии ${routes(n)}. Заменить текущие данные? Текущие тоже сохранятся внутри приложения на всякий случай.`)) return;
    await saveBackupCopy(state, 'before-import');
    state = next;
    syncSeen();
    await saveState(state);
    render();
    toast('Данные восстановлены');
  } catch (e) {
    toast('Не получилось: ' + e.message);
  }
}

// ---------- Отрисовка и запуск ----------

const views = { train: viewTrain, progress: viewProgress, goals: viewGoals, rules: viewRules };

function render() {
  $('#view').innerHTML = views[ui.tab]();
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
}

function checkAutoClose() {
  if (L.autoClose(state, Date.now())) {
    saveState(state);
    render();
    toast('Прошлая тренировка завершена автоматически');
  }
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    swReg = reg;
    const show = () => { if (reg.waiting && navigator.serviceWorker.controller) $('#update').classList.remove('hidden'); };
    show();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') show(); });
    });
  }).catch((e) => console.warn('Service worker не зарегистрирован', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  $('#update-btn').addEventListener('click', async () => {
    await flush(); // данные гарантированно записаны до перезагрузки
    if (swReg && swReg.waiting) swReg.waiting.postMessage('skipWaiting');
  });
}

async function init() {
  state = await loadState();
  checkAutoClose();
  ui.persisted = await isPersisted();
  commit(); // пересчёт звания и целей: окно пирамиды сдвигается со временем

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'SELECT') return;
    const fn = actions[el.dataset.act];
    if (fn) fn(el, e);
  });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && changeActions[el.dataset.act]) changeActions[el.dataset.act](el, e);
  });
  $('#import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
    e.target.value = '';
  });

  setInterval(() => {
    const t = $('#timer');
    const s = L.activeSession(state);
    if (t && s) t.textContent = fmtDur(Date.now() - s.start);
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    checkAutoClose();
    if (swReg) swReg.update().catch(() => {});
  });

  setupServiceWorker();
  // Первая запись — хороший момент попросить браузер не удалять данные.
  if (state.climbs.length && !ui.persisted) requestPersist().then((ok) => { ui.persisted = ok; });
}

init();
