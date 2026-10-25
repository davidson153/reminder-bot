// =====================================================================
// Telegram-бот напоминалка для Cloudflare Workers + база D1
//
// Как это работает:
//   fetch()     - сюда Telegram присылает сообщения и нажатия кнопок (вебхук)
//   scheduled() - Cloudflare запускает раз в минуту (cron), функция находит
//                 напоминания, у которых подошло время, и отправляет их
//
// Своего сервера не нужно: код лежит у Cloudflare и работает круглосуточно.
// =====================================================================

// Варианты "предупредить заранее" (в минутах до события)
const PRE_OPTIONS = [1440, 180, 60, 15];
const PRE_NAMES = { 1440: "1 день", 180: "3 часа", 60: "1 час", 15: "15 мин" };

// Варианты для настроек повторов
const EVERY_OPTIONS = [5, 10, 15, 30, 60];
const TIMES_OPTIONS = [0, 1, 2, 3, 5, 10];

// Настройки по умолчанию
const DEFAULT_TZ = 180;     // UTC+3 (Москва), в минутах
const DEFAULT_PRE = "60";   // предупредить за 1 час
const DEFAULT_EVERY = 10;   // повторять каждые 10 минут
const DEFAULT_TIMES = 3;    // до 3 повторов

const MAX_ACTIVE = 200;     // максимум напоминаний у одного чата
const MAX_TEXT = 500;       // максимальная длина текста напоминания
const BATCH = 20;           // сколько напоминаний отправлять за один запуск cron

const DAY_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const WEEK_REP = ["каждое воскресенье", "каждый понедельник", "каждый вторник", "каждую среду",
  "каждый четверг", "каждую пятницу", "каждую субботу"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
  "сентября", "октября", "ноября", "декабря"];

// Дни недели во всех нужных формах
const WD_RE = "(пн|вт|ср|чт|пт|сб|вс|понедельник(?:ам|а)?|вторник(?:ам|а)?|сред(?:а|у|ам)|" +
  "четверг(?:ам|а)?|пятниц(?:а|у|ам)|суббот(?:а|у|ам)|воскресень(?:е|ям))";
// "дальше не буква" (обычный \b в JS не работает с русскими буквами)
const END = "(?![а-яa-z])";

const SQL_SETUP = [
  "CREATE TABLE IF NOT EXISTS reminders (" +
  " id INTEGER PRIMARY KEY AUTOINCREMENT," +
  " chat_id INTEGER NOT NULL," +
  " text TEXT NOT NULL," +
  " event_at INTEGER NOT NULL," +           // время события (unix, секунды)
  " next_at INTEGER NOT NULL," +            // когда в следующий раз что-то отправить
  " pre TEXT NOT NULL DEFAULT ''," +        // за сколько минут предупредить, через запятую
  " every_min INTEGER NOT NULL DEFAULT 10," + // интервал повторов
  " times INTEGER NOT NULL DEFAULT 3," +    // сколько раз повторить
  " state INTEGER NOT NULL DEFAULT 0," +    // 0 - ждём, 1 - сработало и повторяем, 2 - отработало
  " nags INTEGER NOT NULL DEFAULT 0," +     // сколько повторов уже отправлено
  " rep TEXT NOT NULL DEFAULT '')",         // '' / day / wd (будни) / week
  "CREATE INDEX IF NOT EXISTS idx_next ON reminders(next_at)",
  "CREATE INDEX IF NOT EXISTS idx_chat ON reminders(chat_id)",
  "CREATE TABLE IF NOT EXISTS users (" +
  " chat_id INTEGER PRIMARY KEY," +
  " tz INTEGER NOT NULL DEFAULT 180," +
  " pre TEXT NOT NULL DEFAULT '60'," +
  " every_min INTEGER NOT NULL DEFAULT 10," +
  " times INTEGER NOT NULL DEFAULT 3)"
];

export default {
  // Входящие HTTP-запросы
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Сюда стучится Telegram
    if (url.pathname == "/webhook" && request.method == "POST") {
      // Проверяем секрет, чтобы никто кроме Telegram не мог слать боту фейковые сообщения
      if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") != env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch (e) {
        return new Response("bad request", { status: 400 });
      }
      try {
        await handleUpdate(env, update);
      } catch (e) {
        console.log("Ошибка обработки:", e.stack || e);
      }
      // Всегда отвечаем 200, иначе Telegram будет повторять запрос
      return new Response("ok");
    }

    // Одноразовая настройка: создать таблицы и подключить вебхук
    if (url.pathname == "/setup") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") != env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const result = await setup(env, url.origin);
      return new Response(result, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    return new Response("ok");
  },

  // Запускается по расписанию раз в минуту
  async scheduled(event, env, ctx) {
    await runDue(env);
  }
};

// ---------------------------------------------------------------------
// Настройка
// ---------------------------------------------------------------------

async function setup(env, origin) {
  const list = [];
  for (let i = 0; i < SQL_SETUP.length; i++) {
    list.push(env.DB.prepare(SQL_SETUP[i]));
  }
  await env.DB.batch(list);

  const r1 = await tg(env, "setWebhook", {
    url: origin + "/webhook",
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"]
  });
  const r2 = await tg(env, "setMyCommands", {
    commands: [
      { command: "list", description: "Мои напоминания" },
      { command: "settings", description: "Настройки по умолчанию" },
      { command: "tz", description: "Часовой пояс" },
      { command: "help", description: "Как пользоваться" }
    ]
  });
  return "Таблицы: OK\nsetWebhook: " + JSON.stringify(r1) + "\nsetMyCommands: " + JSON.stringify(r2);
}

// ---------------------------------------------------------------------
// Работа с Telegram API
// ---------------------------------------------------------------------

async function tg(env, method, data) {
  const base = env.TG_API || "https://api.telegram.org";
  try {
    const resp = await fetch(base + "/bot" + env.BOT_TOKEN + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    const res = await resp.json();
    if (!res.ok) {
      console.log("Telegram ответил ошибкой:", method, JSON.stringify(res));
    }
    return res;
  } catch (e) {
    console.log("Не удалось обратиться к Telegram:", method, e);
    return { ok: false, error_code: 0 };
  }
}

function send(env, chatId, text, kb) {
  const data = { chat_id: chatId, text: text, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  if (kb) data.reply_markup = kb;
  return tg(env, "sendMessage", data);
}

function edit(env, chatId, msgId, text, kb) {
  const data = { chat_id: chatId, message_id: msgId, text: text, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  if (kb) data.reply_markup = kb;
  return tg(env, "editMessageText", data);
}

function answer(env, queryId, text) {
  return tg(env, "answerCallbackQuery", { callback_query_id: queryId, text: text });
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trunc(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function plural(n, one, few, many) {
  const a = n % 10;
  const b = n % 100;
  if (a == 1 && b != 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

// ---------------------------------------------------------------------
// Время и даты. Всё храним в UTC (секунды), показываем в поясе пользователя
// ---------------------------------------------------------------------

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Разложить время на части в поясе пользователя (tz - смещение в минутах)
function localParts(ts, tz) {
  const d = new Date((ts + tz * 60) * 1000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay()
  };
}

// Местное время пользователя -> UTC секунды
function toUtc(y, m, d, h, mi, tz) {
  return Date.UTC(y, m, d, h, mi) / 1000 - tz * 60;
}

function validDate(y, m, d) {
  const x = new Date(Date.UTC(y, m, d));
  return x.getUTCMonth() == m && x.getUTCDate() == d;
}

function two(n) {
  return n < 10 ? "0" + n : "" + n;
}

function dayNum(ts, tz) {
  return Math.floor((ts + tz * 60) / 86400);
}

function fmtTime(ts, tz) {
  const p = localParts(ts, tz);
  return two(p.h) + ":" + two(p.mi);
}

function fmtDate(ts, tz) {
  const now = nowSec();
  const p = localParts(ts, tz);
  const diff = dayNum(ts, tz) - dayNum(now, tz);
  let s;
  if (diff == 0) s = "сегодня";
  else if (diff == 1) s = "завтра";
  else {
    s = DAY_SHORT[p.dow] + " " + two(p.d) + "." + two(p.m + 1);
    if (p.y != localParts(now, tz).y) s += "." + p.y;
  }
  return s + " в " + two(p.h) + ":" + two(p.mi);
}

function fmtLeft(sec) {
  const min = Math.round(sec / 60);
  if (min < 1) return "меньше минуты";
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const parts = [];
  if (d > 0) parts.push(d + " д");
  if (h > 0) parts.push(h + " ч");
  if (m > 0 && d == 0) parts.push(m + " мин");
  if (parts.length == 0) parts.push(min + " мин");
  return parts.join(" ");
}

function tzName(tz) {
  const a = Math.abs(tz);
  let s = "UTC" + (tz < 0 ? "-" : "+") + Math.floor(a / 60);
  if (a % 60 != 0) s += ":" + two(a % 60);
  return s;
}

function isWeekend(ts, tz) {
  const dow = localParts(ts, tz).dow;
  return dow == 0 || dow == 6;
}

// Следующий раз для повторяющегося напоминания
function stepRep(at, rep, tz) {
  if (rep == "week") return at + 7 * 86400;
  at = at + 86400;
  if (rep == "wd") {
    while (isWeekend(at, tz)) at = at + 86400;
  }
  return at;
}

// Ближайшее будущее время повторяющегося напоминания после now
function nextOccurrence(r, now, tz) {
  let at = r.event_at;
  while (at <= now) at = stepRep(at, r.rep, tz);
  return at;
}

function dayIndex(w) {
  if (w.startsWith("пн") || w.startsWith("пон")) return 1;
  if (w.startsWith("вт")) return 2;
  if (w.startsWith("ср")) return 3;
  if (w.startsWith("чт") || w.startsWith("чет")) return 4;
  if (w.startsWith("пт") || w.startsWith("пят")) return 5;
  if (w.startsWith("сб") || w.startsWith("суб")) return 6;
  return 0;
}

// ---------------------------------------------------------------------
// Разбор сообщения. "Когда" может стоять в начале ("завтра в 9:00 пара")
// или в конце ("пара завтра в 9:00").
// Возвращает {at, rep, text}, или {error}, или null если время не найдено
// ---------------------------------------------------------------------

function parseMessage(src, tz, now) {
  const r = parseFrom(src, tz, now, 0);
  if (r) return r;
  if (src.length > 300) return null;
  // пробуем найти время в конце: перебираем начала слов слева направо
  for (let i = 1; i < src.length; i++) {
    if (/\s/.test(src[i - 1]) && !/\s/.test(src[i])) {
      const x = parseFrom(src, tz, now, i);
      if (x) return x;
    }
  }
  return null;
}

// Разобрать время, начиная с позиции start
function parseFrom(src, tz, now, start) {
  let low = src.toLowerCase().replace(/ё/g, "е");
  if (low.length != src.length) low = src;   // на случай экзотических символов
  let pos = start;

  // Проверить шаблон с текущего места (pos не двигаем)
  function look(pattern) {
    const re = new RegExp("^" + pattern + "\\s*");
    return re.exec(low.slice(pos));
  }
  // Проверить шаблон и, если подошёл, "съесть" его
  function take(pattern) {
    const m = look(pattern);
    if (m) pos += m[0].length;
    return m;
  }

  let rep = "";
  let wd = -1;              // день недели 0..6
  let shift = -1;           // сегодня = 0, завтра = 1, послезавтра = 2
  let dd = -1, mm = -1, yy = -1;
  let hh = -1, mi = 0;
  let delta = 0;            // "через ..." в секундах
  let badTime = false;      // написали время вроде 25:00
  let m;

  // 1. Повтор
  if (take("(каждый день|ежедневно)" + END)) rep = "day";
  else if (take("(по будням|по рабочим дням|каждый будний день)" + END)) rep = "wd";
  else {
    m = take("(?:каждый|каждую|каждое|по)\\s+" + WD_RE + END);
    if (m) {
      rep = "week";
      wd = dayIndex(m[1]);
    }
  }

  // 2. "через 20 минут", "через 1ч 30м", "через полчаса"
  if (!rep && take("через" + END)) {
    while (true) {
      if (take("полчаса" + END)) {
        delta += 1800;
        continue;
      }
      m = take("(\\d+)?\\s*(минуту|минуты|минут|мин|м|часа|часов|час|ч|дней|дня|день|дн|д|недели|неделю|недель|неделя|нед)" + END + "\\.?");
      if (m) {
        const n = m[1] ? parseInt(m[1], 10) : 1;
        const u = m[2];
        if (u[0] == "м") delta += n * 60;
        else if (u[0] == "ч") delta += n * 3600;
        else if (u[0] == "н") delta += n * 7 * 86400;
        else delta += n * 86400;
        continue;
      }
      if (delta > 0 && take("и" + END)) continue;
      break;
    }
    if (delta == 0) return null;
  }

  // 3. Дата
  function readDate() {
    if (take("сегодня" + END)) { shift = 0; return true; }
    if (take("послезавтра" + END)) { shift = 2; return true; }
    if (take("завтра" + END)) { shift = 1; return true; }

    let x = look("(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}|\\d{2}))?(?![\\d:])");
    if (x) {
      const d = parseInt(x[1], 10);
      const mo = parseInt(x[2], 10);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        dd = d;
        mm = mo - 1;
        if (x[3]) {
          yy = parseInt(x[3], 10);
          if (yy < 100) yy += 2000;
        }
        pos += x[0].length;
        return true;
      }
    }

    x = take("(\\d{1,2})\\s+(" + MONTHS.join("|") + ")(?:\\s+(\\d{4}))?" + END);
    if (x) {
      dd = parseInt(x[1], 10);
      mm = MONTHS.indexOf(x[2]);
      if (x[3]) yy = parseInt(x[3], 10);
      return true;
    }

    if (wd < 0) {
      x = take("(?:во|в)?\\s*" + WD_RE + END);
      if (x) {
        wd = dayIndex(x[1]);
        return true;
      }
    }
    return false;
  }

  // 4. Время
  function readTime() {
    let x = look("(?:во|в|к)?\\s*(\\d{1,2}):(\\d{2})(?!\\d)");
    if (x) {
      const h = parseInt(x[1], 10);
      const mn = parseInt(x[2], 10);
      if (h <= 23 && mn <= 59) {
        hh = h;
        mi = mn;
        pos += x[0].length;
        return true;
      }
      badTime = true;
      return false;
    }
    x = look("(?:в|к)\\s+(\\d{1,2})(?:\\s*(утра|дня|вечера|ночи|часов|часа|час|ч))?(?![\\d:а-яa-z])");
    if (x) {
      let h = parseInt(x[1], 10);
      const w = x[2] || "";
      if ((w == "дня" || w == "вечера") && h < 12) h += 12;
      if (w == "ночи" && h == 12) h = 0;
      if (h <= 23) {
        hh = h;
        mi = 0;
        pos += x[0].length;
        return true;
      }
      return false;
    }
    // "18.30" - только если дата не указана (иначе путается с 18.10)
    if (dd < 0) {
      x = look("(\\d{1,2})\\.(\\d{2})(?![\\d.])");
      if (x) {
        const h = parseInt(x[1], 10);
        const mn = parseInt(x[2], 10);
        if (h <= 23 && mn <= 59) {
          hh = h;
          mi = mn;
          pos += x[0].length;
          return true;
        }
      }
    }
    return false;
  }

  let gotDate = false;
  if (delta > 0) {
    readTime();
  } else {
    gotDate = readDate();
    readTime();
    if (!gotDate) gotDate = readDate();   // "в 18:00 завтра ..."
  }

  if (badTime) return { error: "Такого времени нет. Пиши время от 00:00 до 23:59" };
  if (!rep && delta == 0 && !gotDate && hh < 0) return null;

  let text;
  if (start == 0) {
    text = src.slice(pos).replace(/^[\s,.:;!\-–—]+/, "").trim();
  } else {
    // время в конце: после него ничего, кроме знаков препинания
    if (src.slice(pos).replace(/[\s.,!;]+/g, "") != "") return null;
    text = src.slice(0, start).replace(/[\s,.:;!\-–—]+$/, "").trim();
  }
  if (!text) return { error: "А о чём напомнить? Напиши время и текст, например:\n<code>завтра в 9:00 пара по физике</code>" };

  // 5. Считаем итоговое время
  const t = localParts(now, tz);
  let at;
  if (delta > 0) {
    if (hh >= 0) {
      const b = localParts(now + delta, tz);
      at = toUtc(b.y, b.m, b.d, hh, mi, tz);
    } else {
      at = now + delta;
    }
    if (at <= now) return { error: "Это время уже прошло" };
  } else {
    let y = t.y, mo = t.m, d = t.d;
    if (dd >= 0) {
      y = yy > 0 ? yy : t.y;
      mo = mm;
      d = dd;
      if (!validDate(y, mo, d)) return { error: "Такой даты нет" };
    } else if (shift >= 0) {
      d = t.d + shift;
    } else if (wd >= 0) {
      d = t.d + (wd - t.dow + 7) % 7;
    }
    if (hh < 0) {
      if (shift == 0) return { error: "Укажи время, например:\n<code>сегодня в 18:00 " + esc(trunc(text, 40)) + "</code>" };
      hh = 9;
      mi = 0;
    }
    at = toUtc(y, mo, d, hh, mi, tz);
    if (at <= now) {
      if (dd >= 0 && yy < 0 && !(mo == t.m && d == t.d)) {
        // дата без года уже прошла в этом году - значит в следующем
        if (!validDate(y + 1, mo, d)) return { error: "Такой даты нет" };
        at = toUtc(y + 1, mo, d, hh, mi, tz);
      } else if (dd < 0 && shift < 0 && wd >= 0) {
        at += 7 * 86400;      // этот день недели уже прошёл - через неделю
      } else if (dd < 0 && shift < 0) {
        at += 86400;          // указано только время, и оно прошло - завтра
      } else {
        return { error: "Это время уже прошло" };
      }
    }
  }
  if (rep == "wd") {
    while (isWeekend(at, tz)) at += 86400;
  }
  if (at - now > 5 * 366 * 86400) return { error: "Слишком далеко, максимум 5 лет" };

  return { at: at, rep: rep, text: trunc(text, MAX_TEXT) };
}

// ---------------------------------------------------------------------
// Настройки пользователя
// ---------------------------------------------------------------------

async function getUser(env, chatId) {
  const u = await env.DB.prepare("SELECT * FROM users WHERE chat_id = ?").bind(chatId).first();
  if (u) return u;
  return { chat_id: chatId, tz: DEFAULT_TZ, pre: DEFAULT_PRE, every_min: DEFAULT_EVERY, times: DEFAULT_TIMES };
}

async function saveUser(env, chatId, u) {
  await env.DB.prepare(
    "INSERT INTO users (chat_id, tz, pre, every_min, times) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(chat_id) DO UPDATE SET tz = excluded.tz, pre = excluded.pre, " +
    "every_min = excluded.every_min, times = excluded.times"
  ).bind(chatId, u.tz, u.pre, u.every_min, u.times).run();
}

function allowed(env, from) {
  if (!env.ALLOWED_USERS) return true;
  const list = env.ALLOWED_USERS.split(",");
  for (let i = 0; i < list.length; i++) {
    if (list[i].trim() == String(from.id)) return true;
  }
  return false;
}

function splitPre(s) {
  const res = [];
  if (!s) return res;
  const parts = s.split(",");
  for (let i = 0; i < parts.length; i++) {
    const n = parseInt(parts[i], 10);
    if (n > 0) res.push(n);
  }
  res.sort(function (a, b) { return b - a; });
  return res;
}

function togglePre(s, v) {
  const list = splitPre(s);
  const i = list.indexOf(v);
  if (i >= 0) list.splice(i, 1);
  else if (PRE_OPTIONS.indexOf(v) >= 0) list.push(v);
  list.sort(function (a, b) { return b - a; });
  return list.join(",");
}

function preText(s) {
  const list = splitPre(s);
  if (list.length == 0) return "нет";
  const names = [];
  for (let i = 0; i < list.length; i++) names.push("за " + PRE_NAMES[list[i]]);
  return names.join(", ");
}

function nextOption(arr, cur) {
  const i = arr.indexOf(cur);
  return arr[(i + 1) % arr.length];
}

function repName(rep, at, tz) {
  if (rep == "day") return "каждый день";
  if (rep == "wd") return "по будням";
  if (rep == "week") return WEEK_REP[localParts(at, tz).dow];
  return "";
}

function timesText(r) {
  if (r.times <= 0) return "без повторов";
  return "повторю " + r.times + " " + plural(r.times, "раз", "раза", "раз") + " каждые " + r.every_min + " мин";
}

// Ближайшее время отправки: первое из "заранее", которое ещё не прошло, иначе само событие
function planNext(at, pre, after) {
  let best = at;
  const list = splitPre(pre);
  for (let i = 0; i < list.length; i++) {
    const t = at - list[i] * 60;
    if (t > after && t < best) best = t;
  }
  return best;
}

// Время, которое показывать пользователю
function showAt(r, now, tz) {
  if (r.rep && r.state == 2) return nextOccurrence(r, now, tz);
  return r.event_at;
}

// ---------------------------------------------------------------------
// Тексты и кнопки
// ---------------------------------------------------------------------

function helpText(userId, tz) {
  return "👋 Я бот-напоминалка. Просто напиши, <b>когда</b> и <b>о чём</b> напомнить:\n\n" +
    "<code>через 20 минут выключить чайник</code>\n" +
    "<code>через 1ч 30м позвонить домой</code>\n" +
    "<code>в 18:30 тренировка</code>\n" +
    "<code>завтра в 9:00 пара по физике</code>\n" +
    "<code>послезавтра в 7 вечера кино</code>\n" +
    "<code>28.10 12:00 сдать лабу</code>\n" +
    "<code>5 ноября 10:00 зачёт</code>\n" +
    "<code>в пятницу 15:00 забрать посылку</code>\n" +
    "<code>каждый день 8:00 выпить витамины</code>\n" +
    "<code>по будням 7:30 подъём</code>\n" +
    "<code>каждый пн 10:00 планёрка</code>\n" +
    "<code>позвонить домой завтра в 15:00</code>\n\n" +
    "Время можно писать в начале или в конце. Если дата без времени, напомню в 9:00. " +
    "Время пиши через двоеточие (18:30).\n\n" +
    "<b>Как я напоминаю:</b>\n" +
    "1) заранее (по умолчанию за 1 час, под каждым напоминанием можно выбрать: за день, 3 часа, час, 15 минут);\n" +
    "2) в назначенное время;\n" +
    "3) если не нажать «✅ Готово», повторяю (по умолчанию каждые 10 минут до 3 раз, меняется в /settings). " +
    "Можно отложить на 10 минут, час или сутки.\n\n" +
    "<b>Команды:</b>\n" +
    "/list - мои напоминания (там же удаление)\n" +
    "/settings - настройки по умолчанию\n" +
    "/tz - часовой пояс (сейчас " + tzName(tz) + ")\n" +
    "/help - эта справка\n\n" +
    "Твой Telegram ID: <code>" + userId + "</code>";
}

function cardText(r, tz, title) {
  const now = nowSec();
  const at = showAt(r, now, tz);
  let s = title + "\n\n📝 <b>" + esc(r.text) + "</b>\n🗓 " + fmtDate(at, tz);
  if (at > now) s += " (через " + fmtLeft(at - now) + ")";
  if (r.rep) s += "\n🔁 " + repName(r.rep, at, tz);
  s += "\n⏳ Заранее: " + preText(r.pre);
  s += "\n🔔 Если не нажмёшь «Готово»: " + timesText(r);
  s += "\n\nКогда предупредить заранее (нажми, чтобы вкл/выкл):";
  return s;
}

function preButton(list, v, data) {
  const on = list.indexOf(v) >= 0;
  return { text: (on ? "✅ " : "▫️ ") + "за " + PRE_NAMES[v], callback_data: data };
}

function cardKeyboard(r) {
  const list = splitPre(r.pre);
  return {
    inline_keyboard: [
      [preButton(list, 1440, "p:" + r.id + ":1440"), preButton(list, 180, "p:" + r.id + ":180")],
      [preButton(list, 60, "p:" + r.id + ":60"), preButton(list, 15, "p:" + r.id + ":15")],
      [{ text: "🗑 Удалить", callback_data: "x:" + r.id }]
    ]
  };
}

function alertKeyboard(r) {
  const tail = r.id + ":" + r.event_at;
  return {
    inline_keyboard: [
      [{ text: "✅ Готово", callback_data: "d:" + tail }],
      [
        { text: "⏰ +10 мин", callback_data: "s:" + tail + ":10" },
        { text: "⏰ +1 час", callback_data: "s:" + tail + ":60" },
        { text: "⏰ +1 день", callback_data: "s:" + tail + ":1440" }
      ]
    ]
  };
}

function settingsText(u) {
  return "⚙️ <b>Настройки для новых напоминаний</b>\n\n" +
    "⏳ Заранее: " + preText(u.pre) + "\n" +
    "🔁 Повторять после события: каждые " + u.every_min + " мин\n" +
    "🔢 Сколько раз повторять: " + u.times + "\n" +
    "🌍 Часовой пояс: " + tzName(u.tz) + " (меняется командой /tz)\n\n" +
    "Нажимай на кнопки, чтобы изменить. Уже созданные напоминания не меняются.";
}

function settingsKeyboard(u) {
  const list = splitPre(u.pre);
  return {
    inline_keyboard: [
      [preButton(list, 1440, "sp:1440"), preButton(list, 180, "sp:180")],
      [preButton(list, 60, "sp:60"), preButton(list, 15, "sp:15")],
      [{ text: "🔁 Повтор каждые " + u.every_min + " мин", callback_data: "se" }],
      [{ text: "🔢 Повторов: " + u.times, callback_data: "st" }]
    ]
  };
}

async function buildList(env, chatId, tz) {
  const res = await env.DB.prepare(
    "SELECT * FROM reminders WHERE chat_id = ? AND (state < 2 OR rep != '') ORDER BY event_at LIMIT 30"
  ).bind(chatId).all();
  const rows = res.results;
  if (rows.length == 0) {
    return { text: "📋 Напоминаний пока нет.\n\nНапиши, например: <code>завтра в 9:00 пара</code>", kb: null };
  }
  const now = nowSec();
  for (let i = 0; i < rows.length; i++) rows[i].show = showAt(rows[i], now, tz);
  rows.sort(function (a, b) { return a.show - b.show; });

  let text = "📋 <b>Твои напоминания</b>\n";
  const buttons = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    text += "\n" + (i + 1) + ". " + fmtDate(r.show, tz);
    if (r.rep) text += " 🔁 " + repName(r.rep, r.show, tz);
    if (r.state == 1) text += " 🔔 сейчас";
    text += "\n" + esc(trunc(r.text, 60)) + "\n";
    buttons.push([{ text: "🗑 " + (i + 1) + ". " + trunc(r.text, 25), callback_data: "xl:" + r.id }]);
  }
  text += "\nНажми на кнопку, чтобы удалить.";
  return { text: text, kb: { inline_keyboard: buttons } };
}

// ---------------------------------------------------------------------
// Обработка входящих сообщений
// ---------------------------------------------------------------------

async function handleUpdate(env, upd) {
  if (upd.callback_query) {
    await onButton(env, upd.callback_query);
    return;
  }
  const msg = upd.message;
  if (!msg || !msg.text || !msg.from) return;
  const chatId = msg.chat.id;

  if (!allowed(env, msg.from)) {
    await send(env, chatId, "⛔ Это личный бот. Твой Telegram ID: <code>" + msg.from.id + "</code>");
    return;
  }

  const text = msg.text.trim();
  const user = await getUser(env, chatId);

  if (text.startsWith("/")) {
    const first = text.split(/\s+/)[0];
    const cmd = first.split("@")[0].toLowerCase();
    const arg = text.slice(first.length).trim();
    if (cmd == "/start" || cmd == "/help") {
      await send(env, chatId, helpText(msg.from.id, user.tz));
    } else if (cmd == "/list") {
      const l = await buildList(env, chatId, user.tz);
      await send(env, chatId, l.text, l.kb);
    } else if (cmd == "/settings") {
      await send(env, chatId, settingsText(user), settingsKeyboard(user));
    } else if (cmd == "/tz") {
      await cmdTz(env, chatId, user, arg);
    } else {
      await send(env, chatId, "Не знаю такую команду. /help - справка");
    }
    return;
  }

  const now = nowSec();
  const p = parseMessage(text, user.tz, now);
  if (!p) {
    await send(env, chatId, "🤔 Не понял, когда напомнить.\nНачни сообщение со времени, например:\n" +
      "<code>завтра в 9:00 пара по физике</code>\n\n/help - все варианты");
    return;
  }
  if (p.error) {
    await send(env, chatId, "⚠️ " + p.error);
    return;
  }

  const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM reminders WHERE chat_id = ?").bind(chatId).first();
  if (cnt && cnt.c >= MAX_ACTIVE) {
    await send(env, chatId, "⚠️ Слишком много напоминаний (" + MAX_ACTIVE + "). Удали лишние через /list");
    return;
  }

  const next = planNext(p.at, user.pre, now);
  const res = await env.DB.prepare(
    "INSERT INTO reminders (chat_id, text, event_at, next_at, pre, every_min, times, state, nags, rep) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)"
  ).bind(chatId, p.text, p.at, next, user.pre, user.every_min, user.times, p.rep).run();

  const r = {
    id: res.meta.last_row_id, chat_id: chatId, text: p.text, event_at: p.at, next_at: next,
    pre: user.pre, every_min: user.every_min, times: user.times, state: 0, nags: 0, rep: p.rep
  };
  await send(env, chatId, cardText(r, user.tz, "✅ <b>Напоминание создано</b>"), cardKeyboard(r));
}

async function cmdTz(env, chatId, user, arg) {
  const m = /^(?:utc|gmt)?\s*([+-]?)(\d{1,2})(?::(\d{2}))?$/i.exec(arg);
  if (!m) {
    await send(env, chatId, "🌍 Сейчас: " + tzName(user.tz) + ", у тебя " + fmtTime(nowSec(), user.tz) + "\n\n" +
      "Чтобы поменять, напиши, например:\n<code>/tz +3</code> - Москва\n<code>/tz +5</code> - Екатеринбург\n" +
      "<code>/tz +7</code> - Новосибирск");
    return;
  }
  let mins = parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0);
  if (m[1] == "-") mins = -mins;
  if (mins < -720 || mins > 840) {
    await send(env, chatId, "⚠️ Такого часового пояса нет");
    return;
  }
  user.tz = mins;
  await saveUser(env, chatId, user);
  await send(env, chatId, "🌍 Часовой пояс: " + tzName(mins) + "\nСейчас у тебя " + fmtTime(nowSec(), mins) +
    "\n\nНовые напоминания будут считаться по этому времени.");
}

// Нажатия на кнопки
async function onButton(env, q) {
  if (!q.message || !q.from) return;
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;
  if (!allowed(env, q.from)) {
    await answer(env, q.id, "Нет доступа");
    return;
  }
  const parts = (q.data || "").split(":");
  const kind = parts[0];
  const user = await getUser(env, chatId);
  const now = nowSec();

  // Кнопки настроек
  if (kind == "sp" || kind == "se" || kind == "st") {
    if (kind == "sp") user.pre = togglePre(user.pre, parseInt(parts[1], 10));
    if (kind == "se") user.every_min = nextOption(EVERY_OPTIONS, user.every_min);
    if (kind == "st") user.times = nextOption(TIMES_OPTIONS, user.times);
    await saveUser(env, chatId, user);
    await edit(env, chatId, msgId, settingsText(user), settingsKeyboard(user));
    await answer(env, q.id, "Сохранено");
    return;
  }

  const id = parseInt(parts[1], 10);
  if (!id) {
    await answer(env, q.id, "");
    return;
  }
  // chat_id в условии обязателен: чужие напоминания трогать нельзя
  const r = await env.DB.prepare("SELECT * FROM reminders WHERE id = ? AND chat_id = ?").bind(id, chatId).first();

  // Удаление из списка
  if (kind == "xl") {
    if (r) await deleteReminder(env, r.id);
    const l = await buildList(env, chatId, user.tz);
    await edit(env, chatId, msgId, l.text, l.kb);
    await answer(env, q.id, r ? "Удалено" : "Уже удалено");
    return;
  }

  if (!r) {
    await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    await answer(env, q.id, "Этого напоминания уже нет");
    return;
  }

  // Удаление с карточки
  if (kind == "x") {
    await deleteReminder(env, r.id);
    await edit(env, chatId, msgId, "🗑 Удалено: " + esc(r.text));
    await answer(env, q.id, "Удалено");
    return;
  }

  // Включить/выключить "предупредить заранее"
  if (kind == "p") {
    r.pre = togglePre(r.pre, parseInt(parts[2], 10));
    if (r.state == 0) r.next_at = planNext(r.event_at, r.pre, now);
    if (r.state == 2 && r.rep) r.next_at = planNext(nextOccurrence(r, now, user.tz), r.pre, now);
    await env.DB.prepare("UPDATE reminders SET pre = ?, next_at = ? WHERE id = ?").bind(r.pre, r.next_at, r.id).run();
    await edit(env, chatId, msgId, cardText(r, user.tz, "✅ <b>Напоминание создано</b>"), cardKeyboard(r));
    await answer(env, q.id, "Готово");
    return;
  }

  // "Готово" и "Отложить": проверяем, что кнопка не от прошлого раза
  const evt = parseInt(parts[2], 10);
  if (evt != r.event_at) {
    await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    await answer(env, q.id, "Это напоминание уже неактуально");
    return;
  }

  if (kind == "d") {
    if (r.rep) {
      // повторяющееся: переносим на следующий раз
      let at = stepRep(r.event_at, r.rep, user.tz);
      while (at <= now) at = stepRep(at, r.rep, user.tz);
      const next = planNext(at, r.pre, now);
      await env.DB.prepare("UPDATE reminders SET event_at = ?, next_at = ?, state = 0, nags = 0 WHERE id = ?")
        .bind(at, next, r.id).run();
      await edit(env, chatId, msgId, "✅ Сделано: " + esc(r.text) + "\n🔁 Следующее: " + fmtDate(at, user.tz));
    } else {
      await deleteReminder(env, r.id);
      await edit(env, chatId, msgId, "✅ Сделано: " + esc(r.text));
    }
    await answer(env, q.id, "Отлично 👍");
    return;
  }

  if (kind == "s") {
    const min = parseInt(parts[3], 10);
    if (!(min > 0 && min <= 1440)) {
      await answer(env, q.id, "");
      return;
    }
    const next = now + min * 60;
    await env.DB.prepare("UPDATE reminders SET state = 1, nags = 0, next_at = ? WHERE id = ?").bind(next, r.id).run();
    await edit(env, chatId, msgId, "⏰ Отложено до " + fmtDate(next, user.tz) + ": " + esc(r.text));
    await answer(env, q.id, "Напомню " + fmtDate(next, user.tz));
    return;
  }

  await answer(env, q.id, "");
}

async function deleteReminder(env, id) {
  await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(id).run();
}

// ---------------------------------------------------------------------
// Рассылка напоминаний (cron раз в минуту)
// ---------------------------------------------------------------------

async function runDue(env) {
  const now = nowSec();
  const res = await env.DB.prepare(
    "SELECT r.*, COALESCE(u.tz, " + DEFAULT_TZ + ") AS tz FROM reminders r " +
    "LEFT JOIN users u ON u.chat_id = r.chat_id WHERE r.next_at <= ? ORDER BY r.next_at LIMIT " + BATCH
  ).bind(now).all();
  const rows = res.results;
  for (let i = 0; i < rows.length; i++) {
    try {
      await fireOne(env, rows[i], now);
    } catch (e) {
      console.log("Ошибка при отправке напоминания", rows[i].id, e.stack || e);
    }
  }
}

async function fireOne(env, r, now) {
  const tz = r.tz;

  // Отработавшее напоминание
  if (r.state == 2) {
    if (!r.rep) {
      await deleteReminder(env, r.id);   // чистим старое
      return;
    }
    // повторяющееся: начинаем следующий круг и сразу обрабатываем его
    let at = stepRep(r.event_at, r.rep, tz);
    while (at < r.next_at) at = stepRep(at, r.rep, tz);
    r.event_at = at;
    r.state = 0;
    r.nags = 0;
  }

  let text, kb;
  let state = r.state, nags = r.nags, next;
  let finished = false;

  if (r.state == 0 && now < r.event_at) {
    // Предупреждение заранее
    text = "⏳ Через " + fmtLeft(r.event_at - now) + ": <b>" + esc(r.text) + "</b>\n🗓 " + fmtDate(r.event_at, tz);
    kb = { inline_keyboard: [[{ text: "✅ Уже сделано", callback_data: "d:" + r.id + ":" + r.event_at }]] };
    next = planNext(r.event_at, r.pre, now);
  } else if (r.state == 0) {
    // Само событие
    text = "🔔 <b>" + esc(r.text) + "</b>\n🗓 " + fmtDate(r.event_at, tz);
    if (r.times > 0) text += "\n\nПовторю через " + r.every_min + " мин, если не нажмёшь «Готово»";
    kb = alertKeyboard(r);
    state = 1;
    nags = 0;
    if (r.times > 0) next = now + r.every_min * 60;
    else finished = true;
  } else {
    // Повтор
    nags = r.nags + 1;
    text = "🔔 Напоминаю ещё раз: <b>" + esc(r.text) + "</b>";
    if (r.times > 0) text += " (" + Math.min(nags, r.times) + "/" + r.times + ")";
    kb = alertKeyboard(r);
    if (nags < r.times) {
      next = now + r.every_min * 60;
    } else {
      finished = true;
      text += "\n\nБольше не повторяю. Можно отложить кнопкой ниже.";
    }
  }

  const res = await send(env, r.chat_id, text, kb);
  if (!res.ok) {
    const code = res.error_code || 0;
    // временная проблема - оставляем как есть, попробуем через минуту
    if (code == 0 || code == 429 || code >= 500) return;
    // бот заблокирован, чат удалён и т.п. - удаляем, чтобы не долбить Telegram
    await deleteReminder(env, r.id);
    return;
  }

  if (finished) {
    state = 2;
    if (r.rep) {
      let at = stepRep(r.event_at, r.rep, tz);
      while (at <= now) at = stepRep(at, r.rep, tz);
      next = planNext(at, r.pre, now);
    } else {
      next = now + 3 * 86400;
    }   // ещё 3 дня кнопки «отложить» будут работать, потом удалим
  }
  await env.DB.prepare("UPDATE reminders SET event_at = ?, next_at = ?, state = ?, nags = ? WHERE id = ?")
    .bind(r.event_at, next, state, nags, r.id).run();
}
