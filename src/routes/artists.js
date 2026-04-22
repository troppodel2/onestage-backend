const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// GET /artists — lista pubblica con filtri
router.get('/', async (req, res) => {
  const { city, genre, cachet_max, limit = 20, offset = 0 } = req.query;
  const conditions = [];
  const params = [];

  if (city) {
    params.push(`%${city}%`);
    conditions.push(`ap.city ILIKE $${params.length}`);
  }
  if (genre) {
    params.push(genre);
    conditions.push(`$${params.length} = ANY(ap.genres)`);
  }
  if (cachet_max) {
    params.push(parseInt(cachet_max));
    conditions.push(`ap.cachet_min <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(parseInt(limit), parseInt(offset));

  const { rows } = await db.query(
    `SELECT ap.id, ap.user_id, ap.name, ap.city, ap.genres, ap.cachet_min, ap.cachet_max,
            ap.show_types, ap.avatar_url, ap.is_verified,
            u.plan
     FROM artist_profiles ap
     JOIN users u ON u.id = ap.user_id
     ${where}
     ORDER BY u.plan DESC, ap.name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ artists: rows });
});

// GET /artists/:id — profilo pubblico singolo
router.get('/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT ap.*, u.plan, u.username
     FROM artist_profiles ap
     JOIN users u ON u.id = ap.user_id
     WHERE ap.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Artista non trovato' });
  res.json({ artist: rows[0] });
});

// GET /artists/me/profile — profilo dell'utente loggato
router.get('/me/profile', auth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM artist_profiles WHERE user_id = $1',
    [req.user.id]
  );
  res.json({ profile: rows[0] ?? null });
});

// POST /artists/me/profile — crea profilo artista
router.post('/me/profile', auth, async (req, res) => {
  if (req.user.role !== 'artist')
    return res.status(403).json({ error: 'Solo gli artisti possono creare un profilo artista' });

  const { name, bio, city, cachet_min, cachet_max, set_duration_min, set_duration_max,
          show_types, genres, spotify_url, youtube_url, avatar_url } = req.body;
  if (!name || !city)
    return res.status(400).json({ error: 'name e city sono obbligatori' });

  try {
    const { rows } = await db.query(
      `INSERT INTO artist_profiles
         (user_id, name, bio, city, cachet_min, cachet_max, set_duration_min, set_duration_max,
          show_types, genres, spotify_url, youtube_url, avatar_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [req.user.id, name, bio, city, cachet_min, cachet_max, set_duration_min, set_duration_max,
       show_types ?? [], genres ?? [], spotify_url, youtube_url, avatar_url]
    );
    res.status(201).json({ profile: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Profilo già esistente' });
    res.status(500).json({ error: 'Errore server' });
  }
});

// PATCH /artists/me/profile — aggiorna profilo artista
router.patch('/me/profile', auth, async (req, res) => {
  if (req.user.role !== 'artist')
    return res.status(403).json({ error: 'Accesso negato' });

  const fields = ['name','bio','city','cachet_min','cachet_max','set_duration_min',
                  'set_duration_max','show_types','genres','spotify_url','youtube_url','avatar_url'];
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
    `UPDATE artist_profiles SET ${updates.join(', ')} WHERE user_id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'Profilo non trovato' });
  res.json({ profile: rows[0] });
});

module.exports = router;
