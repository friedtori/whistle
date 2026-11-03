import { bytesToBase64, canonicalize, type LicenceEnvelope, type LicencePayload } from "../src/verification.ts";

// A test keypair generated here. The production licence private key is never used.
export async function testLicenceKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { privateKey: pair.privateKey, publicKeyBase64: bytesToBase64(raw) };
}

export async function signEnvelope(privateKey: CryptoKey, payload: LicencePayload): Promise<LicenceEnvelope> {
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(canonicalize(payload)),
  );
  return { payload, sig: bytesToBase64(new Uint8Array(sig)) };
}
