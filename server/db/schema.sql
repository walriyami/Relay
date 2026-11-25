-- Relay schema. Times are integer milliseconds since the epoch. Ids are UUIDs (v7 when server-made).
-- Bearer secrets (session, invitation, grant, link, request, device and Nearby tokens) are stored
-- only as SHA-256 hashes, and pickup codes only as keyed HMAC digests.

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
  -- What unfinished uploads hold, kept by the held_* triggers below so room checks read a few rows
  -- instead of adding up every unfinished file (see server/modules/transfers/room.ts). At startup
  -- Relay recomputes them from the uploads and corrects any that differ.
  -- `reserved_bytes`: the declared size of this member's pending files.
  reserved_bytes INTEGER NOT NULL DEFAULT 0,
  -- Of pending files sent by request-link visitors to this member, the bytes not yet saved.
  reserved_visitor_unsent INTEGER NOT NULL DEFAULT 0,
  -- Bytes still to arrive in open transfers to this member: their own, and visitors'.
  unsent_member INTEGER NOT NULL DEFAULT 0,
  unsent_visitor INTEGER NOT NULL DEFAULT 0,
  -- Activity up to this time has been seen on some device of the account.
  activity_seen INTEGER NOT NULL DEFAULT 0,
  -- When removing this member stopped part way (they stay suspended, with what couldn't be
  -- deleted), until they are removed after all or their suspension is lifted.
  removal_stopped INTEGER,
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

-- A member's Nearby code. Whoever opens it and gives a name can exchange files directly with the
-- member's devices (see shared/nearby.ts) until it expires or the member ends it. One per member.
CREATE TABLE nearby_invites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
) STRICT;
CREATE INDEX nearby_invites_expires ON nearby_invites(expires);

-- Someone who joined with a Nearby code, holding its per-code cookie. They go with the code.
CREATE TABLE nearby_guests (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES nearby_invites(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'tablet', 'computer')),
  created INTEGER NOT NULL
) STRICT;
CREATE INDEX nearby_guests_invite ON nearby_guests(invite_id);

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
  last_received INTEGER,
  -- The entries (files, folders and texts) and bytes in this request's submissions, unfinished files
  -- included: kept by the request_held_* triggers so a visitor's page doesn't count every file.
  -- Corrected at startup like users.reserved_bytes.
  held_entries INTEGER NOT NULL DEFAULT 0,
  held_bytes INTEGER NOT NULL DEFAULT 0
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

-- What each member stores, by MIME type: the bytes of ready files and texts, and how many files.
-- The node triggers keep it, so usage pages read a few rows instead of adding up every file. At
-- startup Relay compares it with users.bytes_used and rebuilds it from the nodes if they differ.
CREATE TABLE stored_types (
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, mime)
) STRICT, WITHOUT ROWID;

-- Rows that would not change are left alone: a folder of thousands of files marks its item once,
-- not once per file, and a change that moves no bytes does not rewrite its owner.
CREATE TRIGGER nodes_insert AFTER INSERT ON nodes BEGIN
  UPDATE users SET bytes_used = bytes_used + NEW.size WHERE id = NEW.owner AND NEW.state = 'ready' AND NEW.size <> 0;
  UPDATE items SET summary_dirty = 1 WHERE id = NEW.item AND summary_dirty = 0;
  INSERT INTO stored_types(owner, mime, bytes, files)
    SELECT NEW.owner, NEW.mime, NEW.size, NEW.kind = 'file' WHERE NEW.state = 'ready' AND NEW.kind <> 'folder'
    ON CONFLICT(owner, mime) DO UPDATE SET bytes = bytes + excluded.bytes, files = files + excluded.files;
END;
CREATE TRIGGER nodes_delete AFTER DELETE ON nodes BEGIN
  UPDATE users SET bytes_used = bytes_used - OLD.size WHERE id = OLD.owner AND OLD.state = 'ready' AND OLD.size <> 0;
  UPDATE items SET summary_dirty = 1 WHERE id = OLD.item AND summary_dirty = 0;
  UPDATE stored_types SET bytes = bytes - OLD.size, files = files - (OLD.kind = 'file')
    WHERE owner = OLD.owner AND mime = OLD.mime AND OLD.state = 'ready' AND OLD.kind <> 'folder';
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
CREATE TRIGGER nodes_update_type AFTER UPDATE OF owner, state, kind, size, mime ON nodes
WHEN NOT (OLD.owner = NEW.owner AND OLD.state = NEW.state AND OLD.kind = NEW.kind AND OLD.size = NEW.size AND OLD.mime = NEW.mime)
BEGIN
  UPDATE stored_types SET bytes = bytes - OLD.size, files = files - (OLD.kind = 'file')
    WHERE owner = OLD.owner AND mime = OLD.mime AND OLD.state = 'ready' AND OLD.kind <> 'folder';
  INSERT INTO stored_types(owner, mime, bytes, files)
    SELECT NEW.owner, NEW.mime, NEW.size, NEW.kind = 'file' WHERE NEW.state = 'ready' AND NEW.kind <> 'folder'
    ON CONFLICT(owner, mime) DO UPDATE SET bytes = bytes + excluded.bytes, files = files + excluded.files;
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
-- A request-link visit's pages, which are limited (see closeTab) and keep the visit in use.
CREATE INDEX tabs_principal ON tabs(principal);

CREATE TABLE guest_grants (
  token_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  -- Created with the grant's first transfer; every later transfer adds to the same submission.
  item TEXT REFERENCES items(id) ON DELETE SET NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  -- The visitor's address group (see addressKey) and network (an IPv4 /24 or IPv6 /56, see
  -- codeNetworkOf), so starting a new visit can't reset per-visitor limits. Visits made before
  -- 2026-11 have no network, and count by their address alone.
  address TEXT,
  network TEXT
) STRICT;
-- A request's visits from one network and from one address: limited, and the oldest idle one makes room.
CREATE INDEX guest_grants_request ON guest_grants(request_id, network, address, created);
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
-- A visit's open sends, counted against its limits and keeping the visit in use.
CREATE INDEX transfers_open_principal ON transfers(principal) WHERE state = 'open';
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

-- The held_* triggers keep users.reserved_bytes, reserved_visitor_unsent, unsent_member and
-- unsent_visitor. For an upload U of transfer T, credited to T's owner:
--   reserved_visitor_unsent counts node.size - U.offset while U's node is pending and T is a visitor's;
--   unsent_member / unsent_visitor count U.size - U.offset while U is unfinished, still has its node,
--   and T is open (a member's or a visitor's).
-- Each trigger takes away the old share of the row it changes and adds the new one. A node or
-- transfer about to be deleted gives up its uploads' shares first; once it is gone they count for
-- nothing, so the uploads that cascade after it change nothing more.
-- requests.held_entries and held_bytes. An item about to be deleted takes its nodes off its request
-- first; the nodes that cascade after it no longer find their item, so they change nothing more.
CREATE TRIGGER request_held_nodes_insert AFTER INSERT ON nodes BEGIN
  UPDATE requests SET held_entries = held_entries + 1, held_bytes = held_bytes + NEW.size
    WHERE id = (SELECT request_id FROM items WHERE id = NEW.item);
END;
CREATE TRIGGER request_held_nodes_delete AFTER DELETE ON nodes BEGIN
  UPDATE requests SET held_entries = held_entries - 1, held_bytes = held_bytes - OLD.size
    WHERE id = (SELECT request_id FROM items WHERE id = OLD.item);
END;
CREATE TRIGGER request_held_nodes_update AFTER UPDATE OF item, size ON nodes
WHEN OLD.item IS NOT NEW.item OR OLD.size IS NOT NEW.size BEGIN
  UPDATE requests SET held_entries = held_entries - 1, held_bytes = held_bytes - OLD.size
    WHERE id = (SELECT request_id FROM items WHERE id = OLD.item);
  UPDATE requests SET held_entries = held_entries + 1, held_bytes = held_bytes + NEW.size
    WHERE id = (SELECT request_id FROM items WHERE id = NEW.item);
END;
CREATE TRIGGER request_held_items_before_delete BEFORE DELETE ON items WHEN OLD.request_id IS NOT NULL BEGIN
  UPDATE requests SET
      held_entries = held_entries - (SELECT count(*) FROM nodes WHERE item = OLD.id),
      held_bytes = held_bytes - (SELECT ifnull(sum(size), 0) FROM nodes WHERE item = OLD.id)
    WHERE id = OLD.request_id;
END;
CREATE TRIGGER request_held_items_update AFTER UPDATE OF request_id ON items
WHEN OLD.request_id IS NOT NEW.request_id BEGIN
  UPDATE requests SET
      held_entries = held_entries - (SELECT count(*) FROM nodes WHERE item = OLD.id),
      held_bytes = held_bytes - (SELECT ifnull(sum(size), 0) FROM nodes WHERE item = OLD.id)
    WHERE id = OLD.request_id;
  UPDATE requests SET
      held_entries = held_entries + (SELECT count(*) FROM nodes WHERE item = NEW.id),
      held_bytes = held_bytes + (SELECT ifnull(sum(size), 0) FROM nodes WHERE item = NEW.id)
    WHERE id = NEW.request_id;
END;

CREATE TRIGGER held_nodes_insert AFTER INSERT ON nodes WHEN NEW.state = 'pending' AND NEW.size <> 0 BEGIN
  UPDATE users SET reserved_bytes = reserved_bytes + NEW.size WHERE id = NEW.owner;
END;
CREATE TRIGGER held_nodes_delete AFTER DELETE ON nodes WHEN OLD.state = 'pending' AND OLD.size <> 0 BEGIN
  UPDATE users SET reserved_bytes = reserved_bytes - OLD.size WHERE id = OLD.owner;
END;
CREATE TRIGGER held_nodes_before_delete BEFORE DELETE ON nodes WHEN OLD.state = 'pending' BEGIN
  UPDATE users SET reserved_visitor_unsent = reserved_visitor_unsent - (
      SELECT sum(OLD.size - u.offset) FROM uploads u JOIN transfers t ON t.id = u.transfer
      WHERE u.node = OLD.id AND t.principal LIKE 'grant:%' AND t.owner = users.id)
    WHERE id IN (SELECT t.owner FROM uploads u JOIN transfers t ON t.id = u.transfer
      WHERE u.node = OLD.id AND t.principal LIKE 'grant:%');
END;
CREATE TRIGGER held_nodes_update AFTER UPDATE OF state, size, owner ON nodes
WHEN OLD.state IS NOT NEW.state OR OLD.size IS NOT NEW.size OR OLD.owner IS NOT NEW.owner BEGIN
  UPDATE users SET reserved_bytes = reserved_bytes - OLD.size WHERE id = OLD.owner AND OLD.state = 'pending';
  UPDATE users SET reserved_bytes = reserved_bytes + NEW.size WHERE id = NEW.owner AND NEW.state = 'pending';
  UPDATE users SET reserved_visitor_unsent = reserved_visitor_unsent
      - (CASE WHEN OLD.state = 'pending' THEN (
          SELECT ifnull(sum(OLD.size - u.offset), 0) FROM uploads u JOIN transfers t ON t.id = u.transfer
          WHERE u.node = OLD.id AND t.principal LIKE 'grant:%' AND t.owner = users.id) ELSE 0 END)
      + (CASE WHEN NEW.state = 'pending' THEN (
          SELECT ifnull(sum(NEW.size - u.offset), 0) FROM uploads u JOIN transfers t ON t.id = u.transfer
          WHERE u.node = NEW.id AND t.principal LIKE 'grant:%' AND t.owner = users.id) ELSE 0 END)
    WHERE id IN (SELECT t.owner FROM uploads u JOIN transfers t ON t.id = u.transfer
      WHERE u.node = NEW.id AND t.principal LIKE 'grant:%');
END;
CREATE TRIGGER held_uploads_insert AFTER INSERT ON uploads BEGIN
  UPDATE users SET reserved_visitor_unsent = reserved_visitor_unsent + (SELECT size - NEW.offset FROM nodes WHERE id = NEW.node)
    WHERE id = (SELECT t.owner FROM transfers t JOIN nodes n ON n.id = NEW.node
      WHERE t.id = NEW.transfer AND t.principal LIKE 'grant:%' AND n.state = 'pending');
  UPDATE users SET
      unsent_member = unsent_member + (SELECT CASE WHEN principal LIKE 'grant:%' THEN 0 ELSE NEW.size - NEW.offset END FROM transfers WHERE id = NEW.transfer),
      unsent_visitor = unsent_visitor + (SELECT CASE WHEN principal LIKE 'grant:%' THEN NEW.size - NEW.offset ELSE 0 END FROM transfers WHERE id = NEW.transfer)
    WHERE NEW.completed IS NULL AND NEW.node IS NOT NULL
      AND id = (SELECT owner FROM transfers WHERE id = NEW.transfer AND state = 'open');
END;
CREATE TRIGGER held_uploads_delete AFTER DELETE ON uploads BEGIN
  UPDATE users SET reserved_visitor_unsent = reserved_visitor_unsent - (SELECT size - OLD.offset FROM nodes WHERE id = OLD.node)
    WHERE id = (SELECT t.owner FROM transfers t JOIN nodes n ON n.id = OLD.node
      WHERE t.id = OLD.transfer AND t.principal LIKE 'grant:%' AND n.state = 'pending');
  UPDATE users SET
      unsent_member = unsent_member - (SELECT CASE WHEN principal LIKE 'grant:%' THEN 0 ELSE OLD.size - OLD.offset END FROM transfers WHERE id = OLD.transfer),
      unsent_visitor = unsent_visitor - (SELECT CASE WHEN principal LIKE 'grant:%' THEN OLD.size - OLD.offset ELSE 0 END FROM transfers WHERE id = OLD.transfer)
    WHERE OLD.completed IS NULL AND OLD.node IS NOT NULL
      AND id = (SELECT owner FROM transfers WHERE id = OLD.transfer AND state = 'open');
END;
CREATE TRIGGER held_uploads_update AFTER UPDATE OF node, transfer, size, offset, completed ON uploads
WHEN OLD.node IS NOT NEW.node OR OLD.transfer IS NOT NEW.transfer OR OLD.size IS NOT NEW.size
  OR OLD.offset IS NOT NEW.offset OR (OLD.completed IS NULL) IS NOT (NEW.completed IS NULL) BEGIN
  UPDATE users SET reserved_visitor_unsent = reserved_visitor_unsent - (SELECT size - OLD.offset FROM nodes WHERE id = OLD.node)
    WHERE id = (SELECT t.owner FROM transfers t JOIN nodes n ON n.id = OLD.node
      WHERE t.id = OLD.transfer AND t.principal LIKE 'grant:%' AND n.state = 'pending');
  UPDATE users SET reserved_visitor_unsent = reserved_visitor_unsent + (SELECT size - NEW.offset FROM nodes WHERE id = NEW.node)
    WHERE id = (SELECT t.owner FROM transfers t JOIN nodes n ON n.id = NEW.node
      WHERE t.id = NEW.transfer AND t.principal LIKE 'grant:%' AND n.state = 'pending');
  UPDATE users SET
      unsent_member = unsent_member - (SELECT CASE WHEN principal LIKE 'grant:%' THEN 0 ELSE OLD.size - OLD.offset END FROM transfers WHERE id = OLD.transfer),
      unsent_visitor = unsent_visitor - (SELECT CASE WHEN principal LIKE 'grant:%' THEN OLD.size - OLD.offset ELSE 0 END FROM transfers WHERE id = OLD.transfer)
    WHERE OLD.completed IS NULL AND OLD.node IS NOT NULL
      AND id = (SELECT owner FROM transfers WHERE id = OLD.transfer AND state = 'open');
  UPDATE users SET
      unsent_member = unsent_member + (SELECT CASE WHEN principal LIKE 'grant:%' THEN 0 ELSE NEW.size - NEW.offset END FROM transfers WHERE id = NEW.transfer),
      unsent_visitor = unsent_visitor + (SELECT CASE WHEN principal LIKE 'grant:%' THEN NEW.size - NEW.offset ELSE 0 END FROM transfers WHERE id = NEW.transfer)
    WHERE NEW.completed IS NULL AND NEW.node IS NOT NULL
      AND id = (SELECT owner FROM transfers WHERE id = NEW.transfer AND state = 'open');
END;
CREATE TRIGGER held_transfers_before_delete BEFORE DELETE ON transfers BEGIN
  UPDATE users SET reserved_visitor_unsent = reserved_visitor_unsent - (
      SELECT ifnull(sum(n.size - u.offset), 0) FROM uploads u JOIN nodes n ON n.id = u.node
      WHERE u.transfer = OLD.id AND n.state = 'pending')
    WHERE id = OLD.owner AND OLD.principal LIKE 'grant:%';
  UPDATE users SET
      unsent_member = unsent_member - (CASE WHEN OLD.principal LIKE 'grant:%' THEN 0 ELSE (
        SELECT ifnull(sum(size - offset), 0) FROM uploads WHERE transfer = OLD.id AND completed IS NULL AND node IS NOT NULL) END),
      unsent_visitor = unsent_visitor - (CASE WHEN OLD.principal LIKE 'grant:%' THEN (
        SELECT ifnull(sum(size - offset), 0) FROM uploads WHERE transfer = OLD.id AND completed IS NULL AND node IS NOT NULL) ELSE 0 END)
    WHERE id = OLD.owner AND OLD.state = 'open';
END;
CREATE TRIGGER held_transfers_visitor AFTER UPDATE OF principal, owner ON transfers
WHEN OLD.principal IS NOT NEW.principal OR OLD.owner IS NOT NEW.owner BEGIN
  UPDATE users SET reserved_visitor_unsent = reserved_visitor_unsent - (
      SELECT ifnull(sum(n.size - u.offset), 0) FROM uploads u JOIN nodes n ON n.id = u.node
      WHERE u.transfer = OLD.id AND n.state = 'pending')
    WHERE id = OLD.owner AND OLD.principal LIKE 'grant:%';
  UPDATE users SET reserved_visitor_unsent = reserved_visitor_unsent + (
      SELECT ifnull(sum(n.size - u.offset), 0) FROM uploads u JOIN nodes n ON n.id = u.node
      WHERE u.transfer = NEW.id AND n.state = 'pending')
    WHERE id = NEW.owner AND NEW.principal LIKE 'grant:%';
END;
CREATE TRIGGER held_transfers_open AFTER UPDATE OF state, principal, owner ON transfers
WHEN (OLD.state = 'open') IS NOT (NEW.state = 'open') OR OLD.principal IS NOT NEW.principal OR OLD.owner IS NOT NEW.owner BEGIN
  UPDATE users SET
      unsent_member = unsent_member - (CASE WHEN OLD.principal LIKE 'grant:%' THEN 0 ELSE (
        SELECT ifnull(sum(size - offset), 0) FROM uploads WHERE transfer = OLD.id AND completed IS NULL AND node IS NOT NULL) END),
      unsent_visitor = unsent_visitor - (CASE WHEN OLD.principal LIKE 'grant:%' THEN (
        SELECT ifnull(sum(size - offset), 0) FROM uploads WHERE transfer = OLD.id AND completed IS NULL AND node IS NOT NULL) ELSE 0 END)
    WHERE id = OLD.owner AND OLD.state = 'open';
  UPDATE users SET
      unsent_member = unsent_member + (CASE WHEN NEW.principal LIKE 'grant:%' THEN 0 ELSE (
        SELECT ifnull(sum(size - offset), 0) FROM uploads WHERE transfer = NEW.id AND completed IS NULL AND node IS NOT NULL) END),
      unsent_visitor = unsent_visitor + (CASE WHEN NEW.principal LIKE 'grant:%' THEN (
        SELECT ifnull(sum(size - offset), 0) FROM uploads WHERE transfer = NEW.id AND completed IS NULL AND node IS NOT NULL) ELSE 0 END)
    WHERE id = NEW.owner AND NEW.state = 'open';
END;

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

-- An item sent to one of the owner's devices. The device needn't have Relay open: the delivery waits
-- until it does (see delivery_receipts). The receiving device answers it: accepted (downloaded there)
-- or declined. The item stays in Files either way.
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

-- Pickup codes across all kinds, in one namespace. `nonce` is the step of the target's code
-- sequence, so the code can be shown again without storing it. A code works for a day after
-- `created`. An ended code keeps its row for 30 days, so a remembered code never opens someone
-- else's share; after that its digits are free again, and the target's last row is kept with a
-- placeholder hash so its id is never reused.
CREATE TABLE pickup_codes (
  code_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('share', 'request', 'invitation', 'device', 'nearby')),
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
CREATE TRIGGER retire_nearby_code_after_invite_delete AFTER DELETE ON nearby_invites BEGIN
  UPDATE pickup_codes SET retired = MAX(created, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  WHERE kind = 'nearby' AND target_id = OLD.id AND retired IS NULL;
END;

-- Optional shared identity links. App-local accounts remain independent.
CREATE TABLE external_identities (
 issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(issuer, subject), UNIQUE(issuer, user_id)
) STRICT;
-- Admin's member list asks, for each member, whether they sign in with Walriyami.
CREATE INDEX external_identities_user ON external_identities(user_id);
CREATE TABLE external_sessions (
 session_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
 issuer TEXT NOT NULL, subject TEXT NOT NULL
) STRICT;
CREATE TABLE sso_flows (
 state_hash TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL
) STRICT;

-- Web Push (server/modules/push): one subscription per signed-in device that turned notifications
-- on. `endpoint` is the browser's push service address, `p256dh` and `auth` its encryption keys.
-- A device's subscription goes when its last session does (sign-out, password change, expiry).
CREATE TABLE push_subscriptions (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created INTEGER NOT NULL
) STRICT;
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
CREATE TRIGGER push_subscription_after_sign_out AFTER DELETE ON sessions
WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE device_id = OLD.device_id) BEGIN
  DELETE FROM push_subscriptions WHERE device_id = OLD.device_id;
END;

-- When a delivery first reached its device: the device had Relay open and showed it. A sender sees
-- "waiting" until then, never "sent". Answering a delivery also records this, if nothing did before.
CREATE TABLE delivery_receipts (
 delivery TEXT PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
 at INTEGER NOT NULL
) STRICT;

-- The administrator's history of this Relay: members joining, leaving, being suspended or made
-- administrators, what members sent and shared, failed sign-ins and errors. `data` is the
-- event as JSON, never a file's name or contents; `kind` is repeated for filtering, and `user_id`
-- is the member it is about (NULL once they are removed; the name stays in `data`). Repeats of the
-- same failed sign-in or error within an hour share a `dedupe` key and add to `count` on one row,
-- so a burst can't flood it. Kept for 90 days.
CREATE TABLE history (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('joined', 'removed', 'suspended', 'restored', 'role', 'password', 'sent', 'shared', 'received', 'signin', 'error')),
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created INTEGER NOT NULL,
  last INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  dedupe TEXT,
  data TEXT NOT NULL
) STRICT;
-- Index entries end in the rowid, so (created, rowid) puts same-millisecond events in the order they happened.
CREATE INDEX history_created ON history(created);
CREATE INDEX history_kind ON history(kind, created);
CREATE INDEX history_user ON history(user_id, created);
CREATE INDEX history_dedupe ON history(dedupe, created) WHERE dedupe IS NOT NULL;

-- Wrong guesses that still count against a limit: pickup and sign-in codes, account passwords and
-- link passwords. `kind` names the limit and `key` what it counts (an address, a network, an
-- account, a link). Kept across restarts so a restart doesn't forgive anyone; rows older than a
-- day no longer count and are removed.
CREATE TABLE failures (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  time INTEGER NOT NULL
) STRICT;
CREATE INDEX failures_key ON failures(kind, key, time);
CREATE INDEX failures_time ON failures(time);

-- Networks (an IPv4 /24 or IPv6 /48) an account has signed in from, with the password it has now
-- (`password` is a digest of its hash, so a new password forgets them). A new browser on one of
-- them isn't held by the account-wide limit on wrong passwords, so a stranger guessing elsewhere
-- can't keep the owner out at home or at work.
CREATE TABLE sign_in_networks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network TEXT NOT NULL,
  password TEXT NOT NULL,
  last INTEGER NOT NULL,
  PRIMARY KEY (user_id, network)
) STRICT;
