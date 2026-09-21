/* Отпечаток — small pieces of interface: notes, waiting, questions. */
(function (PP) {
  'use strict';

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        if (key === 'class') node.className = props[key];
        else if (key === 'text') node.textContent = props[key];
        else if (key === 'html') node.innerHTML = props[key];
        else if (key === 'style') node.setAttribute('style', props[key]);
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), props[key]);
        else if (props[key] === true) node.setAttribute(key, '');
        else if (props[key] !== false && props[key] != null) node.setAttribute(key, props[key]);
      });
    }
    (children || []).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function toast(message, kind) {
    var host = $('toast-host');
    if (!host) return;
    var node = el('div', { class: 'toast' + (kind === 'bad' ? ' bad' : ''), text: message });
    host.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .3s';
      node.style.opacity = '0';
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 320);
    }, kind === 'bad' ? 5200 : 2900);
  }

  var overlay = {
    show: function (title, note) {
      $('overlay-title').textContent = title || 'Работаю…';
      $('overlay-note').textContent = note || '';
      $('overlay-bar').style.width = '0%';
      $('overlay').hidden = false;
    },
    progress: function (done, total) {
      var pct = total ? Math.round((done / total) * 100) : 0;
      $('overlay-bar').style.width = pct + '%';
      $('overlay-note').textContent = 'Лист ' + done + ' из ' + total;
    },
    note: function (text) {
      $('overlay-note').textContent = text;
    },
    hide: function () {
      $('overlay').hidden = true;
    },
  };

  /** A question with a body you build yourself. Resolves true on «Хорошо». */
  function modal(options) {
    return new Promise(function (resolve) {
      var host = $('modal');
      $('modal-title').textContent = options.title || '';
      var body = $('modal-body');
      body.innerHTML = '';
      if (options.body) body.appendChild(options.body);
      $('modal-ok').textContent = options.ok || 'Хорошо';
      $('modal-cancel').textContent = options.cancel || 'Отмена';
      $('modal-cancel').hidden = options.cancel === false;
      host.hidden = false;

      function close(result) {
        host.hidden = true;
        $('modal-ok').removeEventListener('click', onOk);
        $('modal-cancel').removeEventListener('click', onCancel);
        host.removeEventListener('mousedown', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onOk() {
        close(true);
      }
      function onCancel() {
        close(false);
      }
      function onBackdrop(event) {
        if (event.target === host) close(false);
      }
      function onKey(event) {
        if (event.key === 'Escape') close(false);
        if (event.key === 'Enter' && options.enterOk !== false) close(true);
      }

      $('modal-ok').addEventListener('click', onOk);
      $('modal-cancel').addEventListener('click', onCancel);
      host.addEventListener('mousedown', onBackdrop);
      document.addEventListener('keydown', onKey);
      if (options.focus) setTimeout(function () {
        var target = body.querySelector(options.focus);
        if (target) target.focus();
      }, 30);
    });
  }

  function confirm(title, text, okLabel) {
    return modal({
      title: title,
      body: el('p', { class: 'note', text: text }),
      ok: okLabel || 'Да',
    });
  }

  /** Drop-down menus in the top bar. */
  function bindMenu(buttonId, menuId, onAction) {
    var button = $(buttonId);
    var menu = $(menuId);
    if (!button || !menu) return;

    function close() {
      menu.hidden = true;
      document.removeEventListener('mousedown', outside, true);
    }
    function outside(event) {
      if (!menu.contains(event.target) && event.target !== button) close();
    }
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      if (menu.hidden) {
        document.querySelectorAll('.menu').forEach(function (other) {
          other.hidden = true;
        });
        menu.hidden = false;
        setTimeout(function () {
          document.addEventListener('mousedown', outside, true);
        }, 0);
      } else {
        close();
      }
    });
    menu.addEventListener('click', function (event) {
      var action = event.target.getAttribute && event.target.getAttribute('data-act');
      if (!action) return;
      close();
      onAction(action);
    });
  }

  PP.ui = PP.ui || {};
  PP.ui.el = el;
  PP.ui.$ = $;
  PP.ui.toast = toast;
  PP.ui.overlay = overlay;
  PP.ui.modal = modal;
  PP.ui.confirm = confirm;
  PP.ui.bindMenu = bindMenu;
})((window.PP = window.PP || {}));
