// share-ui.js — robust, declarative components so an agent COMPOSES a share
// instead of hand-writing interaction JS (and re-introducing its bugs). Include
// it after share.js; it scans the DOM for data-share-* widgets, wires them, and
// reports answers through share.submit(). All the fiddly event handling lives
// here ONCE, tested, not copy-pasted per page.
//
// Components:
//   <div data-share-annotate data-src="img/x.png"></div>  pin an image: add / edit / delete
//   <div data-share-choice>                                pick one of N
//     <button data-value="a">A</button> <button data-value="b">B</button>
//   </div>
//   <div data-share-rating data-max="5"></div>             1..N stars
//
// (Kept as a TS-exported string so it ships with the worker like share.js, with
// no backticks/${} inside.)
export const SHARE_UI_JS = `// share-ui.js (served by the share worker)
(function () {
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function report(payload) { if (window.share && share.submit) share.submit(payload); }

  // ---- annotate: pin an image, with add / edit / delete ----
  function annotate(root) {
    var existingImg = root.querySelector('img');
    var src = root.getAttribute('data-src') || (existingImg && existingImg.getAttribute('src'));
    root.innerHTML = '';
    var stage = el('div', 'su-stage');
    var img = el('img'); img.src = src; img.alt = ''; stage.appendChild(img);
    var listWrap = el('div', 'su-list'); listWrap.appendChild(el('div', 'su-list-h', 'Notes'));
    var list = el('div'); listWrap.appendChild(list);
    root.appendChild(stage); root.appendChild(listWrap);

    var pins = [], seq = 0, openBox = null;
    function snapshot() { return pins.map(function (p) { return { n: p.n, x: +p.x.toFixed(4), y: +p.y.toFixed(4), text: p.text }; }); }
    function renumber() { seq = 0; pins.forEach(function (p) { p.n = ++seq; }); }
    function closeBox() { if (openBox) { openBox.remove(); openBox = null; } }

    function render() {
      Array.prototype.slice.call(stage.querySelectorAll('.su-pin')).forEach(function (n) { n.remove(); });
      pins.forEach(function (p) {
        var pin = el('div', 'su-pin', '<b>' + p.n + '</b>');
        pin.style.left = (p.x * 100) + '%'; pin.style.top = (p.y * 100) + '%';
        pin.addEventListener('click', function (ev) { ev.stopPropagation(); editor(p.x, p.y, p); });
        stage.appendChild(pin);
      });
      if (!pins.length) { list.innerHTML = '<div class="su-empty">No pins yet — tap the image to add one.</div>'; return; }
      list.innerHTML = '';
      pins.forEach(function (p) {
        var item = el('div', 'su-item', '<span class="su-n">' + p.n + '</span><span class="su-t">' + esc(p.text) + '</span><span class="su-edit">edit</span>');
        item.addEventListener('click', function () { editor(p.x, p.y, p); });
        list.appendChild(item);
      });
    }

    function editor(x, y, existing) {
      closeBox();
      var box = el('div', 'su-note');
      box.style.left = Math.min(Math.max(x * stage.clientWidth, 8), Math.max(8, stage.clientWidth - 238)) + 'px';
      box.style.top = (y * stage.clientHeight + 14) + 'px';
      var del = existing ? '<button class="su-del">delete</button>' : '';
      box.innerHTML = '<textarea placeholder="What needs to change here?"></textarea>' +
        '<div class="su-row"><button class="su-cancel">cancel</button>' + del +
        '<button class="su-save">' + (existing ? 'save' : 'add pin') + '</button></div>';
      box.addEventListener('click', function (ev) { ev.stopPropagation(); }); // never bubble to stage
      stage.appendChild(box); openBox = box;
      var ta = box.querySelector('textarea'); if (existing) ta.value = existing.text; ta.focus();
      box.querySelector('.su-cancel').onclick = function (ev) { ev.stopPropagation(); closeBox(); };
      box.querySelector('.su-save').onclick = function (ev) {
        ev.stopPropagation(); var t = ta.value.trim(); if (!t) { ta.focus(); return; }
        if (existing) existing.text = t; else pins.push({ n: ++seq, x: x, y: y, text: t });
        closeBox(); render(); report({ kind: 'annotate', pins: snapshot() });
      };
      if (existing) box.querySelector('.su-del').onclick = function (ev) {
        ev.stopPropagation();
        pins = pins.filter(function (p) { return p !== existing; }); renumber();
        closeBox(); render(); report({ kind: 'annotate', pins: snapshot() });
      };
    }

    stage.addEventListener('click', function (e) {
      if (openBox) { closeBox(); return; }
      var r = stage.getBoundingClientRect();
      editor((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, null);
    });
    render();
  }

  // ---- choice: pick one of N (each child [data-value]) ----
  function choice(root) {
    var btns = Array.prototype.slice.call(root.querySelectorAll('[data-value]'));
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        btns.forEach(function (x) { x.classList.remove('su-sel'); });
        b.classList.add('su-sel');
        report({ kind: 'choice', value: b.getAttribute('data-value') });
      });
    });
  }

  // ---- rating: 1..max stars ----
  function rating(root) {
    var max = parseInt(root.getAttribute('data-max') || '5', 10);
    root.classList.add('su-rate'); root.innerHTML = '';
    var stars = [];
    for (var i = 1; i <= max; i++) (function (v) {
      var s = el('span', 'su-star', '★'); stars.push(s);
      s.addEventListener('click', function () {
        stars.forEach(function (x, idx) { x.classList.toggle('su-on', idx < v); });
        report({ kind: 'rating', value: v, max: max });
      });
      root.appendChild(s);
    })(i);
  }

  // ---- form: collect any inputs the agent designed, submit once ----
  // <form-ish container data-share-form> ... inputs with [name] ...
  //   <button data-share-submit data-done="Sent ✓">Send</button>
  // The agent styles its own fields however it likes; this just gathers + sends.
  function form(root) {
    var btn = root.querySelector('[data-share-submit]');
    function collect() {
      var out = {};
      root.querySelectorAll('[name]').forEach(function (f) {
        if (f.type === 'checkbox') out[f.name] = f.checked;
        else if (f.type === 'radio') { if (f.checked) out[f.name] = f.value; }
        else out[f.name] = f.value;
      });
      return out;
    }
    if (btn) btn.addEventListener('click', function (e) {
      e.preventDefault();
      report({ kind: 'form', values: collect() });
      btn.textContent = btn.getAttribute('data-done') || 'Sent ✓'; btn.disabled = true;
    });
  }

  var CSS = '' +
    '.su-stage{position:relative;display:inline-block;width:100%;border-radius:14px;overflow:hidden;border:1px solid #243049;cursor:crosshair;user-select:none}' +
    '.su-stage img{display:block;width:100%;height:auto;pointer-events:none}' +
    '.su-pin{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50% 50% 50% 0;background:#5c8aff;border:2px solid #fff;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,.4);display:grid;place-items:center;cursor:pointer}' +
    '.su-pin b{transform:rotate(45deg);color:#fff;font-size:12px;font-weight:700}' +
    '.su-note{position:absolute;z-index:5;background:#1a2336;border:1px solid #34425f;border-radius:12px;padding:10px;width:230px;box-shadow:0 10px 30px rgba(0,0,0,.5)}' +
    '.su-note textarea{width:100%;min-height:54px;background:#0f1320;border:1px solid #34425f;border-radius:8px;color:#e7ecf5;font:inherit;font-size:13.5px;padding:8px;resize:vertical}' +
    '.su-row{display:flex;gap:8px;margin-top:8px}' +
    '.su-row button{flex:1;border:0;border-radius:8px;padding:8px;font-size:13px;font-weight:700;cursor:pointer}' +
    '.su-save{background:#5c8aff;color:#06122e}.su-cancel{background:#2a3550;color:#aebbd6}.su-del{background:#5a2330;color:#ffb3bf}' +
    '.su-list{margin-top:16px}.su-list-h{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#7d8eaa;margin-bottom:8px}' +
    '.su-item{display:flex;gap:10px;align-items:center;background:#161e30;border:1px solid #243049;border-radius:10px;padding:9px 11px;margin-bottom:7px;font-size:13.5px;cursor:pointer}' +
    '.su-item .su-n{flex:0 0 auto;width:20px;height:20px;border-radius:50%;background:#5c8aff;color:#06122e;display:grid;place-items:center;font-size:11px;font-weight:800}' +
    '.su-item .su-t{flex:1}.su-item .su-edit{color:#7fa9ff;font-size:12px;font-weight:700}' +
    '.su-empty{color:#5f6f8e;font-size:13.5px}' +
    '[data-share-choice] [data-value]{cursor:pointer}[data-share-choice] .su-sel{outline:2px solid #5c8aff;outline-offset:2px}' +
    '.su-rate{display:flex;gap:6px}.su-star{font-size:30px;color:#2b3a59;cursor:pointer;line-height:1}.su-star.su-on{color:#ffce5c}';

  function init(scope) {
    var s = scope || document;
    if (!document.getElementById('su-css')) { var st = el('style'); st.id = 'su-css'; st.textContent = CSS; document.head.appendChild(st); }
    s.querySelectorAll('[data-share-annotate]').forEach(annotate);
    s.querySelectorAll('[data-share-choice]').forEach(choice);
    s.querySelectorAll('[data-share-rating]').forEach(rating);
    s.querySelectorAll('[data-share-form]').forEach(form);
  }
  window.ShareUI = { init: init, annotate: annotate, choice: choice, rating: rating, form: form };
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', function () { init(); });
})();
`
