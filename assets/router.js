/* router.js — загрузчик и навигатор GEO-монитора на GitHub Pages.

   Страницы зашифрованы: hex(IV[12] || AES-256-GCM(gzip(html))), ключ —
   base64url 32 байт в #k= фрагменте ссылки и sessionStorage.

   v4 (12.11.2026) — «снимок как рабочий инструмент»:
   • Действия (теги, «Выполнено», конкуренты, проверки, добавление
     промптов и запросов, обновление данных) — формы POST превращаются в
     операции: страница создаёт issue с JSON-операцией в приватном
     репозитории приложения (GitHub-токен сотрудника, право только на
     issues). GitHub Actions применяет операцию к базе тем же кодом Django
     и пересобирает сайт; до этого изменение видно как «ожидает».
   • Выгрузки XLSX/CSV — заранее собранные зашифрованные файлы.
   Токен GitHub хранится только в localStorage этого браузера. */
(function () {
  'use strict';

  var DEFAULT_PAGE = 'c2-overview';
  var LS_TOKEN = 'geoGithubToken';
  var LS_PENDING = 'geoPendingOps';

  function meta(name) {
    var m = document.querySelector('meta[name="' + name + '"]');
    return m ? m.getAttribute('content') : '';
  }
  function opsRepo() {
    var r = meta('geo-ops-repo');
    if (r) sessionStorage.setItem('geoOpsRepo', r);
    return r || sessionStorage.getItem('geoOpsRepo') || '';
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* приватный режим */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function getKey() {
    var m = (location.hash || '').match(/k=([^&]+)/);
    if (m) {
      var k = decodeURIComponent(m[1]);
      sessionStorage.setItem('geoKey', k);
      return k;
    }
    return sessionStorage.getItem('geoKey');
  }

  function b64urlToBytes(text) {
    var pad = '='.repeat((4 - text.length % 4) % 4);
    var bin = atob((text + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
  }

  function gunzipBytes(bytes) {
    var stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function currentPage() {
    var m = (location.hash || '').match(/p=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function toast(message, ms) {
    var t = document.getElementById('snap-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'snap-toast';
      t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
        'background:#11122e;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;' +
        'z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90vw;line-height:1.45';
      document.body.appendChild(t);
    }
    t.textContent = message;
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.remove(); }, ms || 3600);
  }

  /* Расшифровать файл p/<slug>.enc → байты (gunzip). */
  function fetchDecrypted(slug) {
    var key = getKey();
    return fetch('p/' + encodeURIComponent(slug) + '.enc', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (payload) {
        var raw = hexToBytes(payload.trim());
        var keyBytes = b64urlToBytes(key);
        return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
          .then(function (ck) {
            return crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, ck, raw.slice(12));
          })
          .then(function (plain) { return gunzipBytes(new Uint8Array(plain)); });
      });
  }

  var loading = false;
  var loadSequence = 0;

  function load(slug, pushHistory) {
    var key = getKey();
    if (!key) { location.hash = ''; return; }
    var sequence = ++loadSequence;
    loading = true;
    slug = slug || currentPage() || DEFAULT_PAGE;
    // При смене периода или типа промптов на экране ответов сохраняем
    // локальные переключатели: они фильтруют уже расшифрованный срез.
    var outgoing = document.querySelector('.answer-filters');
    var from = (currentPage() || '').match(/^(c\d+)-answers(?:--|$)/);
    var to = slug.match(/^(c\d+)-answers(?:--|$)/);
    if (outgoing && from && to && from[1] === to[1]) {
      var selection = {};
      ['brand', 'tone', 'cited'].forEach(function (name) {
        selection[name] = outgoing.querySelector('[name=' + name + ']:checked')?.value || '';
      });
      sessionStorage.setItem('geoPendingAnswerFilters', JSON.stringify(selection));
    } else {
      sessionStorage.removeItem('geoPendingAnswerFilters');
    }
    fetchDecrypted(slug)
      .then(function (buf) { return new TextDecoder('utf-8').decode(buf); })
      .then(function (html) {
        if (sequence !== loadSequence) return;
        var nextHash = '#k=' + encodeURIComponent(key) +
          (slug ? '&p=' + encodeURIComponent(slug) : '');
        if (pushHistory && location.hash !== nextHash) history.pushState(null, '', nextHash);
        else history.replaceState(null, '', nextHash);
        document.open();
        document.write(html);
        document.close();
        loading = false;
        var anchor = sessionStorage.getItem('geoScrollTo');
        sessionStorage.removeItem('geoScrollTo');
        var target = anchor && document.getElementById(anchor);
        if (target) target.scrollIntoView({ block: 'start' });
        else window.scrollTo(0, 0);
      })
      .catch(function (e) {
        if (sequence !== loadSequence) return;
        loading = false;
        if (slug === '_stub') {
          document.open();
          document.write('<body style="font-family:system-ui;background:#f3f4f9;display:flex;' +
            'align-items:center;justify-content:center;min-height:100vh;margin:0">' +
            '<div style="background:#fff;border:1px solid #d9dce8;border-radius:12px;' +
            'padding:28px 32px;max-width:420px;color:#121433"><b>Раздел не входит в снимок</b>' +
            '<p style="color:#5d6483">Эта страница не собирается для GitHub Pages.</p>' +
            '<a href="#' + (currentPage() ? 'p=' : '') + '" onclick="location.reload()" ' +
            'style="color:#5b3df5">Вернуться</a></div></body>');
          document.close();
          return;
        }
        var msg = 'Ошибка расшифровки';
        if (String(e.message).indexOf('HTTP') === 0) msg = 'Страница не найдена в снимке';
        else if (e.name === 'OperationError') msg = 'Не удалось расшифровать: проверьте ключ ссылки';
        if (document.getElementById('msg')) {
          var m = document.getElementById('msg');
          m.textContent = msg;
          m.hidden = false;
        } else {
          document.open();
          document.write('<body style="font-family:system-ui;background:#f3f4f9;display:flex;' +
            'align-items:center;justify-content:center;min-height:100vh;margin:0">' +
            '<div style="background:#fff;border:1px solid #d9dce8;border-radius:12px;padding:28px 32px">' +
            '<b>' + msg + '.</b></div></body>');
          document.close();
        }
      });
  }

  /* ---------------------------------------------------- выгрузки (п.3) */
  function download(a) {
    var slug = a.getAttribute('data-export-file');
    var name = a.getAttribute('data-export-name') || 'geo-export';
    var type = a.getAttribute('data-export-type') || 'application/octet-stream';
    toast('Готовлю файл «' + name + '»…');
    fetchDecrypted(slug).then(function (buf) {
      var blob = new Blob([buf], { type: type });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url; link.download = name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }).catch(function () { toast('Не удалось скачать файл: его нет в этой сборке.'); });
  }

  /* ---------------------------------------- операции через GitHub (п.6, 10) */
  function pending() {
    try { return JSON.parse(lsGet(LS_PENDING) || '[]'); } catch (e) { return []; }
  }
  function savePending(list) { lsSet(LS_PENDING, JSON.stringify(list.slice(-30))); }

  function opsDialog(reason) {
    var d = document.getElementById('geo-ops-dialog');
    if (d) d.remove();
    d = document.createElement('dialog');
    d.id = 'geo-ops-dialog';
    d.className = 'chart-dialog';
    var repo = opsRepo();
    var has = !!lsGet(LS_TOKEN);
    d.innerHTML =
      '<div class="cd-head"><div><h2>Действия в GEO-мониторе</h2>' +
      '<div class="cd-sub">' + (reason || 'Изменения применяются к базе в GitHub Actions за 5–15 минут') + '</div></div>' +
      '<button type="button" class="btn ghost small" data-close aria-label="Закрыть">✕</button></div>' +
      '<p class="small">Кнопки и формы снимка создают операцию в репозитории <b>' + (repo || 'не настроен') + '</b>. ' +
      'Нужен ваш GitHub-токен (fine-grained) с доступом только к этому репозиторию и правом <b>Issues: Read and write</b>. ' +
      'Токен хранится только в этом браузере.</p>' +
      '<label class="small" for="geo-ops-token">GitHub-токен</label>' +
      '<input id="geo-ops-token" type="password" autocomplete="off" placeholder="' + (has ? 'сохранён — введите новый, чтобы заменить' : 'github_pat_…') + '" ' +
      'style="width:100%;height:38px;padding:0 10px;border:1px solid #d3d8e6;border-radius:8px;margin:6px 0 12px">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" data-save>Сохранить</button>' +
      (has ? '<button type="button" class="btn secondary" data-forget>Удалить токен</button>' : '') +
      '</div><div id="geo-ops-list"></div>';
    document.body.appendChild(d);
    d.querySelector('[data-close]').onclick = function () { d.close(); };
    d.querySelector('[data-save]').onclick = function () {
      var v = d.querySelector('#geo-ops-token').value.trim();
      if (v) { lsSet(LS_TOKEN, v); toast('Токен сохранён в этом браузере'); }
      d.close();
    };
    var f = d.querySelector('[data-forget]');
    if (f) f.onclick = function () { lsDel(LS_TOKEN); toast('Токен удалён'); d.close(); };
    var list = pending();
    if (list.length) {
      var html = '<h3 style="margin:18px 0 6px;font-size:14px">Последние операции</h3><ul class="small" style="padding-left:18px;margin:0">';
      list.slice().reverse().slice(0, 10).forEach(function (o) {
        html += '<li>' + o.title.replace(/</g, '&lt;') + ' — <a href="' + o.url + '" target="_blank" rel="noopener">' +
          (o.state === 'closed' ? 'применена' : 'ожидает') + '</a></li>';
      });
      d.querySelector('#geo-ops-list').innerHTML = html + '</ul>';
    }
    d.showModal();
  }

  function formOp(form, submitter) {
    var path = form.getAttribute('action') || meta('geo-path') || '/';
    var data = {};
    var fd = new FormData(form, submitter || undefined);
    var hasFile = false;
    fd.forEach(function (v, k) {
      if (k === 'csrfmiddlewaretoken' || k === 'next') return;
      if (typeof v !== 'string') { if (v && v.size) hasFile = true; return; }
      if (data[k] === undefined) data[k] = v;
      else if (Array.isArray(data[k])) data[k].push(v);
      else data[k] = [data[k], v];
    });
    return { path: path, data: data, hasFile: hasFile };
  }

  function describe(form, op) {
    var btn = form.querySelector('button[type=submit], button:not([type])');
    var label = (btn && (btn.getAttribute('aria-label') || btn.textContent) || '').trim();
    var d = op.data, bits = [];
    ['action', 'tag_action', 'tag', 'owner', 'text', 'target_url'].forEach(function (k) {
      if (d[k]) bits.push(String(d[k]).split('\n')[0].slice(0, 40));
    });
    var card = form.closest('.rec-card');
    var title = card && card.querySelector('.rec-title');
    var head = title || document.querySelector('h1');
    return (label || op.path) + (bits.length ? ' (' + bits.join(', ') + ')' : '') +
      (head ? ' · ' + head.textContent.trim().slice(0, 60) : '');
  }

  // Файл в операции (13.11.2026): только формы с атрибутом data-op-file
  // (выгрузка Search Console). Файл сжимается gzip, кодируется base64 и
  // кладётся в issue; если не помещается в одно сообщение GitHub (65 536
  // символов), режется на части-комментарии, а метка geo-op ставится
  // последней — workflow стартует, когда все части уже на месте.
  var OP_FILE_MAX = 2 * 1024 * 1024;   // исходный файл, байт
  var OP_TEXT_MAX = 60000;             // запас до лимита 65 536 символов
  var OP_FILE_EXT = /\.(zip|csv|xlsx)$/i;

  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function packFile(file) {
    return file.arrayBuffer().then(function (buf) {
      var raw = new Uint8Array(buf);
      var gz = (typeof CompressionStream === 'function')
        ? new Response(new Response(raw).body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
        : Promise.resolve(null);
      return Promise.all([crypto.subtle.digest('SHA-256', raw), gz]).then(function (res) {
        var sha = Array.from(new Uint8Array(res[0]), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
        var packed = res[1] ? new Uint8Array(res[1]) : raw;
        return { name: file.name, size: raw.length, sha256: sha,
                 enc: res[1] ? 'gzip' : 'raw', b64: bytesToB64(packed) };
      });
    });
  }

  function opFileOf(form) {
    var input = form.querySelector('input[type=file]');
    return input && input.files && input.files[0] || null;
  }

  function gh(repo, token, method, path, payload) {
    return fetch('https://api.github.com/repos/' + repo + path, {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: payload ? JSON.stringify(payload) : undefined
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error('auth');
      // fine-grained токен без доступа к приватному репозиторию: GitHub
      // отвечает 404, как будто репозитория нет
      if (r.status === 404) throw new Error('norepo');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function sendOp(form, submitter) {
    var repo = opsRepo();
    var token = lsGet(LS_TOKEN);
    if (!repo) { toast('Действия не настроены для этой сборки: нет репозитория операций.'); return; }
    if (!token) { opsDialog('Чтобы выполнить действие, сохраните GitHub-токен'); return; }
    var op = formOp(form, submitter);
    if (!op.hasFile) { postOp(form, op, null, repo, token); return; }
    if (!form.hasAttribute('data-op-file')) {
      toast('Файлы в этой форме через сайт не загружаются: вставьте строки текстом.', 5000);
      return;
    }
    var file = opFileOf(form);
    if (!OP_FILE_EXT.test(file.name)) {
      toast('Нужен файл экспорта Search Console: .zip, .csv или .xlsx', 5000);
      return;
    }
    if (file.size > OP_FILE_MAX) {
      toast('Файл ' + Math.round(file.size / 1024) + ' КБ больше 2 МБ: выгрузите отчёт за меньший период.', 6000);
      return;
    }
    toast('Готовлю файл…');
    packFile(file).then(function (packed) {
      postOp(form, op, packed, repo, token);
    }).catch(function (e) {
      toast('Не удалось прочитать файл: ' + e.message, 5000);
    });
  }

  function postOp(form, op, packed, repo, token) {
    var body = {
      v: 1, campaign: Number(meta('geo-campaign') || 0), path: op.path,
      data: op.data, page: currentPage() || '', at: new Date().toISOString()
    };
    var parts = [];
    if (packed) {
      body.file = { name: packed.name, size: packed.size, sha256: packed.sha256,
                    enc: packed.enc, parts: 0 };
      if (packed.b64.length + 2000 <= OP_TEXT_MAX) {
        body.file.data = packed.b64;
      } else {
        for (var i = 0; i < packed.b64.length; i += OP_TEXT_MAX) {
          parts.push(packed.b64.slice(i, i + OP_TEXT_MAX));
        }
        body.file.parts = parts.length;
      }
    }
    var title = 'geo-op: ' + describe(form, op).slice(0, 120);
    var issueText = 'Операция из снимка GEO-монитора. Применяется GitHub Actions.\n\n```json\n' +
      JSON.stringify(body, null, 2) + '\n```';
    toast(parts.length ? 'Отправляю файл: частей ' + parts.length + '…' : 'Отправляю…');
    var issue;
    // с частями: issue без метки → комментарии по порядку → метка geo-op
    gh(repo, token, 'POST', '/issues', parts.length
      ? { title: title, body: issueText }
      : { title: title, labels: ['geo-op'], body: issueText }
    ).then(function (created) {
      issue = created;
      var chain = Promise.resolve();
      parts.forEach(function (chunk, i) {
        chain = chain.then(function () {
          return gh(repo, token, 'POST', '/issues/' + issue.number + '/comments', {
            body: 'geo-op-part ' + (i + 1) + '/' + parts.length + '\n```\n' + chunk + '\n```'
          });
        });
      });
      return chain.then(function () {
        if (parts.length) {
          return gh(repo, token, 'POST', '/issues/' + issue.number + '/labels', { labels: ['geo-op'] });
        }
      }).catch(function (e) {
        // недособранная операция без метки не применится; закрываем её
        gh(repo, token, 'PATCH', '/issues/' + issue.number,
           { state: 'closed', state_reason: 'not_planned' }).catch(function () {});
        throw e;
      });
    }).then(function () {
      var list = pending();
      list.push({ n: issue.number, url: issue.html_url, title: title.slice(8),
                  at: body.at, state: 'open' });
      savePending(list);
      markPending(form);
      renderBadge();
      toast('Принято: изменение применится и появится в отчёте через 5–15 минут.', 5000);
    }).catch(function (e) {
      if (e.message === 'auth') opsDialog('GitHub отклонил токен: проверьте срок и права (Issues: write)');
      else if (e.message === 'norepo') opsDialog('Токен не видит репозиторий ' + repo +
        ': нужен токен с доступом к нему и правом Issues: Read and write');
      else toast('Не удалось отправить операцию: ' + e.message, 5000);
    });
  }

  function markPending(form) {
    var card = form.closest('.rec-card, tr, .feed-item, .card');
    if (card) card.classList.add('op-pending');
  }

  function renderBadge() {
    var list = pending().filter(function (o) { return o.state !== 'closed'; });
    var b = document.getElementById('geo-ops-badge');
    if (!document.querySelector('.layout')) return;
    if (!b) {
      b = document.createElement('button');
      b.id = 'geo-ops-badge';
      b.type = 'button';
      b.className = 'ops-badge';
      b.onclick = function () { opsDialog(); };
      document.body.appendChild(b);
    }
    b.textContent = list.length ? '⟳ Ожидает публикации: ' + list.length : '⚙ Действия';
    b.classList.toggle('busy', !!list.length);
  }

  function pollPending() {
    var token = lsGet(LS_TOKEN), repo = opsRepo();
    var list = pending();
    var open = list.filter(function (o) { return o.state !== 'closed'; });
    if (!token || !repo || !open.length) return;
    Promise.all(open.map(function (o) {
      return fetch('https://api.github.com/repos/' + repo + '/issues/' + o.n, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' }
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && j.state === 'closed') o.state = 'closed'; })
        .catch(function () {});
    })).then(function () {
      var before = open.length;
      savePending(list);
      var after = list.filter(function (o) { return o.state !== 'closed'; }).length;
      renderBadge();
      if (after < before) {
        var built = meta('snapshot-date');
        toast('Операции применены. Если изменения ещё не видны — сборка сайта занимает пару минут; обновите страницу.', 6000);
      }
    });
  }

  // Фильтры ответов выполняются по всем строкам выбранного среза снимка.
  var answerForm = document.querySelector('.answer-filters');
  if (answerForm) {
    var pendingAnswers = sessionStorage.getItem('geoPendingAnswerFilters');
    sessionStorage.removeItem('geoPendingAnswerFilters');
    if (pendingAnswers) {
      try {
        var selected = JSON.parse(pendingAnswers);
        ['brand', 'tone', 'cited'].forEach(function (name) {
          var item = Array.from(answerForm.querySelectorAll('input[name=' + name + ']'))
            .find(function (radio) { return radio.value === selected[name]; });
          if (item) item.checked = true;
        });
      } catch (_) { /* Оставляем значения текущего среза. */ }
    }
    function filterAnswers() {
      var brand = answerForm.querySelector('[name=brand]:checked')?.value || '';
      var tone = answerForm.querySelector('[name=tone]:checked')?.value || '';
      var cited = answerForm.querySelector('[name=cited]:checked')?.value || '';
      var rows = document.querySelectorAll('.feed-item[data-brand]');
      var count = 0;
      rows.forEach(function (row) {
        var show = (!brand || row.dataset.brand === brand) &&
          (!tone || row.dataset.tone === tone) && (!cited || row.dataset.cited === cited);
        row.hidden = !show;
        row.style.display = show ? '' : 'none';
        if (show) count++;
      });
      answerForm.querySelectorAll('label').forEach(function (label) {
        var radio = label.querySelector('input[type=radio]');
        if (radio) label.classList.toggle('on', radio.checked);
      });
      var counter = document.querySelector('.pagehead .sub b');
      if (counter) counter.textContent = count.toLocaleString('ru-RU');
      var empty = document.getElementById('snapshot-empty-answers');
      if (empty) empty.hidden = count !== 0;
    }
    if (document.querySelector('.feed-item[data-brand]')) {
      var emptyAnswers = document.createElement('div');
      emptyAnswers.id = 'snapshot-empty-answers';
      emptyAnswers.className = 'empty';
      emptyAnswers.textContent = 'Ничего не найдено. Попробуйте убрать часть фильтров.';
      emptyAnswers.hidden = true;
      document.querySelector('.feed').appendChild(emptyAnswers);
    }
    answerForm.addEventListener('change', filterAnswers);
    filterAnswers();
  }

  // Карточки репутации ведут к первому примеру соответствующей категории.
  var quoteFeed = document.querySelector('.quote-feed');
  if (quoteFeed) {
    [['.stat.neg', '.pill.err', 'Показать примеры негативных упоминаний'],
     ['.stat.cau', '.pill.warn', 'Показать примеры упоминаний с оговорками']]
      .forEach(function (config) {
        var card = document.querySelector(config[0]);
        if (!card) return;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', config[2]);
        card.style.cursor = 'pointer';
        function go() {
          var marker = quoteFeed.querySelector(config[1]);
          var target = marker ? marker.closest('.answer-row') : quoteFeed;
          target.scrollIntoView({behavior: 'smooth', block: 'start'});
        }
        card.addEventListener('click', function (event) {
          if (!event.target.closest('details')) go();
        });
        card.addEventListener('keydown', function (event) {
          if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault(); go();
          }
        });
      });
  }

  // Навигация по hash-ссылкам внутри расшифрованных страниц.
  document.addEventListener('click', function (e) {
    var ex = e.target.closest && e.target.closest('a[data-export-file]');
    if (ex) { e.preventDefault(); download(ex); return; }
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (href === '#') return;
    var slug = href.replace(/^#/, '');
    // Внутристраничные якоря (#src-N, #q-add): цель есть в текущем
    // документе — прокручиваем к ней сами, не трогая location.hash.
    var anchorTarget = document.getElementById(slug);
    if (anchorTarget) {
      e.preventDefault();
      anchorTarget.scrollIntoView({ block: 'start' });
      return;
    }
    e.preventDefault();
    if (slug === '_stub') {
      toast('Эта страница не собирается для снимка.');
      return;
    }
    // Общие срезы сохраняются при переходе между основными разделами.
    var destination = slug.match(/^(c\d+)-(overview|prompts-matrix|answers|competitors|sources|reputation)$/);
    var activePage = currentPage() || '';
    var filterBar = document.querySelector('.filterbar[data-period][data-kind]');
    if (destination && a.closest('#main-nav') && filterBar &&
        activePage.indexOf(destination[1] + '-') === 0) {
      var period = filterBar.dataset.period;
      var kind = filterBar.dataset.kind;
      if (/^(last|7d|30d|90d|all)$/.test(period) && /^(all|general|brand)$/.test(kind)) {
        slug = destination[1] + '-' + destination[2] + '--kind=' + kind + '_period=' + period;
      }
    }
    load(slug === '' ? currentPage() : slug, true);
  });

  // Выбор файла: показать имя на кнопке, иначе кажется, что ничего не выбрано.
  document.addEventListener('change', function (e) {
    var input = e.target;
    if (!input.matches || !input.matches('.file-pick input[type=file]')) return;
    var label = input.closest('.file-pick').querySelector('span');
    var f = input.files && input.files[0];
    if (!label) return;
    if (!label.dataset.empty) label.dataset.empty = label.textContent;
    label.textContent = f ? f.name + ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' КБ'
                          : label.dataset.empty;
  });

  // Формы: GET-формы в снимке не нужны (фильтры — ссылки), POST-формы —
  // операции через GitHub.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    e.preventDefault();
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'post') {
      toast('Поиск по тексту в снимке недоступен: используйте фильтры страницы.');
      return;
    }
    sendOp(form, e.submitter);
  }, true);

  window.addEventListener('popstate', function () {
    if (loading || !getKey()) return;
    var raw = location.hash.slice(1);
    if (raw && document.getElementById(raw)) return;
    load(currentPage() || (/^c\d+-/.test(raw) ? raw : DEFAULT_PAGE));
  });
  window.addEventListener('hashchange', function () {
    if (loading) return;
    var p = currentPage();
    var raw = location.hash.slice(1);
    if (p) load(p);
    else if (/^c\d+-/.test(raw) && getKey()) load(raw);
    else if (raw && document.getElementById(raw)) return;
    else if (getKey()) load(DEFAULT_PAGE);
  });

  // На расшифрованной странице: значок операций и опрос их статуса.
  if (document.querySelector('.layout')) {
    renderBadge();
    pollPending();
  }

  // Первый экран: если ключ уже есть в ссылке — открываем сохранённую страницу.
  var k = getKey();
  if (k && document.getElementById('key') && !document.getElementById('main')) {
    load(currentPage() || DEFAULT_PAGE);
  }
})();
