-- OneStage — Schema iniziale
-- Esegui una volta sul DB Railway prima del primo avvio

CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  username            TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('artist', 'venue')),
  plan                TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  plan_expires_at     TIMESTAMP,
  push_token          TEXT,
  privacy_accepted_at TIMESTAMP,
  created_at          TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS artist_profiles (
  id               SERIAL PRIMARY KEY,
  user_id          INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  bio              TEXT,
  city             TEXT NOT NULL,
  cachet_min       INT,
  cachet_max       INT,
  set_duration_min INT,   -- minuti
  set_duration_max INT,
  show_types       TEXT[] DEFAULT '{}',  -- live, acoustic, dj_set, cover, original
  genres           TEXT[] DEFAULT '{}',
  spotify_url      TEXT,
  youtube_url      TEXT,
  avatar_url       TEXT,
  is_verified      BOOLEAN DEFAULT false,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS venue_profiles (
  id               SERIAL PRIMARY KEY,
  user_id          INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  type             TEXT,   -- club, festival, pub, teatro, altro
  city             TEXT NOT NULL,
  address          TEXT,
  capacity         INT,
  has_pa           BOOLEAN DEFAULT false,
  has_backline     BOOLEAN DEFAULT false,
  budget_min       INT,
  budget_max       INT,
  bio              TEXT,
  preferred_genres TEXT[] DEFAULT '{}',
  avatar_url       TEXT,
  is_verified      BOOLEAN DEFAULT false,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS booking_requests (
  id              SERIAL PRIMARY KEY,
  from_user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_date      DATE NOT NULL,
  proposed_cachet INT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','negotiating','confirmed','rejected','cancelled')),
  notes           TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  booking_id INT NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  sender_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ratings (
  id           SERIAL PRIMARY KEY,
  booking_id   INT NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  from_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score        INT NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE(booking_id, from_user_id)
);

-- Indici utili
CREATE INDEX IF NOT EXISTS idx_artist_profiles_city    ON artist_profiles(city);
CREATE INDEX IF NOT EXISTS idx_venue_profiles_city     ON venue_profiles(city);
CREATE INDEX IF NOT EXISTS idx_booking_requests_from   ON booking_requests(from_user_id);
CREATE INDEX IF NOT EXISTS idx_booking_requests_to     ON booking_requests(to_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_booking        ON messages(booking_id);
