-- Relay schema. Times are integer milliseconds since the epoch. Ids are UUIDs (v7 when server-made).
-- Bearer secrets (session, invitation, grant, link, request and device tokens) are stored only as
-- SHA-256 hashes, and pickup codes only as keyed HMAC digests.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  -- The name other people see (share pages, requests, invitations). NULL shows the username.
  display_name TEXT,
  password_hash TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  -- Limits the administrator sets. NULL is no limit: `quota` then shares the total storage with
  -- everyone, and the others allow uploads kept until deleted and links that never expire.
  quota INTEGER,
  max_retention_days INTEGER,
  max_link_days INTEGER,
  -- The member's own choices, kept within those limits. NULL keeps uploads until deleted.
  retention_days INTEGER,
  -- Days an item stays in Trash before it is deleted for good.
  trash_days INTEGER NOT NULL DEFAULT 30,
  prefs TEXT NOT NULL DEFAULT '{}',
  -- Maintained by triggers on nodes: logical bytes of ready file and text nodes.
  bytes_used INTEGER NOT NULL DEFAULT 0,
  -- Activity up to this time has been seen on some device of the account.
  activity_seen INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- From the browser that signed in, so renaming never changes a device's icon.
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'tablet', 'computer')),
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL
) STRICT;
CREATE INDEX devices_user ON devices(user_id, seen);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_device ON sessions(device_id);
CREATE INDEX sessions_expires ON sessions(expires);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY, -- WebAuthn credential id, base64url
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER
) STRICT;
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- An optional note saying who the invitation is for, so open invitations can be told apart.
  note TEXT,
  -- The limits the new member gets, as in users. They can be changed until the invitation is used.
  quota INTEGER,
  max_retention_days INTEGER,
  max_link_days INTEGER,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  used INTEGER
) STRICT;
CREATE INDEX invites_expires ON invites(expires);

-- One-time sign-in codes shown on a signed-in device.
CREATE TABLE login_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The issuing session; signing that session out invalidates its codes.
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  -- The stable sign-in URL's bearer token. The numeric code can rotate; this can't.
  device_token_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER,
  -- The device the code signed in, so the issuing device can confirm that exact code.
  used_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  revoked INTEGER
) STRICT;
CREATE INDEX login_codes_user ON login_codes(user_id, expires);
-- Signing a session out deletes its codes; the sweep deletes expired and revoked ones.
CREATE INDEX login_codes_session ON login_codes(session_hash);
CREATE INDEX login_codes_expires ON login_codes(expires);
CREATE INDEX login_codes_revoked ON login_codes(revoked) WHERE revoked IS NOT NULL;

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  closed INTEGER,
  max_bytes INTEGER NOT NULL,
  creation_fingerprint TEXT NOT NULL,
  -- When a guest last finished a submission, so the owner's open tabs can say so.
  last_received INTEGER
) STRICT;
CREATE INDEX requests_owner ON requests(owner, created);

-- A library card. Its contents are the nodes that reference it.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL means the display name is derived from the contents.
  name TEXT,
  created INTEGER NOT NULL,
  expires INTEGER,
  -- The clock starts with the first saved file/text (or a deliberate folder-only transfer).
  first_saved_at INTEGER,
  retention_days INTEGER,
  -- This cap can only tighten, even before first publication. Hard deadline = first_saved_at + cap.
  max_age_days INTEGER,
  trashed INTEGER,
  -- Fixed when trashed; policy tightening may shorten it, loosening never extends it.
  purge_at INTEGER,
  request_id TEXT REFERENCES requests(id) ON DELETE SET NULL,
  -- The name a guest gave with their submission; NULL when they left it blank, and for member items.
  sender TEXT,
  -- Cached ItemSummary fields derived from the nodes. Triggers set summary_dirty on any node change;
  -- the library recomputes dirty summaries when it next reads them.
  summary TEXT NOT NULL DEFAULT '{}',
  summary_dirty INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX items_owner ON items(owner, trashed, created);
CREATE INDEX items_request ON items(request_id);
CREATE INDEX items_expires ON items(expires) WHERE expires IS NOT NULL AND trashed IS NULL;
CREATE INDEX items_trashed ON items(trashed) WHERE trashed IS NOT NULL;
CREATE INDEX items_dirty ON items(id) WHERE summary_dirty = 1;

-- Content-addressed payloads, stored at blobs/<aa>/<bb>/<sha256>. A blob lives while a node references it.
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  crc32 INTEGER NOT NULL,
  created INTEGER NOT NULL,
  integrity TEXT NOT NULL DEFAULT 'ok' CHECK (integrity IN ('ok', 'missing', 'corrupt', 'unreadable')),
  checked_at INTEGER
) STRICT;
CREATE INDEX blobs_degraded ON blobs(integrity) WHERE integrity <> 'ok';

-- Filesystem cleanup intent exists before staging writes, without claiming the bytes were adopted.
-- Temporary basenames let maintenance recover failed renames/unlinks as well as hash-named payloads.
CREATE TABLE blob_cleanup (
  sha256 TEXT NOT NULL,
  temporary TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'blob' CHECK (kind IN ('blob', 'thumbnail')),
  PRIMARY KEY (sha256, temporary)
) STRICT;

-- The folder tree of an item. Top-level nodes have parent NULL. A pending file is still uploading:
-- it reserves its name and counts toward its owner's reserved bytes.
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder', 'text')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready')),
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',
  blob TEXT REFERENCES blobs(sha256),
  text TEXT,
  created INTEGER NOT NULL,
  -- Order of arrival within the item; the first top-level entry names auto-named items.
  position INTEGER NOT NULL,
  CHECK ((kind = 'file' AND state = 'pending' AND blob IS NULL)
      OR (kind = 'file' AND state = 'ready' AND blob IS NOT NULL)
      OR (kind = 'folder' AND state = 'ready' AND blob IS NULL AND size = 0)
      OR (kind = 'text' AND state = 'ready' AND blob IS NULL AND text IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX nodes_sibling_name ON nodes(item, ifnull(parent, ''), name COLLATE NOCASE);
CREATE INDEX nodes_item ON nodes(item, kind, position);
CREATE INDEX nodes_parent ON nodes(parent);
CREATE INDEX nodes_blob ON nodes(blob) WHERE blob IS NOT NULL;
CREATE INDEX nodes_pending ON nodes(owner) WHERE state = 'pending';
CREATE INDEX nodes_name ON nodes(owner, name COLLATE NOCASE);

-- Rows that would not change are left alone: a folder of thousands of files marks its item once,
-- not once per file, and a change that moves no bytes does not rewrite its owner.
CREATE TRIGGER nodes_insert AFTER INSERT ON nodes BEGIN
  UPDATE users SET bytes_used = bytes_used + NEW.size WHERE id = NEW.owner AND NEW.state = 'ready' AND NEW.size <> 0;
  UPDATE items SET summary_dirty = 1 WHERE id = NEW.item AND summary_dirty = 0;
END;
CREATE TRIGGER nodes_delete AFTER DELETE ON nodes BEGIN
  UPDATE users SET bytes_used = bytes_used - OLD.size WHERE id = OLD.owner AND OLD.state = 'ready' AND OLD.size <> 0;
  UPDATE items SET summary_dirty = 1 WHERE id = OLD.item AND summary_dirty = 0;
END;
CREATE TRIGGER nodes_update AFTER UPDATE ON nodes BEGIN
  UPDATE users SET bytes_used = bytes_used
      - (CASE WHEN OLD.state = 'ready' THEN OLD.size ELSE 0 END)
      + (CASE WHEN NEW.state = 'ready' THEN NEW.size ELSE 0 END)
    WHERE id = NEW.owner
      AND (CASE WHEN OLD.state = 'ready' THEN OLD.size ELSE 0 END)
       <> (CASE WHEN NEW.state = 'ready' THEN NEW.size ELSE 0 END);
  UPDATE items SET summary_dirty = 1 WHERE id IN (OLD.item, NEW.item) AND summary_dirty = 0;
END;

-- One browser page load. Its event stream renews the lease; an expired or closed tab abandons its transfers.
CREATE TABLE tabs (
  id TEXT PRIMARY KEY,
  -- 'user:<id>' or 'grant:<token hash>'
  principal TEXT NOT NULL,
  lease_expires INTEGER NOT NULL,
  closed INTEGER
) STRICT;
-- The sweep removes tabs whose lease ended a day ago, closed or not.
CREATE INDEX tabs_lease ON tabs(lease_expires);

CREATE TABLE guest_grants (
  token_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  -- Created with the grant's first transfer; every later transfer adds to the same submission.
  item TEXT REFERENCES items(id) ON DELETE SET NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
) STRICT;
CREATE INDEX guest_grants_request ON guest_grants(request_id);
CREATE INDEX guest_grants_item ON guest_grants(item) WHERE item IS NOT NULL;
CREATE INDEX guest_grants_expires ON guest_grants(expires);

CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tab TEXT NOT NULL REFERENCES tabs(id),
  state TEXT NOT NULL CHECK (state IN ('open', 'complete', 'cancelled')),
  -- SHA-256 of the canonical create request, so an idempotent retry must match exactly.
  request_hash TEXT NOT NULL,
  -- JSON of the completing destination and its TransferResult ids, once complete.
  result TEXT,
  created INTEGER NOT NULL,
  finished INTEGER
) STRICT;
CREATE INDEX transfers_open ON transfers(tab) WHERE state = 'open';
-- Every transfer of a tab, for deleting the tab once none is left.
CREATE INDEX transfers_tab ON transfers(tab);
CREATE INDEX transfers_item ON transfers(item);
CREATE INDEX transfers_finished ON transfers(finished) WHERE state != 'open';

-- tus uploads. `offset` is the durable, fsynced byte count; the file is uploads/<id>.part.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  transfer TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  node TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  size INTEGER NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  touched INTEGER NOT NULL,
  completed INTEGER
) STRICT;
CREATE INDEX uploads_transfer ON uploads(transfer);
CREATE INDEX uploads_active ON uploads(id) WHERE completed IS NULL;
-- Deleting a node clears its upload's reference; without this, every node deleted scans uploads.
CREATE INDEX uploads_node ON uploads(node) WHERE node IS NOT NULL;

-- Public links show an item's current contents while the link is valid. A link can be kept until
-- turned off (expires NULL), locked with a password, limited to a number of people, and carry a
-- short note for whoever opens it. `password_hash` is a scrypt hash; the password is never kept.
-- `visitor_limit` counts people (browsers) let in, not requests.
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  expires INTEGER,
  revoked INTEGER,
  password_hash TEXT,
  visitor_limit INTEGER CHECK (visitor_limit IS NULL OR visitor_limit >= 1),
  note TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX links_owner ON links(owner, created);
CREATE INDEX links_item ON links(item);

-- One row per person (browser) a link let in. `visitor` is an HMAC of the browser's random visitor
-- cookie and the link id, so rows can't be matched across links. Nothing identifying is stored:
-- `device` is a coarse label such as "Safari on iPhone". `unlocked` holds the password hash the
-- visitor last unlocked with; changing or removing the password makes it stale. The owner's own
-- views are never recorded.
CREATE TABLE link_visits (
  id TEXT PRIMARY KEY,
  link TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  visitor TEXT NOT NULL,
  device TEXT NOT NULL,
  first INTEGER NOT NULL,
  last INTEGER NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  last_download INTEGER,
  unlocked TEXT,
  UNIQUE (link, visitor)
) STRICT;

-- An item sent to one of the owner's devices. The receiving device answers it: accepted (downloaded
-- there) or declined. The item stays in Files either way.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  from_device TEXT REFERENCES devices(id) ON DELETE SET NULL,
  to_device TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('available', 'accepted', 'declined')),
  created INTEGER NOT NULL,
  answered INTEGER,
  CHECK ((state = 'available') = (answered IS NULL))
) STRICT;
CREATE INDEX deliveries_to ON deliveries(to_device, created);
CREATE INDEX deliveries_item ON deliveries(item);
CREATE INDEX deliveries_from ON deliveries(from_device, created);

-- The account's activity feed: sign-ins, password and passkey changes, guest uploads to requests,
-- members joining with an invitation, and link opens and downloads. `data` is the event as JSON;
-- `kind` is repeated for filtering. `by_device` is the member's device that caused it, if one did:
-- that device already knows.
CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('signin', 'password', 'passkey', 'upload', 'joined', 'link')),
  by_device TEXT REFERENCES devices(id) ON DELETE SET NULL,
  created INTEGER NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX activity_owner ON activity(owner, created);
CREATE INDEX activity_created ON activity(created);

-- Hourly usage per member, for their Usage page and for Admin. `hour` counts whole hours since the
-- epoch (UTC). Bytes: `uploaded` by the member, `received` from guests through their requests,
-- `downloaded` by the member, and `shared` with people through their links. Counts: `files` that
-- finished uploading (theirs and guests'), `visitors` their links let in, and `downloads` through
-- those links. `stored` samples bytes_used when it changed during the hour; NULL means unchanged.
-- Rows outlive the items, links and requests they count, and are kept for about thirteen months.
CREATE TABLE usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hour INTEGER NOT NULL,
  uploaded INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  downloaded INTEGER NOT NULL DEFAULT 0,
  shared INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  visitors INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  stored INTEGER,
  PRIMARY KEY (user_id, hour)
) STRICT, WITHOUT ROWID;
CREATE INDEX usage_hour ON usage(hour);

-- Requests the server answered per hour, and how many failed (5xx), for Admin. Kept like usage.
CREATE TABLE traffic (
  hour INTEGER PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Every numeric pickup code ever assigned, across all kinds, in one namespace. `nonce` is the step
-- of the target's code sequence, so the code can be shown again without storing it. A retired row
-- stays as a tombstone, so a printed code that expired, was revoked or was replaced is never given
-- to anyone else.
CREATE TABLE pickup_codes (
  code_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('share', 'request', 'invitation', 'device')),
  target_id TEXT NOT NULL,
  nonce INTEGER NOT NULL CHECK (nonce >= 0),
  created INTEGER NOT NULL,
  retired INTEGER CHECK (retired IS NULL OR retired >= created)
) STRICT;
CREATE UNIQUE INDEX pickup_codes_active_target ON pickup_codes(kind, target_id) WHERE retired IS NULL;
-- Tombstones included: an id that ever had a code is never given out again.
CREATE INDEX pickup_codes_target ON pickup_codes(kind, target_id);

-- A code is live only while its target row exists.
CREATE TRIGGER retire_share_code_after_link_delete AFTER DELETE ON links BEGIN
  UPDATE pickup_codes SET retired = MAX(created, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE kind = 'share' AND target_id = OLD.id AND retired IS NULL;
END;
CREATE TRIGGER retire_request_code_after_request_delete AFTER DELETE ON requests BEGIN
  UPDATE pickup_codes SET retired = MAX(created, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE kind = 'request' AND target_id = OLD.id AND retired IS NULL;
END;
CREATE TRIGGER retire_invitation_code_after_invite_delete AFTER DELETE ON invites BEGIN
  UPDATE pickup_codes SET retired = MAX(created, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE kind = 'invitation' AND target_id = OLD.id AND retired IS NULL;
END;
CREATE TRIGGER retire_device_code_after_login_code_delete AFTER DELETE ON login_codes BEGIN
  UPDATE pickup_codes SET retired = MAX(created, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE kind = 'device' AND target_id = OLD.id AND retired IS NULL;
END;
