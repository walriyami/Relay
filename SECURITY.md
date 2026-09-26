# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Instead, report them privately through [GitHub's security advisories](https://github.com/walriyami/Relay/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an acknowledgement within a few days. Once a fix is available, the advisory will credit you, unless you'd rather stay anonymous.

Only the latest release receives security fixes.

## Security model

Relay is built for a trusted group on a server you control.

- **Accounts** exist only by invitation, apart from the administrator's, which is created during setup by whoever finishes that step first. Finish setup as soon as Relay is reachable. Until then, keep it on a private address (Docker Compose publishes it on `127.0.0.1` only). Passwords are hashed with scrypt, and passkeys (WebAuthn) are supported.
- **Sessions** use `HttpOnly` cookies, which get the `__Host-` prefix and the `Secure` flag over HTTPS. Every state-changing request needs a matching origin and a CSRF token. Set `RELAY_ORIGIN` on a public server to accept only that address.
- **Links and requests** are bearer URLs derived with an HMAC key. The database stores only hashes of them. Links can expire, have a password, be limited to one person, and be revoked at any time.
- **Short codes** are rate-limited per address and across the service, and a retired code is never reused.
- **Privacy between accounts.** Administrators manage accounts and limits, but they can't open members' files, links or activity through Relay.
- **Hardened container.** It runs as a non-root user with a read-only root filesystem, no capabilities and `no-new-privileges`.

Relay is **not** end-to-end encrypted. Anyone with access to the server's disk can read the stored files. Encrypt the disk and restrict access to the host according to how sensitive your content is.
