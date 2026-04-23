const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// GET /favorites — lista preferiti dell'utente loggato
router.get('/', auth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT ap.id, ap.name, ap.city, ap.genres, ap.avatar_url, ap.band_type,
            ap.cachet_min, ap.is_verified, u.plan
     FROM favorites f
     JOIN artist_profiles ap ON ap.id = f.artist_id
     JOIN users u ON u.id = ap.user_id
     WHERE f.user_id = $1
     ORDER BY f.created_at DESC`,
    [req.user.id]
  );
  res.json({ favorites: rows });
});

// POST /favorites/:artist_id — aggiungi preferito
router.post('/:artist_id', auth, async (req, res) => {
  try {
    await db.query(
      'INSERT INTO favorites (user_id, artist_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, req.params.artist_id]
    );
    res.json({ favorited: true });
  } catch (e) {
    res.status(500).json({ error: 'Errore server' });
  }
});

// DELETE /favorites/:artist_id — rimuovi preferito
router.delete('/:artist_id', auth, async (req, res) => {
  await db.query(
    'DELETE FROM favorites WHERE user_id = $1 AND artist_id = $2',
    [req.user.id, req.params.artist_id]
  );
  res.json({ favorited: false });
});

// GET /favorites/:artist_id/check — controlla se è nei preferiti
router.get('/:artist_id/check', auth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT id FROM favorites WHERE user_id = $1 AND artist_id = $2',
    [req.user.id, req.params.artist_id]
  );
  res.json({ favorited: !!rows[0] });
});

module.exports = router;
