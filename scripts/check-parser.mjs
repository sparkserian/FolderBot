// Regression checks for filename parsing. Run with: npm run check:parser
// Compile first, since this reads the built CommonJS output.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const parserPath = path.join(projectRoot, "dist-electron", "shared", "filename-parser.js");

let parser;
try {
  parser = require(parserPath);
} catch {
  console.error("Build the app first: npm run build:electron");
  process.exit(1);
}

const { parseMediaName, formatEpisodeCode } = parser;

// [filename, expected kind, expected episode code (null to skip), expected title (null to skip)]
const cases = [
  // --- canonical episode forms ---
  ["The.Expanse.S01E01.1080p.mkv", "episode", "S01E01", "The Expanse"],
  ["Breaking Bad S05E14 Ozymandias 2160p HDR x265.mkv", "episode", "S05E14", "Breaking Bad"],
  ["Show S00E01 Special.mkv", "episode", "S00E01", "Show"],

  // --- season and episode split by a separator, the case this suite exists for ---
  ["The Expanse S01 E01 1080p.mkv", "episode", "S01E01", "The Expanse"],
  ["The_Expanse_S01_E01_1080p.mkv", "episode", "S01E01", "The Expanse"],
  ["The.Expanse.S01.E01.1080p.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse - S01 - E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01xE01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01~E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01|E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01+E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01#E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01@E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01,E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01;E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01=E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01–E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01 · E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01   E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01 -- E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse.S01..E01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S 01 E 01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse [S01][E01].mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse (S01) (E01).mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse s1e1.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01EP01.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse Season 1 Episode 2.mkv", "episode", "S01E02", "The Expanse"],
  ["The Expanse Season 01 - Episode 02.mkv", "episode", "S01E02", "The Expanse"],
  ["The Expanse Season 1 / Episode 2.mkv", "episode", "S01E02", "The Expanse"],
  ["The Expanse.Season.1.Ep.2.mkv", "episode", "S01E02", "The Expanse"],
  ["Show S01 05 Title.mkv", "episode", "S01E05", "Show"],

  // --- multi-episode files keep the first episode number ---
  ["The Expanse S01E01E02.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01E01-E02.mkv", "episode", "S01E01", "The Expanse"],
  ["The Expanse S01E01-02 1080p.mkv", "episode", "S01E01", "The Expanse"],

  // --- other episode notations ---
  ["The Expanse 1x02.mkv", "episode", "S01E02", "The Expanse"],
  ["The Expanse 01x02 1080p.mkv", "episode", "S01E02", "The Expanse"],
  ["S01E05 The Cave.mkv", "episode", "S01E05", null],
  ["S01 E05 The Cave.mkv", "episode", "S01E05", null],
  ["[S01E05] The Cave.mkv", "episode", "S01E05", "The Cave"],
  ["[YTS] Show S01 E02.mkv", "episode", "S01E02", "Show"],
  ["[SubsGroup] Attack on Titan - 12 [1080p].mkv", "episode", "12", null],
  ["Some Show - Ep 5.mkv", "episode", "05", "Some Show"],
  ["Some Show Episode 12.mkv", "episode", "12", "Some Show"],
  ["Some Show E07.mkv", "episode", "07", "Some Show"],
  ["Show 102.mkv", "episode", "S01E02", "Show"],
  ["S.W.A.T. - S01E01 - Pilot.mkv", "episode", "S01E01", null],

  // --- movies ---
  ["Blade Runner (1982) WEBRip HDR10 x265 1080p.mkv", "movie", null, "Blade Runner"],
  ["Alien.1979.BluRay.x264.1080p.mkv", "movie", null, "Alien"],
  ["Ocean's Eleven (2001) 1080p.mkv", "movie", null, "Ocean's Eleven"],
  ["Ocean's 11 (2001) 1080p.mkv", "movie", null, null],
  ["Se7en (1995) 1080p BluRay.mkv", "movie", null, "Se7en"],
  ["The Hunger Games 2012 1080p.mkv", "movie", null, "The Hunger Games"],
  ["300 (2006) 1080p.mkv", "movie", null, "300"],
  ["Apollo 13 (1995) BluRay 1080p.mkv", "movie", null, "Apollo 13"],
  ["Toy Story 3 (2010) 1080p.mkv", "movie", null, "Toy Story 3"],
  ["The Sandlot 2 (2005) 1080p.mkv", "movie", null, "The Sandlot 2"],
  ["Star Wars Episode 1 The Phantom Menace 1999 1080p.mkv", "movie", null, null],
  ["Mission Impossible 2 (2000) 1080p.mkv", "movie", null, "Mission Impossible 2"],
  ["The Others 2001 1080p.mkv", "movie", null, "The Others"],
  ["Mr. Nobody (2009) 1080p.mkv", "movie", null, "Mr Nobody"],
  ["Dr.Strangelove.1964.1080p.mkv", "movie", null, "Dr Strangelove"],

  // --- release-group and tracker fluff in front of the movie title ---
  ["[YTS.MX] The Dark Knight (2008) 1080p.mkv", "movie", null, "The Dark Knight"],
  ["www.YTS.MX - The Dark Knight (2008) 1080p.mkv", "movie", null, "The Dark Knight"],
  ["www.TamilBlasters.party - The Dark Knight (2008) 1080p.mkv", "movie", null, "The Dark Knight"],
  ["1TamilMV.com - The Dark Knight 2008 1080p.mkv", "movie", null, "The Dark Knight"],
  ["RARBG-Inception.2010.1080p.mkv", "movie", null, "Inception"],
  ["[RARBG] Inception 2010 1080p.mkv", "movie", null, "Inception"],
  ["YIFY.The.Grand.Budapest.Hotel.2014.1080p.mkv", "movie", null, "The Grand Budapest Hotel"],
  ["[GalaxyRG] Everything Everywhere All At Once (2022) 1080p.mkv", "movie", null, "Everything Everywhere All At Once"],
  ["[www.Torrenting.com] - Eternal Sunshine of the Spotless Mind 2004 1080p.mkv", "movie", null, "Eternal Sunshine Of The Spotless Mind"],

  // --- the release year, not just any four-digit number ---
  ["Blade Runner 2049 (2017) 2160p DV x265.mkv", "movie", null, "Blade Runner 2049"],
  ["Blade Runner 2049 2017 2160p.mkv", "movie", null, "Blade Runner 2049"],
  ["2012 (2009) 1080p.mkv", "movie", null, "2012"],
  ["1917 (2019) 1080p BluRay.mkv", "movie", null, "1917"],
  ["Blade Runner (1982) 1080p.mkv", "movie", null, "Blade Runner"]
];

let passed = 0;
const failures = [];

for (const [name, expectedKind, expectedCode, expectedTitle] of cases) {
  const parsed = parseMediaName(name);
  const actualCode =
    parsed.kind === "episode"
      ? formatEpisodeCode(parsed.season, parsed.episode, parsed.absoluteEpisode)
      : null;

  const kindOk = parsed.kind === expectedKind;
  const codeOk = expectedCode === null || actualCode === expectedCode;
  const titleOk = expectedTitle === null || parsed.normalizedTitle === expectedTitle;

  if (kindOk && codeOk && titleOk) {
    passed += 1;
    continue;
  }

  failures.push(
    [
      `FAIL  ${name}`,
      `      kind=${parsed.kind}${kindOk ? "" : ` (expected ${expectedKind})`}`,
      `      code=${actualCode}${codeOk ? "" : ` (expected ${expectedCode})`}`,
      `      title="${parsed.normalizedTitle}"${titleOk ? "" : ` (expected "${expectedTitle}")`}`
    ].join("\n")
  );
}

for (const failure of failures) {
  console.log(failure);
}

console.log(`\n${passed} passed, ${failures.length} failed, ${cases.length} total`);
process.exit(failures.length > 0 ? 1 : 0);
