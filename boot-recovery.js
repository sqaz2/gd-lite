/* No editor imports. A fully hung tab needs browser navigation; JS cannot rescue itself. */
(function () {
  var shown = false, previous = Date.now(), busySince = 0;
  function show() {
    if (shown) return;
    shown = true;
    var box = document.createElement('aside');
    box.className = 'gd-recovery'; box.setAttribute('role', 'status');
    box.innerHTML = '<button type="button">Dismiss</button><b>Taking longer than expected?</b><p>Keep this tab open. Recovery can read the last saved project without loading the editor.</p><a href="/versions/?recover=1" target="_blank" rel="noopener">Open recovery</a><a href="/versions/#recovery" target="_blank" rel="noopener">Freeze help</a>';
    box.querySelector('button').onclick = function () { box.remove(); };
    document.body.appendChild(box);
  }
  window.addEventListener('error', function (event) { if (event.target && event.target.tagName === 'SCRIPT') show(); }, true);
  window.addEventListener('vite:preloadError', show);
  setTimeout(function () {
    var root = document.getElementById('root') || document.getElementById('app');
    if (root && !root.querySelector('header, .site-header')) show();
  }, 12000);
  setInterval(function () {
    var now = Date.now(), working = document.querySelector('.busy-overlay, [data-transfer-busy]');
    if (!document.hidden && now - previous > 20000) show();
    if (working) { if (!busySince) busySince = now; if (now - busySince > 30000) show(); } else busySince = 0;
    previous = now;
  }, 3000);
})();
