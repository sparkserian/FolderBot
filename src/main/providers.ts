import type {
  MetadataSourceId,
  ParsedMedia,
  ProviderStatus,
  RenameOptions,
  ResolvedMetadata
} from "../shared/types";
import { toDisplayTitle } from "../shared/filename-parser";

interface ResolveResult {
  metadata: ResolvedMetadata | null;
  warnings: string[];
}

interface MetadataProvider {
  id: MetadataSourceId;
  label: string;
  getStatus(options: RenameOptions): ProviderStatus;
  resolve(parsed: ParsedMedia, options: RenameOptions): Promise<ResolveResult>;
}

export function createProviders(): MetadataProvider[] {
  return [new LocalMetadataProvider(), new TMDbMetadataProvider(), new TVDbMetadataProvider()];
}

const TVDB_BASE_URL = "https://api4.thetvdb.com/v4";
const tvdbAuthCache = new Map<string, TVDbAuthCacheEntry>();

class LocalMetadataProvider implements MetadataProvider {
  public readonly id = "local" as const;
  public readonly label = "Local Parser";

  public getStatus(): ProviderStatus {
    return {
      id: this.id,
      label: this.label,
      ready: true,
      details: "Works offline using filename heuristics and your chosen output template."
    };
  }

  public async resolve(parsed: ParsedMedia): Promise<ResolveResult> {
    return {
      metadata: {
        sourceId: this.id,
        displayTitle: toDisplayTitle(parsed.normalizedTitle),
        year: parsed.year,
        season: parsed.season,
        episode: parsed.episode
      },
      warnings: parsed.kind === "unknown" ? ["Using the filename as-is because metadata was not resolved."] : []
    };
  }
}

class TMDbMetadataProvider implements MetadataProvider {
  public readonly id = "tmdb" as const;
  public readonly label = "TMDb";
  private readonly movieSearchCache = new Map<string, Promise<SearchResponse>>();
  private readonly tvSearchCache = new Map<string, Promise<SearchResponse>>();
  private readonly episodeCache = new Map<string, Promise<EpisodeResponse>>();

  public getStatus(options: RenameOptions): ProviderStatus {
    return {
      id: this.id,
      label: this.label,
      ready: Boolean(options.tmdbToken),
      details: options.tmdbToken
        ? "Ready. Metadata lookups will use The Movie Database."
        : "Add your TMDb API Read Access Token in Settings to enable TMDb matching."
    };
  }

  public async resolve(parsed: ParsedMedia, options: RenameOptions): Promise<ResolveResult> {
    if (!options.tmdbToken) {
      return {
        metadata: null,
        warnings: ["TMDb is selected, but no bearer token is configured."]
      };
    }

    try {
      if (parsed.kind === "movie") {
        return await this.resolveMovie(parsed, options);
      }

      if (parsed.kind === "episode") {
        return await this.resolveEpisode(parsed, options);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown TMDb error";
      return {
        metadata: null,
        warnings: [`TMDb lookup failed: ${message}`]
      };
    }

    return {
      metadata: null,
      warnings: ["TMDb could not resolve this filename shape."]
    };
  }

  private async resolveMovie(parsed: ParsedMedia, options: RenameOptions): Promise<ResolveResult> {
    const params = new URLSearchParams({
      query: parsed.normalizedTitle,
      language: options.language || "en-US"
    });

    if (parsed.year) {
      params.set("year", String(parsed.year));
    }

    const response = await this.cachedRequest(
      this.movieSearchCache,
      params.toString(),
      `/search/movie?${params.toString()}`,
      options.tmdbToken as string
    );

    const bestMatch = response.results[0];
    if (!bestMatch) {
      return {
        metadata: null,
        warnings: ["TMDb returned no movie match. Falling back to the local parser."]
      };
    }

    return {
      metadata: {
        sourceId: this.id,
        displayTitle: bestMatch.title,
        year: bestMatch.release_date ? Number.parseInt(bestMatch.release_date.slice(0, 4), 10) : parsed.year,
        summary: bestMatch.overview,
        matchConfidence: 0.94
      },
      warnings: []
    };
  }

  private async resolveEpisode(parsed: ParsedMedia, options: RenameOptions): Promise<ResolveResult> {
    const params = new URLSearchParams({
      query: parsed.normalizedTitle,
      language: options.language || "en-US"
    });

    const search = await this.cachedRequest(
      this.tvSearchCache,
      params.toString(),
      `/search/tv?${params.toString()}`,
      options.tmdbToken as string
    );

    const bestMatch = search.results[0];
    if (!bestMatch) {
      return {
        metadata: null,
        warnings: ["TMDb returned no series match. Falling back to the local parser."]
      };
    }

    let episodeTitle: string | undefined;
    let summary = bestMatch.overview;

    if (typeof parsed.season === "number" && typeof parsed.episode === "number") {
      const episodePath = `/tv/${bestMatch.id}/season/${parsed.season}/episode/${parsed.episode}?language=${encodeURIComponent(
        options.language || "en-US"
      )}`;
      const episode = await this.cachedRequest(
        this.episodeCache,
        episodePath,
        episodePath,
        options.tmdbToken as string
      );

      episodeTitle = episode.name;
      summary = episode.overview || summary;
    }

    return {
      metadata: {
        sourceId: this.id,
        displayTitle: bestMatch.name,
        season: parsed.season,
        episode: parsed.episode,
        episodeTitle,
        year: bestMatch.first_air_date ? Number.parseInt(bestMatch.first_air_date.slice(0, 4), 10) : undefined,
        summary,
        matchConfidence: 0.91
      },
      warnings: parsed.absoluteEpisode
        ? ["TMDb matched the series, but absolute episode numbering still needs a season map."]
        : []
    };
  }

  private async cachedRequest<T>(
    cache: Map<string, Promise<T>>,
    key: string,
    path: string,
    token: string
  ): Promise<T> {
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }

    const request = tmdbRequest<T>(path, token).catch((error) => {
      cache.delete(key);
      throw error;
    });

    cache.set(key, request);
    return request;
  }
}

class TVDbMetadataProvider implements MetadataProvider {
  public readonly id = "tvdb" as const;
  public readonly label = "TheTVDB";
  private readonly searchCache = new Map<string, Promise<TVDbSearchResult[]>>();
  private readonly movieCache = new Map<string, Promise<TVDbMovieRecord>>();
  private readonly episodeListCache = new Map<string, Promise<TVDbSeriesEpisodesResponse>>();

  public getStatus(options: RenameOptions): ProviderStatus {
    return {
      id: this.id,
      label: this.label,
      ready: Boolean(options.tvdbApiKey),
      details: options.tvdbApiKey
        ? options.tvdbPin
          ? "Ready. TVDB matching will use your saved API key and subscriber PIN."
          : "Ready. TVDB matching will use your saved API key. Add a subscriber PIN in Settings if your key requires one."
        : "Add a TVDB API key in Settings to enable TVDB matching."
    };
  }

  public async resolve(parsed: ParsedMedia, options: RenameOptions): Promise<ResolveResult> {
    if (!options.tvdbApiKey) {
      return {
        metadata: null,
        warnings: ["TVDB is selected, but no API key is configured."]
      };
    }

    try {
      if (parsed.kind === "movie") {
        return await this.resolveMovie(parsed, options);
      }

      if (parsed.kind === "episode") {
        return await this.resolveEpisode(parsed, options);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown TVDB error";
      return {
        metadata: null,
        warnings: [`TVDB lookup failed: ${message}`]
      };
    }

    return {
      metadata: null,
      warnings: ["TVDB could not resolve this filename shape."]
    };
  }

  private async resolveMovie(parsed: ParsedMedia, options: RenameOptions): Promise<ResolveResult> {
    const searchPath = `/search?${buildTVDbSearchParams({
      query: parsed.normalizedTitle,
      type: "movie",
      year: parsed.year,
      language: toTVDbLanguage(options.language)
    })}`;
    const search = await this.cachedTVDbRequest(this.searchCache, searchPath, searchPath, options);

    const bestMatch = search[0];
    const movieId = getTVDbResultId(bestMatch);
    if (!movieId) {
      return {
        metadata: null,
        warnings: ["TVDB returned no movie match. Falling back to the local parser."]
      };
    }

    const moviePath = `/movies/${movieId}`;
    const movie = await this.cachedTVDbRequest(this.movieCache, moviePath, moviePath, options);

    return {
      metadata: {
        sourceId: this.id,
        displayTitle: movie.name || bestMatch.name || parsed.normalizedTitle,
        year: parseOptionalYear(movie.year ?? bestMatch.year),
        summary: bestMatch.overview,
        matchConfidence: 0.9
      },
      warnings: []
    };
  }

  private async resolveEpisode(parsed: ParsedMedia, options: RenameOptions): Promise<ResolveResult> {
    const searchPath = `/search?${buildTVDbSearchParams({
      query: parsed.normalizedTitle,
      type: "series",
      year: parsed.year,
      language: toTVDbLanguage(options.language)
    })}`;
    const search = await this.cachedTVDbRequest(this.searchCache, searchPath, searchPath, options);

    const bestMatch = search[0];
    const seriesId = getTVDbResultId(bestMatch);
    if (!seriesId) {
      return {
        metadata: null,
        warnings: ["TVDB returned no series match. Falling back to the local parser."]
      };
    }

    let episodeTitle: string | undefined;
    let summary = bestMatch.overview;
    let season = parsed.season;
    let episode = parsed.episode;
    const warnings: string[] = [];

    if (typeof parsed.season === "number" && typeof parsed.episode === "number") {
      const episodesPath = `/series/${seriesId}/episodes/default?page=0&season=${parsed.season}&episodeNumber=${parsed.episode}`;
      const response = await this.cachedTVDbRequest(
        this.episodeListCache,
        episodesPath,
        episodesPath,
        options
      );

      const matchedEpisode = response.episodes[0];
      if (matchedEpisode) {
        episodeTitle = matchedEpisode.name;
        summary = matchedEpisode.overview || summary;
        season = matchedEpisode.seasonNumber ?? season;
        episode = matchedEpisode.number ?? episode;
      } else {
        warnings.push("TVDB matched the series, but did not return the specific season and episode.");
      }
    } else if (typeof parsed.absoluteEpisode === "number") {
      const episodesPath = `/series/${seriesId}/episodes/default?page=0&season=0&episodeNumber=${parsed.absoluteEpisode}`;
      const response = await this.cachedTVDbRequest(
        this.episodeListCache,
        episodesPath,
        episodesPath,
        options
      );

      const absoluteEpisode = response.episodes.find(
        (entry) => entry.absoluteNumber === parsed.absoluteEpisode
      );

      if (absoluteEpisode) {
        episodeTitle = absoluteEpisode.name;
        summary = absoluteEpisode.overview || summary;
        season = absoluteEpisode.seasonNumber ?? season;
        episode = absoluteEpisode.number ?? episode;
      } else {
        warnings.push("TVDB matched the series, but absolute episode mapping was not resolved.");
      }
    }

    return {
      metadata: {
        sourceId: this.id,
        displayTitle: bestMatch.name || parsed.normalizedTitle,
        season,
        episode,
        episodeTitle,
        year: parseOptionalYear(bestMatch.year),
        summary,
        matchConfidence: 0.89
      },
      warnings
    };
  }

  private async cachedTVDbRequest<T>(
    cache: Map<string, Promise<T>>,
    key: string,
    path: string,
    options: RenameOptions
  ): Promise<T> {
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }

    const request = tvdbRequest<T>(path, options).catch((error) => {
      cache.delete(key);
      throw error;
    });

    cache.set(key, request);
    return request;
  }
}

async function tmdbRequest<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.themoviedb.org/3${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

async function tvdbRequest<T>(path: string, options: RenameOptions): Promise<T> {
  const token = await getTVDbBearerToken(options);
  const response = await fetch(`${TVDB_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { data: T };
  return payload.data;
}

async function getTVDbBearerToken(options: RenameOptions): Promise<string> {
  if (!options.tvdbApiKey) {
    throw new Error("Missing TVDB API key");
  }

  const cacheKey = `${options.tvdbApiKey}:${options.tvdbPin ?? ""}`;
  const cached = tvdbAuthCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.token;
  }

  const response = await fetch(`${TVDB_BASE_URL}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      apikey: options.tvdbApiKey,
      ...(options.tvdbPin ? { pin: options.tvdbPin } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`TVDB login failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { data?: { token?: string } };
  const token = payload.data?.token;

  if (!token) {
    throw new Error("TVDB login returned no token");
  }

  tvdbAuthCache.set(cacheKey, {
    token,
    expiresAt: now + 1000 * 60 * 60 * 24 * 28
  });

  return token;
}

function buildTVDbSearchParams(input: {
  query: string;
  type: "series" | "movie";
  language: string;
  year?: number;
}): string {
  const params = new URLSearchParams({
    query: input.query,
    type: input.type,
    language: input.language
  });

  if (input.year) {
    params.set("year", String(input.year));
  }

  params.set("limit", "5");
  return params.toString();
}

function toTVDbLanguage(language: string): string {
  const normalized = (language || "en-US").trim();
  const [base] = normalized.split(/[-_]/);
  const lowerBase = base.toLowerCase();

  const map: Record<string, string> = {
    en: "eng",
    es: "spa",
    fr: "fra",
    de: "deu",
    it: "ita",
    pt: "por",
    nl: "nld",
    sv: "swe",
    da: "dan",
    no: "nor",
    fi: "fin",
    pl: "pol",
    cs: "ces",
    sk: "slk",
    hu: "hun",
    tr: "tur",
    ru: "rus",
    uk: "ukr",
    ja: "jpn",
    ko: "kor",
    zh: "zho"
  };

  return map[lowerBase] ?? "eng";
}

function parseOptionalYear(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value.slice(0, 4), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function getTVDbResultId(result?: TVDbSearchResult): number | undefined {
  const candidate = result?.tvdb_id ?? result?.objectID ?? result?.id;
  if (!candidate) {
    return undefined;
  }

  const parsed = Number.parseInt(candidate, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

interface SearchResult {
  id: number;
  name: string;
  title: string;
  overview: string;
  first_air_date?: string;
  release_date?: string;
}

interface SearchResponse {
  results: SearchResult[];
}

interface EpisodeResponse {
  name: string;
  overview: string;
}

interface TVDbAuthCacheEntry {
  token: string;
  expiresAt: number;
}

interface TVDbSearchResult {
  id?: string;
  objectID?: string;
  tvdb_id?: string;
  name?: string;
  year?: string;
  overview?: string;
}

interface TVDbMovieRecord {
  name?: string;
  year?: string;
}

interface TVDbEpisodeRecord {
  absoluteNumber?: number;
  name?: string;
  number?: number;
  overview?: string;
  seasonNumber?: number;
}

interface TVDbSeriesEpisodesResponse {
  series: {
    name?: string;
  };
  episodes: TVDbEpisodeRecord[];
}
