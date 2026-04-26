const router     = require('express').Router();
const db         = require('../db');
const auth       = require('../middleware/auth');
const { sendPush } = require('../utils/push');

// POST /bookings — invia richiesta data
router.post('/', auth, async (req, res) => {
  const { to_user_id, event_date, proposed_cachet, notes } = req.body;
  if (!to_user_id || !event_date)
    return res.status(400).json({ error: 'to_user_id e event_date sono obbligatori' });
  if (to_user_id === req.user.id)
    return res.status(400).json({ error: 'Non puoi inviare una richiesta a te stesso' });

  // Controlla limite piano free (3 richieste/mese)
  const { rows: userRows } = await db.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
  if (userRows[0]?.plan === 'free') {
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM booking_requests
       WHERE from_user_id = $1 AND created_at >= date_trunc('month', NOW())`,
      [req.user.id]
    );
    if (parseInt(countRows[0].count) >= 3)
      return res.status(403).json({
        error: 'Hai raggiunto il limite di 3 richieste mensili con il piano Free.',
        code: 'PLAN_LIMIT',
      });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO booking_requests (from_user_id, to_user_id, event_date, proposed_cachet, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, to_user_id, event_date, proposed_cachet, notes]
    );

    // Push al destinatario
    const { rows: recipientRows } = await db.query(
      'SELECT push_token, username FROM users WHERE id = $1', [to_user_id]
    );
    const { rows: senderRows } = await db.query(
      'SELECT username FROM users WHERE id = $1', [req.user.id]
    );
    const dateStr = new Date(event_date).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
    sendPush(recipientRows[0]?.push_token, {
      title: '🎵 Nuova richiesta di booking',
      body: `${senderRows[0]?.username} ti ha inviato una proposta per il ${dateStr}`,
      data: { bookingId: rows[0].id, screen: 'BookingDetail' },
    });

    res.status(201).json({ booking: rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Errore server' });
  }
});

// GET /bookings — tutte le richieste dell'utente loggato
router.get('/', auth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT br.*,
            fu.username AS from_username, fu.role AS from_role,
            tu.username AS to_username,   tu.role AS to_role
     FROM booking_requests br
     JOIN users fu ON fu.id = br.from_user_id
     JOIN users tu ON tu.id = br.to_user_id
     WHERE br.from_user_id = $1 OR br.to_user_id = $1
     ORDER BY br.created_at DESC`,
    [req.user.id]
  );
  res.json({ bookings: rows });
});

// GET /bookings/:id — singola richiesta
router.get('/:id', auth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT br.*,
            fu.username AS from_username,
            tu.username AS to_username
     FROM booking_requests br
     JOIN users fu ON fu.id = br.from_user_id
     JOIN users tu ON tu.id = br.to_user_id
     WHERE br.id = $1 AND (br.from_user_id = $2 OR br.to_user_id = $2)`,
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Richiesta non trovata' });
  res.json({ booking: rows[0] });
});

// PATCH /bookings/:id/status — cambia stato (confirmed, rejected, cancelled)
router.patch('/:id/status', auth, async (req, res) => {
  const { status, rejection_reason } = req.body;
  const allowed = ['confirmed', 'rejected', 'cancelled', 'negotiating'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `status deve essere uno di: ${allowed.join(', ')}` });

  const { rows } = await db.query(
    `UPDATE booking_requests
     SET status = $1,
         rejection_reason = CASE WHEN $1 IN ('rejected','cancelled') THEN $4 ELSE rejection_reason END
     WHERE id = $2 AND (from_user_id = $3 OR to_user_id = $3)
     RETURNING *`,
    [status, req.params.id, req.user.id, rejection_reason ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Richiesta non trovata' });

  // Push all'altro utente
  const booking = rows[0];
  const otherId = booking.from_user_id === req.user.id ? booking.to_user_id : booking.from_user_id;
  const { rows: otherRows } = await db.query('SELECT push_token, username FROM users WHERE id = $1', [otherId]);
  const { rows: actorRows } = await db.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
  const statusMessages = {
    confirmed:   '✅ Richiesta confermata!',
    rejected:    '❌ Richiesta rifiutata',
    negotiating: '💬 Trattativa aperta',
    cancelled:   '🚫 Richiesta cancellata',
  };
  if (statusMessages[status]) {
    const dateStr = new Date(booking.event_date).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
    sendPush(otherRows[0]?.push_token, {
      title: statusMessages[status],
      body: `${actorRows[0]?.username} — ${dateStr}`,
      data: { bookingId: booking.id, screen: 'BookingDetail' },
    });
  }

  res.json({ booking: rows[0] });
});

// GET /bookings/:id/messages — messaggi della trattativa
router.get('/:id/messages', auth, async (req, res) => {
  // Verifica accesso
  const { rows: access } = await db.query(
    'SELECT id FROM booking_requests WHERE id = $1 AND (from_user_id = $2 OR to_user_id = $2)',
    [req.params.id, req.user.id]
  );
  if (!access[0]) return res.status(403).json({ error: 'Accesso negato' });

  const { rows } = await db.query(
    `SELECT m.*, u.username AS sender_username
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.booking_id = $1
     ORDER BY m.created_at ASC`,
    [req.params.id]
  );
  res.json({ messages: rows });
});

// POST /bookings/:id/messages — invia messaggio
router.post('/:id/messages', auth, async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Il messaggio non può essere vuoto' });

  const { rows: access } = await db.query(
    'SELECT id FROM booking_requests WHERE id = $1 AND (from_user_id = $2 OR to_user_id = $2)',
    [req.params.id, req.user.id]
  );
  if (!access[0]) return res.status(403).json({ error: 'Accesso negato' });

  const { rows } = await db.query(
    'INSERT INTO messages (booking_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *',
    [req.params.id, req.user.id, body.trim()]
  );
  res.status(201).json({ message: rows[0] });
});

module.exports = router;
