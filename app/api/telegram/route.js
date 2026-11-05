import { get, put } from "@vercel/blob";
import { createHmac, timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STATE_PATH = "telegram-menu-admin-bot/state.json";
const SESSION_PREFIX = "telegram-menu-admin-bot/sessions/";
const BUTTON_PREFIX = "telegram-menu-admin-bot/buttons/";
const BROADCAST_PATH = "telegram-menu-admin-bot/broadcast.json";
const PLACEHOLDER = "...";
const LEGACY_PLACEHOLDER = "🚧 Цей розділ зараз у розробці.";

const initialButtons = [
  { id: "price", label: "📄 Прайс цін 📄" },
  { id: "order", label: "🚚 Замовити 🚚" },
  { id: "taxi", label: "🚚 Таксі і клади 📦" },
  { id: "uah", label: "💵 Фото Гривни 🇺🇦" },
  { id: "usd", label: "💵 Фото Долари 🇺🇸" },
  { id: "eur", label: "💶 Фото Євро 🇪🇺" },
  { id: "cards", label: "💳 Картки банків 💳" },
  { id: "guide", label: "📑 Інструкція 📑" },
  { id: "why", label: "❓ Чому продаємо ❓" },
];

function emptyState() {
  return {
    buttons: initialButtons.map((button) => ({ ...button, text: PLACEHOLDER, photoFileId: null })),
    users: {},
  };
}

function normalizeState(value) {
  const fallback = emptyState();
  if (!value || typeof value !== "object") return fallback;

  const savedButtons = Array.isArray(value.buttons) ? value.buttons : [];
  fallback.buttons = fallback.buttons.map((fallbackButton) => {
    const saved = savedButtons.find((button) => button?.id === fallbackButton.id);
    const normalizedSaved = saved && typeof saved === "object" ? { ...saved } : {};
    if (normalizedSaved.text === LEGACY_PLACEHOLDER) normalizedSaved.text = PLACEHOLDER;
    return {
      ...fallbackButton,
      ...normalizedSaved,
      id: fallbackButton.id,
    };
  });
  fallback.users = value.users && typeof value.users === "object" ? value.users : {};
  return fallback;
}

async function readState() {
  try {
    const result = await get(STATE_PATH, { access: "private" });
    const state = !result || result.statusCode !== 200
      ? emptyState()
      : normalizeState(await new Response(result.stream).json());
    const savedButtons = await Promise.all(state.buttons.map((button) => readButton(button.id)));
    state.buttons = state.buttons.map((button, index) => savedButtons[index] || button);
    return state;
  } catch (error) {
    console.error("Unable to read bot state", error);
    return emptyState();
  }
}

async function writeState(state) {
  // Button contents are saved in their own files. Keeping only users here
  // prevents a slow webhook request from overwriting a newer button edit.
  await put(STATE_PATH, JSON.stringify({ users: state.users }), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

function buttonPath(id) {
  return `${BUTTON_PREFIX}${id}.json`;
}

function normalizeButton(value, id) {
  const fallback = initialButtons.find((button) => button.id === id);
  if (!fallback || !value || typeof value !== "object") return null;
  const text = value.text === LEGACY_PLACEHOLDER ? PLACEHOLDER : value.text;
  return {
    ...fallback,
    label: typeof value.label === "string" ? value.label.slice(0, 60) : fallback.label,
    text: typeof text === "string" ? text : PLACEHOLDER,
    photoFileId: typeof value.photoFileId === "string" ? value.photoFileId : null,
  };
}

async function readButton(id) {
  try {
    const result = await get(buttonPath(id), { access: "private" });
    if (!result || result.statusCode !== 200) return null;
    return normalizeButton(await new Response(result.stream).json(), id);
  } catch (error) {
    console.error("Unable to read button settings", error);
    return null;
  }
}

async function writeButton(button) {
  const normalized = normalizeButton(button, button.id);
  if (!normalized) throw new Error("Unknown button");
  await put(buttonPath(button.id), JSON.stringify(normalized), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

function sessionPath(chatId) {
  return `${SESSION_PREFIX}${String(chatId)}.json`;
}

function normalizeSession(value) {
  const stage = value?.stage;
  const isButtonEdit = stage
    && typeof stage === "object"
    && ["text", "title", "photo"].includes(stage.kind)
    && typeof stage.id === "string";
  if (isButtonEdit) return { stage: { kind: stage.kind, id: stage.id } };
  if (stage && typeof stage === "object" && ["broadcast-password", "broadcast-content", "broadcast-time"].includes(stage.kind)) {
    return { stage: { kind: stage.kind } };
  }
  return {};
}

async function readSession(chatId) {
  try {
    const result = await get(sessionPath(chatId), { access: "private" });
    if (!result || result.statusCode !== 200) return {};
    return normalizeSession(await new Response(result.stream).json());
  } catch (error) {
    console.error("Unable to read admin session", error);
    return {};
  }
}

async function writeSession(chatId, session) {
  await put(sessionPath(chatId), JSON.stringify(normalizeSession(session)), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

function normalizeBroadcast(value) {
  const content = value?.content;
  const validContent = content && typeof content === "object" && (
    (typeof content.text === "string" && content.text.trim()) || typeof content.photoFileId === "string"
  );
  const schedule = value?.schedule;
  const validSchedule = schedule && typeof schedule === "object"
    && ["hourly", "daily"].includes(schedule.mode)
    && (schedule.mode === "hourly" || Number.isInteger(schedule.hour));
  return {
    content: validContent ? {
      text: typeof content.text === "string" ? content.text.slice(0, 4096) : "",
      photoFileId: typeof content.photoFileId === "string" ? content.photoFileId : null,
    } : null,
    schedule: validSchedule ? {
      mode: schedule.mode,
      hour: schedule.mode === "daily" ? schedule.hour : null,
      enabled: schedule.enabled !== false,
      lastRunKey: typeof schedule.lastRunKey === "string" ? schedule.lastRunKey : "",
    } : null,
  };
}

async function readBroadcast() {
  try {
    const result = await get(BROADCAST_PATH, { access: "private" });
    if (!result || result.statusCode !== 200) return normalizeBroadcast(null);
    return normalizeBroadcast(await new Response(result.stream).json());
  } catch (error) {
    console.error("Unable to read broadcast settings", error);
    return normalizeBroadcast(null);
  }
}

async function writeBroadcast(broadcast) {
  await put(BROADCAST_PATH, JSON.stringify(normalizeBroadcast(broadcast)), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

function token() {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return process.env.TELEGRAM_BOT_TOKEN;
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram ${method} failed: ${data?.description || response.status}`);
  }
  return data.result;
}

function menuKeyboard(state) {
  const byId = Object.fromEntries(state.buttons.map((button) => [button.id, button]));
  const row = (...ids) => ids.map((id) => byId[id].label);
  return {
    keyboard: [
      row("price", "order"),
      row("taxi"),
      row("uah", "usd", "eur"),
      row("cards", "guide", "why"),
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Оберіть розділ",
  };
}

function makeAdminToken(chatId) {
  return createHmac("sha256", process.env.ADMIN_PASSWORD || "missing-password")
    .update(String(chatId))
    .digest("hex")
    .slice(0, 16);
}

function hasValidAdminToken(chatId, candidate) {
  if (!candidate || candidate.length !== 16) return false;
  const expected = makeAdminToken(chatId);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

function adminKeyboard(chatId) {
  const token = makeAdminToken(chatId);
  return {
    inline_keyboard: [
      [{ text: "🛠 Редагувати кнопки", callback_data: `ad:${token}:buttons` }],
      [{ text: "📣 Розсилка розділу", callback_data: `ad:${token}:broadcast` }],
      [{ text: "⌨️ Звичайне меню", callback_data: `ad:${token}:public` }],
    ],
  };
}

function buttonPicker(state, chatId, action, title = "Оберіть кнопку") {
  const token = makeAdminToken(chatId);
  return {
    text: title,
    reply_markup: {
      inline_keyboard: [
        ...state.buttons.map((button) => [{ text: button.label, callback_data: `ad:${token}:${action}:${button.id}` }]),
        [{ text: "‹ До адмін-панелі", callback_data: `ad:${token}:admin` }],
      ],
    },
  };
}

function editKeyboard(button, chatId) {
  const token = makeAdminToken(chatId);
  return {
    inline_keyboard: [
      [{ text: "✍️ Змінити текст", callback_data: `ad:${token}:text:${button.id}` }],
      [{ text: "🖼 Додати / замінити фото", callback_data: `ad:${token}:photo:${button.id}` }],
      ...(button.photoFileId ? [[{ text: "🗑 Видалити фото", callback_data: `ad:${token}:clearphoto:${button.id}` }]] : []),
      [{ text: "✏️ Змінити назву", callback_data: `ad:${token}:title:${button.id}` }],
      [{ text: "‹ До кнопок", callback_data: `ad:${token}:buttons` }],
    ],
  };
}

function findButton(state, id) {
  return state.buttons.find((button) => button.id === id);
}

function findButtonByLabel(state, label) {
  return state.buttons.find((button) => button.label === label);
}

async function showPublicMenu(state, chatId) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "...",
    reply_markup: menuKeyboard(state),
  });
}

function rememberUser(state, chat, user) {
  if (!chat?.id) return false;
  const key = String(chat.id);
  const old = state.users[key];
  state.users[key] = {
    chatId: chat.id,
    firstName: user?.first_name || old?.firstName || "",
    username: user?.username || old?.username || "",
    startedAt: old?.startedAt || new Date().toISOString(),
  };
  return !old || old.firstName !== state.users[key].firstName || old.username !== state.users[key].username;
}

async function sendSection(chatId, button, replyMarkup) {
  const text = button.text?.trim() || PLACEHOLDER;
  if (button.photoFileId) {
    await telegram("sendPhoto", {
      chat_id: chatId,
      photo: button.photoFileId,
      ...(text.length <= 1024 ? { caption: text, reply_markup: replyMarkup } : { reply_markup: replyMarkup }),
    });
    if (text.length > 1024) return telegram("sendMessage", { chat_id: chatId, text });
    return;
  }
  return telegram("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
}

async function sendBroadcastContent(chatId, content) {
  const text = content.text?.trim() || "";
  if (content.photoFileId) {
    await telegram("sendPhoto", {
      chat_id: chatId,
      photo: content.photoFileId,
      ...(text && text.length <= 1024 ? { caption: text } : {}),
    });
    if (text.length > 1024) await telegram("sendMessage", { chat_id: chatId, text });
    return;
  }
  await telegram("sendMessage", { chat_id: chatId, text });
}

async function deliverBroadcast(state, content) {
  let delivered = 0;
  let failed = 0;
  for (const user of Object.values(state.users)) {
    try {
      await sendBroadcastContent(user.chatId, content);
      delivered += 1;
    } catch (error) {
      failed += 1;
      console.error("Broadcast delivery failed", error);
    }
  }
  return { delivered, failed };
}

async function showAdmin(chatId, text = "Адмін-панель") {
  await telegram("sendMessage", { chat_id: chatId, text, reply_markup: adminKeyboard(chatId) });
}

function broadcastKeyboard(chatId, broadcast) {
  const adminToken = makeAdminToken(chatId);
  const hasContent = Boolean(broadcast.content);
  const schedule = broadcast.schedule?.enabled ? broadcast.schedule : null;
  const scheduleText = !schedule
    ? "Розклад: вимкнено"
    : schedule.mode === "hourly"
      ? "Розклад: щогодини"
      : `Розклад: щодня о ${String(schedule.hour).padStart(2, "0")}:00`;
  return {
    text: `${hasContent ? "✅ Повідомлення підготовлено" : "⚠️ Повідомлення ще не додано"}\n${scheduleText}\n\nОберіть дію:`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "📝 Додати / замінити повідомлення", callback_data: `ad:${adminToken}:bcontent` }],
        [{ text: "📣 Надіслати зараз", callback_data: `ad:${adminToken}:bnow` }],
        [{ text: "🕐 Розсилати щогодини", callback_data: `ad:${adminToken}:bhourly` }],
        [{ text: "📅 Розсилати щодня", callback_data: `ad:${adminToken}:bdaily` }],
        [{ text: "⏹ Вимкнути розклад", callback_data: `ad:${adminToken}:boff` }],
        [{ text: "‹ До адмін-панелі", callback_data: `ad:${adminToken}:admin` }],
      ],
    },
  };
}

async function showBroadcastPanel(chatId, note = "") {
  const broadcast = await readBroadcast();
  const panel = broadcastKeyboard(chatId, broadcast);
  await telegram("sendMessage", {
    chat_id: chatId,
    text: note ? `${note}\n\n${panel.text}` : panel.text,
    reply_markup: panel.reply_markup,
  });
}

async function showEdit(chatId, button, savedMessage = "") {
  const photoStatus = button.photoFileId ? "✅ фото встановлено" : "— фото немає";
  const contentPreview = button.text?.trim()
    ? `Текст зараз: ${button.text.trim().slice(0, 350)}`
    : "Текст зараз: ...";
  const confirmation = savedMessage ? `✅ ${savedMessage}\n\n` : "";
  await telegram("sendMessage", {
    chat_id: chatId,
    text: `${confirmation}Кнопка: ${button.label}\n${photoStatus}\n${contentPreview}\n\nОберіть, що редагувати:`,
    reply_markup: editKeyboard(button, chatId),
  });
}

async function handleAdminText(message, state) {
  const chatId = message.chat.id;
  const session = await readSession(chatId);
  const text = message.text?.trim();

  if (text === "/cancel") {
    await writeSession(chatId, {});
    await showAdmin(chatId, "Поточну дію скасовано.");
    return true;
  }

  if (session.stage?.kind === "broadcast-password") {
    if (text !== process.env.ADMIN_PASSWORD) {
      await telegram("sendMessage", { chat_id: chatId, text: "Невірний пароль. Спробуйте ще раз або /cancel." });
      return true;
    }
    await writeSession(chatId, {});
    await showBroadcastPanel(chatId, "✅ Доступ до розсилок дозволено.");
    return true;
  }

  // A valid password always opens a fresh admin panel. There is no sticky
  // "waiting for password" state that can accidentally block the public menu.
  if (text && text === process.env.ADMIN_PASSWORD) {
    await writeSession(chatId, {});
    await showAdmin(chatId, "✅ Доступ дозволено. Що змінюємо?");
    return true;
  }

  if (!session.stage) return false;
  const { kind, id } = session.stage;

  if (kind === "broadcast-content") {
    const photo = message.photo?.at(-1);
    const contentText = photo ? (message.caption?.trim() || "") : text;
    if (!photo && !contentText) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть текст або фото з підписом. Для скасування: /cancel" });
      return true;
    }
    const broadcast = await readBroadcast();
    broadcast.content = { text: contentText || "", photoFileId: photo?.file_id || null };
    await writeBroadcast(broadcast);
    await writeSession(chatId, {});
    await showBroadcastPanel(chatId, "✅ Повідомлення для розсилки збережено.");
    return true;
  }

  if (kind === "broadcast-time") {
    const match = text?.match(/^(?:[01]?\d|2[0-3])(?::00)?$/);
    if (!match) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть годину від 0 до 23, наприклад: 19 або 19:00. Для скасування: /cancel" });
      return true;
    }
    const broadcast = await readBroadcast();
    if (!broadcast.content) {
      await writeSession(chatId, {});
      await showBroadcastPanel(chatId, "Спочатку додайте повідомлення для розсилки.");
      return true;
    }
    broadcast.schedule = { mode: "daily", hour: Number(match[0].split(":")[0]), enabled: true, lastRunKey: "" };
    await writeBroadcast(broadcast);
    await writeSession(chatId, {});
    await showBroadcastPanel(chatId, "✅ Щоденну розсилку увімкнено.");
    return true;
  }

  const button = findButton(state, id);
  if (!button) {
    await writeSession(chatId, {});
    await showAdmin(chatId, "Кнопку не знайдено. Оберіть її ще раз.");
    return true;
  }

  if (kind === "text") {
    if (!text) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть текстовий опис або /cancel." });
      return true;
    }
    button.text = text;
    await writeButton(button);
    await writeSession(chatId, {});
    await showEdit(chatId, button, "Текст збережено.");
    return true;
  }

  if (kind === "title") {
    if (!text) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть нову назву кнопки або /cancel." });
      return true;
    }
    button.label = text.slice(0, 60);
    await writeButton(button);
    await writeSession(chatId, {});
    await showEdit(chatId, button, "Назву кнопки збережено.");
    return true;
  }

  if (kind === "photo") {
    const photo = message.photo?.at(-1);
    if (!photo) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть саме фото як зображення (не файлом) або /cancel." });
      return true;
    }
    button.photoFileId = photo.file_id;
    await writeButton(button);
    await writeSession(chatId, {});
    await showEdit(chatId, button, "Фото збережено.");
    return true;
  }

  return false;
}

async function handleCallback(query, state) {
  const data = query.data || "";
  const chatId = query.message?.chat?.id;
  await telegram("answerCallbackQuery", { callback_query_id: query.id });

  if (data.startsWith("open:")) {
    const button = findButton(state, data.slice(5));
    if (button) await sendSection(chatId, button, menuKeyboard(state));
    return;
  }

  const [, receivedToken, action, id] = data.split(":");
  if (!hasValidAdminToken(chatId, receivedToken)) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "Ця стара адмін-панель більше не активна. Надішліть /admin123123321 і пароль ще раз.",
    });
    return;
  }

  if (action === "public") {
    await showPublicMenu(state, chatId);
    return;
  }
  if (action === "admin") {
    await showAdmin(chatId);
    return;
  }
  if (action === "buttons") {
    const picker = buttonPicker(state, chatId, "edit", "Оберіть кнопку для редагування:");
    await telegram("sendMessage", { chat_id: chatId, ...picker });
    return;
  }

  if (action === "bcontent") {
    await writeSession(chatId, { stage: { kind: "broadcast-content" } });
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "Надішліть текст для розсилки або фото з підписом. Для скасування: /cancel",
    });
    return;
  }
  if (action === "bnow") {
    const broadcast = await readBroadcast();
    if (!broadcast.content) {
      await showBroadcastPanel(chatId, "Спочатку додайте повідомлення для розсилки.");
      return;
    }
    const adminToken = makeAdminToken(chatId);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `Надіслати підготовлене повідомлення всім ${Object.keys(state.users).length} користувачам?`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Так, надіслати", callback_data: `ad:${adminToken}:bconfirm` }],
          [{ text: "‹ Скасувати", callback_data: `ad:${adminToken}:bmenu` }],
        ],
      },
    });
    return;
  }
  if (action === "bconfirm") {
    const broadcast = await readBroadcast();
    if (!broadcast.content) {
      await showBroadcastPanel(chatId, "Повідомлення для розсилки не знайдено.");
      return;
    }
    const result = await deliverBroadcast(state, broadcast.content);
    await showBroadcastPanel(chatId, `✅ Розсилку завершено. Надіслано: ${result.delivered}. Не доставлено: ${result.failed}.`);
    return;
  }
  if (action === "bhourly") {
    const broadcast = await readBroadcast();
    if (!broadcast.content) {
      await showBroadcastPanel(chatId, "Спочатку додайте повідомлення для розсилки.");
      return;
    }
    broadcast.schedule = { mode: "hourly", hour: null, enabled: true, lastRunKey: "" };
    await writeBroadcast(broadcast);
    await showBroadcastPanel(chatId, "✅ Щогодинну розсилку увімкнено.");
    return;
  }
  if (action === "bdaily") {
    const broadcast = await readBroadcast();
    if (!broadcast.content) {
      await showBroadcastPanel(chatId, "Спочатку додайте повідомлення для розсилки.");
      return;
    }
    await writeSession(chatId, { stage: { kind: "broadcast-time" } });
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "О котрій годині розсилати щодня за київським часом? Надішліть годину, наприклад: 19 або 19:00.",
    });
    return;
  }
  if (action === "boff") {
    const broadcast = await readBroadcast();
    broadcast.schedule = null;
    await writeBroadcast(broadcast);
    await showBroadcastPanel(chatId, "✅ Розклад вимкнено.");
    return;
  }
  if (action === "bmenu") {
    await showBroadcastPanel(chatId);
    return;
  }

  const button = id ? findButton(state, id) : null;
  if (["edit", "text", "title", "photo", "clearphoto", "send", "confirm"].includes(action) && !button) return;

  if (action === "edit") {
    await showEdit(chatId, button);
    return;
  }
  if (["text", "title", "photo"].includes(action)) {
    const prompts = {
      text: `Надішліть новий текст для «${button.label}».`,
      title: `Надішліть нову назву для «${button.label}».`,
      photo: `Надішліть фото для «${button.label}» як зображення.`,
    };
    // Sessions live in a separate Blob per chat. A stale settings write can
    // therefore never turn a photo edit back into an old text edit.
    await writeSession(chatId, { stage: { kind: action, id } });
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `${prompts[action]}\n\nПросто надішліть текст або фото в чат. Для скасування: /cancel`,
    });
    return;
  }
  if (action === "clearphoto") {
    button.photoFileId = null;
    await writeButton(button);
    await showEdit(chatId, button);
    return;
  }
  if (action === "broadcast") {
    const picker = buttonPicker(state, chatId, "send", "Оберіть розділ для розсилки всім користувачам:");
    await telegram("sendMessage", { chat_id: chatId, ...picker });
    return;
  }
  if (action === "send") {
    const token = makeAdminToken(chatId);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `Розіслати «${button.label}» усім, хто запускав бота?`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Так, розіслати", callback_data: `ad:${token}:confirm:${button.id}` }],
          [{ text: "‹ До адмін-панелі", callback_data: `ad:${token}:admin` }],
        ],
      },
    });
    return;
  }
  if (action === "confirm") {
    let delivered = 0;
    let failed = 0;
    for (const user of Object.values(state.users)) {
      try {
        await sendSection(user.chatId, button);
        delivered += 1;
      } catch (error) {
        failed += 1;
        console.error("Broadcast delivery failed", error);
      }
    }
    await showAdmin(chatId, `Розсилку завершено. Надіслано: ${delivered}. Не доставлено: ${failed}.`);
  }
}

export async function POST(request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const receivedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!expectedSecret || receivedSecret !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const update = await request.json();
    const state = await readState();
    let changed = false;

    if (update.message) {
      const { message } = update;
      changed ||= rememberUser(state, message.chat, message.from);
      const chatId = message.chat.id;
      const command = message.text?.trim();

      if (command === "/start") {
        await writeSession(chatId, {});
        await showPublicMenu(state, chatId);
        changed = true;
      } else if (command === "/admin123123321") {
        await writeSession(chatId, {});
        changed = true;
        await telegram("sendMessage", { chat_id: chatId, text: "Введіть пароль для адмін-панелі:" });
      } else if (command?.startsWith("/startbroadcastdrkbnk")) {
        await writeSession(chatId, { stage: { kind: "broadcast-password" } });
        changed = true;
        await telegram("sendMessage", { chat_id: chatId, text: "Введіть пароль для розсилок:" });
      } else {
        // Public-menu buttons always win over any unfinished edit action.
        // A user can therefore leave editing by simply choosing a section.
        const selectedButton = findButtonByLabel(state, command);
        if (selectedButton) {
          await sendSection(chatId, selectedButton, menuKeyboard(state));
        }
        const handled = selectedButton ? false : await handleAdminText(message, state);
        if (handled) changed = true;
      }
    }

    if (update.callback_query) {
      const query = update.callback_query;
      changed ||= rememberUser(state, query.message?.chat, query.from);
      await handleCallback(query, state);
      if (query.data?.startsWith("ad:")) changed = true;
    }

    if (changed) await writeState(state);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook failed", error);
    return Response.json({ ok: true });
  }
}

