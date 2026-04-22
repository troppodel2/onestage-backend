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
  // future ALTER TABLE qui
];

(async () => {
  for (const sql of migrations) {
    await db.query(sql).catch(e => console.error('Migration error:', e.message));
  }
  app.listen(PORT, () => console.log(`OneStage backend in ascolto su porta ${PORT}`));
})();
