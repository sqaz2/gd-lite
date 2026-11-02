/* Integration for the independently built Lite2 editor; no access to its React internals. */
(function () {
  function mount() {
    document.querySelectorAll('input[type="file"]').forEach(function (input) {
      if (input.accept.indexOf('.gdlproject') >= 0 && input.accept.indexOf('.gdlite') < 0) input.accept += ',.gdlite';
    });
    var header = document.querySelector('.site-header');
    if (!header || header.querySelector('.version-links')) return;
    var nav = document.createElement('div');
    nav.className = 'version-links'; nav.setAttribute('role', 'navigation'); nav.setAttribute('aria-label', 'Studio versions');
    nav.innerHTML = '<a href="/versions/?to=lite" target="_blank" rel="noopener">Lite</a><a href="/mix" aria-current="page">Lite2</a><a href="/versions/?to=lite2" target="_blank" rel="noopener">Files / guide</a>';
    header.appendChild(nav);
  }
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  mount();
  // Keep Lite2's editor and autosave alive while a Lite backup is staged.
  document.addEventListener('change', function (event) {
    var input = event.target, file = input.files && input.files[0];
    if (!file || !/\.gdlite$/i.test(file.name)) return;
    event.stopImmediatePropagation();
    var box = document.createElement('aside'); box.className = 'gd-recovery'; box.setAttribute('role', 'status');
    box.textContent = 'Preparing this Lite backup for the transfer page…'; document.body.appendChild(box);
    var request = indexedDB.open('gd-version-transfer-v1', 1);
    request.onupgradeneeded = function () { request.result.createObjectStore('files'); };
    request.onerror = request.onblocked = function () { box.textContent = 'Could not stage the file. Open Files / guide and choose the original backup there.'; };
    request.onsuccess = function () {
      var db = request.result, id = 'file-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      var tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(file, id);
      tx.onerror = tx.onabort = function () { db.close(); box.textContent = 'Not enough device storage. Open Files / guide and choose the backup there.'; };
      tx.oncomplete = function () {
        db.close(); box.textContent = 'Your Lite backup is ready. The current editor stays open. ';
        var link = document.createElement('a'); link.href = '/versions/?to=lite2&file=' + encodeURIComponent(id); link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open transfer'; box.appendChild(link);
        var close = document.createElement('button'); close.textContent = 'Dismiss'; close.onclick = function () { box.remove(); }; box.appendChild(close);
      };
    };
  }, true);
})();
