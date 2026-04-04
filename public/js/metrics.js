const sendPwaVisit = async ({ domain, path, deviceType, userUuid = null, username = null, isAdmin = 0, loadTimeMs = null, apiKey = null }) => {
  const payload = {
    domain,
    path,
    device_type: deviceType,
    window_width: window.innerWidth,
    window_height: window.innerHeight,
    ...(userUuid !== null && { user_uuid: userUuid }),
    ...(username !== null && { username }),
    ...(isAdmin !== 0 && { is_admin: isAdmin }),
    ...(loadTimeMs !== null && { load_time_ms: loadTimeMs }),
  };

  const headers = { 'Content-Type': 'application/json' };

  if (apiKey) {
    headers.apikey = apiKey;
  }

  try {
    await fetch('https://metrics.philipnewborough.co.uk/api/metrics/receivepwa', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch {
    // Fail silently — analytics should never break the app
  }
};

window.addEventListener('load', () => {
  const loadTimeMs = Math.round(performance.now());

  sendPwaVisit({
    domain: 'drum-kit-canvas.philipnewborough.co.uk',
    path: '/',
    deviceType: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
    loadTimeMs,
  });
});