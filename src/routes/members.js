const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// Verifica che l'utente loggato sia proprietario della band
async function requireOwner(req, res, next) {
  const { rows } = await db.query(
    `SELECT ap.id FROM artist_profiles ap WHERE ap.user_id = $1 AND ap.id = $2`,
    [req.user.id, req.params.artist_id]
  );
  if (!rows[0]) return res.status(403).json({ error: 'Non sei il proprietario di questa band' });
  next();
}

// GET /members/:artist_id — lista tutti (performer + staff)
router.get('/:artist_id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT bm.*, u.username
     FROM band_members bm
     LEFT JOIN users u ON u.id = bm.user_id
     WHERE bm.artist_id = $1
     ORDER BY bm.member_type ASC, bm.is_manager DESC, bm.created_at ASC`,
    [req.params.artist_id]
  );
  res.json({ members: rows });
});

// POST /members/:artist_id — aggiungi membro o staff
router.post('/:artist_id', auth, requireOwner, async (req, res) => {
  const { name, roles, phone, email, member_type = 'performer' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Il nome è obbligatorio' });

  // is_manager = true solo se member_type è 'staff' e ruolo è Manager
  const isManager = member_type === 'staff' && (roles ?? []).includes('Manager');

  let user_id = null;
  if (email) {
    const { rows } = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (rows[0]) user_id = rows[0].id;
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO band_members (artist_id, user_id, name, roles, phone, email, is_manager, member_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.params.artist_id, user_id, name.trim(), roles ?? [], phone, email?.toLowerCase(), isManager, member_type]
    );
    res.status(201).json({ member: rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Errore server' });
  }
});

// PATCH /members/:artist_id/:member_id — modifica membro
router.patch('/:artist_id/:member_id', auth, requireOwner, async (req, res) => {
  const { name, roles, phone, email, member_type } = req.body;
  const fields = [];
  const params = [];

  if (name        !== undefined) { params.push(name);        fields.push(`name = $${params.length}`); }
  if (roles       !== undefined) { params.push(roles);       fields.push(`roles = $${params.length}`); }
  if (phone       !== undefined) { params.push(phone);       fields.push(`phone = $${params.length}`); }
  if (email       !== undefined) { params.push(email);       fields.push(`email = $${params.length}`); }
  if (member_type !== undefined) { params.push(member_type); fields.push(`member_type = $${params.length}`); }

  if (!fields.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

  params.push(req.params.member_id, req.params.artist_id);
  try {
    const { rows } = await db.query(
      `UPDATE band_members SET ${fields.join(', ')}
       WHERE id = $${params.length - 1} AND artist_id = $${params.length}
       RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Membro non trovato' });
    res.json({ member: rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Errore server' });
  }
});

// DELETE /members/:artist_id/:member_id — rimuovi membro/staff
router.delete('/:artist_id/:member_id', auth, requireOwner, async (req, res) => {
  const { rows } = await db.query(
    'DELETE FROM band_members WHERE id = $1 AND artist_id = $2 RETURNING id',
    [req.params.member_id, req.params.artist_id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Membro non trovato' });
  res.json({ deleted: true });
});

module.exports = router;
