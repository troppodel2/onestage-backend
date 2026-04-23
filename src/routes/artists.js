const router       = require('express').Router();
const db           = require('../db');
const auth         = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');

// Verifica che l'utente loggato sia il proprietario della band
async function requireOwner(req, res, next) {
  try {
    const { rows } = await db.query(
      'SELECT id FROM artist_profiles WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(403).json({ error: 'Non sei il proprietario di questa band' });
    next();
  } catch (e) {
    res.status(500).json({ error: 'Errore server' });
  }
}

// GET /artists — lista pubblica con filtri
router.get('/', optionalAuth, async (req, res) => {
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

  try {
    const { rows } = await db.query(
      `SELECT ap.id, ap.user_id, ap.name, ap.city, ap.genres, ap.cachet_min,
              ap.avatar_url, ap.is_verified, ap.band_type,
              u.plan
       FROM artist_profiles ap
       JOIN users u ON u.id = ap.user_id
       ${where}
       ORDER BY u.plan DESC, ap.name ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ artists: rows });
  } catch (e) {
    console.error('GET /artists error:', e.message);
    res.status(500).json({ error: 'Errore server', detail: e.message });
  }
});

// ── Rotte autenticate /me — DEVONO stare prima di /:id ───────────────────────

// GET /artists/me/profiles — tutte le band dell'utente loggato
router.get('/me/profiles', auth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT ap.*,
            (SELECT COUNT(*) FROM band_members bm WHERE bm.artist_id = ap.id) AS member_count
     FROM artist_profiles ap
     WHERE ap.user_id = $1
     ORDER BY ap.created_at ASC`,
    [req.user.id]
  );
  res.json({ profiles: rows });
});

// POST /artists/me/profiles — crea nuova band
router.post('/me/profiles', auth, async (req, res) => {
  if (req.user.role !== 'artist')
    return res.status(403).json({ error: 'Solo gli artisti possono creare un profilo band' });

  const { name, bio, city, cachet_min, set_duration_min, set_duration_max,
          genres, band_type, spotify_url, youtube_url, avatar_url, phone } = req.body;
  if (!name?.trim() || !city?.trim())
    return res.status(400).json({ error: 'name e city sono obbligatori' });

  try {
    const { rows } = await db.query(
      `INSERT INTO artist_profiles
         (user_id, name, bio, city, cachet_min, set_duration_min, set_duration_max,
          genres, band_type, spotify_url, youtube_url, avatar_url, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [req.user.id, name.trim(), bio, city.trim(), cachet_min, set_duration_min, set_duration_max,
       genres ?? [], band_type, spotify_url, youtube_url, avatar_url, phone]
    );
    const profile = rows[0];

    // Auto-aggiunge il creator come manager della band
    const userRow = await db.query('SELECT username, email FROM users WHERE id = $1', [req.user.id]);
    await db.query(
      `INSERT INTO band_members (artist_id, user_id, name, roles, email, is_manager)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [profile.id, req.user.id, userRow.rows[0].username, ['Manager'], userRow.rows[0].email]
    );

    res.status(201).json({ profile });
  } catch (e) {
    res.status(500).json({ error: 'Errore server' });
  }
});

// ── Rotte pubbliche per id — DOPO /me ────────────────────────────────────────

// GET /artists/:id — profilo pubblico singolo
router.get('/:id', optionalAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT ap.*, u.plan, u.username, u.email AS contact_email
     FROM artist_profiles ap
     JOIN users u ON u.id = ap.user_id
     WHERE ap.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Artista non trovato' });

  const artist = { ...rows[0] };
  const isPro  = req.user?.plan === 'pro';
  if (!isPro) delete artist.contact_email;
  res.json({ artist });
});

// PATCH /artists/:id — aggiorna band specifica (solo proprietario)
router.patch('/:id', auth, requireOwner, async (req, res) => {
  const fields = ['name','bio','city','cachet_min','cachet_max','set_duration_min','set_duration_max',
                  'genres','band_type','tribute_artist','spotify_url','youtube_url','avatar_url','phone'];
  const updates = [];
  const params  = [];

  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      updates.push(`${f} = $${params.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

  params.push(req.params.id);
  const { rows } = await db.query(
    `UPDATE artist_profiles SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'Band non trovata' });
  res.json({ profile: rows[0] });
});

// DELETE /artists/:id — elimina band (solo proprietario)
router.delete('/:id', auth, requireOwner, async (req, res) => {
  await db.query('DELETE FROM artist_profiles WHERE id = $1', [req.params.id]);
  res.json({ deleted: true });
});

module.exports = router;
