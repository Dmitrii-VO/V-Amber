// JS страницы /efir/. Вынесен из index.html в отдельный файл: 443-vhost на
// cloud отдаёт строгий CSP (script-src 'self'), инлайн-скрипты им запрещены.

/* ── Плеер ── */
(function () {
  var SRC = '/live/index.m3u8';
  var RETRY_MS = 7000;

  var video = document.getElementById('video');
  var overlay = document.getElementById('overlay');
  var overlayTitle = document.getElementById('overlayTitle');
  var overlayHint = document.getElementById('overlayHint');
  var badge = document.getElementById('liveBadge');
  var unmuteBtn = document.getElementById('unmute');

  var hls = null;
  var retryTimer = null;

  // Подвисания воспроизведения. Нужны, чтобы плашка «смотреть в ВК» из
  // фоновой строчки становилась заметной ровно тем зрителям, у кого видео
  // реально сыпется, — остальных она не отвлекает. Считаем события за окно:
  // одиночная заминка бывает у всех, две подряд — уже плохая связь.
  var TROUBLE_WINDOW_MS = 60000;
  var TROUBLE_CALM_MS = 180000;
  var TROUBLE_MIN_EVENTS = 2;
  var troubleAt = [];

  function markPlaybackTrouble() {
    var now = Date.now();
    troubleAt = troubleAt.filter(function (ts) { return now - ts < TROUBLE_WINDOW_MS; });
    troubleAt.push(now);
    if (troubleAt.length >= TROUBLE_MIN_EVENTS && window.efirOnPlaybackTrouble) {
      window.efirOnPlaybackTrouble(true);
    }
  }

  // Связь восстановилась — через TROUBLE_CALM_MS без заминок плашка снова
  // становится фоновой, чтобы не кричать на зрителя весь эфир из-за одного
  // плохого участка.
  setInterval(function () {
    if (!troubleAt.length) return;
    if (Date.now() - troubleAt[troubleAt.length - 1] < TROUBLE_CALM_MS) return;
    troubleAt = [];
    if (window.efirOnPlaybackTrouble) window.efirOnPlaybackTrouble(false);
  }, 30000);

  function showOffline() {
    overlay.classList.remove('hidden');
    overlayTitle.textContent = 'Эфир ещё не начался';
    overlayHint.textContent = 'Страница обновится сама, когда начнётся трансляция';
    badge.classList.remove('on');
  }

  function showAuthGate() {
    overlay.classList.remove('hidden');
    overlayTitle.textContent = 'Войдите, чтобы посмотреть эфир';
    overlayHint.textContent = 'Представьтесь в чате справа — трансляция откроется сразу после входа';
    badge.classList.remove('on');
  }

  function showLive() {
    overlay.classList.add('hidden');
    badge.classList.add('on');
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      start();
    }, RETRY_MS);
  }

  function stopHls() {
    if (hls) { hls.destroy(); hls = null; }
  }

  function start() {
    stopHls();
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        liveDurationInfinity: true,
        // короткий буфер — эфир торговый, важна близость к реальному времени
        maxBufferLength: 12
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        showLive();
        video.play().catch(function () {});
      });
      hls.on(Hls.Events.ERROR, function (_e, data) {
        // bufferStalledError — «картинка встала, ждём данные»: не фатально,
        // hls.js разберётся сам, но для зрителя это ровно то самое «тормозит».
        if (data.details === 'bufferStalledError' || data.fatal) markPlaybackTrouble();
        if (!data.fatal) return;
        // нет манифеста = эфир не идёт; всё остальное тоже лечим перезапуском
        stopHls();
        showOffline();
        scheduleRetry();
      });
      hls.loadSource(SRC);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS: нативный HLS
      video.src = SRC + '?_=' + Date.now();
      video.play().then(showLive).catch(function () {});
      video.onerror = function () {
        video.removeAttribute('src');
        video.load();
        showOffline();
        scheduleRetry();
      };
      video.onplaying = showLive;
    } else {
      overlayTitle.textContent = 'Браузер не поддерживает трансляцию';
      overlayHint.textContent = 'Откройте страницу в Safari, Chrome или Яндекс.Браузере';
    }
  }

  // Safari/iOS играет HLS нативно, без событий hls.js: там признак заминки —
  // штатный `waiting` (буфер опустел).
  video.addEventListener('waiting', function () {
    // Только после того, как воспроизведение реально пошло: `waiting` на
    // старте и после переключения звука — норма, а не проблема связи.
    if (video.currentTime > 0 && !video.paused) markPlaybackTrouble();
  });

  // автовоспроизведение разрешено только без звука — предлагаем включить
  video.addEventListener('playing', function () {
    if (video.muted) unmuteBtn.classList.add('show');
  });
  unmuteBtn.addEventListener('click', function () {
    video.muted = false;
    unmuteBtn.classList.remove('show');
  });

  // Картинка не должна показываться, пока зритель не авторизован в чате
  // (VK ID или имя+телефон) — чат-модуль ниже вызывает это после applyAuth().
  var started = false;
  window.efirStartPlayer = function () {
    if (started) return;
    started = true;
    showOffline();
    start();
  };
  window.efirStopPlayer = function () {
    started = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    stopHls();
    showAuthGate();
  };

  showAuthGate();
})();

/* ── Чат ── */
(function () {
  var API = '/chat';
  var POLL_MS = 3000;
  var STORAGE_KEY = 'efirChat';
  var CLIENT_KEY = 'efirClientId';

  var log = document.getElementById('chatLog');
  var form = document.getElementById('chatForm');
  var textInput = document.getElementById('chatText');
  var sendBtn = document.getElementById('chatSend');
  var joinPanel = document.getElementById('chatJoin');
  var joinName = document.getElementById('joinName');
  var joinPhone = document.getElementById('joinPhone');
  var joinError = document.getElementById('joinError');
  var joinBtn = document.getElementById('joinBtn');
  var who = document.getElementById('chatWho');
  var vkAuthBtn = document.getElementById('vkAuthBtn');
  var logoutBtn = document.getElementById('chatLogoutBtn');

  var lotCard = document.getElementById('lotCard');
  var lotPhoto = document.getElementById('lotPhoto');
  var lotCode = document.getElementById('lotCode');
  var lotTitle = document.getElementById('lotTitle');
  var lotPrice = document.getElementById('lotPrice');
  var lotPriceOld = document.getElementById('lotPriceOld');
  var lotMeta = document.getElementById('lotMeta');
  var lotHint = document.getElementById('lotHint');

  var viewerCount = document.getElementById('viewerCount');

  var mirrorBar = document.getElementById('mirrorBar');
  var mirrorLink = document.getElementById('mirrorLink');
  var mirrorText = document.getElementById('mirrorText');

  var auth = null;
  var lastSeq = null;
  var polling = false;
  var lotRev = null;
  var mirrorUrl = '';
  var playbackTrouble = false;

  // Возврат из VK: callback чат-сервиса редиректит на
  // /efir/#chatAuth=<base64url(json)> (инлайн-мостик запрещён CSP).
  // Фрагмент не уходит на сервер; сразу вычищаем его из адресной строки.
  if (location.hash.indexOf('#chatAuth=') === 0) {
    try {
      var b64 = location.hash.slice('#chatAuth='.length)
        .replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
      var payload = JSON.parse(new TextDecoder().decode(bytes));
      if (payload && payload.token) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          token: payload.token,
          name: payload.name || ''
        }));
      }
    } catch (e) { /* битый фрагмент — просто показываем форму входа */ }
    history.replaceState(null, '', location.pathname);
  }

  try { auth = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { auth = null; }

  // Случайный идентификатор вкладки-браузера для счётчика «сейчас смотрят».
  // Не привязан к человеку и не уходит никуда, кроме заголовка X-Efir-Client
  // на опросе чата: сервису он нужен только чтобы перезагрузка страницы и
  // вторая вкладка не считались двумя зрителями. Приватный режим/запрет
  // localStorage — id живёт в памяти вкладки, счётчик всё равно работает.
  var clientId = '';
  try { clientId = localStorage.getItem(CLIENT_KEY) || ''; } catch (e) { clientId = ''; }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) {
    clientId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem(CLIENT_KEY, clientId); } catch (e) { /* приватный режим */ }
  }

  // Кнопка «Войти через VK» — только если у сервиса настроен VK ID.
  // Вход по телефону временно скрыт (joinPhoneBlock hidden в index.html) —
  // divider внутри него трогать не нужно.
  fetch(API + '/config').then(function (r) { return r.json(); }).then(function (cfg) {
    if (cfg && cfg.vkAuth) vkAuthBtn.hidden = false;
  }).catch(function () {});

  // Возврат из VK с ошибкой
  if (location.hash === '#chatAuthError') {
    joinError.textContent = 'Вход через VK не удался — попробуйте ещё раз';
    history.replaceState(null, '', location.pathname);
  }

  function applyAuth() {
    if (auth && auth.token) {
      joinPanel.classList.add('hidden');
      who.textContent = auth.name || '';
      logoutBtn.hidden = false;
      if (window.efirStartPlayer) window.efirStartPlayer();
    } else {
      joinPanel.classList.remove('hidden');
      who.textContent = '';
      logoutBtn.hidden = true;
      if (window.efirStopPlayer) window.efirStopPlayer();
    }
  }

  logoutBtn.addEventListener('click', function () {
    auth = null;
    localStorage.removeItem(STORAGE_KEY);
    applyAuth();
  });

  function renderMessage(msg) {
    if (msg.kind === 'session') {
      var divider = document.createElement('div');
      divider.className = 'msg msg--session';
      divider.textContent = '— ' + msg.text + ' —';
      return divider;
    }
    var row = document.createElement('div');
    row.className = 'msg' + (msg.kind === 'service' ? ' msg--service' : '');
    var author = document.createElement('span');
    author.className = 'author';
    author.textContent = msg.name;
    var body = document.createElement('span');
    body.textContent = msg.text;
    row.appendChild(author);
    row.appendChild(body);
    return row;
  }

  function appendMessages(items) {
    if (!items.length) return;
    var pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    for (var i = 0; i < items.length; i++) {
      log.appendChild(renderMessage(items[i]));
      lastSeq = Math.max(lastSeq === null ? 0 : lastSeq, items[i].seq);
    }
    // не дёргаем скролл, если зритель читает историю выше
    if (pinned) log.scrollTop = log.scrollHeight;
    while (log.children.length > 300) log.removeChild(log.firstChild);
  }

  // Плашка «смотреть в ВК». Ссылку присылает V-Amber (см. cross-promo.js) и
  // только пока ВК-эфир реально идёт — на той стороне у состояния есть TTL,
  // поэтому мёртвая ссылка тут появиться не может. Показываем её всем и сразу
  // (зритель с плохой связью не должен ждать сообщения бота), но в спокойном
  // виде; заметной она становится, если плеер начал реально спотыкаться.
  function renderMirror() {
    if (!mirrorUrl) {
      mirrorBar.hidden = true;
      return;
    }
    mirrorLink.href = mirrorUrl;
    mirrorBar.className = 'mirror' + (playbackTrouble ? ' mirror--alert' : '');
    mirrorText.textContent = playbackTrouble
      ? 'Видео подтормаживает — этот же эфир идёт в ВК'
      : 'Тормозит видео или нет звука?';
    mirrorBar.hidden = false;
  }

  window.efirOnPlaybackTrouble = function (trouble) {
    if (playbackTrouble === trouble) return;
    playbackTrouble = trouble;
    renderMirror();
  };

  // «1 зритель / 2 зрителя / 5 зрителей». Счётчик считает открытые страницы
  // /efir/ (опрос чата с TTL на стороне сервиса), а не читателей HLS: зритель,
  // ушедший смотреть в ВК по плашке-зеркалу, страницу обычно не закрывает.
  function formatViewers(count) {
    var mod100 = count % 100;
    var mod10 = count % 10;
    var word = 'зрителей';
    if (mod100 < 11 || mod100 > 14) {
      if (mod10 === 1) word = 'зритель';
      else if (mod10 >= 2 && mod10 <= 4) word = 'зрителя';
    }
    return count + ' ' + word;
  }

  function renderViewers(count) {
    // 0 не показываем: сам зритель уже как минимум один, ноль означает лишь
    // что сервис ещё не успел его засчитать (или отдал старый формат ответа).
    if (!(count > 0)) {
      viewerCount.hidden = true;
      return;
    }
    viewerCount.textContent = '👁 ' + formatViewers(count);
    viewerCount.hidden = false;
  }

  function formatPrice(value) {
    // 2290 → «2 290 ₽»; Intl есть во всех целевых браузерах, но узкий
    // неразрывный пробел местами рисуется квадратом — ставим обычный NBSP.
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
  }

  // Карточка лота приезжает в ответе /chat/messages (см. chat-service):
  // оператор назвал артикул — здесь она и появляется.
  function renderLot(lot) {
    if (!lot) {
      lotCard.hidden = true;
      lotRev = null;
      return;
    }
    if (lot.rev === lotRev) return;
    lotRev = lot.rev;

    var closed = lot.status === 'closed';
    lotCard.className = 'lot' + (closed ? ' lot--closed' : '');
    lotCode.textContent = (closed ? 'Лот закрыт · ' : 'Лот ') + lot.code;
    lotTitle.textContent = lot.name || '';

    if (lot.price > 0) {
      lotPrice.textContent = formatPrice(lot.price);
      var showOld = lot.discount > 0 && lot.basePrice > lot.price;
      lotPriceOld.hidden = !showOld;
      if (showOld) lotPriceOld.textContent = formatPrice(lot.basePrice);
    } else {
      // Цена в МойСкладе бывает нулевой — оператор называет её голосом, и
      // карточка обновится следующим тиком. Пустое поле честнее, чем «0 ₽».
      lotPrice.textContent = 'Цена — в эфире';
      lotPriceOld.hidden = true;
    }

    var meta = [];
    if (typeof lot.availableStock === 'number') meta.push('В наличии: ' + lot.availableStock + ' шт');
    if (lot.category) meta.push(lot.category);
    lotMeta.textContent = meta.join(' · ');

    lotHint.textContent = closed ? '' : 'Бронь: напишите в чат «бронь ' + lot.code + '»';

    if (lot.photoUrl) {
      lotPhoto.src = lot.photoUrl;
      lotPhoto.hidden = false;
    } else {
      lotPhoto.removeAttribute('src');
      lotPhoto.hidden = true;
    }
    lotCard.hidden = false;
  }

  function poll() {
    if (polling) return;
    polling = true;
    var url = API + '/messages' + (lastSeq === null ? '' : '?after=' + lastSeq);
    fetch(url, { headers: { 'X-Efir-Client': clientId } })
      .then(function (r) { return r.json(); }).then(function (data) {
      renderLot(data.lot || null);
      renderViewers(typeof data.online === 'number' ? data.online : 0);
      var nextMirror = (data.broadcast && data.broadcast.vkMirrorUrl) || '';
      if (nextMirror !== mirrorUrl) {
        mirrorUrl = nextMirror;
        renderMirror();
      }
      var items = data.messages || [];
      // appendMessages двигает lastSeq по каждому реально полученному
      // сообщению. На latestSeq (глобальный максимум) не прыгаем: выдача
      // режется по PUBLIC_PAGE_SIZE, и хвост, не влезший в страницу, был бы
      // пропущен навсегда. latestSeq нужен только чтобы встать на курсор,
      // если на старте сессии показывать нечего.
      appendMessages(items);
      if (!items.length && lastSeq === null && typeof data.latestSeq === 'number') {
        lastSeq = data.latestSeq;
      }
    }).catch(function () { /* тихий ретрай следующим тиком */ }).finally(function () {
      polling = false;
    });
  }

  joinBtn.addEventListener('click', function () {
    joinError.textContent = '';
    joinBtn.disabled = true;
    fetch(API + '/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: joinName.value, phone: joinPhone.value })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { joinError.textContent = res.d.error || 'Не получилось войти'; return; }
        auth = { token: res.d.token, name: res.d.name };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
        applyAuth();
        textInput.focus();
      })
      .catch(function () { joinError.textContent = 'Нет связи с сервером, попробуйте ещё раз'; })
      .finally(function () { joinBtn.disabled = false; });
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!auth || !auth.token) { applyAuth(); return; }
    var text = textInput.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    fetch(API + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: auth.token, text: text })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 401) {
          // токен не пережил рестарт сервиса с чистым data-каталогом
          auth = null;
          localStorage.removeItem(STORAGE_KEY);
          applyAuth();
          return;
        }
        if (!res.ok) return; // 429 и прочее — сообщение остаётся в поле
        textInput.value = '';
        poll(); // сразу подтянуть своё сообщение
      })
      .catch(function () {})
      .finally(function () { sendBtn.disabled = false; });
  });

  applyAuth();
  poll();
  setInterval(poll, POLL_MS);
})();
