// tvids.js - Sora module for tvids.net
// Mode: asyncJS (search / details / episodes / stream all fetch on their own)
//
// tvids.net is a TMDB/IMDB backed index. Every watch page ships a server list
// (<ul id="lsv">) whose first entry is the "Pass" player:
//     https://play.xpass.top/e/tv/{tmdb}/{season}/{episode}
//     https://play.xpass.top/e/movie/{tmdb}
// That server list is the only place the TMDB id appears for a series, so the
// stream resolver reads it straight out of the episode page.
//
// The xpass player itself returns AES encrypted blobs, so playback is resolved
// through VapLayer (streamdata.vaplayer.ru), the same TMDB/IMDB API that the
// airflix / imdb / hydrahd modules use. It answers with HLS master playlists.

(function () {
  const TVIDS_ORIGIN = "https://www.tvids.net";
  const TVIDS_HOST_RE = /^https?:\/\/(?:www\.)?tvids\.(?:net|to)\//i;
  const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const HTML_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // VapLayer only serves its own client's Referer/Origin; anything else comes
  // back as an empty shell.
  const VAPLAYER_API = "https://streamdata.vaplayer.ru/api.php";
  const VAPLAYER_ORIGIN = "https://nextgencloudfabric.com";
  const VAPLAYER_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "Referer": VAPLAYER_ORIGIN + "/",
    "Origin": VAPLAYER_ORIGIN,
  };

  // ---------------------------------------------------------------- networking

  // fetchv2 -> { status, headers, text(), json() }
  // fetch    -> plain body string (deprecated, kept as a fallback)
  async function soraFetch(url, headers, method, body) {
    const hdrs = headers || {};

    if (typeof fetchv2 === "function") {
      try {
        const res = await fetchv2(url, hdrs, method || "GET", body || null);
        if (res && typeof res.text === "function" && typeof res.status === "number") {
          return res;
        }
      } catch (e) {
        // fall through to the legacy fetch below
      }
    }

    try {
      const raw = await fetch(url, hdrs);
      let text;
      if (raw && typeof raw.text === "function") {
        // A real Response object.
        text = await raw.text();
      } else {
        // Sora's legacy fetch resolves the body itself.
        text = raw === null || raw === undefined ? "" : String(raw);
      }
      if (typeof text !== "string") text = String(text === null || text === undefined ? "" : text);
      return {
        status: text ? 200 : 0,
        text: function () { return Promise.resolve(text); },
        json: function () { return Promise.resolve(JSON.parse(text)); },
      };
    } catch (e) {
      return null;
    }
  }

  async function getText(url, headers) {
    const res = await soraFetch(url, headers || HTML_HEADERS);
    if (!res || !res.status) return "";
    try {
      const text = await res.text();
      return typeof text === "string" ? text : "";
    } catch (e) {
      return "";
    }
  }

  // ---------------------------------------------------------------- html utils

  const ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c",
    ndash: "\u2013", mdash: "\u2014", hellip: "\u2026",
  };

  function unescapeHtml(value) {
    if (!value) return "";
    return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (match, code) {
      if (code.charAt(0) === "#") {
        const isHex = code.charAt(1) === "x" || code.charAt(1) === "X";
        const num = parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
        return isNaN(num) ? match : String.fromCharCode(num);
      }
      const named = ENTITIES[code.toLowerCase()];
      return named === undefined ? match : named;
    });
  }

  function stripTags(value) {
    if (!value) return "";
    return unescapeHtml(String(value).replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
  }

  function attr(tag, name) {
    const match = String(tag).match(new RegExp("\\b" + name + '\\s*=\\s*"([^"]*)"', "i"));
    return match ? unescapeHtml(match[1]) : "";
  }

  function firstGroup(html, re) {
    const match = html.match(re);
    return match && match[1] ? match[1] : "";
  }

  function metaContent(html, property) {
    const tag = html.match(new RegExp('<meta[^>]*property="' + property + '"[^>]*>', "i"));
    return tag ? attr(tag[0], "content") : "";
  }

  // Normalises every tvids link to the canonical host and resolves relative ones.
  function absUrl(url) {
    let value = String(url || "").trim();
    if (!value) return TVIDS_ORIGIN + "/";
    value = unescapeHtml(value);
    if (value.indexOf("//") === 0) {
      value = "https:" + value;
    } else if (value.charAt(0) === "/") {
      value = TVIDS_ORIGIN + value;
    } else if (!/^https?:\/\//i.test(value)) {
      value = TVIDS_ORIGIN + "/" + value.replace(/^\/+/, "");
    }
    return value.replace(TVIDS_HOST_RE, TVIDS_ORIGIN + "/");
  }

  function slugToTitle(url) {
    const path = String(url || "").split("?")[0].replace(/\/+$/, "");
    let slug = path.substring(path.lastIndexOf("/") + 1);
    slug = slug.replace(/-\d+$/, "").replace(/^watch\d+$/i, "").replace(/-/g, " ");
    return slug.replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim();
  }

  // The right-hand "You may also like" / "Popular" rail repeats the same card
  // markup as the real listing, so everything after it is dropped before parsing.
  function cutSidebar(html) {
    if (!html) return "";
    const match = html.match(/<div class="flex flex-col\s+w-full\s+3xl:w-\[450px\]/i);
    if (match && match.index > 0) return html.slice(0, match.index);
    return html;
  }

  // <div class="w-28">Label: </div><div ...>value</div>
  function labelValue(html, label) {
    const re = new RegExp(
      '<div class="w-28">\\s*' + label + '\\s*:?\\s*</div>\\s*<div[^>]*>([\\s\\S]*?)</div>',
      "i"
    );
    const value = stripTags(firstGroup(html, re));
    if (!value || value.toLowerCase() === "null" || value.toLowerCase() === "undefined") return "";
    return value;
  }

  function pageTitle(html) {
    const poster = html.match(/<img[^>]*class="[^"]*postimg[^"]*"[^>]*>/i);
    if (poster) {
      const alt = attr(poster[0], "alt");
      if (alt) return alt;
    }
    const heading = stripTags(firstGroup(html, /<h1[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/h1>/i));
    if (heading) return heading;
    const og = metaContent(html, "og:title");
    if (og) return og.replace(/^Watch\s+/i, "").replace(/\s+online.*$/i, "").trim();
    const docTitle = stripTags(firstGroup(html, /<title>([\s\S]*?)<\/title>/i));
    return docTitle.replace(/^Watch\s+/i, "").replace(/\s+online.*$/i, "").trim();
  }

  // ------------------------------------------------------------------- search

  async function searchResults(keyword) {
    try {
      const query = encodeURIComponent(String(keyword || ""));
      const html = await getText(TVIDS_ORIGIN + "/search?q=" + query);
      if (!html) return JSON.stringify([]);

      // Cards live in the main results grid; the sidebar rail is cut off first.
      const body = cutSidebar(html);
      const cardRe =
        /<a[^>]+href="([^"]+)"[^>]*>\s*<img[^>]*?data-src="([^"]*)"[^>]*?alt="([^"]*)"/gi;

      const results = [];
      const seen = {};
      let match;
      while ((match = cardRe.exec(body)) !== null) {
        const href = absUrl(match[1]);
        if (!href || seen[href]) continue;
        const image = unescapeHtml(match[2] || "");
        const title = unescapeHtml(match[3] || "") || slugToTitle(href);
        if (!title) continue;
        seen[href] = true;
        results.push({ title: title, image: image, href: href });
      }

      return JSON.stringify(results);
    } catch (error) {
      return JSON.stringify([{ title: "Error", image: "", href: "" }]);
    }
  }

  // ------------------------------------------------------------------ details

  async function extractDetails(url) {
    try {
      const pageUrl = absUrl(url);
      const html = await getText(pageUrl);
      if (!html) {
        return JSON.stringify([{ description: "Unable to load details.", aliases: "", airdate: "" }]);
      }

      const description =
        stripTags(firstGroup(html, /<div class="[^"]*line-clamp-4[^"]*">([\s\S]*?)<\/div>/i)) ||
        stripTags(metaContent(html, "og:description")) ||
        "No description available.";

      const genres = labelValue(html, "Genres");
      const casts = labelValue(html, "Casts");
      const release = labelValue(html, "Release");

      const aliasLines = [];
      if (genres) aliasLines.push("Genres: " + genres);
      if (casts) aliasLines.push("Cast: " + casts);

      return JSON.stringify([
        {
          description: description,
          aliases: aliasLines.join("\n"),
          airdate: release ? "Released: " + release : "",
        },
      ]);
    } catch (error) {
      return JSON.stringify([{ description: "Unable to load details.", aliases: "", airdate: "" }]);
    }
  }

  // ----------------------------------------------------------------- episodes

  function isMoviePage(pageUrl, html) {
    if (/\/movies?\//i.test(pageUrl)) return true;
    return /itemtype="https?:\/\/schema\.org\/Movie"/i.test(html || "");
  }

  // Collects every /season-XX-episode-YY link that sits under its own
  // "Season N" heading. Both the "E1" badge and the episode name link to the
  // same page, so the entry with a title wins.
  function parseEpisodes(html) {
    const body = cutSidebar(html);

    const marks = [];
    const markRe = />\s*Season\s+(\d+)\s*<\/div>/gi;
    let mark;
    while ((mark = markRe.exec(body)) !== null) {
      marks.push({ index: mark.index, season: parseInt(mark[1], 10) });
    }

    const collect = function (segment, seasonHint) {
      const found = [];
      const anchorRe = /<a\b[^>]*>/gi;
      let anchor;
      while ((anchor = anchorRe.exec(segment)) !== null) {
        const href = attr(anchor[0], "href");
        if (!href) continue;
        const ids = href.match(/season-(\d+)-episode-(\d+)/i);
        if (!ids) continue;
        const season = parseInt(ids[1], 10);
        const number = parseInt(ids[2], 10);
        if (seasonHint !== null && season !== seasonHint) continue;
        if (!number) continue;
        found.push({ season: season, number: number, href: href, title: attr(anchor[0], "title") });
      }
      return found;
    };

    let raw = [];
    if (marks.length) {
      for (let i = 0; i < marks.length; i++) {
        const start = marks[i].index;
        const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
        raw = raw.concat(collect(body.slice(start, end), marks[i].season));
      }
    } else {
      raw = collect(body, null);
    }

    const episodes = [];
    const byHref = {};
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      const key = item.href;
      const cleanTitle = item.title && !/^watch\b/i.test(item.title) ? item.title : "";
      if (byHref[key] === undefined) {
        byHref[key] = episodes.length;
        episodes.push({ number: item.number, season: item.season, href: absUrl(item.href), title: cleanTitle });
      } else if (!episodes[byHref[key]].title && cleanTitle) {
        episodes[byHref[key]].title = cleanTitle;
      }
    }

    episodes.sort(function (a, b) {
      if (a.season !== b.season) return a.season - b.season;
      return a.number - b.number;
    });

    return episodes;
  }

  async function extractEpisodes(url) {
    try {
      const pageUrl = absUrl(url);
      const html = await getText(pageUrl);
      if (!html) return JSON.stringify([]);

      if (isMoviePage(pageUrl, html)) {
        return JSON.stringify([
          { number: 1, title: pageTitle(html) || slugToTitle(pageUrl), href: pageUrl },
        ]);
      }

      const episodes = parseEpisodes(html);
      if (!episodes.length) {
        // Series page without an episode grid: treat the page itself as playable.
        return JSON.stringify([{ number: 1, title: pageTitle(html) || slugToTitle(pageUrl), href: pageUrl }]);
      }

      return JSON.stringify(
        episodes.map(function (episode) {
          return { number: episode.number, title: episode.title, href: episode.href };
        })
      );
    } catch (error) {
      return JSON.stringify([]);
    }
  }

  // ------------------------------------------------------------------- stream

  // Pulls TMDB / IMDB ids out of the watch page's server list.
  function parsePlayerInfo(html, pageUrl) {
    const info = { tmdb: "", imdb: "", type: "", season: 0, episode: 0 };

    // 1. The "Pass" player is always server 1 and carries every id we need.
    const pass = html.match(/play\.xpass\.top\/e\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/i);
    if (pass) {
      info.type = pass[1].toLowerCase();
      info.tmdb = pass[2];
      if (pass[3]) info.season = parseInt(pass[3], 10);
      if (pass[4]) info.episode = parseInt(pass[4], 10);
    }

    // 2. Any other server that embeds a TMDB id.
    if (!info.tmdb) {
      const tmdbRes = [
        /player\.videasy\.net\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/i,
        /vidapi\.xyz\/embed\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/i,
        /vidking\.net\/embed\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/i,
        /(?:2embed\.cc|multiembed\.mov)\/[^"']*?(?:video_id=|\/embed(?:tv)?\/)(\d+)/i,
      ];
      for (let i = 0; i < tmdbRes.length; i++) {
        const match = html.match(tmdbRes[i]);
        if (!match) continue;
        if (match[2] && /^\d+$/.test(match[2])) {
          info.type = match[1].toLowerCase();
          info.tmdb = match[2];
          if (match[3]) info.season = parseInt(match[3], 10);
          if (match[4]) info.episode = parseInt(match[4], 10);
        } else {
          info.tmdb = match[1];
        }
        break;
      }
    }

    // 3. IMDB id, used when no TMDB id is exposed.
    if (!info.tmdb && !info.imdb) {
      const imdb = html.match(/(tt\d{6,})/);
      if (imdb) info.imdb = imdb[1];
    }

    // 4. Fall back to the page URL for media type / season / episode.
    if (!info.type) info.type = /\/movies?\//i.test(pageUrl) ? "movie" : "tv";
    const se = pageUrl.match(/season-(\d+)-episode-(\d+)/i);
    if (se) {
      if (!info.season) info.season = parseInt(se[1], 10);
      if (!info.episode) info.episode = parseInt(se[2], 10);
    }
    if (info.type === "tv") {
      if (!info.season) info.season = 1;
      if (!info.episode) info.episode = 1;
    }

    return info;
  }

  function vapLayerUrl(info) {
    let query;
    if (info.tmdb) {
      query = "tmdb=" + encodeURIComponent(info.tmdb);
    } else if (info.imdb) {
      query = "imdb=" + encodeURIComponent(info.imdb);
    } else {
      return "";
    }

    query += "&type=" + (info.type === "movie" ? "movie" : "tv");
    if (info.type !== "movie") {
      query += "&season=" + encodeURIComponent(String(info.season || 1));
      query += "&episode=" + encodeURIComponent(String(info.episode || 1));
    }
    return VAPLAYER_API + "?" + query;
  }

  function qualityFromFileName(name) {
    const match = String(name || "").match(/(\d{3,4}p)/i);
    return match ? match[1].toLowerCase() : "";
  }

  async function extractStreamUrl(url) {
    try {
      const pageUrl = absUrl(url);
      const html = await getText(pageUrl);
      if (!html) return JSON.stringify({ streams: [] });

      const info = parsePlayerInfo(html, pageUrl);
      const apiUrl = vapLayerUrl(info);
      if (!apiUrl) return JSON.stringify({ streams: [] });

      const res = await soraFetch(apiUrl, VAPLAYER_HEADERS);
      if (!res || !res.status) return JSON.stringify({ streams: [] });

      let payload = null;
      try {
        payload = await res.json();
      } catch (e) {
        return JSON.stringify({ streams: [] });
      }

      const data = payload && payload.data ? payload.data : null;
      if (!data || String(payload.status_code) !== "200") return JSON.stringify({ streams: [] });

      const urls = Array.isArray(data.stream_urls) ? data.stream_urls : [];
      const quality = qualityFromFileName(data.file_name);

      const streams = [];
      for (let i = 0; i < urls.length && streams.length < 3; i++) {
        const streamUrl = String(urls[i] || "");
        if (!/^https?:\/\/\S+\.m3u8/i.test(streamUrl)) continue;
        streams.push({
          title: "VapLayer" + (quality ? " " + quality : "") + (streams.length ? " (mirror " + (streams.length + 1) + ")" : ""),
          streamUrl: streamUrl,
          headers: {
            "User-Agent": USER_AGENT,
            "Referer": VAPLAYER_ORIGIN + "/",
            "Origin": VAPLAYER_ORIGIN,
          },
        });
      }

      if (!streams.length) return JSON.stringify({ streams: [] });

      const result = { streams: streams };

      // Subtitles are only shipped by VapLayer for some titles. Only real
      // subtitle files are passed on; HLS wrapper playlists would just fail in
      // Sora's VTT loader.
      const subs = Array.isArray(data.default_subs) ? data.default_subs : [];
      const subtitleUrls = [];
      for (let i = 0; i < subs.length; i++) {
        const entry = subs[i];
        const subUrl =
          typeof entry === "string" ? entry : entry && (entry.url || entry.file || entry.src) ? (entry.url || entry.file || entry.src) : "";
        if (/^https?:\/\/\S+\.(?:vtt|srt)(?:[?#]\S*)?$/i.test(String(subUrl))) subtitleUrls.push(String(subUrl));
      }
      if (subtitleUrls.length) result.subtitles = subtitleUrls;

      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ streams: [] });
    }
  }

  // Only the four functions Sora looks up are exposed globally.
  var globalScope = typeof globalThis !== "undefined" ? globalThis : this;
  globalScope.searchResults = searchResults;
  globalScope.extractDetails = extractDetails;
  globalScope.extractEpisodes = extractEpisodes;
  globalScope.extractStreamUrl = extractStreamUrl;
})();