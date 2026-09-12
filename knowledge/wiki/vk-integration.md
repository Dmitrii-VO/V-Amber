# VK integration

VK API is used for live video comments, lot-card publication, reservation
replies, discount notifications, and lot close messages.

## Runtime files

- `server/vk.js` owns VK API calls, URL validation, comment polling, and
  throttling/backoff.
- `server/ws-server.js` coordinates VK events with active lots and reservation
  state.
- `web-ui/app.js` lets the operator provide or persist a VK live video URL.

## Operational notes

The VK client includes rate-limit protection for `VK API 6`. The live video URL
must be valid and must not parse to zero IDs.

### Queue priority and poll cadence (since 2026-06-06)

`server/vk.js` runs all VK calls through one rate-limited queue (single
`minApiIntervalMs` gate, adaptive `backoffMultiplier` up to ×8 on `VK API 6`).
Since 2026-07-05 the penalty decays gradually on success (×8 → ×4 → ×2 → ×1,
one halving per successful call) instead of resetting to ×1: the instant reset
caused rate-limit thrash during comment storms — each successful publish
restored full speed and the very next poll hit `VK API 6` again (33 warnings
in 3.5 minutes during the 2026-07-05 эфир).
The queue has **two lanes**: publishing (cards/price/replies/lot-closed/photo
upload) is high priority and preempts the low-priority `video.getComments` poll,
so a polling burst never delays a reservation reply. The comment poll cadence in
`server/ws-server.js` is adaptive — ~1.5 s active, ramping to 8 s when quiet
(was a fixed 2 s). Lot cards also degrade to text-only when a photo upload fails
or VK returns `error_code 100`. Details in [[vk-comments]].

Since 2026-06-08, the poller also stays alive for a 30-second grace window after
the last open lot closes. Comments that look like reservations during that gap
are escalated as `reservationAttention` with no automatic reservation, so the
operator can handle late or between-lot bookings manually.

## Публикация: комментарии к записи эфира (с 2026-09-13)

Карточки лота, подтверждения броней, объявление победителя конкурса и
инструкция зрителям уходят через **`wall.createComment` под ГРУППОВЫМ
токеном** с `from_group=1` — то есть от имени сообщества.

Видео эфира висит на записи стены, и комментарии под видео — это её
комментарии. `video.createComment` сообществу закрыт (ошибка 27), а
`wall.createComment` — открыт. Проверено на боевом эфире 13.09.2026:
комментарий ушёл групповым токеном (`comment_id=302807`) и появился под видео
с подписью «Амберри — натуральный янтарь… · Автор».

Что это даёт:

- эфир перестал зависеть от пользовательского токена, который ВК 12.09
  заблокировал по флуду (см. раздел про Long Poll выше);
- зал видит ответы **от сообщества**, а не от человека — старая претензия
  оператора «чтобы не Амбер Стандарт писал» закрыта;
- читать стену сообществу по-прежнему нельзя (`wall.get`, `wall.getById`,
  `wall.getComments` → ошибка 27), но чтение и не нужно: комментарии приходят
  событиями Long Poll.

### Откуда берётся `post_id`

1. Событие `wall_reply_new` приходит **зеркалом** к каждому
   `video_comment_new` и несёт `post_id` — `server/vk.js` запоминает его сам
   при первом же комментарии зрителя. Как комментарий зеркальное событие не
   разбирается, иначе зал задвоится.
2. `VK_LIVE_POST_ID` в `.env` — когда публиковать надо до того, как кто-то
   написал (первая карточка лота в начале эфира).

`setLiveVideoUrl` **сбрасывает** запомненный `post_id`: новый эфир — новая
запись, иначе карточки уйдут под вчерашнее видео.

### Ограничение

Подтверждение брони больше не ответ в ветке, а отдельный комментарий с именем
покупателя в начале: `«Аня, бронь принята (код 03900)»`. Id комментария к
видео и id комментария к записи — разные пространства, ответить по первому
через `wall.createComment` нельзя. Сопоставить их можно по паре событий
(`from_id`, `date`, `text`) — помечено `ponytail:` в `server/vk.js`.

Запасной путь через `video.createComment` под пользовательским токеном
сохранён: он включается сам, пока `post_id` неизвестен.

## Token routing (critical)

**`VK_GROUP_TOKEN` — единственный VK-токен.** Пользовательский убран
13.09.2026 вместе со всеми `video.*` вызовами.

| что | метод | почему сообществу можно |
|---|---|---|
| комментарии зрителей | Long Poll `wall_reply_new` | событие, а не чтение |
| карточки, брони, конкурс | `wall.createComment` (+`from_group=1`) | стена сообществу открыта |
| удаление комментария | `wall.deleteComment` | там же |
| бан спамера | `groups.ban` | право `manage` |
| имена зрителей | `users.get` | доступен и групповому |
| ЛС покупателю | `messages.send` | профильный метод сообщества |

`video.*` сообществу закрыт целиком: чтение и публикация отвечают
`error_code 27`, `video.get` — `error_code 5`. Поэтому:

- **зал принимаем из `wall_reply_new`**, а не из `video_comment_new`: id
  комментария к записи — то же пространство, что публикация, ответ веткой и
  удаление. Событие видео осталось опознавателем записи (см. выше);
- **ссылку эфира больше не валидируем через API** — разбираем только текст.
  Закрытые комментарии всплывут ошибкой 214 при первой публикации и поднимут
  баннер оператору;
- **запасного пути нет**: опрос `video.getComments` удалён. Выключенное
  событие Long Poll = глухой эфир, поэтому проверка перед эфиром
  (`node scripts/vk-token-check.js`) обязательна.

Исторический контекст (почему когда-то был user-токен и как он умер) —
[[vk-comments]] и разделы выше про эфир 12.09.2026.


## Приём комментариев: Long Poll сообщества (с 2026-09-12)

Основной канал входящих комментариев — **событие `video_comment_new` в Long
Poll сообщества**, под `VK_GROUP_TOKEN`. Опрос `video.getComments` остался
запасным путём и включается сам, если Long Poll недоступен.

Почему так. Эфир 2026-09-12: ВК заблокировал аккаунт `VK_USER_TOKEN` по флуду
(`error_code 9`, Flood control), и **249 из 249** опросов упали. Комментариев
за два часа — ноль, броней — ноль, конкурс закрылся с `attempts: 0`, карточки
лота в ВК не ушли (`publish_failed` ×186). Причина блока — объём: 357
комментариев с одного пользовательского аккаунта за эфир плюс опрос раз в
1–2 секунды. До этого та же линия давала `error_code 6` (29.08) и `29` (30.08).

Что даёт событийный канал:

- ходит по своей трубе (`lp.vk.com`), **квоту VK API не ест** и под флуд-блок
  user-аккаунта не попадает — проверено: `groups.getLongPollServer` и
  `users.get` под групповым токеном отвечают, когда `video.getComments` под
  user-токеном возвращает 9;
- комментарий приходит сразу, без задержки опроса (1–9 с при backoff).

Чего он **не** чинит: публикацию. `video.createComment` под групповой
авторизацией ВК не принимает (`error_code 27`), поэтому карточки лота, ответы
о бронях и объявление победителя конкурса по-прежнему требуют живого
`VK_USER_TOKEN`. При мёртвом user-токене эфир работает «на приём»: брони
регистрируются, зал их подтверждения в ВК не видит (в зеркале `/efir/` —
видит).

### Включение (один раз, руками)

Управление сообществом → Работа с API → Long Poll API → **Типы событий** →
«Комментарий к видео: добавлен». Плюс сам Long Poll должен быть включён.

Приложение **намеренно не включает событие само**:
`groups.setLongPollSettings` переписывает все флаги разом и погасил бы события
чужих ботов сообщества (на 2026-09-12 у группы включены `message_new`,
`message_reply`, `wall_reply_new`, `group_join`). Если событие выключено,
`server/domain/comment-pollers.js` один раз говорит об этом оператору и уходит
на опрос.

### Имена авторов

В событии имени нет — `fetchViewerNames` дотягивает их пачкой через
`users.get` под групповым токеном (он работает и при флуд-блоке user-аккаунта).

### Когда user-аккаунт под флуд-блоком

- Опрос-фоллбек отходит на **5 минут** между попытками (`error_code 9`):
  блок висит часами и от повторов только продлевается.
- Оператор видит **баннер** «Комментарии ВК не приходят» — состояние, а не
  тост: 12.09 единственное предупреждение всплыло на первой минуте
  двухчасового эфира и было потеряно.
- Проверка перед эфиром: `node scripts/vk-token-check.js` — только чтение,
  ничего не публикует. Ошибка 9 у `video.getComments` = аккаунт под блоком,
  нужен `VK_USER_TOKEN` другого администратора сообщества.

## Moderation

`server/vk.js` exposes two operator-driven moderation calls, both under the
**user token** (`videoToken`), routed through the high-priority queue lane:

- `banViewer({ userId, reason, comment })` → `groups.ban`. Bans the spammer
  from the эфир's community. The эфир video is community-owned (`liveOwnerId`
  negative), so the group id is `-liveOwnerId`; guarded to reject a non-community
  эфир (`owner_id ≥ 0` → `not_community`). Works because the user-token account
  administers the community — the `VK_GROUP_TOKEN` belongs to a *different*
  community and cannot ban here. Ban is community-wide, reversible via
  `groups.unban`.
- `deleteVideoComment({ commentId })` → `video.deleteComment` on `liveOwnerId`.
  Removes the comment from the эфир.

Both return a structured `{ok, code?, vkErrorCode?}` and never throw. Rationale,
token choice, and the two-community setup are in
[[vk-comments#Real VK ban + comment deletion (2026-07-22)]]. HTTP surface:
[[http-api#Blocked viewer routes]].

## Reservation comments

Buyer comments such as `бронь` are processed against the current active lot.
The poller ignores comments authored by the bot's own account
(`from_id === vk.getSelfUserId()`, resolved via `users.get` or `VK_SELF_USER_ID`)
so the bot never re-ingests its own confirmation replies as buyer reservations.
See [[vk-comments]] and [[operator-feedback]].

## Related pages

- [[reservation-flow]]
- [[live-commerce-flow]]
- [[configuration-and-secrets]]

## Карточка лота уходит без фото (2026-08-29)

Весь фото-конвейер удалён: `photos.getWallUploadServer` / `photos.saveWallPhoto`,
скачивание картинки из МойСклада, `attachments` у `video.createComment` и
повторная публикация текстом при ошибке VK 100.

Причины по логам эфира 29.08:

- у 121 товара из 143 фото в МойСкладе нет вовсе, а `LOT_DEFAULT_PLACEHOLDER_IMAGE_URL`
  не задан — большинство карточек и так уходило без изображения;
- там, где фото было, загрузка в ВК регулярно падала с «photo is undefined»:
  8 карточек без картинки и одна (`03902`) не опубликованная вовсе.

Решение оператора: не присылать фото вообще. Товар зритель видит в эфире,
карточка нужна ради артикула и цены. Побочно ушло по одному скачиванию
картинки и до трёх вызовов VK на каждый лот.

Заглушка `LOT_DEFAULT_PLACEHOLDER_IMAGE_URL` печатается строкой «Фото: …»
всегда, когда задана.
