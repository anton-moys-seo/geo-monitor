/* router.js — загрузка и навигация по зашифрованному снапшоту.
   Ключ хранится только в sessionStorage и #k= фрагменте ссылки.
   Схема шифрования: hex(IV[12] || AES-256-GCM(gzip(html))),
   ключ доступа — base64url 32 байт в #k= фрагменте. */
(function () {
  'use strict';

  var DEFAULT_PAGE = 'c2-overview';

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

  function gunzip(bytes) {
    var stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
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

  function toast(message) {
    var t = document.getElementById('snap-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'snap-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
        'background:#11122e;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;' +
        'z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90vw';
      document.body.appendChild(t);
    }
    t.textContent = message;
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.remove(); }, 3200);
  }

  var loading = false;

  function load(slug) {
    var key = getKey();
    if (!key) { location.hash = ''; return; }
    if (loading) return;
    loading = true;
    slug = slug || currentPage() || DEFAULT_PAGE;
    fetch('p/' + encodeURIComponent(slug) + '.enc', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (payload) {
        var raw = hexToBytes(payload.trim());
        var iv = raw.slice(0, 12);
        var data = raw.slice(12);
        var keyBytes = b64urlToBytes(key);
        return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
          .then(function (ck) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, ck, data); })
          .then(function (plain) { return gunzip(new Uint8Array(plain)); });
      })
      .then(function (html) {
        history.replaceState(null, '', '#k=' + encodeURIComponent(key) +
          (slug ? '&p=' + encodeURIComponent(slug) : ''));
        document.open();
        document.write(html);
        document.close();
        loading = false;
        window.scrollTo(0, 0);
      })
      .catch(function (e) {
        loading = false;
        if (slug === '_stub') {
          document.open();
          document.write('<body style="font-family:system-ui;background:#f3f4f9;display:flex;' +
            'align-items:center;justify-content:center;min-height:100vh;margin:0">' +
            '<div style="background:#fff;border:1px solid #d9dce8;border-radius:12px;' +
            'padding:28px 32px;max-width:420px;color:#121433"><b>Раздел не входит в снапшот</b>' +
            '<p style="color:#5d6483">Это статический снимок: часть страниц с действиями ' +
            '(запуски съёмов, формы, настройки) в него не включена.</p>' +
            '<a href="#' + (currentPage() ? 'p=' : '') + '" onclick="location.reload()" ' +
            'style="color:#5b3df5">Вернуться</a></div></body>');
          document.close();
          return;
        }
        var msg = 'Ошибка расшифровки';
        if (String(e.message).indexOf('HTTP') === 0) msg = 'Страница не найдена в снапшоте';
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

  // Фильтры ответов выполняются по всем строкам выбранного среза снимка.
  var answerForm = document.querySelector('.answer-filters');
  if (answerForm && document.querySelector('.feed-item[data-brand]')) {
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
    var emptyAnswers = document.createElement('div');
    emptyAnswers.id = 'snapshot-empty-answers';
    emptyAnswers.className = 'empty';
    emptyAnswers.textContent = 'Ничего не найдено. Попробуйте убрать часть фильтров.';
    emptyAnswers.hidden = true;
    document.querySelector('.feed').appendChild(emptyAnswers);
    answerForm.addEventListener('change', filterAnswers);
    filterAnswers();
  }

  var kindFilter = document.querySelector('.filterbar input[name=kind]');
  if (kindFilter) {
    kindFilter.form.addEventListener('change', function (e) {
      if (e.target.name !== 'kind') return;
      var page = currentPage() || DEFAULT_PAGE;
      var match = page.match(/^(c\d+)-(prompts-matrix|answers)(?:--.*)?$/);
      if (match) load(match[1] + '-' + match[2] + '--kind=' + e.target.value);
    });
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
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (href === '#' || href === '#main') return;
    var slug = href.replace(/^#/, '');
    // Внутристраничные якоря (#src-N, #sources на страницах ответов):
    // цель есть в текущем документе — прокручиваем к ней сами, не трогая
    // location.hash, чтобы не потерять #k=ключ и не сработал hashchange.
    var anchorTarget = document.getElementById(slug);
    if (anchorTarget) {
      e.preventDefault();
      anchorTarget.scrollIntoView({ block: 'start' });
      return;
    }
    e.preventDefault();
    load(slug === '' ? currentPage() : slug);
  });

  // Формы и действия в снапшоне не работают.
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    toast('В снапшоне недоступно: это просмотр данных. Действия — в живом инструменте.');
  }, true);

  window.addEventListener('hashchange', function () {
    var p = currentPage();
    if (p && !loading) load(p);
    else if (!p && getKey() && !loading) load(DEFAULT_PAGE);
  });

  // Первый экран: если ключ уже есть в ссылке — открываем сохранённую страницу.
  var k = getKey();
  if (k && document.getElementById('key') && !document.getElementById('main')) {
    load(currentPage() || DEFAULT_PAGE);
  }
})();
