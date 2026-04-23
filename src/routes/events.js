const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// GET /events — lista eventi pubblici
router.get('/', async (req, res) => {
  const { city, artist_id, venue_id, from_date, limit = 20, offset = 0 } = req.query;
  const conditions = ['e.is_public = true', 'e.event_date >= CURRENT_DATE'];
  const params = [];

  if (city) {
    params.push(`%${city}%`);
    conditions.push(`vp.city ILIKE $${params.length}`);
  }
  if (artist_id) {
    params.push(parseInt(artist_id));
    conditions.push(`e.artist_id = $${params.length}`);
  }
  if (venue_id) {
    params.push(parseInt(venue_id));
    conditions.push(`e.venue_id = $${params.length}`);
  }
  if (from_date) {
    params.push(from_date);
    conditions.push(`e.event_date >= $${params.length}`);
  }

  params.push(parseInt(limit), parseInt(offset));

  try {
    const { rows } = await db.query(
      `SELECT e.id, e.event_date, e.title, e.description,
              ap.name AS artist_name, ap.city AS artist_city, ap.genres, ap.avatar_url AS artist_avatar,
              vp.name AS venue_name, vp.city AS venue_city, vp.address, vp.avatar_url AS venue_avatar
       FROM events e
       JOIN artist_profiles ap ON ap.id = e.artist_id
       JOIN venue_profiles  vp ON vp.id = e.venue_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.event_date ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ events: rows });
  } catch (e) {
    console.error('GET /events error:', e.message);
    res.json({ events: [] });
  }
});

// GET /events/:id — singolo evento
router.get('/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT e.*,
            ap.name AS artist_name, ap.city AS artist_city, ap.genres, ap.avatar_url AS artist_avatar,
            ap.cachet_min, ap.cachet_max, ap.show_types,
            vp.name AS venue_name, vp.city AS venue_city, vp.address, vp.capacity,
            vp.avatar_url AS venue_avatar
     FROM events e
     JOIN artist_profiles ap ON ap.id = e.artist_id
     JOIN venue_profiles  vp ON vp.id = e.venue_id
     WHERE e.id = $1 AND e.is_public = true`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Evento non trovato' });
  res.json({ event: rows[0] });
});

// POST /events — crea evento pubblico (venue o artista coinvolti)
router.post('/', auth, async (req, res) => {
  const { booking_id, venue_id, artist_id, event_date, title, description, is_public } = req.body;
  if (!venue_id || !artist_id || !event_date)
    return res.status(400).json({ error: 'venue_id, artist_id e event_date sono obbligatori' });

  try {
    const { rows } = await db.query(
      `INSERT INTO events (booking_id, venue_id, artist_id, event_date, title, description, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [booking_id ?? null, venue_id, artist_id, event_date, title, description, is_public ?? true]
    );
    res.status(201).json({ event: rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Errore server' });
  }
});

module.exports = router;
