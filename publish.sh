#!/usr/bin/env bash
# Публикация снапшота GEO-монитора на GitHub Pages.
#
# Использование:
#   GITHUB_TOKEN=ghp_... ./publish.sh [имя_репозитория]
#   ./publish.sh [имя_репозитория]     # токен спросит интерактивно (read -s)
#
# Токен: classic «repo» или fine-grained (Administration + Contents + Pages
# write) на репозиторий. Токен НЕ передаётся аргументом командной строки
# (аргументы видны в ps и попадают в историю шелла), НЕ записывается в
# .git/config и в скрипты: git получает его через GIT_ASKPASS, curl — через
# конфиг во временном каталоге 0700, который сносится trap'ом при выходе.
set -euo pipefail

OWNER="anton-moys-seo"
PUBLISH_SLEEP="${PUBLISH_SLEEP:-30}"        # пауза между проверками сайта
PUBLISH_ATTEMPTS="${PUBLISH_ATTEMPTS:-10}"  # всего проверок после публикации

die() { echo "Ошибка: $*" >&2; exit 1; }

# --- аргументы: только имя репозитория; токен аргументом запрещён ---------
[ $# -le 1 ] || die "токен аргументом больше не принимается. Используйте: GITHUB_TOKEN=... ./publish.sh [репозиторий]"
REPO="${1:-geo-monitor}"
[[ "$REPO" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
  || die "недопустимое имя репозитория «$REPO»"
case "$REPO" in
  ghp_*|gho_*|ghu_*|ghs_*|ghr_*|github_pat_*)
    die "похоже, токен передан аргументом. Используйте: GITHUB_TOKEN=... ./publish.sh" ;;
esac

# --- токен: из окружения или скрытым вводом -------------------------------
if [ -n "${GITHUB_TOKEN:-}" ]; then
  TOKEN="$GITHUB_TOKEN"
elif [ -t 0 ]; then
  read -r -s -p "GitHub token (ввод скрыт): " TOKEN
  echo >&2
else
  die "задайте токен через окружение: GITHUB_TOKEN=... ./publish.sh"
fi
[ -n "$TOKEN" ] || die "пустой токен"

cd "$(dirname "$0")"

# --- только нужный каталог: убеждаемся, что это снапшот -------------------
for f in index.html .nojekyll assets/router.js; do
  [ -e "$f" ] || die "«$f» не найден — это не каталог снапшота, публиковать отсюда нельзя"
done

command -v git  >/dev/null || die "git не найден"
command -v curl >/dev/null || die "curl не найден"
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] \
  || die "текущий каталог — не git-репозиторий"

# --- временный каталог (0700): askpass для git и конфиг для curl ----------
# При любом выходе (успех, ошибка, Ctrl-C) каталог с токеном удаляется.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/publish.XXXXXX")"
chmod 700 "$TMP"
cleanup() {
  rm -rf "$TMP"
  unset TOKEN GITHUB_TOKEN 2>/dev/null || true
}
trap cleanup EXIT

# git спрашивает сначала имя пользователя, потом пароль. Токен читается из
# окружения процесса: в файл-скрипт, в argv и в .git/config он не попадает.
cat > "$TMP/askpass" <<'EOF'
#!/bin/sh
case "$1" in
  *sername*) printf '%s\n' "x-access-token" ;;
  *)         printf '%s\n' "$GITHUB_TOKEN" ;;
esac
EOF
chmod 700 "$TMP/askpass"
export GITHUB_TOKEN="$TOKEN"
export GIT_ASKPASS="$TMP/askpass" GIT_TERMINAL_PROMPT=0

# curl получает Authorization из конфига во временном каталоге, а не из argv
cat > "$TMP/curl.conf" <<EOF
header = "Authorization: Bearer ${TOKEN}"
header = "Accept: application/vnd.github+json"
EOF
chmod 600 "$TMP/curl.conf"

# --- только нужный репозиторий: origin — ровно WANT_URL и без секретов ----
WANT_URL="https://github.com/${OWNER}/${REPO}.git"
CUR_URL="$(git remote get-url origin 2>/dev/null || true)"
case "$CUR_URL" in
  *@*) die "в URL origin встроены учётные данные (${CUR_URL%%@*}@…). Уберите их: git remote set-url origin ${WANT_URL}" ;;
esac
if [ -n "$CUR_URL" ] && [ "$CUR_URL" != "$WANT_URL" ]; then
  die "origin указывает на ${CUR_URL}, а публикую только в ${WANT_URL}. Чужой remote не трогаю."
fi
[ -n "$CUR_URL" ] || git remote add origin "$WANT_URL"

# --- 1/4 репозиторий -------------------------------------------------------
# Сначала GET: fine-grained токен с Contents write на существующий репозиторий
# не имеет права POST /user/repos (403) — создаём, только если репозитория
# действительно нет.
echo "==> 1/4 Репозиторий ${OWNER}/${REPO}"
code="$(curl -sS --max-time 30 -K "$TMP/curl.conf" \
  -o "$TMP/repo.json" -w "%{http_code}" \
  "https://api.github.com/repos/${OWNER}/${REPO}")" \
  || die "API GitHub недоступен при проверке репозитория"
case "$code" in
  200) echo "    существует — создавать не нужно" ;;
  404)
    code="$(curl -sS --max-time 30 -K "$TMP/curl.conf" \
      -o "$TMP/repo.json" -w "%{http_code}" -X POST \
      https://api.github.com/user/repos \
      -d "{\"name\":\"${REPO}\",\"description\":\"GEO-монитор: снапшот видимости бренда в ответах нейросетей\",\"private\":false,\"has_issues\":false,\"has_wiki\":false,\"auto_init\":false}")" \
      || die "API GitHub недоступен при создании репозитория"
    case "$code" in
      201) echo "    создан" ;;
      401|403) die "репозитория нет, а создать его токен не может (HTTP ${code}). Создайте github.com/${OWNER}/${REPO} вручную или дайте токену право на создание репозиториев" ;;
      *)   die "GitHub ответил HTTP ${code}: $(head -c 200 "$TMP/repo.json")" ;;
    esac ;;
  401|403) die "токен отклонён (HTTP ${code}): проверьте GITHUB_TOKEN и доступ к ${OWNER}/${REPO}" ;;
  *)   die "GitHub ответил HTTP ${code}: $(head -c 200 "$TMP/repo.json")" ;;
esac

# --- 2/4 пуш, строго без --force -------------------------------------------
echo "==> 2/4 Пуш ветки main (без --force)"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] \
  || die "текущая ветка не main — публикую только main"
if ! git push -u origin main; then
  die "push не прошёл. Без --force: подтяните удалённые изменения (git fetch origin && git rebase origin/main) и повторите"
fi

# --- 3/4 GitHub Pages ------------------------------------------------------
# GET /pages требует лишь чтения репозитория; POST — права Pages write.
# Если Pages уже включён, ограничиваемся GET: право Pages не нужно.
echo "==> 3/4 GitHub Pages (branch main, корень)"
code="$(curl -sS --max-time 30 -K "$TMP/curl.conf" \
  -o "$TMP/pages.json" -w "%{http_code}" \
  "https://api.github.com/repos/${OWNER}/${REPO}/pages")" || code="000"
case "$code" in
  200) echo "    Pages уже включён — право Pages не требуется" ;;
  404)
    code="$(curl -sS --max-time 30 -K "$TMP/curl.conf" \
      -o "$TMP/pages.json" -w "%{http_code}" -X POST \
      "https://api.github.com/repos/${OWNER}/${REPO}/pages" \
      -d '{"source":{"branch":"main","path":"/"}}')" || code="000"
    case "$code" in
      201) echo "    Pages включён" ;;
      *)   echo "    ! не удалось включить Pages (HTTP ${code}): $(head -c 300 "$TMP/pages.json" 2>/dev/null || echo 'нет ответа')"
           echo "    Включите вручную: github.com/${OWNER}/${REPO} → Settings → Pages →"
           echo "    Source: Deploy from a branch → main → / (root) → Save" ;;
    esac ;;
  *)   echo "    ! не удалось проверить Pages (HTTP ${code})"
       echo "    Проверьте вручную: github.com/${OWNER}/${REPO} → Settings → Pages" ;;
esac

# --- 4/4 ждём первую сборку ------------------------------------------------
echo "==> 4/4 Жду первую сборку и проверяю сайт"
url="https://${OWNER}.github.io/${REPO}/"
for i in $(seq 1 "$PUBLISH_ATTEMPTS"); do
  sleep "$PUBLISH_SLEEP"
  code="$(curl -sS --max-time 15 -o /dev/null -w "%{http_code}" "$url" || echo 000)"
  echo "    попытка ${i}: HTTP ${code}"
  [ "$code" = "200" ] && break
done
if [ "$code" = "200" ]; then
  echo "Готово: ${url}"
else
  echo "Сайт пока не отвечает 200 — Pages собирается дольше обычного, проверьте позже: ${url}"
fi
echo "Ссылка для коллег: ${url}#k=<ключ> (ключ в файле access_key.txt рядом со снапшотом)"
