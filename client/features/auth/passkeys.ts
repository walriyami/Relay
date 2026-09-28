import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { api, call } from "../../api";
import { browserName, thisDevice } from "./device-name";

// The WebAuthn helper loads only when someone starts a passkey ceremony.
const webauthn = () => import("@simplewebauthn/browser");

export const passkeysSupported = () =>
  typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";

/** The person closed the browser's passkey prompt or it timed out: not an error worth showing. */
export const passkeyDismissed = (error: unknown) =>
  error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError");

// The server produces the options with @simplewebauthn/server, whose JSON the browser library reads as-is.
export async function signInWithPasskey() {
  const [{ startAuthentication }, { challenge, options }] = await Promise.all([
    webauthn(),
    call(api.session.passkeyOptions),
  ]);
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON });
  } catch (error) {
    if (passkeyDismissed(error)) throw error;
    // The browser's own wording ("Resident credentials … are not supported") means nothing to people.
    throw new Error("This browser couldn’t use a passkey. Sign in with your password instead.", { cause: error });
  }
  return call(api.session.passkey, { body: { challenge, response: { ...response }, ...thisDevice() } });
}

export async function addPasskey(password: string, name = browserName()) {
  const [{ startRegistration, WebAuthnError }, { challenge, options }] = await Promise.all([
    webauthn(),
    call(api.account.passkeyOptions, { body: { password } }),
  ]);
  let response;
  try {
    response = await startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON });
  } catch (error) {
    if (passkeyDismissed(error)) throw error;
    if (error instanceof WebAuthnError && error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED")
      throw new Error("This passkey is already saved for your account.", { cause: error });
    throw new Error("This browser couldn’t create a passkey. Try again, or use another browser or device.", {
      cause: error,
    });
  }
  return call(api.account.addPasskey, { body: { challenge, name, response: { ...response } } });
}
