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
  `ALTER TABLE band_members ADD COLUMN IF NOT EXISTS member_type TEXT DEFAULT 'performer'`,
  `ALTER TABLE band_members ADD COLUMN IF NOT EXISTS is_performer BOOLEAN DEFAULT true`,
  `ALTER TABLE band_members ADD COLUMN IF NOT EXISTS contact_visible BOOLEAN DEFAULT false`,
  `UPDATE band_members SET member_type = 'staff', is_performer = false WHERE is_manager = true AND member_type = 'performer'`,
  `ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS website_url TEXT`,
  `ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS facebook_url TEXT`,
  `ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS instagram_url TEXT`,
  `CREATE TABLE IF NOT EXISTS events (
     id          SERIAL PRIMARY KEY,
     booking_id  INT REFERENCES bookings(id) ON DELETE SET NULL,
     venue_id    INT NOT NULL REFERENCES venue_profiles(id) ON DELETE CASCADE,
     artist_id   INT NOT NULL REFERENCES artist_profiles(id) ON DELETE CASCADE,
     event_date  DATE NOT NULL,
     title       TEXT,
     description TEXT,
     is_public   BOOLEAN DEFAULT true,
     created_at  TIMESTAMP DEFAULT NOW()
   )`,
  `ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT`,
  `ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS expired_at TIMESTAMP`,
  `ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS band_id INT REFERENCES artist_profiles(id) ON DELETE SET NULL`,
  `ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS set_duration INT`,
  `ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS preferred_period TEXT`,
  `ALTER TABLE booking_requests ALTER COLUMN event_date DROP NOT NULL`,
  `CREATE TABLE IF NOT EXISTS booking_archives (
     user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     booking_id INT NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
     archived_at TIMESTAMP DEFAULT NOW(),
     PRIMARY KEY (user_id, booking_id)
   )`,
  `CREATE TABLE IF NOT EXISTS booking_deletions (
     user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     booking_id INT NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
     deleted_at  TIMESTAMP DEFAULT NOW(),
     PRIMARY KEY (user_id, booking_id)
   )`,
  `ALTER TABLE venue_profiles DROP CONSTRAINT IF EXISTS venue_profiles_user_id_key`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS phone TEXT`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS website_url TEXT`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS instagram_url TEXT`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS facebook_url TEXT`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS types TEXT[] DEFAULT '{}'`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS features TEXT[] DEFAULT '{}'`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS budget_estimate INT`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS tech_equipment TEXT[] DEFAULT '{}'`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS requested_band_types TEXT[] DEFAULT '{}'`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS start_date DATE`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS end_date DATE`,
  `ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS custom_type_name TEXT`,
];

// Scadenza automatica: ogni ora marca come 'expired' le richieste pending/negotiating
// la cui event_date è già passata
async function expireBookings() {
  try {
    const { rows } = await db.query(
      `UPDATE booking_requests
       SET status = 'rejected', rejection_reason = 'Scaduta automaticamente — data evento superata', expired_at = NOW()
       WHERE status IN ('pending', 'negotiating')
         AND event_date < CURRENT_DATE
       RETURNING id, from_user_id, to_user_id, event_date`
    );
    if (rows.length > 0) {
      console.log(`[expireBookings] scadute ${rows.length} richieste`);
      const { sendPush } = require('./utils/push');
      for (const b of rows) {
        const [fromRows, toRows] = await Promise.all([
          db.query('SELECT push_token FROM users WHERE id = $1', [b.from_user_id]),
          db.query('SELECT push_token FROM users WHERE id = $1', [b.to_user_id]),
        ]);
        const dateStr = new Date(b.event_date).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
        const msg = { title: '⏰ Richiesta scaduta', body: `La proposta per il ${dateStr} è scaduta automaticamente.`, data: { bookingId: b.id } };
        sendPush(fromRows.rows[0]?.push_token, msg);
        sendPush(toRows.rows[0]?.push_token, msg);
      }
    }
  } catch (e) {
    console.error('[expireBookings] errore:', e.message);
  }
}

// Auto-archivio: richieste confermate la cui data concerto è già passata
// → entrambi gli utenti vengono aggiunti a booking_archives
async function archiveCompletedBookings() {
  try {
    const { rows } = await db.query(
      `SELECT id, from_user_id, to_user_id, event_date FROM booking_requests
       WHERE status = 'confirmed' AND event_date < CURRENT_DATE`
    );
    for (const b of rows) {
      await Promise.all([
        db.query(
          'INSERT INTO booking_archives (user_id, booking_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [b.from_user_id, b.id]
        ),
        db.query(
          'INSERT INTO booking_archives (user_id, booking_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [b.to_user_id, b.id]
        ),
      ]);
    }
    if (rows.length > 0) console.log(`[archiveCompleted] archiviati ${rows.length} booking`);
  } catch (e) {
    console.error('[archiveCompleted] errore:', e.message);
  }
}

(async () => {
  for (const sql of migrations) {
    await db.query(sql).catch(e => console.error('Migration error:', e.message));
  }

  // Esegui subito all'avvio, poi ogni ora
  await expireBookings();
  await archiveCompletedBookings();
  setInterval(async () => {
    await expireBookings();
    await archiveCompletedBookings();
  }, 60 * 60 * 1000);

  app.listen(PORT, () => console.log(`OneStage backend in ascolto su porta ${PORT}`));
})();
