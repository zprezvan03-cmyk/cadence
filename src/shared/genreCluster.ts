/**
 * Multi-cluster genre segmentation, taxonomy normalization, fallback inference,
 * and bilinear transition affinity matrix for Cadence Smart Shuffle.
 *
 * Pure and dependency-free so it can run in the renderer, main process, and unit tests.
 */

export const GENRE_CLUSTERS = [
  "rock",
  "metal",
  "pop",
  "electronic",
  "hip-hop",
  "r&b-soul",
  "jazz-blues",
  "classical-score",
  "folk-country",
  "latin-world",
  "jpop-kpop-anime",
  "ambient-chill",
  "experimental",
  "spoken-other",
] as const;

export type GenreCluster = (typeof GENRE_CLUSTERS)[number];

export const NUM_GENRE_CLUSTERS = GENRE_CLUSTERS.length; // 14

export const CLUSTER_INDEX: Readonly<Record<GenreCluster, number>> = {
  rock: 0,
  metal: 1,
  pop: 2,
  electronic: 3,
  "hip-hop": 4,
  "r&b-soul": 5,
  "jazz-blues": 6,
  "classical-score": 7,
  "folk-country": 8,
  "latin-world": 9,
  "jpop-kpop-anime": 10,
  "ambient-chill": 11,
  experimental: 12,
  "spoken-other": 13,
};

export type GenreDistribution = Partial<Record<GenreCluster, number>>;

export interface ParsedGenreProfile {
  /** Normalized weights across all 14 macro clusters (sum === 1, or all 0 if unknown). */
  vector: Float32Array;
  /** True when no genre cluster could be determined from tags, album, artist, or path. */
  isUnknown: boolean;
  /** Clusters with weight >= 0.15, ordered from highest weight to lowest. */
  dominantClusters: GenreCluster[];
}

export interface GenreTrackInput {
  id: number;
  genre: string;
  artist: string;
  albumArtist?: string;
  album: string;
  path?: string;
  externalGenres?: readonly string[] | null;
}

/** Standard ID3v1 numeric genre codes commonly found in legacy MP3 tags like "(17)" or "17". */
const ID3V1_CODE_MAP: Readonly<Record<number, string>> = {
  0: "blues",
  1: "classic rock",
  2: "country",
  3: "dance",
  4: "disco",
  5: "funk",
  6: "grunge",
  7: "hip-hop",
  8: "jazz",
  9: "metal",
  10: "new age",
  11: "oldies",
  12: "other",
  13: "pop",
  14: "r&b",
  15: "rap",
  16: "reggae",
  17: "rock",
  18: "techno",
  19: "industrial",
  20: "alternative",
  21: "ska",
  22: "death metal",
  24: "soundtrack",
  26: "ambient",
  27: "trip-hop",
  28: "vocal",
  29: "jazz fusion",
  30: "fusion",
  31: "trance",
  32: "classical",
  33: "instrumental",
  36: "game",
  37: "sound clip",
  38: "gospel",
  39: "noise",
  40: "alternative rock",
  41: "bass",
  42: "soul",
  43: "punk",
  45: "meditative",
  52: "electronic",
  54: "eurodance",
  63: "jungle",
  74: "acid jazz",
  80: "folk",
  81: "folk rock",
  85: "bebop",
  86: "latin",
  88: "celtic",
  89: "bluegrass",
  90: "avantgarde",
  94: "symphonic rock",
  97: "chorus",
  99: "acoustic",
  101: "speech",
  103: "opera",
  104: "chamber music",
  105: "sonata",
  106: "symphony",
  113: "tango",
  114: "samba",
  121: "punk rock",
  126: "goa",
  127: "drum & bass",
  131: "indie",
  142: "merengue",
  143: "salsa",
  144: "thrash metal",
  145: "anime",
  146: "jpop",
  147: "synthpop",
};

/**
 * Exact and compound subgenre mappings into multi-cluster fractional distributions.
 * Single subgenre strings can map to multiple macro clusters to preserve hybrid identity.
 */
const EXACT_SUBGENRE_MAP: Readonly<Record<string, GenreDistribution>> = {
  // Rock & hybrids
  rock: { rock: 1.0 },
  "classic rock": { rock: 1.0 },
  "hard rock": { rock: 0.75, metal: 0.25 },
  "alternative rock": { rock: 0.85, pop: 0.15 },
  alt: { rock: 0.8, pop: 0.2 },
  alternative: { rock: 0.8, pop: 0.2 },
  "indie rock": { rock: 0.8, pop: 0.2 },
  indie: { rock: 0.55, pop: 0.45 },
  shoegaze: { rock: 0.6, pop: 0.2, "ambient-chill": 0.2 },
  "post rock": { rock: 0.65, "ambient-chill": 0.35 },
  "post punk": { rock: 0.8, electronic: 0.2 },
  punk: { rock: 0.9, metal: 0.1 },
  "punk rock": { rock: 0.9, metal: 0.1 },
  "pop punk": { rock: 0.65, pop: 0.35 },
  grunge: { rock: 0.85, metal: 0.15 },
  emo: { rock: 0.8, pop: 0.2 },
  "math rock": { rock: 0.65, experimental: 0.35 },
  "prog rock": { rock: 0.8, experimental: 0.2 },
  "progressive rock": { rock: 0.8, experimental: 0.2 },
  "psychedelic rock": { rock: 0.75, experimental: 0.25 },
  "garage rock": { rock: 1.0 },
  "soft rock": { rock: 0.65, pop: 0.35 },
  "pop rock": { rock: 0.55, pop: 0.45 },
  "folk rock": { "folk-country": 0.55, rock: 0.45 },
  "blues rock": { rock: 0.6, "jazz-blues": 0.4 },
  "country rock": { "folk-country": 0.55, rock: 0.45 },
  "symphonic rock": { rock: 0.65, "classical-score": 0.35 },
  "art rock": { rock: 0.7, experimental: 0.3 },
  krautrock: { rock: 0.5, electronic: 0.25, experimental: 0.25 },
  britpop: { rock: 0.6, pop: 0.4 },
  "new wave": { pop: 0.45, rock: 0.35, electronic: 0.2 },

  // Metal & hybrids
  metal: { metal: 1.0 },
  "heavy metal": { metal: 0.9, rock: 0.1 },
  "death metal": { metal: 1.0 },
  "melodic death metal": { metal: 1.0 },
  "black metal": { metal: 1.0 },
  "thrash metal": { metal: 1.0 },
  "doom metal": { metal: 1.0 },
  "power metal": { metal: 0.9, "classical-score": 0.1 },
  "progressive metal": { metal: 0.8, experimental: 0.2 },
  "prog metal": { metal: 0.8, experimental: 0.2 },
  "symphonic metal": { metal: 0.65, "classical-score": 0.35 },
  metalcore: { metal: 0.85, rock: 0.15 },
  deathcore: { metal: 1.0 },
  "nu metal": { metal: 0.65, rock: 0.2, "hip-hop": 0.15 },
  "industrial metal": { metal: 0.65, experimental: 0.2, electronic: 0.15 },
  "folk metal": { metal: 0.65, "folk-country": 0.35 },
  djent: { metal: 0.85, experimental: 0.15 },

  // Pop & hybrids
  pop: { pop: 1.0 },
  "synth pop": { pop: 0.6, electronic: 0.4 },
  synthpop: { pop: 0.6, electronic: 0.4 },
  electropop: { pop: 0.55, electronic: 0.45 },
  "electro pop": { pop: 0.55, electronic: 0.45 },
  "dance pop": { pop: 0.65, electronic: 0.35 },
  "indie pop": { pop: 0.7, rock: 0.3 },
  "dream pop": { pop: 0.55, rock: 0.25, "ambient-chill": 0.2 },
  "art pop": { pop: 0.7, experimental: 0.3 },
  "chamber pop": { pop: 0.65, "classical-score": 0.35 },
  "bedroom pop": { pop: 0.65, "ambient-chill": 0.2, rock: 0.15 },
  hyperpop: { pop: 0.5, electronic: 0.35, experimental: 0.15 },
  "teen pop": { pop: 1.0 },
  eurodance: { electronic: 0.6, pop: 0.4 },
  disco: { "r&b-soul": 0.5, pop: 0.3, electronic: 0.2 },
  "nu disco": { electronic: 0.5, "r&b-soul": 0.3, pop: 0.2 },

  // Electronic & Dance
  electronic: { electronic: 1.0 },
  electronica: { electronic: 0.85, "ambient-chill": 0.15 },
  edm: { electronic: 0.85, pop: 0.15 },
  dance: { electronic: 0.75, pop: 0.25 },
  house: { electronic: 1.0 },
  "deep house": { electronic: 0.85, "ambient-chill": 0.15 },
  "tech house": { electronic: 1.0 },
  "progressive house": { electronic: 1.0 },
  techno: { electronic: 1.0 },
  trance: { electronic: 1.0 },
  "drum and bass": { electronic: 1.0 },
  "drum bass": { electronic: 1.0 },
  dnb: { electronic: 1.0 },
  jungle: { electronic: 1.0 },
  breakbeat: { electronic: 1.0 },
  breakcore: { electronic: 0.75, experimental: 0.25 },
  dubstep: { electronic: 1.0 },
  "uk garage": { electronic: 0.85, "r&b-soul": 0.15 },
  garage: { electronic: 0.7, rock: 0.3 },
  idm: { electronic: 0.7, experimental: 0.3 },
  synthwave: { electronic: 0.8, pop: 0.2 },
  retrowave: { electronic: 0.8, pop: 0.2 },
  vaporwave: { electronic: 0.45, "ambient-chill": 0.4, experimental: 0.15 },
  "future bass": { electronic: 0.8, pop: 0.2 },
  hardstyle: { electronic: 1.0 },
  electro: { electronic: 1.0 },
  "trip hop": { electronic: 0.45, "ambient-chill": 0.3, "hip-hop": 0.25 },
  triphop: { electronic: 0.45, "ambient-chill": 0.3, "hip-hop": 0.25 },

  // Hip-Hop & Rap
  "hip hop": { "hip-hop": 1.0 },
  hiphop: { "hip-hop": 1.0 },
  rap: { "hip-hop": 1.0 },
  trap: { "hip-hop": 0.85, electronic: 0.15 },
  drill: { "hip-hop": 1.0 },
  grime: { "hip-hop": 0.75, electronic: 0.25 },
  "boom bap": { "hip-hop": 1.0 },
  "cloud rap": { "hip-hop": 0.8, "ambient-chill": 0.2 },
  "jazz rap": { "hip-hop": 0.6, "jazz-blues": 0.4 },
  "conscious hip hop": { "hip-hop": 1.0 },
  "alternative hip hop": { "hip-hop": 0.85, rock: 0.15 },
  "lofi hip hop": { "hip-hop": 0.55, "ambient-chill": 0.45 },
  "lo fi hip hop": { "hip-hop": 0.55, "ambient-chill": 0.45 },
  phonk: { "hip-hop": 0.7, electronic: 0.3 },
  "drift phonk": { "hip-hop": 0.65, electronic: 0.35 },

  // R&B, Soul, Funk
  "r b": { "r&b-soul": 1.0 },
  rnb: { "r&b-soul": 1.0 },
  "r&b": { "r&b-soul": 1.0 },
  "contemporary r b": { "r&b-soul": 0.8, pop: 0.2 },
  "alternative r b": { "r&b-soul": 0.75, electronic: 0.15, pop: 0.1 },
  soul: { "r&b-soul": 1.0 },
  "neo soul": { "r&b-soul": 0.8, "jazz-blues": 0.2 },
  funk: { "r&b-soul": 0.85, "jazz-blues": 0.15 },
  motown: { "r&b-soul": 0.85, pop: 0.15 },
  gospel: { "r&b-soul": 0.85, "folk-country": 0.15 },

  // Jazz & Blues
  jazz: { "jazz-blues": 1.0 },
  bebop: { "jazz-blues": 1.0 },
  "hard bop": { "jazz-blues": 1.0 },
  "cool jazz": { "jazz-blues": 0.85, "ambient-chill": 0.15 },
  "smooth jazz": { "jazz-blues": 0.75, "r&b-soul": 0.15, "ambient-chill": 0.1 },
  "jazz fusion": { "jazz-blues": 0.65, rock: 0.2, electronic: 0.15 },
  fusion: { "jazz-blues": 0.7, rock: 0.3 },
  "acid jazz": { "jazz-blues": 0.6, "r&b-soul": 0.25, electronic: 0.15 },
  "nu jazz": { "jazz-blues": 0.65, electronic: 0.35 },
  swing: { "jazz-blues": 1.0 },
  "big band": { "jazz-blues": 1.0 },
  "bossa nova": { "jazz-blues": 0.6, "latin-world": 0.4 },
  blues: { "jazz-blues": 1.0 },
  "delta blues": { "jazz-blues": 0.8, "folk-country": 0.2 },

  // Classical, Orchestral, Soundtrack / Score
  classical: { "classical-score": 1.0 },
  orchestral: { "classical-score": 1.0 },
  symphony: { "classical-score": 1.0 },
  opera: { "classical-score": 1.0 },
  "chamber music": { "classical-score": 1.0 },
  baroque: { "classical-score": 1.0 },
  romantic: { "classical-score": 1.0 },
  "modern classical": { "classical-score": 0.75, "ambient-chill": 0.25 },
  "neo classical": { "classical-score": 0.75, "ambient-chill": 0.25 },
  neoclassical: { "classical-score": 0.75, "ambient-chill": 0.25 },
  soundtrack: { "classical-score": 0.8, "ambient-chill": 0.2 },
  ost: { "classical-score": 0.7, "jpop-kpop-anime": 0.3 },
  score: { "classical-score": 0.85, "ambient-chill": 0.15 },
  "film score": { "classical-score": 0.9, "ambient-chill": 0.1 },
  "video game music": { "classical-score": 0.5, electronic: 0.3, "jpop-kpop-anime": 0.2 },
  vgm: { "classical-score": 0.5, electronic: 0.3, "jpop-kpop-anime": 0.2 },
  game: { "classical-score": 0.5, electronic: 0.3, "jpop-kpop-anime": 0.2 },
  choral: { "classical-score": 1.0 },
  piano: { "classical-score": 0.7, "ambient-chill": 0.3 },

  // Folk, Country, Acoustic
  folk: { "folk-country": 1.0 },
  "indie folk": { "folk-country": 0.7, rock: 0.3 },
  "contemporary folk": { "folk-country": 1.0 },
  "singer songwriter": { "folk-country": 0.7, pop: 0.3 },
  acoustic: { "folk-country": 0.75, pop: 0.25 },
  country: { "folk-country": 1.0 },
  "alt country": { "folk-country": 0.7, rock: 0.3 },
  americana: { "folk-country": 0.8, rock: 0.2 },
  bluegrass: { "folk-country": 1.0 },
  celtic: { "folk-country": 0.7, "latin-world": 0.3 },

  // Latin, Reggae, World
  latin: { "latin-world": 1.0 },
  "latin pop": { "latin-world": 0.65, pop: 0.35 },
  reggaeton: { "latin-world": 0.7, "hip-hop": 0.3 },
  salsa: { "latin-world": 1.0 },
  bachata: { "latin-world": 1.0 },
  merengue: { "latin-world": 1.0 },
  cumbia: { "latin-world": 1.0 },
  tango: { "latin-world": 0.8, "classical-score": 0.2 },
  samba: { "latin-world": 1.0 },
  mpb: { "latin-world": 0.7, "jazz-blues": 0.3 },
  afrobeats: { "latin-world": 0.65, "r&b-soul": 0.2, pop: 0.15 },
  afrobeat: { "latin-world": 0.65, "jazz-blues": 0.2, "r&b-soul": 0.15 },
  reggae: { "latin-world": 1.0 },
  dub: { "latin-world": 0.6, electronic: 0.4 },
  ska: { "latin-world": 0.55, rock: 0.45 },
  dancehall: { "latin-world": 0.75, "hip-hop": 0.25 },
  world: { "latin-world": 1.0 },
  flamenco: { "latin-world": 0.8, "folk-country": 0.2 },

  // J-Pop, K-Pop, Anime, Vocaloid, City Pop
  "j pop": { "jpop-kpop-anime": 0.88, pop: 0.12 },
  jpop: { "jpop-kpop-anime": 0.88, pop: 0.12 },
  "j idol": { "jpop-kpop-anime": 0.9, pop: 0.1 },
  "japanese idol": { "jpop-kpop-anime": 0.9, pop: 0.1 },
  "idol pop": { "jpop-kpop-anime": 0.88, pop: 0.12 },
  idol: { "jpop-kpop-anime": 0.85, pop: 0.15 },
  kayokyoku: { "jpop-kpop-anime": 0.85, pop: 0.15 },
  denpa: { "jpop-kpop-anime": 0.75, electronic: 0.25 },
  "j rock": { "jpop-kpop-anime": 0.6, rock: 0.4 },
  jrock: { "jpop-kpop-anime": 0.6, rock: 0.4 },
  "k pop": { "jpop-kpop-anime": 0.85, pop: 0.15 },
  kpop: { "jpop-kpop-anime": 0.85, pop: 0.15 },
  "c pop": { "jpop-kpop-anime": 0.85, pop: 0.15 },
  cpop: { "jpop-kpop-anime": 0.85, pop: 0.15 },
  anime: { "jpop-kpop-anime": 0.8, "classical-score": 0.2 },
  anison: { "jpop-kpop-anime": 0.75, pop: 0.15, rock: 0.1 },
  vocaloid: { "jpop-kpop-anime": 0.65, electronic: 0.2, pop: 0.15 },
  "city pop": { "jpop-kpop-anime": 0.5, pop: 0.3, "r&b-soul": 0.2 },
  citypop: { "jpop-kpop-anime": 0.5, pop: 0.3, "r&b-soul": 0.2 },
  "shibuya kei": { "jpop-kpop-anime": 0.55, pop: 0.3, electronic: 0.15 },
  enka: { "jpop-kpop-anime": 0.8, "folk-country": 0.2 },
  touhou: { "jpop-kpop-anime": 0.6, electronic: 0.4 },
  doujin: { "jpop-kpop-anime": 0.7, electronic: 0.3 },

  // Ambient, Chill, Downtempo, Lo-Fi
  ambient: { "ambient-chill": 1.0 },
  "dark ambient": { "ambient-chill": 0.7, experimental: 0.3 },
  downtempo: { "ambient-chill": 0.7, electronic: 0.3 },
  chillout: { "ambient-chill": 0.8, electronic: 0.2 },
  chill: { "ambient-chill": 0.85, pop: 0.15 },
  chillwave: { "ambient-chill": 0.55, electronic: 0.25, pop: 0.2 },
  lofi: { "ambient-chill": 0.7, "hip-hop": 0.3 },
  "lo fi": { "ambient-chill": 0.7, "hip-hop": 0.3 },
  "new age": { "ambient-chill": 0.85, "classical-score": 0.15 },
  drone: { "ambient-chill": 0.65, experimental: 0.35 },
  meditative: { "ambient-chill": 1.0 },
  instrumental: { "ambient-chill": 0.55, "classical-score": 0.45 },

  // Experimental, Industrial, Avant-garde
  experimental: { experimental: 1.0 },
  "avant garde": { experimental: 0.85, "classical-score": 0.15 },
  avantgarde: { experimental: 0.85, "classical-score": 0.15 },
  industrial: { experimental: 0.65, electronic: 0.35 },
  noise: { experimental: 1.0 },
  "noise rock": { experimental: 0.55, rock: 0.45 },
  glitch: { experimental: 0.6, electronic: 0.4 },
  "musique concrete": { experimental: 1.0 },

  // Spoken Word, Comedy, Podcast
  podcast: { "spoken-other": 1.0 },
  audiobook: { "spoken-other": 1.0 },
  "spoken word": { "spoken-other": 1.0 },
  speech: { "spoken-other": 1.0 },
  comedy: { "spoken-other": 1.0 },
};

/**
 * Keyword stem rules evaluated when an exact subgenre string is not in `EXACT_SUBGENRE_MAP`.
 * Multiple keyword rules can match a single compound genre token (e.g. "Electro-Jazz-Funk"),
 * preserving all matching macro clusters.
 */
const KEYWORD_RULES: ReadonlyArray<{ pattern: RegExp; weights: GenreDistribution }> = [
  {
    pattern: /\b(j[\s-]?pop|j[\s-]?rock|k[\s-]?pop|c[\s-]?pop|anime|anison|vocaloid|touhou|doujin|idol|kayokyoku|denpa|enka)\b/,
    weights: { "jpop-kpop-anime": 0.85 },
  },
  { pattern: /\b(phonk)\b/, weights: { "hip-hop": 0.7, electronic: 0.3 } },
  { pattern: /\b(metal|metalcore|deathcore|thrash|doom|blackened|djent)\b/, weights: { metal: 0.9 } },
  { pattern: /\b(rock|punk|grunge|shoegaze|emo|britpop)\b/, weights: { rock: 0.85 } },
  { pattern: /\b(hip[\s-]?hop|rap|trap|drill|boom[\s-]?bap|grime)\b/, weights: { "hip-hop": 0.9 } },
  { pattern: /\b(r&b|rnb|soul|funk|motown|disco|gospel)\b/, weights: { "r&b-soul": 0.85 } },
  { pattern: /\b(jazz|blues|bebop|swing|bossa|fusion)\b/, weights: { "jazz-blues": 0.85 } },
  { pattern: /\b(classical|orchestra|orchestral|symphon|opera|baroque|chamber|soundtrack|ost|score|cinematic)\b/, weights: { "classical-score": 0.85 } },
  { pattern: /\b(folk|country|americana|bluegrass|acoustic|celtic|singer)\b/, weights: { "folk-country": 0.85 } },
  { pattern: /\b(latin|reggaeton|salsa|bachata|cumbia|samba|tango|afrobeat|reggae|ska|dancehall|world)\b/, weights: { "latin-world": 0.85 } },
  { pattern: /\b(ambient|chill|downtempo|lofi|lo[\s-]?fi|new[\s-]?age|drone|meditat)\b/, weights: { "ambient-chill": 0.8 } },
  { pattern: /\b(electro|electronic|house|techno|trance|dubstep|dnb|drum|synth|edm|dance|idm|vaporwave|breakbeat)\b/, weights: { electronic: 0.8 } },
  { pattern: /\b(experimental|avant|industrial|noise|glitch)\b/, weights: { experimental: 0.8 } },
  { pattern: /\b(podcast|audiobook|spoken|speech|comedy|interview)\b/, weights: { "spoken-other": 0.95 } },
  { pattern: /\b(pop|indie)\b/, weights: { pop: 0.7 } },
];

/**
 * Symmetric 14x14 Cluster Affinity Matrix.
 * Values in [0, 1] represent how smoothly cluster c1 transitions into cluster c2.
 */
const RAW_AFFINITY_PAIRS: ReadonlyArray<[GenreCluster, GenreCluster, number]> = [
  // Rock affinities
  ["rock", "metal", 0.75],
  ["rock", "pop", 0.65],
  ["rock", "folk-country", 0.75],
  ["rock", "jazz-blues", 0.52],
  ["rock", "electronic", 0.45],
  ["rock", "jpop-kpop-anime", 0.52],
  ["rock", "r&b-soul", 0.45],
  ["rock", "experimental", 0.52],
  ["rock", "ambient-chill", 0.38],
  ["rock", "hip-hop", 0.30],
  ["rock", "latin-world", 0.38],
  ["rock", "classical-score", 0.30],
  ["rock", "spoken-other", 0.08],

  // Metal affinities
  ["metal", "experimental", 0.60],
  ["metal", "classical-score", 0.45],
  ["metal", "electronic", 0.38],
  ["metal", "jpop-kpop-anime", 0.35],
  ["metal", "folk-country", 0.35],
  ["metal", "pop", 0.20],
  ["metal", "hip-hop", 0.25],
  ["metal", "jazz-blues", 0.20],
  ["metal", "r&b-soul", 0.15],
  ["metal", "ambient-chill", 0.20],
  ["metal", "latin-world", 0.18],
  ["metal", "spoken-other", 0.06],

  // Pop affinities
  ["pop", "electronic", 0.78],
  ["pop", "r&b-soul", 0.78],
  ["pop", "jpop-kpop-anime", 0.38],
  ["pop", "hip-hop", 0.52],
  ["pop", "folk-country", 0.55],
  ["pop", "latin-world", 0.62],
  ["pop", "ambient-chill", 0.48],
  ["pop", "jazz-blues", 0.45],
  ["pop", "classical-score", 0.28],
  ["pop", "experimental", 0.28],
  ["pop", "spoken-other", 0.10],

  // Electronic affinities
  ["electronic", "ambient-chill", 0.78],
  ["electronic", "hip-hop", 0.55],
  ["electronic", "r&b-soul", 0.55],
  ["electronic", "jpop-kpop-anime", 0.40],
  ["electronic", "experimental", 0.68],
  ["electronic", "latin-world", 0.45],
  ["electronic", "jazz-blues", 0.42],
  ["electronic", "classical-score", 0.38],
  ["electronic", "folk-country", 0.22],
  ["electronic", "spoken-other", 0.08],

  // Hip-Hop affinities
  ["hip-hop", "r&b-soul", 0.84],
  ["hip-hop", "latin-world", 0.62],
  ["hip-hop", "jazz-blues", 0.55],
  ["hip-hop", "ambient-chill", 0.45],
  ["hip-hop", "jpop-kpop-anime", 0.16],
  ["hip-hop", "experimental", 0.38],
  ["hip-hop", "folk-country", 0.18],
  ["hip-hop", "classical-score", 0.15],
  ["hip-hop", "spoken-other", 0.18],

  // R&B / Soul affinities
  ["r&b-soul", "jazz-blues", 0.78],
  ["r&b-soul", "latin-world", 0.60],
  ["r&b-soul", "ambient-chill", 0.55],
  ["r&b-soul", "folk-country", 0.45],
  ["r&b-soul", "jpop-kpop-anime", 0.28],
  ["r&b-soul", "classical-score", 0.30],
  ["r&b-soul", "experimental", 0.28],
  ["r&b-soul", "spoken-other", 0.10],

  // Jazz & Blues affinities
  ["jazz-blues", "ambient-chill", 0.68],
  ["jazz-blues", "classical-score", 0.60],
  ["jazz-blues", "latin-world", 0.64],
  ["jazz-blues", "folk-country", 0.55],
  ["jazz-blues", "experimental", 0.52],
  ["jazz-blues", "jpop-kpop-anime", 0.35],
  ["jazz-blues", "spoken-other", 0.12],

  // Classical & Score affinities
  ["classical-score", "ambient-chill", 0.78],
  ["classical-score", "folk-country", 0.48],
  ["classical-score", "jpop-kpop-anime", 0.52],
  ["classical-score", "experimental", 0.50],
  ["classical-score", "latin-world", 0.35],
  ["classical-score", "spoken-other", 0.12],

  // Folk & Country affinities
  ["folk-country", "ambient-chill", 0.55],
  ["folk-country", "latin-world", 0.52],
  ["folk-country", "jpop-kpop-anime", 0.28],
  ["folk-country", "experimental", 0.25],
  ["folk-country", "spoken-other", 0.12],

  // Latin & World affinities
  ["latin-world", "ambient-chill", 0.45],
  ["latin-world", "jpop-kpop-anime", 0.22],
  ["latin-world", "experimental", 0.30],
  ["latin-world", "spoken-other", 0.10],

  // J-Pop / K-Pop / Anime affinities
  ["jpop-kpop-anime", "ambient-chill", 0.38],
  ["jpop-kpop-anime", "experimental", 0.30],
  ["jpop-kpop-anime", "spoken-other", 0.08],

  // Ambient / Chill affinities
  ["ambient-chill", "experimental", 0.65],
  ["ambient-chill", "spoken-other", 0.15],

  // Experimental affinities
  ["experimental", "spoken-other", 0.12],
];

/** Flat 14x14 affinity lookup table for fast O(M^2) inner-loop evaluation. */
export const AFFINITY_MATRIX: Float32Array = (() => {
  const matrix = new Float32Array(NUM_GENRE_CLUSTERS * NUM_GENRE_CLUSTERS);
  matrix.fill(0.15);
  for (let i = 0; i < NUM_GENRE_CLUSTERS; i++) {
    matrix[i * NUM_GENRE_CLUSTERS + i] = 1.0;
  }
  for (const [c1, c2, weight] of RAW_AFFINITY_PAIRS) {
    const i = CLUSTER_INDEX[c1];
    const j = CLUSTER_INDEX[c2];
    matrix[i * NUM_GENRE_CLUSTERS + j] = weight;
    matrix[j * NUM_GENRE_CLUSTERS + i] = weight;
  }
  return matrix;
})();

export function clusterAffinity(c1: GenreCluster, c2: GenreCluster): number {
  return AFFINITY_MATRIX[CLUSTER_INDEX[c1] * NUM_GENRE_CLUSTERS + CLUSTER_INDEX[c2]];
}

/** Normalizes a single genre token, expanding ID3v1 numeric codes like "(17)" -> "rock". */
export function normalizeGenreToken(rawToken: string): string {
  const trimmed = rawToken.normalize("NFC").trim();
  if (!trimmed) return "";

  const id3Match = /^\(?(\d{1,3})\)?$/.exec(trimmed);
  if (id3Match) {
    const code = Number(id3Match[1]);
    return ID3V1_CODE_MAP[code] ?? "";
  }

  // Handle prefixed ID3v1 tags like "(17)Rock"
  const prefixedMatch = /^\((\d{1,3})\)\s*(.+)$/.exec(trimmed);
  const effective = prefixedMatch ? prefixedMatch[2] : trimmed;

  return effective
    .toLocaleLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[-_./\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits a raw multi-genre tag string into normalized individual tokens. */
export function tokenizeGenreString(rawGenre: string): string[] {
  if (!rawGenre || typeof rawGenre !== "string") return [];
  const tokens: string[] = [];
  // Preserve "r&b" and "drum & bass" before splitting on "&"
  const protectedText = rawGenre
    .replace(/\br\s*&\s*b\b/gi, "r&b")
    .replace(/\bdrum\s*&\s*bass\b/gi, "drum and bass");

  for (const part of protectedText.split(/[,;/|+]+|\s+&\s+/)) {
    const normalized = normalizeGenreToken(part);
    if (
      normalized &&
      normalized !== "unknown" &&
      normalized !== "unknown genre" &&
      normalized !== "other" &&
      normalized !== "none" &&
      normalized !== "unclassified"
    ) {
      tokens.push(normalized);
    }
  }
  return tokens;
}

function addDistributionToVector(target: Float32Array, dist: GenreDistribution, scale = 1.0): boolean {
  let added = false;
  for (const [cluster, weight] of Object.entries(dist) as [GenreCluster, number][]) {
    if (weight > 0) {
      const idx = CLUSTER_INDEX[cluster];
      if (idx !== undefined) {
        target[idx] += weight * scale;
        added = true;
      }
    }
  }
  return added;
}

function matchSingleTokenToVector(token: string, target: Float32Array, scale = 1.0): boolean {
  const exact = EXACT_SUBGENRE_MAP[token];
  if (exact) {
    return addDistributionToVector(target, exact, scale);
  }

  let matchedAny = false;
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(token)) {
      if (addDistributionToVector(target, rule.weights, scale)) {
        matchedAny = true;
      }
    }
  }
  return matchedAny;
}

/** Normalizes a Float32Array in place so its components sum to 1.0. Returns true if non-zero. */
export function normalizeGenreVectorInPlace(vector: Float32Array): boolean {
  let sum = 0;
  for (let i = 0; i < NUM_GENRE_CLUSTERS; i++) {
    if (vector[i] > 0) sum += vector[i];
    else vector[i] = 0;
  }
  if (sum <= 1e-6) {
    vector.fill(0);
    return false;
  }
  for (let i = 0; i < NUM_GENRE_CLUSTERS; i++) {
    vector[i] /= sum;
  }
  return true;
}

export function dominantClustersFromVector(vector: Float32Array, minWeight = 0.15): GenreCluster[] {
  const pairs: { cluster: GenreCluster; weight: number }[] = [];
  for (let i = 0; i < NUM_GENRE_CLUSTERS; i++) {
    if (vector[i] >= minWeight) {
      pairs.push({ cluster: GENRE_CLUSTERS[i], weight: vector[i] });
    }
  }
  pairs.sort((a, b) => b.weight - a.weight);
  return pairs.map(p => p.cluster);
}

/**
 * Extracts a multi-cluster genre profile from a track's tag string and optional external tags.
 */
export function parseGenreProfile(
  rawGenre: string,
  externalGenres?: readonly string[] | null
): ParsedGenreProfile {
  const vector = new Float32Array(NUM_GENRE_CLUSTERS);
  const primaryTokens = tokenizeGenreString(rawGenre);

  for (let i = 0; i < primaryTokens.length; i++) {
    // Earlier tags in a multi-genre string carry slightly higher weight (1.0, 0.85, 0.75...)
    const positionalWeight = 1.0 / (1.0 + i * 0.18);
    matchSingleTokenToVector(primaryTokens[i], vector, positionalWeight);
  }

  if (externalGenres && externalGenres.length > 0) {
    // If local tags already matched, external tags blend in softly (0.35x); otherwise full weight
    let hasLocal = false;
    for (let i = 0; i < NUM_GENRE_CLUSTERS; i++) {
      if (vector[i] > 0) {
        hasLocal = true;
        break;
      }
    }
    const extScale = hasLocal ? 0.35 : 1.0;
    for (let i = 0; i < externalGenres.length; i++) {
      for (const token of tokenizeGenreString(externalGenres[i])) {
        matchSingleTokenToVector(token, vector, extScale / (1.0 + i * 0.25));
      }
    }
  }

  const known = normalizeGenreVectorInPlace(vector);
  return {
    vector,
    isUnknown: !known,
    dominantClusters: known ? dominantClustersFromVector(vector) : [],
  };
}

/** Attempts to infer genre from directory segments of a file path (excluding the filename itself). */
export function inferGenreFromPath(filePath: string | undefined, target: Float32Array): boolean {
  if (!filePath) return false;
  const parts = filePath.split(/[\\/]+/);
  if (parts.length <= 1) return false;
  // Inspect up to 3 parent directory names above the file
  const dirs = parts.slice(Math.max(0, parts.length - 4), parts.length - 1);
  let matched = false;
  for (const dir of dirs) {
    const normalized = normalizeGenreToken(dir);
    if (normalized && matchSingleTokenToVector(normalized, target, 0.5)) {
      matched = true;
    }
  }
  return matched && normalizeGenreVectorInPlace(target);
}

/**
 * Computes multi-cluster genre vectors for an entire library of tracks, applying fallback
 * inference (Album consensus -> Artist consensus -> Folder path) for tracks with missing tags.
 *
 * Returns a flat `Float32Array(tracks.length * NUM_GENRE_CLUSTERS)` and `Uint8Array(tracks.length)`
 * (`1` when unknown) for cache-friendly, low-memory indexing on 20,000+ track libraries.
 */
export function buildLibraryGenreVectors(tracks: readonly GenreTrackInput[]): {
  vectors: Float32Array;
  unknownFlags: Uint8Array;
} {
  const n = tracks.length;
  const vectors = new Float32Array(n * NUM_GENRE_CLUSTERS);
  const unknownFlags = new Uint8Array(n);

  const albumAccum = new Map<string, Float32Array>();
  const artistAccum = new Map<string, Float32Array>();

  const accumulate = (map: Map<string, Float32Array>, key: string, offset: number) => {
    if (!key) return;
    let acc = map.get(key);
    if (!acc) {
      acc = new Float32Array(NUM_GENRE_CLUSTERS);
      map.set(key, acc);
    }
    for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
      acc[c] += vectors[offset + c];
    }
  };

  // Pass 1: Direct tag + external tag extraction (with per-string profile memoization)
  const profileCache = new Map<string, ParsedGenreProfile>();
  let anyUnknown = false;

  for (let i = 0; i < n; i++) {
    const track = tracks[i];
    const offset = i * NUM_GENRE_CLUSTERS;
    const rawGenre = track.genre ?? "";
    const ext = track.externalGenres;
    const cacheKey =
      ext && ext.length > 0 ? `${rawGenre}\u0000${ext.join("|")}` : rawGenre;
    let profile = profileCache.get(cacheKey);
    if (!profile) {
      profile = parseGenreProfile(rawGenre, ext);
      profileCache.set(cacheKey, profile);
    }

    if (!profile.isUnknown) {
      vectors.set(profile.vector, offset);
      unknownFlags[i] = 0;
    } else {
      unknownFlags[i] = 1;
      anyUnknown = true;
    }
  }

  if (!anyUnknown) {
    return { vectors, unknownFlags };
  }

  for (let i = 0; i < n; i++) {
    if (unknownFlags[i] === 1) continue;
    const track = tracks[i];
    const offset = i * NUM_GENRE_CLUSTERS;
    const artistKey = (track.albumArtist || track.artist || "").trim().toLowerCase();
    const albumLower = track.album ? track.album.trim().toLowerCase() : "";
    const albumKey = albumLower ? `${artistKey}\u0000${albumLower}` : "";
    if (albumKey && !albumLower.includes("unknown")) {
      accumulate(albumAccum, albumKey, offset);
    }
    if (artistKey && !artistKey.includes("unknown")) {
      accumulate(artistAccum, artistKey, offset);
    }
    const primaryArtist = (track.artist || "").trim().toLowerCase();
    if (primaryArtist && primaryArtist !== artistKey && !primaryArtist.includes("unknown")) {
      accumulate(artistAccum, primaryArtist, offset);
    }
  }

  // Normalize accumulated album and artist consensus vectors
  for (const vec of albumAccum.values()) normalizeGenreVectorInPlace(vec);
  for (const vec of artistAccum.values()) normalizeGenreVectorInPlace(vec);

  // Pass 2: Fallback inference for untagged tracks
  const scratch = new Float32Array(NUM_GENRE_CLUSTERS);
  for (let i = 0; i < n; i++) {
    if (unknownFlags[i] === 0) continue;
    const track = tracks[i];
    const offset = i * NUM_GENRE_CLUSTERS;
    const artistKey = (track.albumArtist || track.artist || "").trim().toLocaleLowerCase();
    const albumKey = track.album ? `${artistKey}\u0000${track.album.trim().toLocaleLowerCase()}` : "";

    const albumVec = albumKey ? albumAccum.get(albumKey) : undefined;
    if (albumVec) {
      vectors.set(albumVec, offset);
      unknownFlags[i] = 0;
      continue;
    }

    const primaryArtist = (track.artist || "").trim().toLocaleLowerCase();
    const artistVec = artistAccum.get(primaryArtist) ?? artistAccum.get(artistKey);
    if (artistVec) {
      vectors.set(artistVec, offset);
      unknownFlags[i] = 0;
      continue;
    }

    scratch.fill(0);
    if (inferGenreFromPath(track.path, scratch)) {
      vectors.set(scratch, offset);
      unknownFlags[i] = 0;
    }
  }

  return { vectors, unknownFlags };
}

export const NEUTRAL_UNKNOWN_GENRE_COMPATIBILITY = 0.46;

/**
 * Share of a candidate's genre mass that must sit in the session's **dominant** clusters (those
 * holding >= 0.25 of the session) before a transition counts as a genuine neighbour instead of a
 * bridge through the affinity matrix.
 *
 * 0.10 is deliberately small: it keeps a J-Pop candidate in a Pop context (its 0.12 "pop" share is
 * real evidence of musical overlap) while rejecting anything that only shares a *neighbouring*
 * cluster — a pure Electronic track against a pure Pop session, or Phonk (hip-hop 0.7 +
 * electronic 0.3) whose overlap with pop is exactly zero.
 */
export const MIN_DOMINANT_CLUSTER_OVERLAP = 0.1;

/**
 * Compatibility factor for a focused session (dominant cluster >= 0.45) evaluated at **zero**
 * overlap with every dominant cluster; it eases linearly up to 1.0 once the candidate reaches
 * {@link MIN_DOMINANT_CLUSTER_OVERLAP}.
 *
 * This used to be an all-or-nothing 0.72 for "no overlap at all", which was too generous: the
 * pop<->electronic affinity is 0.78, so a pure-electronic candidate scored 0.78 * 0.72 = 0.5616
 * against a pure-pop session and cleared the 0.52 primary gate — an Electronic artist could never
 * be non-relevant to a Pop seed. At 0.45 the same candidate lands at 0.35 and is rejected, while
 * cross-cluster candidates that *do* carry dominant-cluster mass are untouched.
 */
const DISJOINT_DOMINANT_CLUSTER_DAMPING = 0.45;

/**
 * 0 when the candidate shares nothing with the session's dominant clusters, 1 once it reaches
 * {@link MIN_DOMINANT_CLUSTER_OVERLAP}; used to blend between the damping floor and full affinity.
 */
function dominantClusterAgreement(dominantOverlap: number): number {
  return Math.min(1, Math.max(0, dominantOverlap) / MIN_DOMINANT_CLUSTER_OVERLAP);
}

/**
 * Evaluates multi-cluster bilinear genre compatibility between the current session state
 * (`sessionVector` + `exposureStreaks`) and a candidate track's genre vector.
 *
 * Includes:
 * 1. Gentle continuous exposure streak damping when staying in an already-saturated cluster
 *    (bounded at >= 0.68 so staying in the user's current genre never drops below incompatible genres).
 * 2. Dominant-cluster agreement damping (0.45x at zero overlap, easing to 1.0 once the candidate
 *    carries MIN_DOMINANT_CLUSTER_OVERLAP of its mass in a dominant cluster of a focused session).
 * 3. Bridge bonus (+0.14) when a multi-cluster candidate shares a saturated cluster with the
 *    session AND smoothly pivots into a fresh cluster.
 */
export function computeGenreCompatibilityFast(
  sessionVector: Float32Array,
  exposureStreaks: Float32Array,
  sessionHasGenre: boolean,
  candidateVectors: Float32Array,
  candidateOffset: number,
  candidateIsUnknown: boolean
): number {
  if (!sessionHasGenre || candidateIsUnknown) {
    return NEUTRAL_UNKNOWN_GENRE_COMPATIBILITY;
  }

  let bilinearSum = 0;
  let saturatedOverlap = 0;
  let freshOverlap = 0;
  let dominantOverlap = 0;
  let maxSessionWeight = 0;

  for (let c1 = 0; c1 < NUM_GENRE_CLUSTERS; c1++) {
    const s1 = sessionVector[c1];
    if (s1 > maxSessionWeight) maxSessionWeight = s1;
    if (s1 <= 1e-4) continue;
    const rowOffset = c1 * NUM_GENRE_CLUSTERS;

    for (let c2 = 0; c2 < NUM_GENRE_CLUSTERS; c2++) {
      const g2 = candidateVectors[candidateOffset + c2];
      if (g2 <= 1e-4) continue;

      let affinity = AFFINITY_MATRIX[rowOffset + c2];
      const streak = exposureStreaks[c2];

      if (c1 === c2 && streak > 2.0) {
        const damp = Math.max(0.68, 1.0 - 0.08 * (streak - 2.0));
        affinity *= damp;
      } else if (c1 !== c2 && streak > 3.0) {
        // Slightly damp transitions into another cluster that was also heavily played recently
        affinity *= Math.max(0.60, 1.0 - 0.06 * (streak - 3.0));
      }

      bilinearSum += s1 * affinity * g2;
    }
  }

  // Check dominant cluster overlap and multi-cluster bridge potential
  for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
    const g = candidateVectors[candidateOffset + c];
    if (sessionVector[c] >= 0.25) {
      dominantOverlap += g;
    }
    if (g >= 0.2) {
      if (exposureStreaks[c] >= 2.5 && sessionVector[c] >= 0.25) {
        saturatedOverlap += g;
      } else if (exposureStreaks[c] < 1.0) {
        freshOverlap += g;
      }
    }
  }

  if (maxSessionWeight >= 0.45) {
    const agreement = dominantClusterAgreement(dominantOverlap);
    bilinearSum *=
      DISJOINT_DOMINANT_CLUSTER_DAMPING + (1 - DISJOINT_DOMINANT_CLUSTER_DAMPING) * agreement;
  }

  const bridgeBonus = saturatedOverlap >= 0.25 && freshOverlap >= 0.20 ? 0.14 : 0;
  return Math.min(1.0, Math.max(0.05, bilinearSum + bridgeBonus));
}

/**
 * Precomputes `p = sessionVector^T * W(exposureStreaks)` (14 floats) plus saturated/fresh/dominant
 * cluster masks once per step, reducing each candidate genre evaluation from O(14^2) = 196 ops to O(14) = 14 ops.
 */
export function precomputeStepGenreProjection(
  sessionVector: Float32Array,
  exposureStreaks: Float32Array,
  outProjection: Float32Array,
  outSaturatedMask: Uint8Array,
  outFreshMask: Uint8Array,
  outDominantMask?: Uint8Array
): boolean {
  outProjection.fill(0);
  let maxSessionWeight = 0;
  for (let c2 = 0; c2 < NUM_GENRE_CLUSTERS; c2++) {
    const s = sessionVector[c2];
    if (s > maxSessionWeight) maxSessionWeight = s;
    const streak = exposureStreaks[c2];
    outSaturatedMask[c2] = streak >= 2.5 && s >= 0.25 ? 1 : 0;
    outFreshMask[c2] = streak < 1.0 ? 1 : 0;
    if (outDominantMask) {
      outDominantMask[c2] = s >= 0.25 ? 1 : 0;
    }
  }

  for (let c1 = 0; c1 < NUM_GENRE_CLUSTERS; c1++) {
    const s1 = sessionVector[c1];
    if (s1 <= 1e-4) continue;
    const rowOffset = c1 * NUM_GENRE_CLUSTERS;

    for (let c2 = 0; c2 < NUM_GENRE_CLUSTERS; c2++) {
      let affinity = AFFINITY_MATRIX[rowOffset + c2];
      const streak = exposureStreaks[c2];
      if (c1 === c2 && streak > 2.0) {
        affinity *= Math.max(0.68, 1.0 - 0.08 * (streak - 2.0));
      } else if (c1 !== c2 && streak > 3.0) {
        affinity *= Math.max(0.60, 1.0 - 0.06 * (streak - 3.0));
      }
      outProjection[c2] += s1 * affinity;
    }
  }
  return maxSessionWeight >= 0.45;
}

export function scoreProjectedGenreCompatibility(
  projection: Float32Array,
  saturatedMask: Uint8Array,
  freshMask: Uint8Array,
  sessionHasGenre: boolean,
  candidateVectors: Float32Array,
  candidateOffset: number,
  candidateIsUnknown: boolean,
  dominantMask?: Uint8Array,
  sessionIsFocused = true
): number {
  if (!sessionHasGenre || candidateIsUnknown) {
    return NEUTRAL_UNKNOWN_GENRE_COMPATIBILITY;
  }
  let bilinearSum = 0;
  let saturatedOverlap = 0;
  let freshOverlap = 0;
  let dominantOverlap = 0;

  for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
    const g = candidateVectors[candidateOffset + c];
    if (g <= 1e-4) continue;
    bilinearSum += projection[c] * g;
    if (dominantMask && dominantMask[c] === 1) {
      dominantOverlap += g;
    }
    if (g >= 0.2) {
      if (saturatedMask[c] === 1) saturatedOverlap += g;
      else if (freshMask[c] === 1) freshOverlap += g;
    }
  }

  if (dominantMask && sessionIsFocused) {
    const agreement = dominantClusterAgreement(dominantOverlap);
    bilinearSum *=
      DISJOINT_DOMINANT_CLUSTER_DAMPING + (1 - DISJOINT_DOMINANT_CLUSTER_DAMPING) * agreement;
  }

  const bridgeBonus = saturatedOverlap >= 0.25 && freshOverlap >= 0.20 ? 0.14 : 0;
  return Math.min(1.0, Math.max(0.05, bilinearSum + bridgeBonus));
}

/**
 * Updates the session's exponentially weighted genre context vector and continuous cluster
 * exposure streak counters after a track is selected/played.
 */
export function updateGenreSessionState(
  sessionVector: Float32Array,
  exposureStreaks: Float32Array,
  sessionHasGenre: boolean,
  playedVectors: Float32Array,
  playedOffset: number,
  playedIsUnknown: boolean,
  alpha = 0.55
): boolean {
  if (playedIsUnknown) {
    // Decay streaks gently when an untagged track plays
    for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
      exposureStreaks[c] = Math.max(0, exposureStreaks[c] - 0.35);
    }
    return sessionHasGenre;
  }

  for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
    const g = playedVectors[playedOffset + c];
    if (!sessionHasGenre) {
      sessionVector[c] = g;
    } else {
      sessionVector[c] = alpha * g + (1 - alpha) * sessionVector[c];
    }

    if (g >= 0.2) {
      exposureStreaks[c] += g;
    } else {
      exposureStreaks[c] = Math.max(0, exposureStreaks[c] - 0.5);
    }
  }

  normalizeGenreVectorInPlace(sessionVector);
  return true;
}
