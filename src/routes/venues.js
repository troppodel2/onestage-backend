const router       = require('express').Router();
const db           = require('../db');
const auth         = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');

// GET /venues — lista pubblica con filtri
router.get('/', optionalAuth, async (req, res) => {
  const { city, genre, capacity_min, limit = 20, offset = 0 } = req.query;
  const conditions = [];
  const params = [];

  if (city) {
    params.push(`%${city}%`);
    conditions.push(`vp.city ILIKE $${params.length}`);
  }
  if (genre) {
    params.push(genre);
    conditions.push(`$${params.length} = ANY(vp.preferred_genres)`);
  }
  if (capacity_min) {
    params.push(parseInt(capacity_min));
    conditions.push(`vp.capacity >= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(parseInt(limit), parseInt(offset));

  const { rows } = await db.query(
    `SELECT vp.id, vp.user_id, vp.name, vp.type, vp.city, vp.capacity,
            vp.has_pa, vp.budget_min, vp.budget_max, vp.preferred_genres,
            vp.avatar_url, vp.is_verified, u.plan
     FROM venue_profiles vp
     JOIN users u ON u.id = vp.user_id
     ${where}
     ORDER BY u.plan DESC, vp.name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ venues: rows });
});

// GET /venues/:id — profilo pubblico singolo (contatti solo per Pro loggati)
router.get('/:id', optionalAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT vp.*, u.plan, u.username, u.email AS contact_email
     FROM venue_profiles vp
     JOIN users u ON u.id = vp.user_id
     WHERE vp.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Venue non trovata' });

  const venue = { ...rows[0] };
  const isPro = req.user?.plan === 'pro';
  if (!isPro) {
    delete venue.contact_email;
  }
  res.json({ venue });
});

// GET /venues/me/profile
router.get('/me/profile', auth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM venue_profiles WHERE user_id = $1',
    [req.user.id]
  );
  res.json({ profile: rows[0] ?? null });
});

// POST /venues/me/profile — crea profilo venue
router.post('/me/profile', auth, async (req, res) => {
  if (req.user.role !== 'venue')
    return res.status(403).json({ error: 'Solo i venue possono creare un profilo venue' });

  const { name, type, city, address, capacity, has_pa, has_backline,
          budget_min, budget_max, bio, preferred_genres, avatar_url } = req.body;
  if (!name || !city)
    return res.status(400).json({ error: 'name e city sono obbligatori' });

  try {
    const { rows } = await db.query(
      `INSERT INTO venue_profiles
         (user_id, name, type, city, address, capacity, has_pa, has_backline,
          budget_min, budget_max, bio, preferred_genres, avatar_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [req.user.id, name, type, city, address, capacity,
       has_pa ?? false, has_backline ?? false,
       budget_min, budget_max, bio, preferred_genres ?? [], avatar_url]
    );
    res.status(201).json({ profile: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Profilo già esistente' });
    res.status(500).json({ error: 'Errore server' });
  }
});

// PATCH /venues/me/profile — aggiorna profilo venue
router.patch('/me/profile', auth, async (req, res) => {
  if (req.user.role !== 'venue')
    return res.status(403).json({ error: 'Accesso negato' });

  const fields = ['name','type','city','address','capacity','has_pa','has_backline',
                  'budget_min','budget_max','bio','preferred_genres','avatar_url'];
  const updates = [];
  const params  = [];

  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      updates.push(`${f} = $${params.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

  params.push(req.user.id);
  const { rows } = await db.query(
    `UPDATE venue_profiles SET ${updates.join(', ')} WHERE user_id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'Profilo non trovato' });
  res.json({ profile: rows[0] });
});

module.exports = router;
