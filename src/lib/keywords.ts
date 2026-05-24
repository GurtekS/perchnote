/**
 * Keyword extraction shared between MeetingStats (display) and EnhanceButton (prompt grounding).
 *
 * Algorithm: TF-IDF-inspired scoring + bigram phrases + proper noun detection.
 *   score = freq × idf(segCount) × properBonus × phraseBonus
 *
 *   idf(n)      = log((totalSegs+1) / (n+1))
 *   properBonus = 1.6 for capitalised mid-sentence words / ALL-CAPS acronyms
 *   phraseBonus = 2.5 for two-word bigrams
 *
 * Greedy dedup: once a bigram is selected its constituent words are suppressed.
 */

export interface RawSegment {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker?: string | null;
}

// ─── Stopwords ───────────────────────────────────────────────────────────────

export const STOPWORDS = new Set([
  // Articles, prepositions, conjunctions
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by","from",
  "into","over","under","about","above","after","before","between","during","through",
  "without","within","along","following","across","behind","beyond","plus","except",
  "up","out","off","down","around","near","per","than","then","when","where","why","how",
  // Pronouns
  "i","we","you","he","she","they","them","their","our","your","his","her","my","me",
  "us","him","it","its","itself","himself","herself","themselves","ourselves","yourself",
  "who","what","which","that","this","these","those","whoever","whatever","whichever",
  // Auxiliary / modal / common verbs
  "is","was","are","were","be","been","being","have","has","had","do","does","did",
  "will","would","could","should","may","might","must","shall","can","need","dare",
  "get","got","go","went","come","came","make","made","say","said","know","knew",
  "think","thought","take","took","see","saw","look","looked","use","used","find",
  "found","give","gave","tell","told","work","worked","call","called","try","tried",
  "ask","asked","seem","seemed","feel","felt","leave","left","put","keep","kept",
  "let","begin","began","show","showed","hear","heard","play","move","live","want",
  "mean","meant","set","run","ran","start","end","bring","brought","turn","help",
  "talk","meet","add","build","built","send","sent","read","write",
  // Adverbs, qualifiers, discourse markers
  "not","no","so","if","as","just","very","more","most","also","too","even","still",
  "already","always","never","often","well","there","here","now","back","again","ever",
  "yet","only","both","each","few","much","many","other","some","any","all","same",
  "such","own","little","really","quite","rather","maybe","probably","actually",
  "basically","literally","certainly","definitely","especially","generally","usually",
  "typically","simply","clearly","exactly","specifically","essentially","obviously",
  // Spoken fillers
  "yeah","yes","yep","nope","okay","ok","right","sure","uh","um","ah","oh","hmm",
  "like","well","hey","sort","kind","thing","stuff","things","lot","bit","way",
  "point","part","place","time","times","something","anything","everything","nothing",
  "someone","anyone","everyone","somewhere","anywhere","everywhere",
  // Generic meeting-speak
  "meeting","meetings","call","calls","team","teams","project","projects","work",
  "working","make","making","good","great","nice","going","really","want","wanted",
  "look","looking","talk","talking","come","coming","done","doing","deal","deals",
  "able","that's","it's","don't","doesn't","didn't","isn't","aren't","wasn't",
  "weren't","won't","wouldn't","couldn't","shouldn't","haven't","hasn't","hadn't",
  "gonna","wanna","gotta","kinda","sorta","alright","cool","think","thinking",
  "thought","know","knowing","knew","understood","understand",
]);

// ─── Core extraction ─────────────────────────────────────────────────────────

export function extractKeywords(segments: RawSegment[], topN = 8): string[] {
  if (segments.length === 0) return [];

  const totalSegs = segments.length;
  const minUniFreq = Math.max(2, Math.round(totalSegs / 50));

  const uniFreq  = new Map<string, number>();
  const uniSegs  = new Map<string, Set<number>>();
  const propNoun = new Set<string>();

  const biFreq = new Map<string, number>();
  const biSegs = new Map<string, Set<number>>();

  segments.forEach((seg, si) => {
    const rawWords = seg.text.split(/\s+/);
    const cleaned: string[] = [];

    rawWords.forEach((raw, wi) => {
      const lower = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
      const isAcronym = raw.length >= 2 && raw === raw.toUpperCase() && /^[A-Z]/.test(raw);
      const prevEndsSentence = wi > 0 && /[.!?]$/.test(rawWords[wi - 1]);
      const isMidCap = wi > 0 && !prevEndsSentence && /^[A-Z]/.test(raw);
      const minLen = isAcronym ? 2 : 3;

      if (
        lower.length < minLen ||
        /^\d/.test(lower) ||
        /^\d+$/.test(lower) ||
        /^(.)\1{2,}$/.test(lower) ||
        STOPWORDS.has(lower)
      ) {
        cleaned.push("");
        return;
      }

      cleaned.push(lower);
      if (isAcronym || isMidCap) propNoun.add(lower);

      uniFreq.set(lower, (uniFreq.get(lower) ?? 0) + 1);
      if (!uniSegs.has(lower)) uniSegs.set(lower, new Set());
      uniSegs.get(lower)!.add(si);
    });

    for (let i = 0; i < cleaned.length - 1; i++) {
      const w1 = cleaned[i], w2 = cleaned[i + 1];
      if (!w1 || !w2 || w1.length < 3 || w2.length < 3) continue;
      const bg = `${w1} ${w2}`;
      biFreq.set(bg, (biFreq.get(bg) ?? 0) + 1);
      if (!biSegs.has(bg)) biSegs.set(bg, new Set());
      biSegs.get(bg)!.add(si);
    }
  });

  const idf = (n: number) => Math.log((totalSegs + 1) / (n + 1));

  type Cand = { text: string; score: number; isPhrase: boolean };

  const uniCands: Cand[] = Array.from(uniFreq.entries())
    .filter(([w, f]) => w.length >= 4 && f >= minUniFreq)
    .map(([w, freq]) => ({
      text: w,
      score: freq * idf(uniSegs.get(w)?.size ?? 0) * (propNoun.has(w) ? 1.6 : 1.0),
      isPhrase: false,
    }));

  const biCands: Cand[] = Array.from(biFreq.entries())
    .filter(([, f]) => f >= 2)
    .map(([phrase, freq]) => {
      const hasProper = phrase.split(" ").some(p => propNoun.has(p));
      return {
        text: phrase,
        score: freq * idf(biSegs.get(phrase)?.size ?? 0) * 2.5 * (hasProper ? 1.4 : 1.0),
        isPhrase: true,
      };
    });

  const all = [...biCands, ...uniCands].sort((a, b) => b.score - a.score);
  const result: string[] = [];
  const suppressed = new Set<string>();

  for (const c of all) {
    if (result.length >= topN) break;
    if (c.isPhrase) {
      result.push(c.text);
      c.text.split(" ").forEach(w => suppressed.add(w));
    } else if (!suppressed.has(c.text)) {
      result.push(c.text);
    }
  }

  return result;
}
