(async () => {
  const $ = (id) => document.getElementById(id);
  const err = new URLSearchParams(location.search).get('error');
  if (err) { $('error').textContent = err; $('error').hidden = false; }
  try {
    const c = await (await fetch('/auth/config')).json();
    $('sso').hidden = !c.sso;
    if (c.sso) $('sso').textContent = `Continue with ${c.providerName}`;
    $('dev').hidden = !c.dev;
    $('no-sso').hidden = c.sso;
  } catch {
    $('error').textContent = 'Cannot reach the server.';
    $('error').hidden = false;
  }
})();
