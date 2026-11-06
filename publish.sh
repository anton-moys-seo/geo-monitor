#!/usr/bin/env bash
# Публикация снапшота GEO-монитора на GitHub Pages.
# Использование: ./publish.sh <github_token> [имя_репозитория]
# Токен нужен с правами на создание репозиториев (classic: repo)
# или fine-grained: Administration write + Contents write + Pages write.
set -euo pipefail

TOKEN="${1:?Использование: ./publish.sh <github_token> [имя_репозитория]}"
REPO="${2:-geo-monitor}"
OWNER="anton-moys-seo"

cd "$(dirname "$0")"

echo "==> 1/4 Создаю репозиторий ${OWNER}/${REPO} (если его нет)"
code=$(curl -s -o /tmp/repo_resp.json -w "%{http_code}" -X POST \
  -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"${REPO}\",\"description\":\"GEO-монитор: снапшот видимости бренда в ответах нейросетей\",\"private\":false,\"has_issues\":false,\"has_wiki\":false,\"auto_init\":false}")
if [ "$code" = "201" ]; then
  echo "    репозиторий создан"
elif [ "$code" = "422" ]; then
  echo "    репозиторий уже существует — ок"
else
  echo "    ! ответ ${code} (не критично, продолжаю): $(head -c 200 /tmp/repo_resp.json)"
fi

echo "==> 2/4 Пуш ветки main"
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git"
git push -u origin main --force
git remote set-url origin "https://github.com/${OWNER}/${REPO}.git"

echo "==> 3/4 Включаю GitHub Pages (branch main, корень)"
code=$(curl -s -o /tmp/pages_resp.json -w "%{http_code}" -X POST \
  -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${OWNER}/${REPO}/pages" \
  -d '{"source":{"branch":"main","path":"/"}}')
if [ "$code" = "201" ]; then
  echo "    Pages включён"
elif [ "$code" = "409" ]; then
  echo "    Pages уже включён — ок"
else
  echo "    ! ответ ${code}: $(head -c 300 /tmp/pages_resp.json)"
  echo "    Включите вручную: ${OWNER}.github.com → ${REPO} → Settings → Pages →"
  echo "    Source: Deploy from a branch → main → / (root) → Save"
fi

echo "==> 4/4 Жду первую сборку и проверяю сайт (до 5 минут)"
url="https://${OWNER}.github.io/${REPO}/"
for i in $(seq 1 10); do
  sleep 30
  code=$(curl -s -o /dev/null -w "%{http_code}" "$url" || true)
  echo "    попытка ${i}: HTTP ${code}"
  [ "$code" = "200" ] && break
done
echo "Готово: ${url}"
echo "Ссылка для коллег: ${url}#k=<ключ> (ключ в файле access_key.txt рядом со снапшотом)"
