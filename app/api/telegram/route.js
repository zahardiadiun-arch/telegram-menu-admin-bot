import { get, put } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STATE_PATH = "telegram-menu-admin-bot/state.json";
const PLACEHOLDER = "...";
const LEGACY_PLACEHOLDER = "🚧 Цей розділ зараз у розробці.";

const initialButtons = [
  { id: "price", label: "📄 Прайс цін 📄" },
  { id: "order", label: "🚚 Замовити 🚚" },
  { id: "taxi", label: "🚚 Таксі і клади 📦" },
  { id: "reviews", label: "✍️ Відгуки ✍️" },
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
    sessions: {},
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
  fallback.sessions = value.sessions && typeof value.sessions === "object" ? value.sessions : {};
  return fallback;
}

async function readState() {
  try {
    const result = await get(STATE_PATH, { access: "private" });
    if (!result || result.statusCode !== 200) return emptyState();
    return normalizeState(await new Response(result.stream).json());
  } catch (error) {
    console.error("Unable to read bot state", error);
    return emptyState();
  }
}

async function writeState(state) {
  await put(STATE_PATH, JSON.stringify(state), {
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
      row("taxi", "reviews"),
      row("uah", "usd", "eur"),
      row("cards", "guide", "why"),
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Оберіть розділ",
  };
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛠 Редагувати кнопки", callback_data: "ad:buttons" }],
      [{ text: "📣 Розсилка розділу", callback_data: "ad:broadcast" }],
      [{ text: "⌨️ Звичайне меню", callback_data: "ad:public" }],
    ],
  };
}

function buttonPicker(state, prefix, title = "Оберіть кнопку") {
  return {
    text: title,
    reply_markup: {
      inline_keyboard: [
        ...state.buttons.map((button) => [{ text: button.label, callback_data: `${prefix}:${button.id}` }]),
        [{ text: "‹ Назад", callback_data: "ad:home" }],
      ],
    },
  };
}

function editKeyboard(button) {
  return {
    inline_keyboard: [
      [{ text: "✍️ Змінити текст", callback_data: `ad:text:${button.id}` }],
      [{ text: "🖼 Додати / замінити фото", callback_data: `ad:photo:${button.id}` }],
      ...(button.photoFileId ? [[{ text: "🗑 Видалити фото", callback_data: `ad:clearphoto:${button.id}` }]] : []),
      [{ text: "✏️ Змінити назву", callback_data: `ad:title:${button.id}` }],
      [{ text: "‹ До кнопок", callback_data: "ad:buttons" }],
    ],
  };
}

function findButton(state, id) {
  return state.buttons.find((button) => button.id === id);
}

function findButtonByLabel(state, label) {
  return state.buttons.find((button) => button.label === label);
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
    return telegram("sendPhoto", {
      chat_id: chatId,
      photo: button.photoFileId,
      caption: text,
      reply_markup: replyMarkup,
    });
  }
  return telegram("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
}

async function showAdmin(chatId, text = "Адмін-панель") {
  await telegram("sendMessage", { chat_id: chatId, text, reply_markup: adminKeyboard() });
}

async function showEdit(chatId, button) {
  const photoStatus = button.photoFileId ? "✅ фото встановлено" : "— фото немає";
  await telegram("sendMessage", {
    chat_id: chatId,
    text: `Кнопка: ${button.label}\n${photoStatus}\n\nОберіть, що редагувати:`,
    reply_markup: editKeyboard(button),
  });
}

async function handleAdminText(message, state) {
  const chatId = message.chat.id;
  const key = String(chatId);
  const session = state.sessions[key] || {};
  const text = message.text?.trim();

  if (text === "/cancel") {
    delete session.stage;
    delete session.awaitPassword;
    state.sessions[key] = session;
    await showAdmin(chatId, "Поточну дію скасовано.");
    return true;
  }

  if (session.awaitPassword) {
    if (text && text === process.env.ADMIN_PASSWORD) {
      state.sessions[key] = { authorized: true };
      await showAdmin(chatId, "✅ Доступ дозволено. Що змінюємо?");
    } else {
      await telegram("sendMessage", { chat_id: chatId, text: "Невірний пароль. Спробуйте ще раз або надішліть /cancel." });
    }
    return true;
  }

  if (!session.authorized || !session.stage) return false;
  const [kind, id] = session.stage.split(":");
  const button = findButton(state, id);
  if (!button) {
    delete session.stage;
    state.sessions[key] = session;
    await showAdmin(chatId, "Кнопку не знайдено. Оберіть її ще раз.");
    return true;
  }

  if (kind === "text") {
    if (!text) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть текстовий опис або /cancel." });
      return true;
    }
    button.text = text;
    delete session.stage;
    state.sessions[key] = session;
    await showEdit(chatId, button);
    return true;
  }

  if (kind === "title") {
    if (!text) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть нову назву кнопки або /cancel." });
      return true;
    }
    button.label = text.slice(0, 60);
    delete session.stage;
    state.sessions[key] = session;
    await showEdit(chatId, button);
    return true;
  }

  if (kind === "photo") {
    const photo = message.photo?.at(-1);
    if (!photo) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть саме фото як зображення (не файлом) або /cancel." });
      return true;
    }
    button.photoFileId = photo.file_id;
    delete session.stage;
    state.sessions[key] = session;
    await showEdit(chatId, button);
    return true;
  }

  return false;
}

async function handleCallback(query, state) {
  const data = query.data || "";
  const chatId = query.message?.chat?.id;
  const sessionKey = String(chatId);
  const session = state.sessions[sessionKey] || {};
  await telegram("answerCallbackQuery", { callback_query_id: query.id });

  if (data.startsWith("open:")) {
    const button = findButton(state, data.slice(5));
    if (button) await sendSection(chatId, button, menuKeyboard(state));
    return;
  }

  if (!session.authorized) return;

  const opensLegacyPublicMenu = data === "ad:home" && query.message?.text?.includes("Доступ дозволено");
  if (data === "ad:public" || opensLegacyPublicMenu) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "...",
      reply_markup: menuKeyboard(state),
    });
    return;
  }
  if (data === "ad:home") {
    await showAdmin(chatId);
    return;
  }
  if (data === "ad:buttons") {
    const picker = buttonPicker(state, "ad:edit", "Оберіть кнопку для редагування:");
    await telegram("sendMessage", { chat_id: chatId, ...picker });
    return;
  }
  if (data.startsWith("ad:edit:")) {
    const button = findButton(state, data.split(":")[2]);
    if (button) await showEdit(chatId, button);
    return;
  }
  if (data.startsWith("ad:text:") || data.startsWith("ad:title:") || data.startsWith("ad:photo:")) {
    const [, kind, id] = data.split(":");
    const button = findButton(state, id);
    if (!button) return;
    session.stage = `${kind}:${id}`;
    state.sessions[sessionKey] = session;
    const prompts = {
      text: `Надішліть новий текст для «${button.label}».`,
      title: `Надішліть нову назву для «${button.label}».`,
      photo: `Надішліть фото для «${button.label}» як зображення.`,
    };
    await telegram("sendMessage", { chat_id: chatId, text: `${prompts[kind]}\n\nДля скасування: /cancel` });
    return;
  }
  if (data.startsWith("ad:clearphoto:")) {
    const button = findButton(state, data.split(":")[2]);
    if (button) {
      button.photoFileId = null;
      await showEdit(chatId, button);
    }
    return;
  }
  if (data === "ad:broadcast") {
    const picker = buttonPicker(state, "ad:send", "Оберіть розділ для розсилки всім користувачам:");
    await telegram("sendMessage", { chat_id: chatId, ...picker });
    return;
  }
  if (data.startsWith("ad:send:")) {
    const button = findButton(state, data.split(":")[2]);
    if (!button) return;
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `Розіслати «${button.label}» усім, хто запускав бота?`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Так, розіслати", callback_data: `ad:confirm:${button.id}` }],
          [{ text: "‹ Скасувати", callback_data: "ad:home" }],
        ],
      },
    });
    return;
  }
  if (data.startsWith("ad:confirm:")) {
    const button = findButton(state, data.split(":")[2]);
    if (!button) return;
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
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "...",
          reply_markup: menuKeyboard(state),
        });
      } else if (command === "/admin123123321") {
        state.sessions[String(chatId)] = { awaitPassword: true };
        changed = true;
        await telegram("sendMessage", { chat_id: chatId, text: "Введіть пароль для адмін-панелі:" });
      } else {
        const session = state.sessions[String(chatId)] || {};
        const isEditingAdminContent = Boolean(session.awaitPassword || session.stage);
        const selectedButton = isEditingAdminContent ? null : findButtonByLabel(state, command);
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

