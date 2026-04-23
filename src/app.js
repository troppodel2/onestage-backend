require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/auth',     require('./routes/auth'));
app.use('/artists',  require('./routes/artists'));
app.use('/venues',   require('./routes/venues'));
app.use('/bookings', require('./routes/bookings'));
app.use('/events',   require('./routes/events'));
app.use('/members',  require('./routes/members'));
app.use('/favorites', require('./routes/favorites'));

app.get('/health', (_, res) => res.json({ status: 'ok', app: 'onestage' }));

app.get('/health/db', async (_, res) => {
  try {
    const db = require('./db');
    const r  = await db.query('SELECT NOW() AS now');
    res.json({ status: 'ok', now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
const db   = require('./db');

// Migrazioni runtime — aggiornamenti incrementali al DB
const migrations = [
  // Permette più band per utente (rimuove vincolo UNIQUE su user_id)
  `ALTER TABLE artist_profiles DROP CONSTRAINT IF EXISTS artist_profiles_user_id_key`,
  // Colonne aggiuntive non presenti nello schema iniziale
  `ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS band_type TEXT`,
  `ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS phone TEXT`,
  `ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS cachet_max INT`,
  `ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS tribute_artist TEXT`,
  `ALTER TABLE band_members ADD COLUMN IF NOT EXISTS roles TEXT[] DEFAULT '{}'`,
  `CREATE TABLE IF NOT EXISTS favorites (
     id         SERIAL PRIMARY KEY,
     user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     artist_id  INT NOT NULL REFERENCES artist_profiles(id) ON DELETE CASCADE,
     created_at TIMESTAMP DEFAULT NOW(),
     UNIQUE(user_id, artist_id)
   )`,
];

(async () => {
  for (const sql of migrations) {
    await db.query(sql).catch(e => console.error('Migration error:', e.message));
  }
  app.listen(PORT, () => console.log(`OneStage backend in ascolto su porta ${PORT}`));
})();
