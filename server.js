const express = require("express");
const https = require("https");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Cookie-aware HTTP client ---

// Global cookie jar for instagram.com
let cookieJar = {};
let cookiesInitialized = false;

function parseCookies(setCookieHeaders) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];
  for (const header of headers) {
    const parts = header.split(";")[0].split("=");
    const name = parts[0].trim();
    const value = parts.slice(1).join("=").trim();
    if (name && value) cookieJar[name] = value;
  }
}

function getCookieString() {
  return Object.entries(cookieJar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Make an HTTP(S) request with cookie support.
 * followRedirects: true = follow redirects (default), false = return redirect info
 */
function fetchWithCookies(url, options = {}) {
  const {
    extraHeaders = {},
    followRedirects = true,
    maxRedirects = 5,
    method = "GET",
  } = options;

  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));

    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "https:" ? https : http;

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      Cookie: getCookieString(),
      ...extraHeaders,
    };

    const req = transport.request(url, { method, headers }, (res) => {
      // Always capture cookies from response
      parseCookies(res.headers["set-cookie"]);

      if (
        followRedirects &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return resolve(
          fetchWithCookies(redirectUrl, {
            ...options,
            maxRedirects: maxRedirects - 1,
          })
        );
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          redirectUrl: res.headers.location || null,
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

/**
 * Visit instagram.com to initialize cookies (csrftoken, mid, ig_did, etc).
 * Must be called before any other Instagram requests.
 */
async function initCookies() {
  if (cookiesInitialized) return;

  try {
    console.log("Initializing Instagram cookies...");
    await fetchWithCookies("https://www.instagram.com/", {
      extraHeaders: {
        Referer: "https://www.google.com/",
      },
    });
    cookiesInitialized = true;
    const cookieNames = Object.keys(cookieJar);
    console.log(`Got ${cookieNames.length} cookies: ${cookieNames.join(", ")}`);
  } catch (err) {
    console.error("Cookie init error:", err.message);
  }
}

// Initialize cookies on startup
initCookies();

// Session ID management — needed for carousel posts (multi-image)
let savedSessionId = null;

function applySessionId() {
  if (savedSessionId) {
    cookieJar["sessionid"] = savedSessionId;
  }
}

// --- Shortcode extraction ---

function extractShortcode(url) {
  const match = url.match(
    /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i
  );
  return match ? match[1] : null;
}

function sanitizeUrl(rawUrl) {
  let url = rawUrl;
  url = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  url = url.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  url = url.replace(/\\\//g, "/");
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

function isPostImage(url) {
  if (!url) return false;
  if (!url.includes("cdninstagram") && !url.includes("fbcdn")) return false;
  if (url.includes("s150x150")) return false;
  if (url.includes("s100x100")) return false;
  if (url.includes("s50x50")) return false;
  if (url.includes("44x44")) return false;
  if (url.includes("profile_pic")) return false;
  return true;
}

/**
 * Extract a fingerprint from a CDN URL for deduplication.
 * Instagram CDN URLs look like:
 *   https://scontent-xxx.cdninstagram.com/v/t51.29350-15/HASH_n.jpg?...
 * The unique part is the filename (HASH_n.jpg). Different strategies may
 * return URLs with different CDN hostnames or query params for the same image.
 */
function imageFingerprint(url) {
  try {
    const parsed = new URL(url);
    // Get the last path segment (filename)
    const parts = parsed.pathname.split("/");
    const filename = parts[parts.length - 1];
    // Strip file extension and return as key
    return filename.replace(/\.[^.]+$/, "");
  } catch {
    return url;
  }
}

/**
 * Deduplicate images by CDN filename. Keeps the first (highest priority) URL
 * for each unique image.
 */
function deduplicateImages(urls) {
  const seen = new Map(); // fingerprint -> url
  const result = [];
  for (const url of urls) {
    const fp = imageFingerprint(url);
    if (!seen.has(fp)) {
      seen.set(fp, url);
      result.push(url);
    }
  }
  return result;
}

// --- Extraction strategies ---

/**
 * Strategy 1: /media/?size=l — Instagram redirects to the CDN image URL.
 * Most reliable, works without JS, but only returns the first image (not carousel).
 */
async function fetchFromMediaRedirect(shortcode) {
  const images = [];
  const mediaUrl = `https://www.instagram.com/p/${shortcode}/media/?size=l`;

  try {
    // Don't follow redirects — we want the Location header
    const response = await fetchWithCookies(mediaUrl, {
      followRedirects: false,
    });

    if (response.status >= 300 && response.status < 400 && response.redirectUrl) {
      const url = sanitizeUrl(response.redirectUrl);
      if (url) {
        console.log(`  media redirect → ${url.substring(0, 80)}...`);
        images.push(url);
      }
    } else if (response.status === 200) {
      // Sometimes it returns the image directly instead of redirecting
      const ct = response.headers["content-type"] || "";
      if (ct.startsWith("image/") && response.body.length > 5000) {
        // We got the actual image — we can't use a URL for this,
        // but let's try to get the URL from the response
        console.log("  media returned image directly (no redirect URL)");
      }
    }
  } catch (err) {
    console.error("Media redirect error:", err.message);
  }

  return images;
}

/**
 * Strategy 2: Embed page with cookies.
 */
async function fetchFromEmbed(shortcode) {
  const images = [];
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

  try {
    const response = await fetchWithCookies(embedUrl, {
      extraHeaders: {
        Referer: "https://www.instagram.com/",
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
      },
    });

    if (response.status !== 200) {
      console.log(`  embed returned status ${response.status}`);
      return [];
    }

    const html = response.body.toString("utf-8");
    let match;

    // 1. EmbeddedMediaImage class
    const embeddedImgRegex =
      /class="EmbeddedMediaImage"[^>]*src="([^"]+)"/gi;
    while ((match = embeddedImgRegex.exec(html)) !== null) {
      const url = sanitizeUrl(match[1]);
      if (url && isPostImage(url)) images.push(url);
    }
    const embeddedImgRegex2 =
      /src="([^"]+)"[^>]*class="EmbeddedMediaImage"/gi;
    while ((match = embeddedImgRegex2.exec(html)) !== null) {
      const url = sanitizeUrl(match[1]);
      if (url && isPostImage(url)) images.push(url);
    }

    // 2. display_url in script data
    const displayUrlRegex = /"display_url"\s*:\s*"(https?:[^"]+)"/gi;
    while ((match = displayUrlRegex.exec(html)) !== null) {
      try {
        const url = sanitizeUrl(JSON.parse(`"${match[1]}"`));
        if (url && isPostImage(url)) images.push(url);
      } catch {
        const url = sanitizeUrl(match[1]);
        if (url && isPostImage(url)) images.push(url);
      }
    }

    // 3. img tags with CDN src (fallback)
    if (images.length === 0) {
      const imgRegex =
        /<img[^>]+src="(https:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]+)"/gi;
      while ((match = imgRegex.exec(html)) !== null) {
        const url = sanitizeUrl(match[1]);
        if (url && isPostImage(url)) images.push(url);
      }
    }

    // Log a snippet of the HTML if we got nothing (for debugging)
    if (images.length === 0) {
      const title = html.match(/<title>([^<]*)<\/title>/i);
      console.log(`  embed page title: "${title ? title[1] : "none"}"`);
      console.log(`  embed HTML length: ${html.length}`);
    }
  } catch (err) {
    console.error("Embed error:", err.message);
  }

  return images;
}

/**
 * Strategy 3: JSON endpoint with cookies.
 */
async function fetchFromJsonEndpoint(shortcode) {
  const images = [];
  const jsonUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;

  try {
    const response = await fetchWithCookies(jsonUrl, {
      extraHeaders: {
        "X-IG-App-ID": "936619743392459",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://www.instagram.com/p/${shortcode}/`,
        Accept: "*/*",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    if (response.status !== 200) return [];

    let data;
    try {
      data = JSON.parse(response.body.toString("utf-8"));
    } catch {
      return [];
    }

    // items[] format
    if (data?.items) {
      for (const item of data.items) {
        if (item.carousel_media) {
          // Carousel post: extract each slide's image (skip top-level image_versions2
          // because it's just the cover/first image, same as carousel_media[0])
          for (const cm of item.carousel_media) {
            if (cm.image_versions2?.candidates) {
              const best = cm.image_versions2.candidates.reduce((a, b) =>
                (a.width || 0) > (b.width || 0) ? a : b
              );
              if (best?.url) {
                const url = sanitizeUrl(best.url);
                if (url) images.push(url);
              }
            }
          }
        } else if (item.image_versions2?.candidates) {
          // Single image post
          const best = item.image_versions2.candidates.reduce((a, b) =>
            (a.width || 0) > (b.width || 0) ? a : b
          );
          if (best?.url) {
            const url = sanitizeUrl(best.url);
            if (url) images.push(url);
          }
        }
      }
    }

    // graphql format
    const media = data?.graphql?.shortcode_media;
    if (media) {
      if (media.edge_sidecar_to_children?.edges?.length > 0) {
        // Carousel: get each slide (skip top-level display_url, it's the cover)
        for (const edge of media.edge_sidecar_to_children.edges) {
          if (edge.node?.display_url) {
            const url = sanitizeUrl(edge.node.display_url);
            if (url) images.push(url);
          }
        }
      } else if (media.display_url) {
        // Single image
        const url = sanitizeUrl(media.display_url);
        if (url) images.push(url);
      }
    }
  } catch (err) {
    console.error("JSON endpoint error:", err.message);
  }

  return images;
}

/**
 * Strategy 4: oEmbed with cookies.
 */
async function fetchFromOembed(shortcode) {
  const images = [];
  const postUrl = `https://www.instagram.com/p/${shortcode}/`;
  const oembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(postUrl)}&maxwidth=1080`;

  try {
    const response = await fetchWithCookies(oembedUrl, {
      extraHeaders: {
        Accept: "application/json",
        Referer: "https://www.instagram.com/",
      },
    });
    if (response.status !== 200) return [];

    const text = response.body.toString("utf-8");
    // Check it's actually JSON before parsing
    if (text.startsWith("{") || text.startsWith("[")) {
      const data = JSON.parse(text);
      if (data.thumbnail_url) {
        const url = sanitizeUrl(data.thumbnail_url);
        if (url) images.push(url);
      }
    }
  } catch (err) {
    console.error("oEmbed error:", err.message);
  }

  return images;
}

// --- API Routes ---

// Save Instagram session ID
app.post("/api/set-session", (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
    savedSessionId = null;
    return res.json({ ok: true, hasSession: false });
  }
  savedSessionId = sessionId.trim();
  applySessionId();
  console.log("Session ID saved");
  res.json({ ok: true, hasSession: true });
});

// Check if session is configured
app.get("/api/session-status", (req, res) => {
  res.json({ hasSession: !!savedSessionId });
});

app.post("/api/fetch-images", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  const instaRegex =
    /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+/i;
  if (!instaRegex.test(url)) {
    return res.status(400).json({
      error:
        "Invalid Instagram URL. Please provide a link like: https://www.instagram.com/p/XXXXX/",
    });
  }

  const shortcode = extractShortcode(url);
  if (!shortcode) {
    return res.status(400).json({ error: "Could not extract post ID from URL." });
  }

  // Ensure cookies are initialized, then inject session ID
  await initCookies();
  applySessionId();

  try {
    console.log(`\nFetching images for: ${shortcode} (session: ${savedSessionId ? "yes" : "no"})`);

    // Run all strategies in parallel
    const [mediaImages, embedImages, jsonImages, oembedImages] =
      await Promise.all([
        fetchFromMediaRedirect(shortcode),
        fetchFromEmbed(shortcode),
        fetchFromJsonEndpoint(shortcode),
        fetchFromOembed(shortcode),
      ]);

    console.log(
      `Results: media=${mediaImages.length}, embed=${embedImages.length}, json=${jsonImages.length}, oembed=${oembedImages.length}`
    );

    // Merge and deduplicate by CDN filename fingerprint
    // Prioritize JSON (has all carousel images) > media > embed > oembed
    const allImages = [
      ...jsonImages,
      ...mediaImages,
      ...embedImages,
      ...oembedImages,
    ];
    const uniqueImages = deduplicateImages(allImages);

    console.log(`After dedup: ${uniqueImages.length} unique (from ${allImages.length} total)`);

    if (uniqueImages.length === 0) {
      // Reset cookies and try again next time — they may have expired
      cookiesInitialized = false;
      cookieJar = {};

      return res.status(404).json({
        error:
          "No images found. The post may be private, a video-only post, or Instagram may be blocking the request. Try again — cookies have been refreshed.",
      });
    }

    console.log(`Returning ${uniqueImages.length} images`);
    res.json({ images: uniqueImages });
  } catch (err) {
    console.error("Fetch error:", err.message);
    res.status(500).json({ error: `Failed to fetch post: ${err.message}` });
  }
});

/**
 * Proxy images from Instagram/Facebook CDN to avoid CORS.
 */
app.get("/api/proxy-image", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "URL parameter is required" });
  }

  try {
    const parsed = new URL(url);
    const allowedHosts = [
      "cdninstagram.com",
      "instagram.com",
      "fbcdn.net",
      "facebook.com",
    ];
    const isAllowed = allowedHosts.some(
      (host) =>
        parsed.hostname === host || parsed.hostname.endsWith("." + host)
    );
    if (!isAllowed) {
      return res
        .status(403)
        .json({ error: "Only Instagram/Facebook CDN URLs are allowed" });
    }
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  try {
    const response = await fetchWithCookies(url, {
      extraHeaders: {
        Referer: "https://www.instagram.com/",
        Accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      },
    });

    const contentType = response.headers["content-type"] || "image/jpeg";

    if (contentType.includes("text/html") || response.body.length < 1000) {
      console.error(
        `Proxy: not an image — status=${response.status}, type=${contentType}, size=${response.body.length}`
      );
      return res.status(502).json({ error: "Image not available" });
    }

    res.set("Content-Type", contentType);
    res.set("Content-Length", response.body.length);
    res.set("Cache-Control", "public, max-age=3600");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(response.body);
  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(502).json({ error: "Failed to fetch image" });
  }
});

app.listen(PORT, () => {
  console.log(`Insta-Scrap running at http://localhost:${PORT}`);
});
