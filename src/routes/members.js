const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

async function requireOwner(req, res, next) {
  const { rows } = await db.query(
    'SELECT id FROM artist_profiles WHERE user_id = $1 AND id = $2',
    [req.user.id, req.params.artist_id]
  );
  if (!rows[0]) return res.status(403).json({ error: 'Non sei il proprietario di questa band' });
  next();
}

// GET /members/:artist_id
// - Pubblico: nome, ruoli, is_performer
// - Venue: + contatto se contact_visible = true
// - Venue Pro: + contatto anche se contact_visible = false
router.get('/:artist_id', async (req, res) => {
  // Determina il livello di accesso dal token opzionale
  let userId = null, userRole = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
      userId   = decoded.id;
      userRole = decoded.role;
    } catch {}
  }

  // Piano dal DB (il JWT non include plan per evitare dati stale)
  let userPlan = null;
  if (userId) {
    const { rows: planRows } = await db.query('SELECT plan FROM users WHERE id = $1', [userId]);
    userPlan = planRows[0]?.plan ?? null;
  }

  const isVenue    = userRole === 'venue';
  const isVenuePro = isVenue && userPlan === 'pro';

  // Il proprietario della band vede tutto
  let isOwner = false;
  if (userId) {
    const { rows: ownerRows } = await db.query(
      'SELECT id FROM artist_profiles WHERE id = $1 AND user_id = $2',
      [req.params.artist_id, userId]
    );
    isOwner = ownerRows.length > 0;
  }

  const showAll      = isVenuePro || isOwner;
  const showIfPublic = false; // contatti solo a venue Pro e proprietario

  const { rows } = await db.query(
    `SELECT id, name, roles, is_performer, is_manager, member_type, contact_visible,
            user_id,
            CASE WHEN $1 OR (contact_visible = true AND $2) THEN phone ELSE NULL END AS phone,
            CASE WHEN $1 THEN email ELSE NULL END AS email
     FROM band_members
     WHERE artist_id = $3
     ORDER BY is_performer DESC, is_manager DESC, created_at ASC`,
    [showAll, showIfPublic, req.params.artist_id]
  );
  res.json({ members: rows });
});

// POST /members/:artist_id — aggiungi membro
router.post('/:artist_id', auth, requireOwner, async (req, res) => {
  const { name, roles, phone, email, is_performer = true, contact_visible = false } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Il nome è obbligatorio' });

  const isManager = (roles ?? []).some(r =>
    ['Manager', 'Booking Agent'].includes(r)
  );

  let user_id = null;
  if (email) {
    const { rows } = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (rows[0]) user_id = rows[0].id;
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO band_members
         (artist_id, user_id, name, roles, phone, email, is_manager, is_performer, contact_visible, member_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.params.artist_id, user_id, name.trim(), roles ?? [],
        phone || null, email?.toLowerCase() || null,
        isManager, is_performer,
        contact_visible,
        is_performer ? 'performer' : 'staff',
      ]
    );
    res.status(201).json({ member: rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Errore server' });
  }
});

// PATCH /members/:artist_id/:member_id
router.patch('/:artist_id/:member_id', auth, requireOwner, async (req, res) => {
  const allowed = ['name','roles','phone','email','is_performer','contact_visible','member_type'];
  const fields = [], params = [];

  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      fields.push(`${f} = $${params.length}`);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

  // Ricalcola is_manager se cambiano i ruoli
  if (req.body.roles !== undefined) {
    const isManager = req.body.roles.some(r => ['Manager','Booking Agent'].includes(r));
    params.push(isManager);
    fields.push(`is_manager = $${params.length}`);
  }

  params.push(req.params.member_id, req.params.artist_id);
  const { rows } = await db.query(
    `UPDATE band_members SET ${fields.join(', ')}
     WHERE id = $${params.length - 1} AND artist_id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'Membro non trovato' });
  res.json({ member: rows[0] });
});

// DELETE /members/:artist_id/:member_id
router.delete('/:artist_id/:member_id', auth, requireOwner, async (req, res) => {
  const { rows } = await db.query(
    'DELETE FROM band_members WHERE id = $1 AND artist_id = $2 RETURNING id',
    [req.params.member_id, req.params.artist_id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Membro non trovato' });
  res.json({ deleted: true });
});

module.exports = router;
