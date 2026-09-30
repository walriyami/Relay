# Independent account and session lifecycle verification

Scope: Relay worktree `/Users/riyami/.codex/worktrees/security-audit/Relay`, supplied baseline `76044eb`. All requests used disposable `tests/support/harness.ts` instances, accounts, data and secrets. Real local-helper checks used a private temporary Unix socket and an ephemeral UDP port. No deployed data, external targets or production source edits were used by this verifier.

## Result

The final focused lifecycle suite passed **24/24 tests**. TypeScript and the new test file's Prettier checks passed. The existing lifecycle suite passed **85/85 tests** across password authentication, session streams, passkeys, upload requests and the local helper. After the final guards were integrated, five selected existing authentication controls also passed, including a successful password change that signs out other sessions. No verified issue remains in the reviewed lifecycle changes.

## Confirmed issues and verification

| Mutation boundary                                                                                   | Before correction                                                                   | Final check                                                                         |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Member password change after the initiating session expires during hashing                          | HTTP 200; password changed                                                          | HTTP 401; password unchanged                                                        |
| Administrator reset after the initiating administrator signs out during hashing                     | HTTP 200; target reset and sessions revoked                                         | HTTP 401; target password and session preserved                                     |
| Administrator reset after the initiating session expires during hashing                             | HTTP 200; target reset and sessions revoked                                         | HTTP 401; target password and session preserved                                     |
| Administrator role loss during a pending reset                                                      | Added defense-in-depth regression using disposable database role change             | HTTP 403; target unchanged                                                          |
| Transfer completion after originating-session signout while another same-user session remains valid | Reviewed coordinator's corrected callback                                           | HTTP 401; no share; second session can independently finish the user-owned transfer |
| PATCH revocation during file close or directory sync                                                | Found missing check before the durable offset update in the first coordinator patch | HTTP 401; durable offset and uploaded-byte usage unchanged                          |
| Authorized retry after that revoked PATCH leaves an uncommitted tail at offset zero                 | HTTP 503 in first recovery patch                                                    | HTTP 204; authorized replacement content saved correctly                            |
| Authorized retry with a previously committed prefix                                                 | Added explicit regression                                                           | HTTP 204; prefix preserved and uncommitted tail replaced                            |

The password races hold the callback of a real native scrypt operation. The upload races hold completion of a real `FileHandle.close()` or directory `FileHandle.sync()` call. They preserve the original operations and suspend only their completion, so the authorization change occurs at the precise asynchronous boundary. The tests assert both rejection and the absence of durable mutation, then verify successful authorized recovery.

## Route review

- `server/lib/auth.ts`: `currentMember`, `currentAuth` and `currentPrincipalFor` read current session expiry, account availability and grants. Local-helper requests retain their original session hash and do not inherit browser cookies. Fresh transfer ownership checks remain tied to the originating request's credentials.
- `server/modules/auth/account.ts`: the password mutation now requires the same current session at the synchronous transaction checkpoint. Existing password-reset conflict behavior remains covered.
- `server/modules/admin/index.ts`: pending resets now check the initiating session and its current administrator role inside the mutation transaction.
- `server/modules/auth/session.ts` and `sessions.ts`: password sign-in checks the current password hash after scrypt; `insertSession` checks current account availability. Held-verification disable/reset regressions pass without creating a session.
- `server/modules/auth/passkeys.ts`: registration authorization checks the issuing session, expiry, current password and active account before issuance and insertion. Sign-in uses a conditional current credential/counter update and active-account check. The existing software-authenticator tests exercise real registration and assertion verification.
- `server/modules/setup/index.ts`: first-account creation repeats the setup-state check inside its synchronous transaction. The previously saved auth-direct suite meaningfully tests wrong/missing setup keys and the competing first-account race; this verifier reviewed that suite rather than overwriting its separate runtime evidence.
- `server/modules/local/index.ts`: local tokens name the original session. Actual Unix-socket checks return 200 before expiry/signout/reset/disable and 401 afterward.
- Transfers: completion checks fresh authorization after awaits; request-facing receiver settle/receive/publication paths carry authorization callbacks; publication checks before final node mutation. Recovery without an originating request uses the documented trusted internal path. The final offset/usage guard runs after close/directory sync, and zero-prefix recovery avoids a negative read-stream end position.
- Guest grants: expired grant, expired request, closed request and disabled owner all reject completion with 404 and do not complete the transfer. User-owned transfers remain resumable from another valid session of the same account.

## Evidence

- New regressions: `tests/security-audit-account-lifecycle.test.ts` (8 top-level tests, 24 tests including subtests).
- Final focused log and machine-readable results: `work/security-audit/account-lifecycle-final.log`, `work/security-audit/account-verification-final-runtime.json`.
- Existing controls: `work/security-audit/account-lifecycle-controls.log` (85/85).
- Selected existing authentication controls after final integration: `work/security-audit/account-lifecycle-final-controls.log` (5/5).
- TypeScript and formatting: `work/security-audit/account-verification-typecheck-final.log`, `work/security-audit/account-verification-format.log`.
- Earlier observed failures: `work/security-audit/account-lifecycle-initial.log`, `work/security-audit/account-verification-initial.json`, `work/security-audit/account-lifecycle-followup.log`, `work/security-audit/account-verification-followup.json`. The initial log also includes one malformed device-link test request missing `deviceName`; that test input was corrected before final verification and is not an application finding.

Changed files owned by this verifier: the new regression test and account-verification evidence/report files. Production fixes were implemented by the coordinator. Decisions: maintain exact originating-session authorization, allow independent same-account resume, and retain committed upload prefixes while discarding uncommitted tails. Pending work: none in this verification scope. Active wait handles: none after final verification.
