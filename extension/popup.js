const $ = (id) => document.getElementById(id);
const status = (m, ok = true) => { $('status').textContent = m; $('status').style.color = ok ? '#3ddc84' : '#ff5d5d'; };

async function refresh() {
  const { server, username, token } = await chrome.storage.local.get(['server', 'username', 'token']);
  const signedIn = !!token;
  $('signedout').classList.toggle('hidden', signedIn);
  $('signedin').classList.toggle('hidden', !signedIn);
  if (signedIn) $('who').textContent = `Signed in as ${username} · ${server}`;
}

$('signin').addEventListener('click', async () => {
  const server = $('server').value.trim().replace(/\/$/, '');
  const username = $('user').value.trim();
  const password = $('pass').value;
  if (!server || !username || !password) return status('Fill in all fields', false);
  status('Signing in…');
  try {
    // ask for permission to talk to this server, then log in
    const origin = new URL(server).origin + '/*';
    const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => true);
    if (granted === false) return status('Permission denied for that server', false);
    const res = await fetch(server + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) return status(data.error || 'Sign in failed', false);
    await chrome.storage.local.set({ server, username: data.username, token: data.token });
    status('Signed in!');
    refresh();
  } catch (e) { status('Could not reach server', false); }
});

$('signout').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token']);
  status('Signed out');
  refresh();
});

refresh();
