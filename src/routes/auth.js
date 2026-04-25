const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../db');

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '90d' }
  );
}

function validatePassword(password) {
  if (!password || password.length < 8)
    return 'La password deve contenere almeno 8 caratteri.';
  if (!/[A-Z]/.test(password))
    return 'La password deve contenere almeno una lettera maiuscola.';
  if (!/[a-z]/.test(password))
    return 'La password deve contenere almeno una lettera minuscola.';
  if (!/[0-9]/.test(password))
    return 'La password deve contenere almeno un numero.';
  return null;
}

// POST /auth/register
router.post('/register', async (req, res) => {
  const { email, username, password, role, privacy_accepted } = req.body;
  if (!email || !username || !password || !role)
    return res.status(400).json({ error: 'email, username, password e role sono obbligatori' });
  if (!['artist', 'venue', 'visitor'].includes(role))
    return res.status(400).json({ error: 'role deve essere artist, venue o visitor' });
  if (!privacy_accepted)
    return res.status(400).json({ error: 'Devi accettare l\'informativa sulla privacy.', code: 'PRIVACY_REQUIRED' });
  const pwdError = validatePassword(password);
  if (pwdError)
    return res.status(400).json({ error: pwdError, code: 'WEAK_PASSWORD' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO users (email, username, password_hash, role, privacy_accepted_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, email, username, role, plan`,
      [email.toLowerCase(), username, hash, role]
    );
    res.status(201).json({ token: makeToken(rows[0]), user: rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      const field = e.constraint?.includes('email') ? 'email' : 'username';
      return res.status(409).json({ error: `${field} già in uso` });
    }
    res.status(500).json({ error: 'Errore server' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email e password sono obbligatori' });

  const { rows } = await db.query(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Email o password non corretti.' });

  res.json({
    token: makeToken(user),
    user: { id: user.id, email: user.email, username: user.username, role: user.role, plan: user.plan },
  });
});

// GET /auth/me — dati utente corrente
router.get('/me', require('../middleware/auth'), async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, email, username, role, plan, plan_expires_at, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Utente non trovato' });
  res.json({ user: rows[0] });
});

// PATCH /auth/me/push-token
router.patch('/me/push-token', require('../middleware/auth'), async (req, res) => {
  const { push_token } = req.body;
  if (!push_token || typeof push_token !== 'string')
    return res.status(400).json({ error: 'push_token obbligatorio' });

  await db.query('UPDATE users SET push_token = $1 WHERE id = $2', [push_token, req.user.id]);
  res.json({ ok: true });
});

// PATCH /auth/me/plan — [DEV ONLY] toggle piano pro/free
router.patch('/me/plan', require('../middleware/auth'), async (req, res) => {
  const { plan } = req.body;
  if (!['free', 'pro'].includes(plan))
    return res.status(400).json({ error: 'plan deve essere free o pro' });
  const { rows } = await db.query(
    'UPDATE users SET plan = $1 WHERE id = $2 RETURNING id, email, username, role, plan',
    [plan, req.user.id]
  );
  res.json({ user: rows[0] });
});

// DELETE /auth/me — cancella account
router.delete('/me', require('../middleware/auth'), async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Errore server' });
  } finally {
    client.release();
  }
});

module.exports = router;
