// Words that appear in bank narrations but carry no semantic meaning for ledger matching
const STOPWORDS = new Set([
  // Payment modes
  "neft", "rtgs", "imps", "upi", "nach", "ach", "ecs", "chq", "cheque", "dd",
  // Directional / transactional
  "to", "by", "from", "via", "ref", "no", "the", "and", "for", "of", "per", "at",
  // Bank names
  "hdfc", "sbi", "icici", "axis", "kotak", "pnb", "bob", "canara", "union", "ubi",
  "baroda", "syndicate", "allahabad", "idbi", "yes", "indusind", "federal", "rbl",
  // Generic entity suffixes
  "pvt", "ltd", "private", "limited", "co", "corp", "india", "inc", "llp", "llc",
  // Banking terms
  "ac", "acc", "account", "bank", "transfer", "payment", "credit", "debit", "tr",
  "mb", "net", "online", "mobile", "branch",
]);

interface Ledger {
  ledger_name: string;
  ledger_type: string;
}

export interface ScoredLedger extends Ledger {
  score: number;
  matchedTokens: string[];
}

/**
 * Tokenise a string: uppercase, strip non-alphanumeric, split on spaces/separators,
 * filter out stopwords, numbers-only, and tokens shorter than 3 chars.
 */
function tokenise(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()) && !/^\d+$/.test(t));
}

/**
 * Score a single ledger against narration tokens.
 * Returns a score and the tokens that matched.
 *
 * Scoring weights:
 *   +12  exact token match (e.g. narration has "STEELS", ledger has "STEELS")
 *   +6   one is a prefix of the other (≥4 chars, e.g. "STEEL" matches "STEELS")
 *   +2   one contains the other as a substring (≥4 chars)
 *   +3   bonus if the ledger is under a party type (Sundry Creditors / Debtors)
 */
function scoreLedger(narrTokens: string[], ledger: Ledger): { score: number; matchedTokens: string[] } {
  const ledgerTokens = tokenise(ledger.ledger_name);
  if (ledgerTokens.length === 0) return { score: 0, matchedTokens: [] };

  let score = 0;
  const matched: string[] = [];

  for (const nt of narrTokens) {
    let best = 0;
    let bestLt = "";
    for (const lt of ledgerTokens) {
      let s = 0;
      if (nt === lt) {
        s = 12;
      } else if (nt.length >= 4 && lt.length >= 4 && (nt.startsWith(lt) || lt.startsWith(nt))) {
        s = 6;
      } else if (nt.length >= 4 && lt.length >= 4 && (nt.includes(lt) || lt.includes(nt))) {
        s = 2;
      }
      if (s > best) { best = s; bestLt = lt; }
    }
    if (best > 0) { score += best; if (!matched.includes(bestLt)) matched.push(bestLt); }
  }

  // Party ledger bonus — these are the most useful for vendor identification
  const typeL = (ledger.ledger_type ?? "").toLowerCase();
  if (typeL.includes("creditor") || typeL.includes("debtor") ||
      typeL.includes("sundry") || typeL.includes("party")) {
    score += 3;
  }

  return { score, matchedTokens: matched };
}

/**
 * Fuzzy-match a bank narration against a list of ledgers.
 * Returns the top-N ledgers ordered by match confidence, only those with score > 0.
 *
 * @param narration  Raw bank narration string
 * @param ledgers    Array of ledger_masters rows for this client
 * @param topN       How many results to return (default 6)
 */
export function fuzzyMatchLedgers(
  narration: string,
  ledgers: Ledger[],
  topN = 6
): ScoredLedger[] {
  const tokens = tokenise(narration);
  if (tokens.length === 0 || ledgers.length === 0) return [];

  return ledgers
    .map((l) => {
      const { score, matchedTokens } = scoreLedger(tokens, l);
      return { ...l, score, matchedTokens };
    })
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
