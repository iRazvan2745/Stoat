const GRAVATAR_URL = "https://gravatar.com/avatar";

export const getGravatarUrl = async (email: string): Promise<string> => {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `${GRAVATAR_URL}/${hash}?s=80&d=identicon`;
};
