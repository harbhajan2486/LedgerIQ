// HaveIBeenPwned password check
// Checks if a password has appeared in known data breaches
// Uses k-anonymity model — only the first 5 chars of SHA1 hash are sent, never the full password

import { createHash } from "crypto";

export async function isPasswordBreached(password: string): Promise<boolean> {
  try {
    const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);

    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true" },
    });

    if (!response.ok) return false; // fail open — don't block signup if API is down

    const text = await response.text();
    const lines = text.split("\n");

    for (const line of lines) {
      const [hashSuffix, count] = line.split(":");
      if (hashSuffix.trim() === suffix && parseInt(count) > 0) {
        return true; // password found in breach database
      }
    }

    return false;
  } catch {
    return false; // fail open on network error
  }
}
