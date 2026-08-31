// HTTP Basic Auth gate for Vercel serverless functions. Reused by every
// handler in api/ — wrap the export with requireAuth(handler).
function requireAuth(handler) {
  return async (req, res) => {
    const password = process.env.SCHEDULER_PASSWORD || '';
    if (!password) {
      res.status(500).json({ error: 'SCHEDULER_PASSWORD is not set on the server.' });
      return;
    }

    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    let ok = false;
    if (scheme === 'Basic' && encoded) {
      const [, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      ok = pass === password;
    }

    if (!ok) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Shoot Scheduler"');
      res.status(401).send('Authentication required.');
      return;
    }

    return handler(req, res);
  };
}

module.exports = { requireAuth };
