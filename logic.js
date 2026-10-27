// Правила приложения: очки, пирамида, звания, уровни, квесты, цели и ачивки.
// Здесь только расчёты по данным, без интерфейса.

export const GRADES = [
  { id: '5c', color: 'Белая', bg: '#FFFFFF', fg: '#2C2C2A', border: '#B4B2A9', base: 10, rank: 'Белая улитка' },
  { id: '6a', color: 'Жёлтая', bg: '#FAC775', fg: '#412402', base: 20, rank: 'Жёлтая ящерица' },
  { id: '6b', color: 'Зелёная', bg: '#97C459', fg: '#173404', base: 30, rank: 'Зелёный геккон' },
  { id: '6c', color: 'Синяя', bg: '#378ADD', fg: '#FFFFFF', base: 45, rank: 'Синяя белка' },
  { id: '7a', color: 'Красная', bg: '#E24B4A', fg: '#FFFFFF', base: 65, rank: 'Красная панда' },
  { id: '7b', color: 'Чёрная', bg: '#2C2C2A', fg: '#FFFFFF', border: '#888780', base: 90, rank: 'Чёрная пантера' },
  { id: '7c–8a', color: 'Розовая', bg: '#ED93B1', fg: '#4B1528', base: 120, rank: 'Розовая горная коза' },
];

export const STYLES = {
  onsight: { label: 'Онсайт', hint: 'С первой попытки, ничего не зная о трассе заранее', mult: 2, send: true, color: '#1D9E75' },
  flash: { label: 'Флэш', hint: 'С первой попытки, но видела, как лезут другие, или знала подсказки', mult: 1.5, send: true, color: '#7F77DD' },
  redpoint: { label: 'Рэдпоинт', hint: 'Пролезла не с первой попытки', mult: 1, send: true, color: '#378ADD' },
  fail: { label: 'Не вышло', hint: 'Пробовала, но пока не пролезла. Нужно для процента успеха и проектов', mult: 0, send: false, color: '#B4B2A9' },
};
export const STYLE_ORDER = ['onsight', 'flash', 'redpoint', 'fail'];

export const PYRAMID = [1, 2, 4, 8];
export const QUEST_BONUS = 30;
export const MIN_TRIES_FOR_RATE = 4;
const WEEK = 7 * 24 * 3600 * 1000;

export const isSend = (c) => STYLES[c.style].send;
export const points = (c) => Math.round(GRADES[c.g].base * STYLES[c.style].mult);

export const activeSession = (state) => state.sessions.find((s) => !s.end) || null;
export const sessionClimbs = (state, sid) => state.climbs.filter((c) => c.sessionId === sid);

export function sessionStats(state, s) {
  const climbs = sessionClimbs(state, s.id);
  const sends = climbs.filter(isSend);
  const bonus = questDone(state, s) ? QUEST_BONUS : 0;
  return {
    climbs,
    sends: sends.length,
    points: climbs.reduce((a, c) => a + points(c), 0) + bonus,
    bonus,
    maxG: sends.length ? Math.max(...sends.map((c) => c.g)) : -1,
  };
}

// Тренировки, в которых записана хотя бы одна трасса, по порядку.
export function finishedSessions(state) {
  return state.sessions
    .filter((s) => state.climbs.some((c) => c.sessionId === s.id))
    .sort((a, b) => a.start - b.start);
}

export function windowClimbs(state, now) {
  const from = now - state.settings.windowWeeks * WEEK;
  return state.climbs.filter((c) => c.ts >= from);
}

// Пирамида 1–2–4–8 до цвета target: сколько разных трасс нужно на каждом уровне ниже.
export function pyramid(state, target, now) {
  const sends = windowClimbs(state, now).filter((c) => isSend(c) && !c.repeat);
  const rows = [];
  PYRAMID.forEach((need, k) => {
    const g = target - k;
    if (g < 0) return;
    rows.push({ g, need, have: sends.filter((c) => c.g === g).length });
  });
  const filled = rows.reduce((a, r) => a + Math.min(r.have, r.need), 0);
  const total = rows.reduce((a, r) => a + r.need, 0);
  return { target, rows, filled, total, closed: filled === total };
}

export function successRate(state, g, now) {
  const tries = windowClimbs(state, now).filter((c) => c.g === g);
  const sends = tries.filter(isSend).length;
  return { sends, total: tries.length, rate: tries.length ? sends / tries.length : 0 };
}

// Условия следующего звания.
export function rankConditions(state, now) {
  const cur = state.rank.g;
  const next = cur + 1;
  if (next >= GRADES.length) return null;
  const p = pyramid(state, next, now);
  const sr = successRate(state, cur, now);
  const distinct = Math.min(3, windowClimbs(state, now).filter((c) => c.g === next && isSend(c) && !c.repeat).length);
  const conds = [
    { text: `Пирамида до ${GRADES[next].id} закрыта`, done: p.closed, progress: `${p.filled}/${p.total}` },
    {
      text: `Пролезаешь ≥ 50% трасс ${GRADES[cur].id}`,
      done: sr.total >= MIN_TRIES_FOR_RATE && sr.rate >= 0.5,
      progress: sr.total >= MIN_TRIES_FOR_RATE ? `${sr.sends} из ${sr.total}` : `попыток ${sr.total}/${MIN_TRIES_FOR_RATE}`,
    },
    { text: `3 разные трассы ${GRADES[next].id}`, done: distinct >= 3, progress: `${distinct}/3` },
  ];
  return { next, conds, ready: conds.every((c) => c.done) };
}

export function checkRankUp(state, now) {
  const ups = [];
  for (;;) {
    const rc = rankConditions(state, now);
    if (!rc || !rc.ready) break;
    state.rank.g = rc.next;
    state.rank.history.push({ g: rc.next, at: now });
    ups.push(rc.next);
  }
  return ups;
}

// Уровни: на уровень N нужно 100·N очков опыта.
export const totalXP = (state) => state.sessions.reduce((a, s) => a + sessionStats(state, s).points, 0);
export function levelInfo(xp) {
  let level = 1;
  let need = 100;
  let rest = xp;
  while (rest >= need) {
    rest -= need;
    level += 1;
    need = 100 * level;
  }
  return { level, cur: rest, need };
}

// Серия недель (неделя с понедельника).
export function weekKey(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
function prevWeek(k) {
  const d = new Date(k);
  d.setDate(d.getDate() - 7);
  return d.getTime();
}
const trainedWeeks = (state) => new Set(finishedSessions(state).map((s) => weekKey(s.start)));

export function currentStreak(state, now) {
  const weeks = trainedWeeks(state);
  let k = weekKey(now);
  if (!weeks.has(k)) k = prevWeek(k); // на этой неделе ещё не была — серия не прервана
  let n = 0;
  while (weeks.has(k)) {
    n += 1;
    k = prevWeek(k);
  }
  return n;
}

export function longestStreak(state) {
  const ks = [...trainedWeeks(state)].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev = null;
  for (const k of ks) {
    run = prev !== null && prevWeek(k) === prev ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  return best;
}

// Квест на тренировку: три маленькие задачи, создаются при старте тренировки.
export function makeQuest(state) {
  const g = state.rank.g;
  const items = [];
  const project = state.projects.find((p) => !p.sentAt);
  if (project) items.push({ type: 'project', projectId: project.id, n: 3 });
  else items.push({ type: 'try', g: Math.min(g + 1, GRADES.length - 1), n: 1 });
  const recent = finishedSessions(state).slice(-4).map((s) => sessionClimbs(state, s.id).filter(isSend).length);
  const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  items.push({ type: 'volume', n: Math.max(6, Math.min(20, Math.round(avg * 1.1) || 6)) });
  items.push({ type: 'first', g, n: 1 });
  return items;
}

export function questProgress(state, s) {
  if (!s.quest) return [];
  const climbs = sessionClimbs(state, s.id);
  return s.quest.map((q) => {
    let have = 0;
    let text = '';
    if (q.type === 'project') {
      const p = state.projects.find((x) => x.id === q.projectId);
      have = climbs
        .filter((c) => c.projectId === q.projectId && c.ts <= s.start + 30 * 60 * 1000)
        .reduce((a, c) => a + c.attempts, 0);
      text = `${q.n} попытки на проект «${p ? p.name : 'удалён'}» в первые 30 минут`;
    } else if (q.type === 'try') {
      have = climbs.filter((c) => c.g >= q.g).length;
      text = 'Попробуй трассу цвета';
    } else if (q.type === 'volume') {
      have = climbs.filter(isSend).length;
      text = `Пролезь ${q.n} трасс`;
    } else if (q.type === 'first') {
      have = climbs.filter((c) => c.g >= q.g && (c.style === 'onsight' || c.style === 'flash')).length;
      text = 'Онсайт или флэш трассы цвета';
    }
    return { text, g: q.g, have: Math.min(have, q.n), n: q.n, done: have >= q.n };
  });
}

export function questDone(state, s) {
  const items = questProgress(state, s);
  return items.length > 0 && items.every((q) => q.done);
}

// Цели на сезон.
export const GOAL_TYPES = {
  pyramid: 'Закрыть пирамиду до цвета',
  sends: 'Пролезть N трасс цвета',
  weeks: 'Тренироваться N недель подряд',
};
export const GOAL_STYLES = {
  any: 'любым стилем',
  first: 'онсайт или флэш',
  onsight: 'онсайт',
  flash: 'флэш',
};

export function goalProgress(state, goal, now) {
  if (goal.type === 'pyramid') {
    const p = pyramid(state, goal.g, now);
    return { text: 'Закрыть пирамиду до', g: goal.g, have: p.filled, n: p.total, done: p.closed };
  }
  if (goal.type === 'sends') {
    const have = state.climbs.filter(
      (c) =>
        c.ts >= goal.createdAt &&
        isSend(c) &&
        !c.repeat &&
        c.g >= goal.g &&
        (goal.style === 'any' ||
          (goal.style === 'first' ? c.style === 'onsight' || c.style === 'flash' : c.style === goal.style)),
    ).length;
    const st = goal.style === 'any' ? '' : ` (${GOAL_STYLES[goal.style]})`;
    return { text: `${goal.n} трасс${st} от цвета`, g: goal.g, have: Math.min(have, goal.n), n: goal.n, done: have >= goal.n };
  }
  const have = currentStreak(state, now);
  return { text: `${goal.n} недель подряд без пропусков`, have: Math.min(have, goal.n), n: goal.n, done: have >= goal.n };
}

// Ачивки.
export function achievements(state) {
  const sends = state.climbs.filter(isSend);
  const sessions = finishedSessions(state).map((s) => sessionClimbs(state, s.id).filter(isSend));
  const longest = longestStreak(state);
  const list = [
    { id: 'first', icon: '🧗', title: 'Первая трасса', got: sends.length >= 1 },
    { id: 'onsight', icon: '👁️', title: 'Первый онсайт', got: sends.some((c) => c.style === 'onsight') },
    { id: 'flash', icon: '⚡', title: 'Первый флэш', got: sends.some((c) => c.style === 'flash') },
  ];
  GRADES.forEach((G, g) => {
    if (g === 0) return;
    list.push({ id: `color-${g}`, icon: '🏅', title: `Первая ${G.color.toLowerCase()}`, g, got: sends.some((c) => c.g === g) });
  });
  for (const n of [10, 50, 100, 250]) list.push({ id: `sends-${n}`, icon: '🔢', title: `${n} трасс`, got: sends.length >= n });
  for (const n of [4, 8, 12]) list.push({ id: `streak-${n}`, icon: '🔥', title: `${n} недель подряд`, got: longest >= n });
  list.push(
    { id: 'project', icon: '🎯', title: 'Проект взят', got: state.projects.some((p) => p.sentAt) },
    { id: 'stubborn', icon: '🐏', title: 'Упрямица: рэдпоинт с 10+ попыток', got: sends.some((c) => c.style === 'redpoint' && c.attempts >= 10) },
    { id: 'marathon', icon: '🏃', title: 'Марафон: 15 трасс за тренировку', got: sessions.some((cl) => cl.length >= 15) },
    { id: 'rainbow', icon: '🌈', title: 'Радуга: 4 цвета за тренировку', got: sessions.some((cl) => new Set(cl.map((c) => c.g)).size >= 4) },
  );
  return list;
}

// Если трасс не было дольше autoEndMin минут, тренировка завершается временем последней трассы.
export function autoClose(state, now) {
  const s = activeSession(state);
  if (!s) return false;
  const climbs = sessionClimbs(state, s.id);
  const last = climbs.length ? Math.max(...climbs.map((c) => c.ts)) : s.start;
  if (now - last <= state.settings.autoEndMin * 60 * 1000) return false;
  if (climbs.length) s.end = last;
  else state.sessions = state.sessions.filter((x) => x !== s);
  return true;
}
