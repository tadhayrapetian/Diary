import { EventEmitter } from 'node:events';
import { htmlToText, normalizeSubject, snippetFrom, textToHtml } from './util.js';

/**
 * A complete mailbox that lives in memory. It lets the whole client run before an
 * account is wired in, and it is the same interface the IMAP store implements, so
 * the browser cannot tell the difference.
 */

const ME = { name: 'Вы', address: 'you@aether.local' };

const FOLDERS = [
  { id: 'inbox', name: 'Входящие', role: 'inbox' },
  { id: 'starred', name: 'Избранное', role: 'flagged', virtual: true },
  { id: 'drafts', name: 'Черновики', role: 'drafts' },
  { id: 'sent', name: 'Отправленные', role: 'sent' },
  { id: 'archive', name: 'Архив', role: 'archive' },
  { id: 'junk', name: 'Спам', role: 'junk' },
  { id: 'trash', name: 'Корзина', role: 'trash' },
  { id: 'work', name: 'Работа', role: null },
  { id: 'travel', name: 'Путешествия', role: null },
];

const people = {
  anna: { name: 'Анна Соколова', address: 'anna@studio-lumen.ru' },
  ilya: { name: 'Илья Морозов', address: 'ilya.morozov@devhaus.io' },
  mom: { name: 'Мама', address: 'mama.ira@mail.ru' },
  kate: { name: 'Катя Белова', address: 'kate.belova@gmail.com' },
  sky: { name: 'Небо Авиа', address: 'tickets@nebo-avia.example' },
  bank: { name: 'Банк «Север»', address: 'noreply@sever-bank.example' },
  digest: { name: 'Утренний дайджест', address: 'hello@morning-digest.example' },
  gh: { name: 'Code Review Bot', address: 'notifications@review.example' },
  max: { name: 'Max Fischer', address: 'max@northwind.design' },
  hr: { name: 'Ольга, HR', address: 'olga@devhaus.io' },
  studio: { name: 'Йога-студия «Тишина»', address: 'hello@tishina.example' },
  lena: { name: 'Лена Орлова', address: 'lena.orlova@yandex.ru' },
  spam: { name: 'Выигрыш!!!', address: 'winner@prize-now.example' },
};

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const SVG_COVER = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c6cff"/><stop offset=".55" stop-color="#ff7eb3"/><stop offset="1" stop-color="#ffc77d"/></linearGradient></defs>
  <rect width="1200" height="600" fill="url(#g)"/>
  <circle cx="930" cy="170" r="120" fill="#fff" fill-opacity=".25"/>
  <circle cx="260" cy="470" r="200" fill="#fff" fill-opacity=".12"/>
  <text x="80" y="330" font-family="Georgia, serif" font-size="96" fill="#fff">Lumen — v2</text>
  <text x="84" y="400" font-family="Helvetica, Arial" font-size="32" fill="#fff" fill-opacity=".85">новая айдентика · финальная версия</text>
</svg>`,
);

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    '4 0 obj<</Length 58>>stream\nBT /F1 28 Tf 72 700 Td (Aether demo attachment) Tj ET\nendstream endobj\n' +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

function seed() {
  const list = [];
  let n = 0;
  const add = (m) => {
    n += 1;
    const html = m.html ?? textToHtml(m.text ?? '');
    const text = m.text ?? htmlToText(html);
    list.push({
      id: String(n),
      folder: m.folder || 'inbox',
      from: m.from,
      to: m.to || [ME],
      cc: m.cc || [],
      replyTo: [],
      subject: m.subject,
      date: ago(m.ago),
      seen: Boolean(m.seen),
      flagged: Boolean(m.flagged),
      answered: false,
      html,
      text,
      plain: m.html == null,
      attachments: (m.attachments || []).map((a, index) => ({ index, ...a, size: a.content.length })),
      messageId: `<demo-${n}@aether.local>`,
      inReplyTo: null,
      references: [],
      threadKey: m.thread || normalizeSubject(m.subject),
    });
  };

  add({
    from: people.anna,
    subject: 'Финальная айдентика Lumen — посмотри до пятницы',
    ago: 7,
    flagged: true,
    attachments: [
      { filename: 'lumen-cover.svg', contentType: 'image/svg+xml', content: SVG_COVER, cid: 'cover@lumen', inline: true },
      { filename: 'Lumen_brandbook_v2.pdf', contentType: 'application/pdf', content: PDF },
    ],
    html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1d1d1f">
<p>Привет!</p>
<p>Собрала финальную версию айдентики для Lumen. Обложку прикладываю прямо в письмо, полный брендбук — PDF во вложении.</p>
<p><img src="cid:cover@lumen" alt="Обложка Lumen" style="width:100%;max-width:560px;border-radius:14px"></p>
<p>Что поменялось с прошлой итерации:</p>
<ul><li>градиент стал теплее, ушли от холодного синего;</li><li>логотип — тоньше штрих, лучше читается в 16px;</li><li>добавила вторую гарнитуру для длинных текстов.</li></ul>
<p>Клиент ждёт ответ <b>в пятницу до 12:00</b>. Если есть правки — пиши сегодня-завтра, успею.</p>
<p>Обнимаю,<br>Аня</p></div>`,
  });

  add({
    from: people.ilya,
    to: [ME, people.max],
    subject: 'Релиз 3.4: что катим в четверг',
    ago: 38,
    thread: 'release-34',
    text: `Коллеги, привет.

План на четверг:
1. Миграция базы — в 10:00, окно 20 минут.
2. Новый онбординг — под фича-флагом, 10% пользователей.
3. Фикс утечки памяти в воркере уведомлений.

Нужен апрув от тебя по пункту 2 до среды. Ещё вопрос: кто дежурит в выходные?

Илья`,
  });

  add({
    from: people.max,
    to: [people.ilya, ME],
    subject: 'Re: Релиз 3.4: что катим в четверг',
    ago: 24,
    thread: 'release-34',
    text: `Ilya, sounds good. I can take on-call this weekend.

One thing: let's keep the onboarding flag at 5% for the first day, then bump to 10% if error rates stay flat.

— Max

On Tue, Ilya Morozov wrote:
> План на четверг:
> 1. Миграция базы — в 10:00, окно 20 минут.`,
  });

  add({
    from: people.mom,
    subject: 'В воскресенье ждём на обед 🥧',
    ago: 95,
    text: `Солнышко, привет!

В воскресенье приезжай к двум, папа обещал испечь свой пирог с яблоками. Катя тоже будет.

Не забудь, пожалуйста, захватить тот удлинитель, который брал в прошлый раз.

Целую, мама`,
  });

  add({
    from: people.sky,
    folder: 'travel',
    subject: 'Ваш электронный билет: Москва → Калининград, 14 ноября',
    ago: 180,
    flagged: true,
    html: `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5fb;padding:24px 0;font-family:Helvetica,Arial,sans-serif">
<tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#1b4dff;color:#fff;padding:28px 32px;font-size:22px;font-weight:700">Небо Авиа · Посадочный готов</td></tr>
<tr><td style="padding:28px 32px;color:#1c2333;font-size:15px;line-height:1.6">
<p style="margin:0 0 16px">Здравствуйте! Ваш рейс <b>NA&nbsp;2241</b> подтверждён.</p>
<table width="100%" style="border-collapse:collapse;font-size:15px">
<tr><td style="color:#6b7385;padding:6px 0">Вылет</td><td align="right"><b>14 ноября, 08:35</b> · Шереметьево, B</td></tr>
<tr><td style="color:#6b7385;padding:6px 0">Прилёт</td><td align="right"><b>10:10</b> · Храброво</td></tr>
<tr><td style="color:#6b7385;padding:6px 0">Место</td><td align="right"><b>12A</b>, у окна</td></tr>
<tr><td style="color:#6b7385;padding:6px 0">Багаж</td><td align="right">1 × 23 кг</td></tr></table>
<p style="margin:24px 0 0"><img src="https://picsum.photos/seed/aether-flight/560/200" width="496" alt="Калининград" style="border-radius:12px;display:block"></p>
<p style="margin:24px 0 0;color:#6b7385;font-size:13px">Онлайн-регистрация откроется за 24 часа до вылета.</p>
</td></tr></table></td></tr></table>`,
  });

  add({
    from: people.bank,
    subject: 'Выписка за октябрь готова',
    ago: 260,
    seen: true,
    text: `Здравствуйте!

Ваша выписка по счёту •• 4417 за октябрь сформирована.
Поступления: 214 300 ₽
Списания: 168 940 ₽
Кэшбэк: 3 412 ₽

Это автоматическое письмо, отвечать на него не нужно.`,
  });

  add({
    from: people.digest,
    subject: '☕ 5 вещей, которые стоит знать этим утром',
    ago: 420,
    html: `<div style="max-width:600px;margin:0 auto;font-family:Georgia,serif;color:#222;line-height:1.65;font-size:17px">
<h1 style="font-size:30px;margin:0 0 6px">Доброе утро.</h1><p style="color:#888;margin:0 0 28px;font-family:Helvetica,Arial">Вторник · 4 минуты чтения</p>
<img src="https://picsum.photos/seed/aether-morning/600/260" width="600" alt="" style="width:100%;border-radius:8px">
<h2 style="font-size:21px;margin:28px 0 6px">1. Почему все снова пишут письма</h2><p>Длинные письма возвращаются: исследование показывает, что люди устали от мессенджеров и хотят говорить медленнее.</p>
<h2 style="font-size:21px;margin:28px 0 6px">2. Город без машин — на один день</h2><p>В воскресенье центр перекроют для пешеходов и велосипедистов. Карта маршрутов — внутри.</p>
<h2 style="font-size:21px;margin:28px 0 6px">3. Как спать лучше, ничего не покупая</h2><p>Три привычки, которые работают лучше любого гаджета.</p>
<p style="font-family:Helvetica,Arial;font-size:13px;color:#999;margin-top:40px">Вы получили это письмо, потому что подписались. <a href="https://example.com/unsubscribe" style="color:#999">Отписаться</a></p></div>`,
  });

  add({
    from: people.gh,
    folder: 'work',
    subject: '[aether/core] PR #482: Ускорить поиск по вложениям',
    ago: 520,
    seen: true,
    text: `@you запросили ваш ревью.

+214 −38 в 6 файлах
✓ Все проверки прошли

Описание: индекс по именам вложений теперь строится лениво, поиск по 50k писем — 40 мс вместо 900.`,
  });

  add({
    from: people.hr,
    folder: 'work',
    subject: 'Отпуск в декабре — подтверди даты',
    ago: 60 * 26,
    text: `Привет! Видим заявку на отпуск с 23 декабря по 8 января. Подтверди, пожалуйста, что даты верные, и я отправлю на согласование.

Хорошего дня!
Ольга`,
  });

  add({
    from: people.kate,
    subject: 'Фотки с дачи 📸',
    ago: 60 * 30,
    seen: true,
    text: `Скинула все фотки в общую папку, там их штук двести 😅 Выбери, какие напечатать для мамы, ладно?

И да — с тебя кофе за то, что я разбирала их два вечера.`,
  });

  add({
    from: people.studio,
    subject: 'Ваше место на субботней практике забронировано',
    ago: 60 * 50,
    seen: true,
    text: `Ждём вас в субботу в 10:00. Коврики есть в студии, приходите за 10 минут до начала.

Студия «Тишина»`,
  });

  add({
    from: people.lena,
    subject: 'Книга, которую обещала',
    ago: 60 * 75,
    seen: true,
    flagged: true,
    text: `Вспомнила название: «Ремесло» Ричарда Сеннета. Про то, как делать вещи хорошо ради самого дела. Очень в твоём духе.

Как прочитаешь — обсудим?`,
  });

  add({
    from: people.max,
    folder: 'work',
    subject: 'Design review notes — Aether onboarding',
    ago: 60 * 100,
    seen: true,
    text: `Hey,

Quick notes from today's review:
– The empty inbox illustration is lovely, keep it.
– Compose should open in under 100ms. It currently takes ~300ms on cold start.
– Let's try the softer shadow on cards.

Max`,
  });

  add({
    from: people.bank,
    subject: 'Вход в интернет-банк с нового устройства',
    ago: 60 * 140,
    seen: true,
    text: `Выполнен вход с устройства Safari, macOS. Если это были не вы — позвоните по номеру на обратной стороне карты.`,
  });

  add({
    from: people.anna,
    subject: 'Мудборд для Lumen',
    ago: 60 * 24 * 6,
    seen: true,
    text: `Скидываю мудборд — тёплые градиенты, много воздуха, мягкая типографика. Посмотри, что откликается.`,
  });

  add({
    from: people.spam,
    folder: 'junk',
    subject: 'ВЫ ВЫИГРАЛИ iPhone!!! Подтвердите получение',
    ago: 60 * 5,
    text: 'Поздравляем! Перейдите по ссылке и введите данные карты для оплаты доставки.',
  });

  add({
    from: ME,
    to: [people.anna],
    folder: 'sent',
    subject: 'Re: Мудборд для Lumen',
    ago: 60 * 24 * 5,
    seen: true,
    text: 'Очень круто! Больше всего нравятся вторая и пятая картинки. Давай в эту сторону.',
    thread: normalizeSubject('Мудборд для Lumen'),
  });

  add({
    from: ME,
    to: [people.ilya],
    folder: 'sent',
    subject: 'Ревью по онбордингу',
    ago: 60 * 48,
    seen: true,
    text: 'Посмотрел — всё ок, только поправь текст на третьем экране, он слишком длинный.',
  });

  add({
    from: people.sky,
    folder: 'archive',
    subject: 'Спасибо за полёт! Оцените поездку',
    ago: 60 * 24 * 20,
    seen: true,
    text: 'Расскажите, как прошёл полёт — это займёт минуту.',
  });

  return list;
}

const AUTO_REPLIES = [
  'Получил(а), спасибо! Посмотрю сегодня вечером и вернусь с ответом.',
  'Супер, договорились 🙌',
  'Спасибо за письмо! Отвечу подробнее завтра утром.',
];

export class DemoStore extends EventEmitter {
  constructor() {
    super();
    this.kind = 'demo';
    this.messages = seed();
    this.nextId = this.messages.length + 1;
  }

  async info() {
    return { name: 'Демо-ящик', address: ME.address };
  }

  async folders() {
    return FOLDERS.map((f) => {
      const inside = this.#inFolder(f.id);
      return {
        id: f.id,
        name: f.name,
        role: f.role,
        total: inside.length,
        unread: inside.filter((m) => !m.seen).length,
      };
    });
  }

  #inFolder(folder) {
    if (folder === 'starred') return this.messages.filter((m) => m.flagged && m.folder !== 'trash' && m.folder !== 'junk');
    return this.messages.filter((m) => m.folder === folder);
  }

  #find(id) {
    const m = this.messages.find((x) => x.id === String(id));
    if (!m) throw Object.assign(new Error('message not found'), { status: 404 });
    return m;
  }

  #summary(m) {
    return {
      id: m.id,
      folder: m.folder,
      threadId: m.threadKey,
      from: m.from,
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      snippet: snippetFrom(m.text),
      date: m.date,
      seen: m.seen,
      flagged: m.flagged,
      answered: m.answered,
      hasAttachments: m.attachments.some((a) => !a.inline),
    };
  }

  #full(m) {
    return {
      ...this.#summary(m),
      html: m.html,
      text: m.text,
      plain: Boolean(m.plain),
      replyTo: m.replyTo,
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      references: m.references,
      attachments: m.attachments.map(({ content, ...rest }) => rest),
    };
  }

  async list({ folder = 'inbox', q = '', filter = 'all', offset = 0, limit = 50 }) {
    let items = q ? this.messages.filter((m) => m.folder !== 'trash' || folder === 'trash') : this.#inFolder(folder);
    if (q) {
      const needle = q.toLowerCase();
      items = items.filter((m) =>
        [m.subject, m.text, m.from.name, m.from.address, ...m.to.map((t) => t.address), ...m.attachments.map((a) => a.filename)]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }
    if (filter === 'unread') items = items.filter((m) => !m.seen);
    if (filter === 'flagged') items = items.filter((m) => m.flagged);
    if (filter === 'attachments') items = items.filter((m) => m.attachments.some((a) => !a.inline));
    items = [...items].sort((a, b) => b.date.localeCompare(a.date));
    const page = items.slice(offset, offset + limit).map((m) => this.#summary(m));
    return { items: page, next: offset + limit < items.length ? offset + limit : null, total: items.length };
  }

  async get(_folder, id) {
    return this.#full(this.#find(id));
  }

  async thread(_folder, id) {
    const root = this.#find(id);
    return this.messages
      .filter((m) => m.threadKey === root.threadKey && m.folder !== 'trash')
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((m) => this.#full(m));
  }

  async attachment(_folder, id, index) {
    const a = this.#find(id).attachments[Number(index)];
    if (!a) throw Object.assign(new Error('attachment not found'), { status: 404 });
    return { filename: a.filename, contentType: a.contentType, content: a.content };
  }

  async flags(_folder, ids, { add = [], remove = [] }) {
    for (const id of ids) {
      const m = this.#find(id);
      for (const f of add) if (f in FLAG_KEYS) m[FLAG_KEYS[f]] = true;
      for (const f of remove) if (f in FLAG_KEYS) m[FLAG_KEYS[f]] = false;
    }
  }

  async move(_folder, ids, to) {
    const target = FOLDERS.find((f) => f.role === to || f.id === to);
    if (!target || target.virtual) throw Object.assign(new Error('no such folder'), { status: 400 });
    for (const id of ids) this.#find(id).folder = target.id;
  }

  async destroy(_folder, ids) {
    const drop = new Set(ids.map(String));
    this.messages = this.messages.filter((m) => !drop.has(m.id));
  }

  async send(mail) {
    const id = String(this.nextId++);
    const html = mail.html || textToHtml(mail.text || '');
    const sent = {
      id,
      folder: 'sent',
      from: ME,
      to: mail.to,
      cc: mail.cc || [],
      replyTo: [],
      subject: mail.subject || '(без темы)',
      date: new Date().toISOString(),
      seen: true,
      flagged: false,
      answered: false,
      html,
      text: mail.text || htmlToText(html),
      attachments: (mail.attachments || []).map((a, index) => ({
        index,
        filename: a.filename,
        contentType: a.contentType,
        content: a.content,
        size: a.content.length,
      })),
      messageId: `<demo-${id}@aether.local>`,
      inReplyTo: mail.inReplyTo || null,
      references: mail.references || [],
      threadKey: normalizeSubject(mail.subject),
    };
    if (mail.inReplyTo) {
      const original = this.messages.find((m) => m.messageId === mail.inReplyTo);
      if (original) {
        original.answered = true;
        sent.threadKey = original.threadKey;
      }
    }
    this.messages.push(sent);

    // Someone on the other end answers, so live delivery and notifications can be seen.
    const known = Object.values(people).find((p) => mail.to.some((t) => t.address.toLowerCase() === p.address));
    if (known && known !== people.spam) {
      setTimeout(() => {
        const rid = String(this.nextId++);
        const subject = /^re:/i.test(sent.subject) ? sent.subject : `Re: ${sent.subject}`;
        const text = AUTO_REPLIES[Number(rid) % AUTO_REPLIES.length];
        const reply = {
          ...sent,
          id: rid,
          folder: 'inbox',
          from: known,
          to: [ME],
          cc: [],
          subject,
          date: new Date().toISOString(),
          seen: false,
          text,
          html: textToHtml(text),
          plain: true,
          attachments: [],
          messageId: `<demo-${rid}@aether.local>`,
          inReplyTo: sent.messageId,
        };
        this.messages.push(reply);
        this.emit('new', { folder: 'inbox', message: this.#summary(reply) });
      }, 9000).unref?.();
    }
    return { id };
  }
}

const FLAG_KEYS = { seen: 'seen', flagged: 'flagged', answered: 'answered' };
