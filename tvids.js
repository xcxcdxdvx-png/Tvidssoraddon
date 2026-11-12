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
// The xpass player used to expose its server list ("backups") as plain JSON.
// It is now an AES-256-GCM encrypted blob: the /data/... response is base64url
// encoded, the first 12 bytes are the IV, the last 16 bytes are the GCM tag and
// the key is SHA-256("spv3-data-response|spv3-build-...|" + dataPath + "|" + token).
// Sora's JavaScriptCore context has no crypto.subtle, TextEncoder or binary-safe
// atob, so SHA-256, AES-256 and GHASH are implemented below in plain JS.
//
// Once the backups list is decrypted each entry points at a playlist.json that
// resolves to a real HLS manifest. LUL 1 is the most reliable of those servers;
// the others are kept as additional options when they carry the title.

(function () {
  const TVIDS_ORIGIN = "https://www.tvids.net";
  const TVIDS_HOST_RE = /^https?:\/\/(?:www\.)?tvids\.(?:net|to)\//i;
  // IMPORTANT: the CDN token on the resolved playlists is bound to the exact
  // User-Agent that fetched the master playlist. The module and Sora's player
  // therefore have to send the same UA, otherwise the player gets HTTP 403 and
  // shows an unplayable item. Sora's CustomPlayer always injects this exact
  // Chrome 134 string, so it is used here as well.
  const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
  const HTML_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
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

  const XPASS_ORIGIN = "https://play.xpass.top";
  const XPASS_TOKEN_SALT = "spv3-data-response|spv3-build-1787821613-50e5fc97c9dce367|";

  // The Xpass "Pass" server list. LUL is by far the most stable family, so it
  // is validated first. Everything else is only probed when no LUL server
  // carries the title, which keeps the common case fast (some of the other
  // servers take 5-8 s before they fail). Names missing here are probed last.
  const XPASS_SERVER_ORDER = [
    "LUL 1", "LUL 2", "LUL 3", "LUL 4", "LUL 5", "LUL 6", "LUL 7",
    "ZUR 1", "ZUR 2", "MIX 1", "MIX 2", "MIX 3", "ARA 1",
    "MEG 1", "MEG 2", "VID 1", "MOL 1", "MOL 2", "MOL 3",
    "TIK 1", "VIP 1", "FIL 1", "FIL 2", "WIS 1", "WIS 2", "WIS 3", "WIS 4",
    "BIG 1", "BIG 2", "BIG 3", "BIG 4", "BIG 5", "BOX 1",
    "TAP 1", "TAP 2", "TAP 3", "TAP 4", "SAF 1", "SAF 2", "SAF 3",
    "UP4 1", "AKC", "VXR 1", "VRK 1",
  ];
  // Servers that only recently worked are still worth probing when LUL has no
  // copy of the title. The remaining Xpass servers currently fail or hang for
  // 20-40 s, so they are deliberately not contacted.
  const XPASS_EXTRA_SERVERS = ["ZUR 1", "ZUR 2", "MIX 1", "MIX 2", "MIX 3", "ARA 1"];
  const MAX_XPASS_SERVERS = 20; // playlist probes in the fallback pass
  const MAX_XPASS_STREAMS = 6; // returned options

  // VapLayer only serves its own client's Referer/Origin; anything else comes
  // back as an empty shell. It no longer serves playable CDN links for tvids,
  // so it is only used as a last-resort fallback.
  const VAPLAYER_API = "https://streamdata.vaplayer.ru/api.php";
  const VAPLAYER_ORIGIN = "https://nextgencloudfabric.com";
  const VAPLAYER_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "Referer": VAPLAYER_ORIGIN + "/",
    "Origin": VAPLAYER_ORIGIN,
  };

  // ------------------------------------------------------------- base64 / utf8

  const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // Sora's atob() decodes to a UTF-8 string and chokes on binary blobs, so the
  // base64url payload is decoded to bytes by hand.
  function b64ToBytes(value) {
    const clean = String(value)
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/=+$/, "")
      .replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4) + 3);
    let p = 0;
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < clean.length; i++) {
      const v = B64_CHARS.indexOf(clean.charAt(i));
      if (v < 0) continue;
      buffer = (buffer << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[p++] = (buffer >>> bits) & 0xff;
      }
    }
    return out.subarray(0, p);
  }

  function utf8Bytes(str) {
    const out = [];
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          i++;
          out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        } else {
          out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return new Uint8Array(out);
  }

  function bytesToUtf8(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; ) {
      const c = bytes[i++];
      if (c < 0x80) {
        s += String.fromCharCode(c);
      } else if (c < 0xe0) {
        s += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
      } else if (c < 0xf0) {
        s += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
      } else {
        let cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return s;
  }

  // ------------------------------------------------------------------- sha-256

  const SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function ror32(x, n) {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
  }

  function sha256(bytes) {
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const len = bytes.length;
    const padded = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(padded);
    buf.set(bytes, 0);
    buf[len] = 0x80;

    const bitHi = Math.floor(len / 0x20000000) >>> 0;
    const bitLo = (len * 8) >>> 0;
    buf[padded - 8] = (bitHi >>> 24) & 0xff;
    buf[padded - 7] = (bitHi >>> 16) & 0xff;
    buf[padded - 6] = (bitHi >>> 8) & 0xff;
    buf[padded - 5] = bitHi & 0xff;
    buf[padded - 4] = (bitLo >>> 24) & 0xff;
    buf[padded - 3] = (bitLo >>> 16) & 0xff;
    buf[padded - 2] = (bitLo >>> 8) & 0xff;
    buf[padded - 1] = bitLo & 0xff;

    const w = new Uint32Array(64);
    for (let off = 0; off < padded; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        w[i] = ((buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const s0 = (ror32(w[i - 15], 7) ^ ror32(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        const s1 = (ror32(w[i - 2], 17) ^ ror32(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = (ror32(e, 6) ^ ror32(e, 11) ^ ror32(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0;
        const S0 = (ror32(a, 2) ^ ror32(a, 13) ^ ror32(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const t2 = (S0 + maj) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }

      H[0] = (H[0] + a) >>> 0;
      H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0;
      H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0;
      H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0;
      H[7] = (H[7] + h) >>> 0;
    }

    const digest = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      digest[i * 4] = (H[i] >>> 24) & 0xff;
      digest[i * 4 + 1] = (H[i] >>> 16) & 0xff;
      digest[i * 4 + 2] = (H[i] >>> 8) & 0xff;
      digest[i * 4 + 3] = H[i] & 0xff;
    }
    return digest;
  }

  // ------------------------------------------------------------------- aes-256

  const SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
  ];

  function xtime(b) {
    return ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
  }

  function aesExpandKey(key) {
    const Nk = key.length >> 2;
    const Nr = Nk + 6;
    const total = 4 * (Nr + 1);
    const w = new Array(total);
    for (let i = 0; i < Nk; i++) {
      w[i] = [key[i * 4], key[i * 4 + 1], key[i * 4 + 2], key[i * 4 + 3]];
    }
    let rcon = 1;
    for (let i = Nk; i < total; i++) {
      let t = w[i - 1].slice();
      if (i % Nk === 0) {
        t = [t[1], t[2], t[3], t[0]];
        t = [SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]];
        t[0] ^= rcon;
        rcon = xtime(rcon);
      } else if (Nk > 6 && i % Nk === 4) {
        t = [SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]];
      }
      const prev = w[i - Nk];
      w[i] = [prev[0] ^ t[0], prev[1] ^ t[1], prev[2] ^ t[2], prev[3] ^ t[3]];
    }
    return { w: w, Nr: Nr };
  }

  // Encrypts a single 16-byte block. GCM only needs the forward cipher.
  function aesEncryptBlock(input, keySchedule, out) {
    const w = keySchedule.w;
    const Nr = keySchedule.Nr;
    const s = new Uint8Array(16);
    s.set(input);

    const addRoundKey = function (round) {
      for (let c = 0; c < 4; c++) {
        const k = w[round * 4 + c];
        const i = c * 4;
        s[i] ^= k[0];
        s[i + 1] ^= k[1];
        s[i + 2] ^= k[2];
        s[i + 3] ^= k[3];
      }
    };

    addRoundKey(0);
    for (let round = 1; round <= Nr; round++) {
      for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      const tmp = s.slice();
      for (let r = 1; r < 4; r++) {
        for (let c = 0; c < 4; c++) s[r + 4 * c] = tmp[r + 4 * ((c + r) % 4)];
      }
      if (round !== Nr) {
        for (let c = 0; c < 4; c++) {
          const i = c * 4;
          const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
          const t = a0 ^ a1 ^ a2 ^ a3;
          s[i] = a0 ^ t ^ xtime(a0 ^ a1);
          s[i + 1] = a1 ^ t ^ xtime(a1 ^ a2);
          s[i + 2] = a2 ^ t ^ xtime(a2 ^ a3);
          s[i + 3] = a3 ^ t ^ xtime(a3 ^ a0);
        }
      }
      addRoundKey(round);
    }
    out.set(s);
    return out;
  }

  // GF(2^128) multiplication used by GHASH.
  function ghashMul(x, h) {
    const z = new Uint8Array(16);
    const v = h.slice();
    for (let i = 0; i < 128; i++) {
      if ((x[i >> 3] >> (7 - (i & 7))) & 1) {
        for (let j = 0; j < 16; j++) z[j] ^= v[j];
      }
      const lsb = v[15] & 1;
      for (let j = 15; j > 0; j--) v[j] = ((v[j] >> 1) | ((v[j - 1] & 1) << 7)) & 0xff;
      v[0] = (v[0] >> 1) & 0xff;
      if (lsb) v[0] ^= 0xe1;
    }
    return z;
  }

  function aesGcmDecrypt(key, iv, ciphertext, tag) {
    const keySchedule = aesExpandKey(key);
    const block = new Uint8Array(16);

    aesEncryptBlock(new Uint8Array(16), keySchedule, block);
    const H = block.slice();

    const j0 = new Uint8Array(16);
    j0.set(iv.subarray(0, 12));
    j0[15] = 1;

    let X = new Uint8Array(16);
    for (let off = 0; off < ciphertext.length; off += 16) {
      const b = new Uint8Array(16);
      b.set(ciphertext.subarray(off, Math.min(off + 16, ciphertext.length)));
      for (let j = 0; j < 16; j++) X[j] ^= b[j];
      X = ghashMul(X, H);
    }

    const lengthBlock = new Uint8Array(16);
    const bitsHi = Math.floor(ciphertext.length / 0x20000000) >>> 0;
    const bitsLo = (ciphertext.length * 8) >>> 0;
    lengthBlock[8] = (bitsHi >>> 24) & 0xff;
    lengthBlock[9] = (bitsHi >>> 16) & 0xff;
    lengthBlock[10] = (bitsHi >>> 8) & 0xff;
    lengthBlock[11] = bitsHi & 0xff;
    lengthBlock[12] = (bitsLo >>> 24) & 0xff;
    lengthBlock[13] = (bitsLo >>> 16) & 0xff;
    lengthBlock[14] = (bitsLo >>> 8) & 0xff;
    lengthBlock[15] = bitsLo & 0xff;
    for (let j = 0; j < 16; j++) X[j] ^= lengthBlock[j];
    X = ghashMul(X, H);

    const eKj0 = new Uint8Array(16);
    aesEncryptBlock(j0, keySchedule, eKj0);
    let diff = 0;
    for (let j = 0; j < 16; j++) diff |= (eKj0[j] ^ X[j]) ^ tag[j];
    if (diff !== 0) throw new Error("xpass: GCM tag mismatch");

    const plain = new Uint8Array(ciphertext.length);
    const counter = j0.slice();
    const stream = new Uint8Array(16);
    for (let off = 0; off < ciphertext.length; off += 16) {
      for (let j = 15; j >= 12; j--) {
        counter[j] = (counter[j] + 1) & 0xff;
        if (counter[j]) break;
      }
      aesEncryptBlock(counter, keySchedule, stream);
      const n = Math.min(16, ciphertext.length - off);
      for (let j = 0; j < n; j++) plain[off + j] = ciphertext[off + j] ^ stream[j];
    }
    return plain;
  }

  function decryptXpassData(blob, dataPath, token) {
    const raw = b64ToBytes(blob);
    if (raw.length < 29) throw new Error("xpass: payload too short");
    const key = sha256(utf8Bytes(XPASS_TOKEN_SALT + dataPath + "|" + token));
    const iv = raw.subarray(0, 12);
    const ciphertext = raw.subarray(12, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    return bytesToUtf8(aesGcmDecrypt(key, iv, ciphertext, tag));
  }

  // -------------------------------------------------------------- url helpers

  function resolveUrl(base, relative) {
    const rel = String(relative || "").trim();
    if (/^https?:\/\//i.test(rel)) return rel;
    if (rel.indexOf("//") === 0) return "https:" + rel;

    let prefix = base;
    if (!/^https?:\/\//i.test(prefix)) return rel;

    // Query-only reference: keep the current path, swap the query.
    if (rel.charAt(0) === "?") {
      const q = prefix.indexOf("?");
      const h = prefix.indexOf("#");
      let cut = prefix.length;
      if (q !== -1 && q < cut) cut = q;
      if (h !== -1 && h < cut) cut = h;
      return prefix.substring(0, cut) + rel;
    }

    if (rel.charAt(0) === "/") {
      // keep scheme + host only
      const hostEnd = prefix.indexOf("/", prefix.indexOf("//") + 2);
      return (hostEnd === -1 ? prefix : prefix.substring(0, hostEnd)) + rel;
    }

    let query = prefix.indexOf("?");
    if (query !== -1) prefix = prefix.substring(0, query);
    const hash = prefix.indexOf("#");
    if (hash !== -1) prefix = prefix.substring(0, hash);
    const slash = prefix.lastIndexOf("/");
    const dir = slash > prefix.indexOf("//") + 7 ? prefix.substring(0, slash + 1) : prefix + "/";

    // normalise ./ and ../
    const parts = (dir + rel).split("/");
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === "." || part === "") {
        if (i === 0) out.push(part);
        continue;
      }
      if (part === "..") {
        if (out.length > 2) out.pop();
        continue;
      }
      out.push(part);
    }
    return out.join("/");
  }

  // --------------------------------------------------------------- xpass flow

  // Pulls TMDB / IMDB ids out of the watch page's server list.
  function parsePlayerInfo(html, pageUrl) {
    const info = { tmdb: "", imdb: "", type: "", season: 0, episode: 0, embed: "" };

    // 1. The "Pass" player is always server 1 and carries every id we need.
    const pass = html.match(/play\.xpass\.top\/e\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/i);
    if (pass) {
      info.type = pass[1].toLowerCase();
      info.tmdb = pass[2];
      if (pass[3]) info.season = parseInt(pass[3], 10);
      if (pass[4]) info.episode = parseInt(pass[4], 10);
    }

    // The full embed URL keeps the exact season/episode the site links to.
    const embed = html.match(/https?:\/\/play\.xpass\.top\/e\/(?:movie|tv)\/[\d/]+/i);
    if (embed) info.embed = embed[0].split("?")[0];

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

    // 5. Build the xpass embed URL when the page only exposed ids.
    if (!info.embed && info.tmdb) {
      info.embed =
        XPASS_ORIGIN +
        (info.type === "movie"
          ? "/e/movie/" + info.tmdb
          : "/e/tv/" + info.tmdb + "/" + info.season + "/" + info.episode);
    }

    return info;
  }

  function qualityFromFileName(name) {
    const match = String(name || "").match(/(\d{3,4}p)/i);
    return match ? match[1].toLowerCase() : "";
  }

  function isPlayableSourceUrl(url) {
    const value = String(url || "");
    if (!/^https?:\/\//i.test(value)) return false;
    if (/\/video\/error/i.test(value)) return false;
    return true;
  }

  // --------------------------------------------------------------- subtitles

  // The embed page advertises an external WebVTT catalogue in `var suburl`.
  // Sora only renders its own subtitle overlay (and therefore only offers the
  // "Toggle Subtitles" action) when the module returns a `subtitles` URL, so
  // this is what makes the soft subs switchable. HLS-embedded subtitle tracks
  // cannot be toggled from Sora's UI.
  const SUB_ORIGIN = "https://sub.1x2.space";

  function embeddedSubUrl(html) {
    const source = String(html || "");
    const match =
      source.match(/var\s+suburl\s*=\s*"([^"]+)"/i) ||
      source.match(/\bsuburl\s*[:=]\s*["']([^"']+)["']/i);
    if (!match) return "";
    let value = unescapeHtml(match[1]).replace(/\\\//g, "/");
    if (value.indexOf("//") === 0) value = "https:" + value;
    return value;
  }

  function subtitleApiUrl(info, suburl) {
    if (suburl) return suburl;
    if (!info || !info.tmdb) return "";
    if (info.type === "movie") return SUB_ORIGIN + "/api/movie/" + info.tmdb;
    return (
      SUB_ORIGIN + "/api/tv/" + info.tmdb + "/" +
      encodeURIComponent(String(info.season || 1)) + "/" +
      encodeURIComponent(String(info.episode || 1))
    );
  }

  // The catalogue is a JSON array of { label, language, url }. Only plain
  // WebVTT/SRT can be rendered by Sora, so English is preferred and everything
  // else is ignored.
  async function fetchSubtitleUrls(info, suburl) {
    try {
      const apiUrl = subtitleApiUrl(info, suburl);
      if (!apiUrl) return [];

      const res = await soraFetch(apiUrl, {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": TVIDS_ORIGIN + "/",
      });
      if (!res || res.status !== 200) return [];

      let list = null;
      try {
        list = await res.json();
      } catch (e) {
        return [];
      }
      if (!Array.isArray(list) || !list.length) return [];

      let chosen = null;
      for (let i = 0; i < list.length; i++) {
        const item = list[i] || {};
        const name = String(item.label || item.language || "").toLowerCase();
        if (name.indexOf("english") !== -1 || name === "en" || name.indexOf("eng") === 0) {
          chosen = item;
          break;
        }
      }
      if (!chosen) chosen = list[0];

      const file = String(chosen.url || chosen.file || chosen.src || "");
      if (!file) return [];
      const absolute = /^https?:\/\//i.test(file) ? file : resolveUrl(SUB_ORIGIN + "/", file);
      return /\.(?:vtt|srt)(?:[?#]|$)/i.test(absolute) ? [absolute] : [];
    } catch (e) {
      return [];
    }
  }

  // Fetches the embed page, then its /data payload. Returns the decrypted backup
  // server list plus the subtitle API URL advertised by the embed page.
  async function fetchXpassBackups(embedUrl) {
    const embedHtml = await getText(embedUrl, {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": TVIDS_ORIGIN + "/",
    });
    if (!embedHtml) return null;

    const suburl = embeddedSubUrl(embedHtml);

    const requestHeaders = {
      "User-Agent": USER_AGENT,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": embedUrl,
      "Origin": XPASS_ORIGIN,
    };

    const dataUrlMatch = embedHtml.match(/var\s+dataUrl\s*=\s*"([^"]+)"/);
    if (!dataUrlMatch) {
      // Older player builds shipped the list inline as `var backups=[...]`.
      const inline = embedHtml.match(/var\s+backups\s*=\s*(\[[\s\S]*?\])\s*;/);
      if (inline) {
        try {
          const parsed = JSON.parse(inline[1]);
          if (parsed && parsed.length) return { backups: parsed, suburl: suburl };
        } catch (e) {
          return null;
        }
      }
      return { backups: [], suburl: suburl };
    }

    let dataUrl = unescapeHtml(dataUrlMatch[1]).replace(/\\\//g, "/");
    if (dataUrl.indexOf("//") === 0) dataUrl = "https:" + dataUrl;
    const absoluteDataUrl = /^https?:\/\//i.test(dataUrl) ? dataUrl : XPASS_ORIGIN + dataUrl;

    const queryIndex = absoluteDataUrl.indexOf("?");
    const dataPath = queryIndex === -1 ? absoluteDataUrl : absoluteDataUrl.substring(0, queryIndex);
    let token = "";
    const tokenMatch = dataUrl.match(/[?&]token=([^&#]+)/);
    if (tokenMatch) {
      token = tokenMatch[1];
      try {
        token = decodeURIComponent(token);
      } catch (e) {
        // keep the raw value
      }
    }

    const res = await soraFetch(absoluteDataUrl, requestHeaders);
    if (!res || res.status !== 200) return { backups: [], suburl: suburl };

    let body = "";
    try {
      body = String(await res.text() || "").trim();
    } catch (e) {
      return { backups: [], suburl: suburl };
    }
    if (!body) return { backups: [], suburl: suburl };

    // Plain JSON (pre-encryption builds) or the current base64url blob.
    try {
      if (body.charAt(0) === "[" || body.charAt(0) === "{") {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) return { backups: parsed, suburl: suburl };
        if (parsed && Array.isArray(parsed.backups)) return { backups: parsed.backups, suburl: suburl };
        return { backups: [], suburl: suburl };
      }
      const pathOnly = dataPath.replace(/^https?:\/\/[^/]+/i, "");
      const parsed = JSON.parse(decryptXpassData(body, pathOnly, token));
      return { backups: Array.isArray(parsed) ? parsed : [], suburl: suburl };
    } catch (e) {
      return { backups: [], suburl: suburl };
    }
  }

  // Resolves one backup entry to its HLS/MP4 sources.
  async function fetchXpassSources(server, embedUrl) {
    const rawUrl = String(server.url || "");
    if (!rawUrl) return [];
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : XPASS_ORIGIN + rawUrl;

    const res = await soraFetch(url, {
      "User-Agent": USER_AGENT,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": embedUrl,
      "Origin": XPASS_ORIGIN,
    });
    if (!res || res.status !== 200) return [];

    let payload;
    try {
      payload = await res.json();
    } catch (e) {
      return [];
    }

    const groups = Array.isArray(payload && payload.playlist) ? payload.playlist : [];
    const sources = [];
    for (let i = 0; i < groups.length; i++) {
      const entries = Array.isArray(groups[i] && groups[i].sources) ? groups[i].sources : [];
      for (let j = 0; j < entries.length; j++) {
        const entry = entries[j] || {};
        const file = entry.file || entry.url || entry.src || "";
        if (!isPlayableSourceUrl(file)) continue;
        sources.push({
          url: String(file),
          quality: qualityFromFileName(file) || qualityFromFileName(entry.label),
        });
      }
    }
    return sources;
  }

  const XPASS_STREAM_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Referer": XPASS_ORIGIN + "/",
  };

  // fetchv2 hands back the raw response headers; the casing differs between
  // servers, so look them up case-insensitively.
  function headerValue(headers, name) {
    if (!headers) return "";
    const wanted = String(name).toLowerCase();
    for (const key in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
      if (String(key).toLowerCase() !== wanted) continue;
      const value = headers[key];
      return value === null || value === undefined ? "" : String(value);
    }
    return "";
  }

  // Cheap but effective liveness test: the playlist must load and the first
  // media segment must come back as media (not an HTML error page or an
  // anti-bot placeholder image). Dead servers are dropped instead of showing a
  // broken player.
  //
  // Also reports whether the master declares an embedded subtitle group. Those
  // tracks are auto-selected by the native player and cannot be toggled by Sora,
  // so a server without one is preferred and returned as its master URL (which
  // mints a fresh token for whatever UA the player sends). Servers that only
  // offer an embedded track are returned as their direct variant, which drops
  // the forced track and lets the external WebVTT be the only subtitle source.
  async function probeStream(url, headersOverride) {
    const requestHeaders = headersOverride || XPASS_STREAM_HEADERS;
    const fail = { ok: false, masterUrl: url, playbackUrl: url, hasEmbeddedSubs: false };
    const master = await soraFetch(url, requestHeaders);
    if (!master || master.status !== 200) return fail;

    // Direct media files (MP4/WebM) are accepted, but only when the response is
    // actually media and not an HTML/JSON error page. Do not read the body: it
    // would download the whole file just to validate it.
    if (/\.(?:mp4|m4v|webm|mkv)(?:[?#]|$)/i.test(url)) {
      const mediaType = headerValue(master.headers, "content-type").toLowerCase();
      if (/text\/html|text\/xml|application\/json/i.test(mediaType)) return fail;
      return { ok: true, masterUrl: url, playbackUrl: url, hasEmbeddedSubs: false };
    }

    let text = "";
    try {
      text = String(await master.text() || "");
    } catch (e) {
      return fail;
    }

    if (!/#EXTM3U/i.test(text)) {
      return fail;
    }

    const hasEmbeddedSubs = /#EXT-X-MEDIA:[^\r\n]*TYPE=SUBTITLES/i.test(text);

    let mediaUrl = url;
    let mediaText = text;

    // If this is a master playlist, pick the highest-bandwidth variant.
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
      const bandwidth = lines[i].match(/BANDWIDTH=(\d+)/i);
      let variant = "";
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (!line || line.charAt(0) === "#") continue;
        variant = line;
        break;
      }
      if (!variant) continue;
      variants.push({
        url: resolveUrl(url, variant),
        bandwidth: bandwidth ? parseInt(bandwidth[1], 10) : 0,
      });
    }
    if (variants.length) {
      let best = variants[0];
      for (let i = 1; i < variants.length; i++) {
        if (variants[i].bandwidth > best.bandwidth) best = variants[i];
      }
      mediaUrl = best.url;
      const media = await soraFetch(mediaUrl, requestHeaders);
      if (!media || media.status !== 200) return fail;
      try {
        mediaText = String(await media.text() || "");
      } catch (e) {
        return fail;
      }
      if (!/#EXTM3U/i.test(mediaText)) return fail;
    }

    const mediaLines = mediaText.split(/\r?\n/);
    let segment = "";
    for (let i = 0; i < mediaLines.length; i++) {
      const line = mediaLines[i].trim();
      if (!line || line.charAt(0) === "#") continue;
      segment = line;
      break;
    }
    if (!segment) return fail;

    const segmentUrl = resolveUrl(mediaUrl, segment);
    const headers = {
      "User-Agent": USER_AGENT,
      "Accept": "*/*",
      "Range": "bytes=0-1",
      "Referer": requestHeaders["Referer"] || XPASS_ORIGIN + "/",
    };
    const probe = await soraFetch(segmentUrl, headers);
    if (!probe || probe.status === 0) {
      // Unknown status: keep the option.
      return { ok: true, masterUrl: url, playbackUrl: mediaUrl, hasEmbeddedSubs: hasEmbeddedSubs };
    }
    if (probe.status >= 400) return fail;

    const contentType = headerValue(probe.headers, "content-type").toLowerCase();
    if (contentType) {
      if (/text\/html|text\/xml|application\/json|image\//.test(contentType)) {
        return fail;
      }
      if (contentType.indexOf("text/plain") === 0) return fail;
    }
    return { ok: true, masterUrl: url, playbackUrl: mediaUrl, hasEmbeddedSubs: hasEmbeddedSubs };
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

  async function vapLayerStreams(info) {
    const apiUrl = vapLayerUrl(info);
    if (!apiUrl) return [];
    const res = await soraFetch(apiUrl, VAPLAYER_HEADERS);
    if (!res || !res.status) return [];

    let payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      return [];
    }

    const data = payload && payload.data ? payload.data : null;
    if (!data || String(payload.status_code) !== "200") return [];

    const urls = Array.isArray(data.stream_urls) ? data.stream_urls : [];
    const quality = qualityFromFileName(data.file_name);

    // VapLayer links are often dead (HTTP 401). Probe them before showing them,
    // otherwise the player would get an unplayable item.
    const candidates = [];
    for (let i = 0; i < urls.length && candidates.length < 3; i++) {
      const streamUrl = String(urls[i] || "");
      if (!/^https?:\/\/\S+\.m3u8/i.test(streamUrl)) continue;
      candidates.push(streamUrl);
    }
    if (!candidates.length) return [];

    const probes = await Promise.all(
      candidates.map(function (streamUrl) {
        return probeStream(streamUrl, VAPLAYER_HEADERS).catch(function () {
          return { ok: false, masterUrl: streamUrl, playbackUrl: streamUrl };
        });
      })
    );

    const streams = [];
    for (let i = 0; i < probes.length; i++) {
      if (!probes[i].ok) continue;
      streams.push({
        title: "VapLayer" + (quality ? " " + quality : "") + (streams.length ? " (mirror " + (streams.length + 1) + ")" : ""),
        streamUrl: probes[i].masterUrl || candidates[i],
        headers: {
          "Referer": VAPLAYER_ORIGIN + "/",
          "Origin": VAPLAYER_ORIGIN,
        },
      });
    }
    return streams;
  }

  async function xpassStreams(info) {
    if (!info.embed) return { streams: [], suburl: "" };
    const meta = await fetchXpassBackups(info.embed);
    const suburl = meta && meta.suburl ? meta.suburl : "";
    const backups = meta && meta.backups ? meta.backups : [];
    if (!backups.length) return { streams: [], suburl: suburl };

    // Order the backup list by the known-good priority, keeping unknown names
    // (new servers) at the end so they still get a chance.
    const ranked = [];
    for (let i = 0; i < backups.length; i++) {
      const server = backups[i];
      if (!server || !server.url) continue;
      let rank = XPASS_SERVER_ORDER.indexOf(String(server.name || ""));
      if (rank === -1) rank = XPASS_SERVER_ORDER.length + i;
      ranked.push({ server: server, rank: rank, index: i });
    }
    ranked.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.index - b.index;
    });

    const candidates = ranked.slice(0, MAX_XPASS_SERVERS);

    // Resolve a set of candidates and validate their first source. Servers are
    // probed in parallel; only the first source of each server is used, because
    // the mirrors point at the same CDN asset.
    async function probeCandidates(list) {
      const resolved = await Promise.all(
        list.map(function (entry) {
          return fetchXpassSources(entry.server, info.embed).then(function (sources) {
            return { server: entry.server, sources: sources };
          }).catch(function () {
            return { server: entry.server, sources: [] };
          });
        })
      );

      const checks = [];
      for (let i = 0; i < resolved.length; i++) {
        const item = resolved[i];
        if (!item.sources.length) continue;
        for (let j = 0; j < item.sources.length && j < 1; j++) {
          checks.push({
            name: String(item.server.name || "Server"),
            source: item.sources[j],
          });
        }
      }
      if (!checks.length) return [];

      return Promise.all(
        checks.map(function (entry) {
          return probeStream(entry.source.url).then(function (probe) {
            return {
              entry: entry,
              ok: probe.ok,
              masterUrl: probe.masterUrl || entry.source.url,
              playbackUrl: probe.playbackUrl || entry.source.url,
              hasEmbeddedSubs: probe.hasEmbeddedSubs === true,
            };
          }).catch(function () {
            return {
              entry: entry,
              ok: false,
              masterUrl: entry.source.url,
              playbackUrl: entry.source.url,
              hasEmbeddedSubs: false,
            };
          });
        })
      );
    }

    // Servers whose master has no embedded subtitle group are preferred: their
    // master URL mints a fresh token for the player's own request, so playback
    // works no matter which User-Agent the player sends. Servers that only have
    // an embedded track are returned as the direct variant, which drops that
    // forced track.
    function buildStreams(results) {
      const clean = [];
      const subbed = [];
      const seen = {};
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (!result.ok) continue;
        const useMaster = !result.hasEmbeddedSubs;
        const streamUrl = useMaster ? result.masterUrl : result.playbackUrl;
        if (!streamUrl || seen[streamUrl]) continue;
        seen[streamUrl] = true;

        const entry = result.entry;
        const quality = entry.source.quality;
        const baseTitle = String(entry.name || "Server") + (quality ? " " + quality : "");
        if (useMaster) {
          clean.push({
            title: baseTitle,
            streamUrl: streamUrl,
            headers: { "Referer": XPASS_ORIGIN + "/" },
          });
          continue;
        }

        // Embedded-subtitle server: the variant drops the forced track so the
        // external WebVTT can be toggled. The variant token is bound to the UA
        // that fetched it, so also offer the UA-agnostic master (worker) as a
        // guaranteed-playback fallback; its embedded track simply stays on.
        subbed.push({
          title: baseTitle,
          streamUrl: streamUrl,
          headers: { "Referer": XPASS_ORIGIN + "/" },
        });
        if (result.masterUrl && !seen[result.masterUrl]) {
          seen[result.masterUrl] = true;
          subbed.push({
            title: baseTitle + " (embedded subs)",
            streamUrl: result.masterUrl,
            headers: { "Referer": XPASS_ORIGIN + "/" },
          });
        }
      }
      return (clean.length ? clean : subbed).slice(0, MAX_XPASS_STREAMS);
    }

    // First pass: LUL only. It carries most titles and answers in 1-4 s, so the
    // slower fallback servers are never contacted in the common case.
    function isLul(entry) {
      return /^LUL\s/i.test(String(entry.server.name || ""));
    }
    let fast = candidates.filter(isLul);
    let slow = candidates.filter(function (entry) {
      if (isLul(entry)) return false;
      return XPASS_EXTRA_SERVERS.indexOf(String(entry.server.name || "")) !== -1;
    });
    if (!fast.length) {
      // No LUL entry at all: go straight to the known fallback servers.
      fast = slow;
      slow = [];
    }
    if (!fast.length) return { streams: [], suburl: suburl };

    let results = await probeCandidates(fast);
    let streams = buildStreams(results);
    if (streams.length) return { streams: streams, suburl: suburl };

    // Fallback: everything else. Slow/failing servers only cost time here.
    if (slow.length) {
      results = results.concat(await probeCandidates(slow));
      streams = buildStreams(results);
    }
    return { streams: streams, suburl: suburl };
  }

  async function extractStreamUrl(url) {
    try {
      const pageUrl = absUrl(url);
      const html = await getText(pageUrl);
      if (!html) return JSON.stringify({ streams: [] });

      const info = parsePlayerInfo(html, pageUrl);

      // The subtitle catalogue is independent of server resolution, so start it
      // alongside the stream probes instead of adding it to the load time.
      const subtitlePromise = fetchSubtitleUrls(info, "").catch(function () {
        return [];
      });

      let streams = [];
      let suburl = "";
      try {
        const xpass = await xpassStreams(info);
        streams = xpass.streams;
        suburl = xpass.suburl;
      } catch (e) {
        streams = [];
      }

      // Keep the old VapLayer path as a last resort: it is kept for titles the
      // xpass servers do not carry, even though its CDN links are often 401.
      if (!streams.length) {
        try {
          streams = await vapLayerStreams(info);
        } catch (e) {
          streams = [];
        }
      }

      // External WebVTT makes Sora show its own subtitle overlay, which is the
      // only subtitle source the player can toggle on/off.
      let subtitles = await subtitlePromise;
      if (!subtitles.length && suburl) {
        try {
          subtitles = await fetchSubtitleUrls(info, suburl);
        } catch (e) {
          subtitles = [];
        }
      }

      if (!streams.length) return JSON.stringify({ streams: [], subtitles: subtitles });
      return JSON.stringify({ streams: streams, subtitles: subtitles });
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
