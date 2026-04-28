const router     = require('express').Router();
const db         = require('../db');
const auth       = require('../middleware/auth');
const { sendPush } = require('../utils/push');

// POST /bookings — invia richiesta (venue→band) o proposta (band→venue)
router.post('/', auth, async (req, res) => {
  const { to_user_id, event_date, proposed_cachet, notes,
          band_id, set_duration, preferred_period } = req.body;
  if (!to_user_id)
    return res.status(400).json({ error: 'to_user_id è obbligatorio' });
  if (to_user_id === req.user.id)
    return res.status(400).json({ error: 'Non puoi inviare una richiesta a te stesso' });

  const { rows: userRows } = await db.query('SELECT plan, role FROM users WHERE id = $1', [req.user.id]);
  if (userRows[0]?.plan === 'free') {
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM booking_requests
       WHERE from_user_id = $1 AND created_at >= CURRENT_DATE`,
      [req.user.id]
    );
    if (parseInt(countRows[0].count) >= 2)
      return res.status(403).json({
        error: 'Hai raggiunto il limite di 2 richieste giornaliere con il piano Free.',
        code: 'PLAN_LIMIT',
      });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO booking_requests
         (from_user_id, to_user_id, event_date, proposed_cachet, notes,
          band_id, set_duration, preferred_period)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.user.id, to_user_id, event_date ?? null, proposed_cachet ?? null,
       notes ?? null, band_id ?? null, set_duration ?? null, preferred_period ?? null]
    );

    const { rows: recipientRows } = await db.query(
      'SELECT push_token, username FROM users WHERE id = $1', [to_user_id]
    );
    const { rows: senderRows } = await db.query(
      'SELECT username FROM users WHERE id = $1', [req.user.id]
    );
    const isProposal = userRows[0]?.role === 'artist';
    const pushBody = isProposal
      ? `${senderRows[0]?.username} ti ha inviato una proposta per suonare nel tuo locale`
      : (() => {
          const dateStr = event_date
            ? new Date(event_date).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })
            : 'data da definire';
          return `${senderRows[0]?.username} ti ha inviato una proposta per il ${dateStr}`;
        })();

    sendPush(recipientRows[0]?.push_token, {
      title: isProposal ? '🎸 Nuova proposta da una band' : '🎵 Nuova richiesta di booking',
      body: pushBody,
      data: { bookingId: rows[0].id, screen: 'BookingDetail' },
    });

    res.status(201).json({ booking: rows[0] });
  } catch (e) {
    console.error('POST /bookings error:', e.message);
    res.status(500).json({ error: 'Errore server' });
  }
});

// GET /bookings/daily-count — quante richieste ha inviato oggi l'utente free
router.get('/daily-count', auth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT COUNT(*) FROM booking_requests
     WHERE from_user_id = $1 AND created_at >= CURRENT_DATE`,
    [req.user.id]
  );
  const { rows: userRows } = await db.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
  const plan  = userRows[0]?.plan ?? 'free';
  const count = parseInt(rows[0].count);
  const limit = plan === 'pro' ? null : 2;
  res.json({ count, limit, remaining: limit === null ? null : Math.max(0, limit - count) });
});

// GET /bookings — richieste attive o archiviate (?archived=true)
router.get('/', auth, async (req, res) => {
  const archived = req.query.archived === 'true';
  const { rows } = await db.query(
    `SELECT br.*,
            fu.username AS from_username, fu.role AS from_role,
            tu.username AS to_username,   tu.role AS to_role,
            ap.name AS band_name, ap.city AS band_city,
            ap.genres AS band_genres, ap.band_type AS band_type_key,
            ap.avatar_url AS band_avatar_url,
            last_msg.created_at AS last_message_at,
            last_msg.sender_id  AS last_message_sender_id
     FROM booking_requests br
     JOIN users fu ON fu.id = br.from_user_id
     JOIN users tu ON tu.id = br.to_user_id
     LEFT JOIN artist_profiles ap ON ap.id = br.band_id
     LEFT JOIN LATERAL (
       SELECT sender_id, created_at FROM messages
       WHERE booking_id = br.id
       ORDER BY created_at DESC LIMIT 1
     ) last_msg ON true
     WHERE (br.from_user_id = $1 OR br.to_user_id = $1)
       AND NOT EXISTS (SELECT 1 FROM booking_deletions bd WHERE bd.booking_id = br.id AND bd.user_id = $1)
       AND ${archived
         ? 'EXISTS (SELECT 1 FROM booking_archives ba WHERE ba.booking_id = br.id AND ba.user_id = $1)'
         : 'NOT EXISTS (SELECT 1 FROM booking_archives ba WHERE ba.booking_id = br.id AND ba.user_id = $1)'
       }
     ORDER BY COALESCE(last_msg.created_at, br.created_at) DESC`,
    [req.user.id]
  );
  res.json({ bookings: rows });
});

// PATCH /bookings/:id/archive — toggle archivio per l'utente corrente
router.patch('/:id/archive', auth, async (req, res) => {
  const { rows: access } = await db.query(
    'SELECT id FROM booking_requests WHERE id = $1 AND (from_user_id = $2 OR to_user_id = $2)',
    [req.params.id, req.user.id]
  );
  if (!access[0]) return res.status(404).json({ error: 'Richiesta non trovata' });

  const { rows: existing } = await db.query(
    'SELECT 1 FROM booking_archives WHERE booking_id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );

  if (existing.length > 0) {
    await db.query('DELETE FROM booking_archives WHERE booking_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ archived: false });
  } else {
    await db.query('INSERT INTO booking_archives (booking_id, user_id) VALUES ($1, $2)', [req.params.id, req.user.id]);
    res.json({ archived: true });
  }
});

// DELETE /bookings/:id — soft delete per l'utente corrente
// Il record viene eliminato dal DB solo quando entrambe le parti l'hanno cancellato
router.delete('/:id', auth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, from_user_id, to_user_id FROM booking_requests WHERE id = $1 AND (from_user_id = $2 OR to_user_id = $2)',
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Richiesta non trovata' });

  // Registra l'eliminazione per questo utente (ignora se già presente)
  await db.query(
    'INSERT INTO booking_deletions (user_id, booking_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user.id, req.params.id]
  );

  // Se entrambe le parti hanno eliminato, cancella il record definitivamente
  const booking = rows[0];
  const otherId = booking.from_user_id === req.user.id ? booking.to_user_id : booking.from_user_id;
  const { rows: otherDel } = await db.query(
    'SELECT 1 FROM booking_deletions WHERE booking_id = $1 AND user_id = $2',
    [req.params.id, otherId]
  );
  if (otherDel.length > 0) {
    await db.query('DELETE FROM booking_requests WHERE id = $1', [req.params.id]);
  }

  res.json({ deleted: true });
});

// GET /bookings/:id — singola richiesta
router.get('/:id', auth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT br.*,
            fu.username AS from_username, fu.role AS from_role,
            tu.username AS to_username,   tu.role AS to_role,
            ap.name AS band_name, ap.city AS band_city,
            ap.genres AS band_genres, ap.band_type AS band_type_key,
            ap.avatar_url AS band_avatar_url, ap.id AS band_profile_id,
            ap.cachet_min, ap.set_duration_min, ap.set_duration_max
     FROM booking_requests br
     JOIN users fu ON fu.id = br.from_user_id
     JOIN users tu ON tu.id = br.to_user_id
     LEFT JOIN artist_profiles ap ON ap.id = br.band_id
     WHERE br.id = $1 AND (br.from_user_id = $2 OR br.to_user_id = $2)`,
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Richiesta non trovata' });
  res.json({ booking: rows[0] });
});

// PATCH /bookings/:id/status — cambia stato (confirmed, rejected, cancelled)
router.patch('/:id/status', auth, async (req, res) => {
  const { status, rejection_reason, confirmed_date, confirmed_cachet } = req.body;
  const allowed = ['confirmed', 'rejected', 'cancelled', 'negotiating'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `status deve essere uno di: ${allowed.join(', ')}` });

  const { rows } = await db.query(
    `UPDATE booking_requests
     SET status = $1,
         rejection_reason = CASE WHEN $1 IN ('rejected','cancelled') THEN $4 ELSE rejection_reason END,
         event_date       = CASE WHEN $1 = 'confirmed' AND $5::date IS NOT NULL THEN $5::date ELSE event_date END,
         proposed_cachet  = CASE WHEN $1 = 'confirmed' AND $6::int IS NOT NULL  THEN $6::int  ELSE proposed_cachet END
     WHERE id = $2 AND (from_user_id = $3 OR to_user_id = $3)
     RETURNING *`,
    [status, req.params.id, req.user.id, rejection_reason ?? null,
     confirmed_date ?? null, confirmed_cachet ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Richiesta non trovata' });

  // Push all'altro utente
  const booking = rows[0];
  const otherId = booking.from_user_id === req.user.id ? booking.to_user_id : booking.from_user_id;
  const { rows: otherRows } = await db.query('SELECT push_token, username FROM users WHERE id = $1', [otherId]);
  const { rows: actorRows } = await db.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
  if (status !== 'negotiating') { // negotiating non manda push
    const dateStr = booking.event_date
      ? new Date(booking.event_date).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })
      : null;
    const pushTitles = {
      confirmed:   '✅ Collaborazione confermata!',
      rejected:    '❌ Richiesta rifiutata',
      negotiating: '',
      cancelled:   '🚫 Richiesta cancellata',
    };
    const pushBody = status === 'confirmed' && dateStr
      ? `${actorRows[0]?.username} ha confermato la data: ${dateStr}`
      : status === 'confirmed'
        ? `${actorRows[0]?.username} ha confermato la collaborazione`
        : `${actorRows[0]?.username}${dateStr ? ` — ${dateStr}` : ''}`;
    sendPush(otherRows[0]?.push_token, {
      title: pushTitles[status],
      body:  pushBody,
      data:  { bookingId: booking.id, screen: 'BookingDetail' },
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
    'SELECT br.*, fu.username AS from_username, tu.username AS to_username, fu.push_token AS from_push, tu.push_token AS to_push FROM booking_requests br JOIN users fu ON fu.id = br.from_user_id JOIN users tu ON tu.id = br.to_user_id WHERE br.id = $1 AND (br.from_user_id = $2 OR br.to_user_id = $2)',
    [req.params.id, req.user.id]
  );
  if (!access[0]) return res.status(403).json({ error: 'Accesso negato' });

  const { rows } = await db.query(
    'INSERT INTO messages (booking_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *',
    [req.params.id, req.user.id, body.trim()]
  );

  // Push all'altro partecipante
  const booking = access[0];
  const isSender = req.user.id === booking.from_user_id;
  const otherPush = isSender ? booking.to_push : booking.from_push;
  const senderName = isSender ? booking.from_username : booking.to_username;
  const dateStr = new Date(booking.event_date).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  sendPush(otherPush, {
    title: `💬 ${senderName}`,
    body: body.trim().length > 80 ? body.trim().slice(0, 77) + '…' : body.trim(),
    data: { bookingId: booking.id, screen: 'BookingDetail', eventDate: dateStr },
  });

  res.status(201).json({ message: rows[0] });
});

module.exports = router;
