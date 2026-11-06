# Запуск сервера BrotherHub

На сервере работают три программы, каждая в своём Docker-контейнере:

| Контейнер | Что делает |
|-----------|------------|
| `server`  | Наш сервер: комнаты, чат, синхронизация, пропуска в голос |
| `livekit` | Голосовой сервер |
| `caddy`   | Получает бесплатные HTTPS-сертификаты и шифрует соединения |

Собирать на сервере ничего не нужно: образ нашего сервера собирает GitHub,
а сервер его только скачивает.

**Нужно:** Linux с Docker (например, Ubuntu 22.04/24.04 или Debian 12),
1 ядро, 1 ГБ памяти, 1 ГБ свободного места, домен.

## 0. Один раз — у владельца репозитория

1. Отправь код на GitHub (`git push`). На вкладке **Actions** запустится
   «Образ сервера» — подожди зелёную галочку (первый раз ~5–10 минут).
2. Сделай образ публичным, чтобы сервер мог его скачать без логина:
   профиль GitHub → **Packages** → `brotherwatch-server` →
   **Package settings** → **Change visibility** → **Public**.

## 1. Домен

Нужны два адреса, оба указывают на IP сервера (DNS-записи типа **A**):

- `DOMAIN` — для приложения, например `watch.example.ru`;
- `VOICE_DOMAIN` — для голоса, например `voice.watch.example.ru`.

Своего домена нет — подойдёт бесплатный [DuckDNS](https://www.duckdns.org):
заведи поддомен, например `brotherwatch.duckdns.org`, и укажи в нём IP
сервера. Адрес для голоса `voice.brotherwatch.duckdns.org` заработает сам.

## 2. Docker

Если Docker ещё не установлен (Ubuntu/Debian):

```bash
curl -fsSL https://get.docker.com | sudo sh
```

## 3. Порты

| Порт | Протокол | Зачем |
|------|----------|-------|
| 80   | TCP | Получение и продление HTTPS-сертификата |
| 443  | TCP | Приложение и подключение к голосу |
| 7882 | UDP | Звук голоса |
| 7881 | TCP | Звук голоса, запасной путь |

Если включён файрвол `ufw`:

```bash
sudo ufw allow 80,443,7881/tcp
sudo ufw allow 7882/udp
```

У арендованного сервера (VPS) порты часто нужно открыть ещё и в панели
хостинга («Firewall», «Security groups»). Если сервер дома — пробрось эти
порты на роутере, и нужен «белый» IP от провайдера.

## 4. Файлы и настройки

```bash
git clone https://github.com/Ferrumnyak/Brotherwatch.git
cd Brotherwatch/deploy
cp .env.example .env
openssl rand -hex 32        # это будет LIVEKIT_API_SECRET
nano .env
```

Заполни в `.env` домены, пароль для друзей и секрет. Файл `.env` остаётся
только на сервере.

## 5. Запуск

```bash
docker compose pull
docker compose up -d
docker compose logs -f      # выйти — Ctrl+C
```

Проверка: открой в браузере `https://DOMAIN/health` — должно быть `ok`.
В логах `server` должны быть строки `голосовая связь: wss://…` и
`слушает 0.0.0.0:8080`.

Адрес сервера для установщика друзей — `wss://DOMAIN`.

## Если уже есть свой прокси (Nginx Proxy Manager и т.п.)

Если на 80/443 уже работает свой обратный прокси (например, для других
сайтов на том же домене), Caddy не нужен: шифрование сделает прокси.

1. На сервере BrotherHub остановить и переключиться:

   ```bash
   cd ~/Brotherwatch && git pull && cd deploy
   docker compose down
   echo 'COMPOSE_FILE=docker-compose.yml:behind-proxy.yml' >> .env
   docker compose up -d
   ```

   Теперь наш сервер слушает порт `8080`, а LiveKit — `7880` в локальной сети.

2. В прокси добавить два хоста (в Nginx Proxy Manager — **Proxy Hosts** →
   **Add Proxy Host**), где `IP` — локальный адрес сервера BrotherHub
   (`hostname -I`, первый адрес):

   | Домен | Куда | Порт |
   |-------|------|------|
   | `DOMAIN` | `http://IP` | 8080 |
   | `VOICE_DOMAIN` | `http://IP` | 7880 |

   В обоих включить **Websockets Support**, на вкладке **SSL** —
   **Request a new SSL Certificate** (Let's Encrypt) и **Force SSL**.

3. На роутере 80 и 443 остаются на прокси, а **7881/TCP и 7882/UDP** —
   напрямую на сервер BrotherHub (звук голоса идёт мимо прокси).

## Обновление

После каждого `git push` с изменениями сервера GitHub собирает новый образ.
На сервере:

```bash
cd Brotherwatch
git pull
cd deploy
docker compose pull
docker compose up -d
```

Во время перезапуска все на пару секунд потеряют связь, приложение
переподключится само (ведущий может смениться).

## Если что-то не так

**`https://DOMAIN/health` не открывается.** Проверь, что DNS указывает на
сервер (`ping DOMAIN`), открыты 80 и 443, и посмотри `docker compose logs caddy`
— там видно, получился ли сертификат.

**Приложение входит, а голос не подключается.** Почти всегда — закрыт
UDP 7882 или TCP 7881 (в `ufw`, в панели хостинга или на роутере).
Логи голоса: `docker compose logs livekit`.

**`docker compose pull` пишет «denied».** Образ ещё не сделан публичным
(шаг 0) или ещё не собрался на GitHub.
