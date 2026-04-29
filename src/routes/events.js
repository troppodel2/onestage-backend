const router       = require('express').Router();
const db           = require('../db');
const auth         = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');

const EVENT_SELECT = `
  SELECT e.*,
         ap.name     AS band_name,    ap.city   AS band_city,
         ap.genres   AS band_genres,  ap.avatar_url AS band_avatar,
         vp.name     AS venue_name_db, vp.city  AS venue_city_db,
         vp.address  AS venue_address, vp.avatar_url AS venue_avatar
  FROM events e
  LEFT JOIN artist_profiles ap ON ap.id = e.artist_id
  LEFT JOIN venue_profiles  vp ON vp.id = e.venue_id
`;

// GET /events — tutti gli eventi pubblici (altri utenti)
router.get('/', optionalAuth, async (req, res) => {
  const { artist_id, venue_id, limit = 30, offset = 0 } = req.query;
  const conditions = ['e.is_public = true', 'e.is_cancelled = false',
                      'e.event_date >= CURRENT_DATE'];
  const params = [];

  if (artist_id) { params.push(parseInt(artist_id)); conditions.push(`e.artist_id = $${params.length}`); }
  if (venue_id)  { params.push(parseInt(venue_id));  conditions.push(`e.venue_id  = $${params.length}`); }

  // Escludi eventi dell'utente loggato
  if (req.user?.id) {
    params.push(req.user.id);
    conditions.push(`e.user_id != $${params.length}`);
  }

  params.push(parseInt(limit), parseInt(offset));
  try {
    const { rows } = await db.query(
      `${EVENT_SELECT} WHERE ${conditions.join(' AND ')}
       ORDER BY e.event_date ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    res.json({ events: rows });
  } catch (e) {
    console.error('GET /events error:', e.message);
    res.json({ events: [] });
  }
});

// GET /events/mine — i miei eventi (come band o venue)
router.get('/mine', auth, async (req, res) => {
  try {
    // Profili dell'utente
    const [artistRows, venueRows] = await Promise.all([
      db.query('SELECT id FROM artist_profiles WHERE user_id = $1', [req.user.id]),
      db.query('SELECT id FROM venue_profiles   WHERE user_id = $1', [req.user.id]),
    ]);
    const artistIds = artistRows.rows.map(r => r.id);
    const venueIds  = venueRows.rows.map(r => r.id);

    const { rows } = await db.query(
      `${EVENT_SELECT}
       WHERE (e.user_id = $1
          OR e.artist_id = ANY($2::int[])
          OR e.venue_id  = ANY($3::int[]))
         AND e.is_cancelled = false
       ORDER BY e.event_date ASC`,
      [req.user.id, artistIds, venueIds]
    );
    res.json({ events: rows });
  } catch (e) {
    console.error('GET /events/mine error:', e.message);
    res.json({ events: [] });
  }
});

// POST /events — crea evento manualmente
router.post('/', auth, async (req, res) => {
  const { artist_id, venue_id, event_date, title, description,
          location, artist_name, venue_name, is_public } = req.body;
  if (!event_date)
    return res.status(400).json({ error: 'event_date è obbligatorio' });

  try {
    const { rows } = await db.query(
      `INSERT INTO events
         (user_id, artist_id, venue_id, event_date, title, description,
          location, artist_name, venue_name, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, artist_id ?? null, venue_id ?? null, event_date,
       title ?? null, description ?? null,
       location ?? null, artist_name ?? null, venue_name ?? null,
       is_public ?? true]
    );
    res.status(201).json({ event: rows[0] });
  } catch (e) {
    console.error('POST /events error:', e.message);
    res.status(500).json({ error: 'Errore server' });
  }
});

// PATCH /events/:id — aggiorna evento (solo creatore)
router.patch('/:id', auth, async (req, res) => {
  const fields = ['title','description','event_date','location',
                  'artist_name','venue_name','is_public','is_cancelled'];
  const updates = [], params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nessun campo' });
  params.push(req.params.id, req.user.id);
  const { rows } = await db.query(
    `UPDATE events SET ${updates.join(',')} WHERE id = $${params.length-1} AND user_id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'Evento non trovato' });
  res.json({ event: rows[0] });
});

// DELETE /events/:id — elimina evento (solo creatore)
router.delete('/:id', auth, async (req, res) => {
  const { rows } = await db.query(
    'DELETE FROM events WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Evento non trovato' });
  res.json({ deleted: true });
});

module.exports = router;
