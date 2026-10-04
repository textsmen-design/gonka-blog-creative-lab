import fs from 'fs';

let js = fs.readFileSync('tools/admin/ui/app.js', 'utf8');

const newLogin = `
  $('#gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    state.token = $('#gate-token').value.trim();
    if (!state.token) return;
    
    $('#gate-submit').disabled = true;
    try {
      const loginRes = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: state.token })
      });
      if (!loginRes.ok) throw new Error('invalid');
      
      // Cookie is now set, load data without sending token in header
      const ok = await load().catch(() => false);
      if (!ok && !state.versionError) showGate('Не удалось загрузить данные после входа');
      else {
        sessionStorage.setItem('gonka-admin-token', 'SESSION_ACTIVE');
        $('#gate-error').hidden = true;
      }
    } catch(e) {
      showGate('Неверный пароль или ошибка сети');
    } finally {
      $('#gate-submit').disabled = false;
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    sessionStorage.removeItem('gonka-admin-token');
    state.token = '';
    location.reload();
  });
`;

// Replace original gate-form and btn-logout
js = js.replace(/\$\('#gate-form'\)\.addEventListener\('submit', async \(e\) => \{[\s\S]*?\$\('#btn-logout'\)\.addEventListener\('click', \(\) => \{[\s\S]*?showGate\(\);\n  \}\);/, newLogin.trim());

// We also need to remove 'X-Admin-Token' from fetch calls because we use cookies!
js = js.replace(/headers: \{ 'X-Admin-Token': state.token \}/g, "headers: {}");
js = js.replace(/headers: \{ 'X-Admin-Token': state.token, 'Content-Type': file.type \}/g, "headers: { 'Content-Type': file.type }");

// Finally, modify the start routine to check /api/session instead of load() directly
const newStart = `
  (async () => {
    // If we have an active session, verify it via API
    try {
      const sessRes = await fetch('/api/session');
      if (!sessRes.ok) {
        showGate();
        return;
      }
    } catch(e) {
      showGate('Ошибка сети');
      return;
    }

    const ok = await load().catch(() => false);
    if (!ok && !state.versionError) showGate('Не удалось загрузить данные');
    else showConnection(true, 'localhost:' + (location.port || '80'));
  })();
`;

js = js.replace(/\(async \(\) => \{[\s\S]*?\}\)\(\);/, newStart.trim());

fs.writeFileSync('tools/admin/ui/app.js', js);
console.log("Patched app.js with proper session logic");
