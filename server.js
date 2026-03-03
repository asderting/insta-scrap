const express = require("express");
const https = require("https");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/**
 * Fetch a URL following redirects. Returns { status, headers, body }.
 */
function fetchUrl(url, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));

    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "https:" ? https : http;

    const req = transport.get(
      url,
      {
        headers: {
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
          ...headers,
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const redirectUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          return resolve(fetchUrl(redirectUrl, headers, maxRedirects - 1));
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

/**
 * Extract the shortcode from an Instagram URL.
 */
function extractShortcode(url) {
  const match = url.match(
    /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i
  );
  return match ? match[1] : null;
}

/**
 * Decode unicode escape sequences in strings (e.g. \u0026 -> &).
 */
function decodeUnicodeEscapes(str) {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

/**
 * Strategy 1: Fetch the embed page (/embed/captioned/).
 * This endpoint is designed for third-party embedding and is less restricted.
 */
async function fetchFromEmbed(shortcode) {
  const images = new Set();
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

  try {
    const response = await fetchUrl(embedUrl, {
      Referer: "https://www.google.com/",
    });
    if (response.status !== 200) return [];

    const html = response.body.toString("utf-8");

    // The embed page has images in <img> tags with Instagram CDN URLs
    const imgRegex =
      /<img[^>]+src="(https:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]+)"/gi;
    let match;
    while ((match = imgRegex.exec(html)) !== null) {
      const src = decodeUnicodeEscapes(match[1]);
      // Skip profile pictures and tiny thumbnails
      if (
        !src.includes("s150x150") &&
        !src.includes("/s150x150/") &&
        !src.includes("44x44") &&
        !src.includes("profile_pic")
      ) {
        images.add(src);
      }
    }

    // Also check srcset for higher-res versions
    const srcsetRegex =
      /srcset="(https:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]+)"/gi;
    while ((match = srcsetRegex.exec(html)) !== null) {
      const src = decodeUnicodeEscapes(match[1].split(" ")[0]);
      if (!src.includes("s150x150") && !src.includes("profile_pic")) {
        images.add(src);
      }
    }

    // Look for display_url / display_src in embedded JSON
    const displayUrlRegex =
      /"(?:display_url|display_src|thumbnail_src)"\s*:\s*"(https?:[^"]+)"/gi;
    while ((match = displayUrlRegex.exec(html)) !== null) {
      try {
        images.add(JSON.parse(`"${match[1]}"`));
      } catch {
        images.add(decodeUnicodeEscapes(match[1]));
      }
    }

    // Look for image URLs in data attributes
    const dataRegex =
      /data-(?:src|image|url)="(https:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]+)"/gi;
    while ((match = dataRegex.exec(html)) !== null) {
      const src = decodeUnicodeEscapes(match[1]);
      if (!src.includes("s150x150") && !src.includes("profile_pic")) {
        images.add(src);
      }
    }

    // Look in inline style background-image
    const bgRegex =
      /background-image:\s*url\(['"]?(https:\/\/[^'")\s]+(?:cdninstagram|fbcdn)[^'")\s]+)['"]?\)/gi;
    while ((match = bgRegex.exec(html)) !== null) {
      images.add(decodeUnicodeEscapes(match[1]));
    }
  } catch (err) {
    console.error("Embed fetch error:", err.message);
  }

  return [...images];
}

/**
 * Strategy 2: Use the ?__a=1&__d=dis JSON endpoint.
 */
async function fetchFromJsonEndpoint(shortcode) {
  const images = new Set();
  const jsonUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;

  try {
    const response = await fetchUrl(jsonUrl, {
      "X-IG-App-ID": "936619743392459",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `https://www.instagram.com/p/${shortcode}/`,
    });
    if (response.status !== 200) return [];

    const text = response.body.toString("utf-8");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }

    // Navigate the response structure
    const items = data?.items || data?.graphql?.shortcode_media
      ? [data.graphql.shortcode_media]
      : [];

    if (data?.items) {
      for (const item of data.items) {
        // Single image
        if (item.image_versions2?.candidates) {
          // Get the highest resolution
          const best = item.image_versions2.candidates.reduce((a, b) =>
            (a.width || 0) > (b.width || 0) ? a : b
          );
          if (best?.url) images.add(best.url);
        }

        // Carousel
        if (item.carousel_media) {
          for (const cm of item.carousel_media) {
            if (cm.image_versions2?.candidates) {
              const best = cm.image_versions2.candidates.reduce((a, b) =>
                (a.width || 0) > (b.width || 0) ? a : b
              );
              if (best?.url) images.add(best.url);
            }
          }
        }
      }
    }

    // GraphQL format
    const media = data?.graphql?.shortcode_media;
    if (media) {
      if (media.display_url) images.add(media.display_url);

      if (media.edge_sidecar_to_children?.edges) {
        for (const edge of media.edge_sidecar_to_children.edges) {
          if (edge.node?.display_url) images.add(edge.node.display_url);
        }
      }
    }
  } catch (err) {
    console.error("JSON endpoint error:", err.message);
  }

  return [...images];
}

/**
 * Strategy 3: Fetch the main page and parse og:image / embedded data.
 */
async function fetchFromMainPage(shortcode) {
  const images = new Set();
  const pageUrl = `https://www.instagram.com/p/${shortcode}/`;

  try {
    const response = await fetchUrl(pageUrl);
    if (response.status !== 200) return [];

    const html = response.body.toString("utf-8");

    // og:image meta tags
    const ogRegex =
      /<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/gi;
    let match;
    while ((match = ogRegex.exec(html)) !== null) {
      images.add(match[1]);
    }
    const ogRegex2 =
      /<meta\s+content="([^"]+)"\s+(?:property|name)="og:image"/gi;
    while ((match = ogRegex2.exec(html)) !== null) {
      images.add(match[1]);
    }

    // display_url in script data
    const displayRegex =
      /"(?:display_url|display_src|thumbnail_src)"\s*:\s*"(https?:[^"]+)"/gi;
    while ((match = displayRegex.exec(html)) !== null) {
      try {
        images.add(JSON.parse(`"${match[1]}"`));
      } catch {
        images.add(decodeUnicodeEscapes(match[1]));
      }
    }

    // JSON-LD
    const jsonLdRegex =
      /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1]);
        const imgs = Array.isArray(data.image) ? data.image : [data.image];
        for (const img of imgs) {
          if (typeof img === "string") images.add(img);
          else if (img?.url) images.add(img.url);
        }
      } catch {}
    }
  } catch (err) {
    console.error("Main page error:", err.message);
  }

  return [...images];
}

/**
 * Strategy 4: Use Instagram's oEmbed API (no auth required, returns thumbnail).
 */
async function fetchFromOembed(shortcode) {
  const images = new Set();
  const url = `https://www.instagram.com/p/${shortcode}/`;
  const oembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}&maxwidth=1080`;

  try {
    const response = await fetchUrl(oembedUrl, {
      Accept: "application/json",
    });
    if (response.status !== 200) return [];

    const data = JSON.parse(response.body.toString("utf-8"));
    if (data.thumbnail_url) images.add(data.thumbnail_url);
  } catch (err) {
    console.error("oEmbed error:", err.message);
  }

  return [...images];
}

/**
 * Deduplicate images — keep only the highest resolution variant per base image.
 * Instagram CDN URLs share a path pattern but differ in resolution params.
 */
function deduplicateImages(urls) {
  // Group by the image path identifier (the part that stays the same across resolutions)
  const groups = new Map();

  for (const url of urls) {
    try {
      const parsed = new URL(url);
      // Extract the image filename/path as a key
      const pathParts = parsed.pathname.split("/");
      const filename = pathParts[pathParts.length - 1];
      // Also use a coarser key: strip resolution suffixes
      const baseKey = filename.replace(
        /(_[ns]\d+x\d+|_\d+x\d+)/g,
        ""
      );

      if (!groups.has(baseKey)) {
        groups.set(baseKey, []);
      }
      groups.get(baseKey).push(url);
    } catch {
      // If URL parsing fails, keep it as-is
      if (!groups.has(url)) {
        groups.set(url, [url]);
      }
    }
  }

  // For each group, prefer URLs with larger resolution indicators or longer URLs
  const result = [];
  for (const [, group] of groups) {
    // Sort by URL length descending (longer URLs tend to have more params = higher res)
    // and by presence of resolution indicators
    group.sort((a, b) => {
      const resA = extractResolution(a);
      const resB = extractResolution(b);
      if (resA !== resB) return resB - resA;
      return b.length - a.length;
    });
    result.push(group[0]);
  }

  return result;
}

function extractResolution(url) {
  // Try to extract resolution from URL patterns like 1080x1080 or e35/...
  const match = url.match(/(\d{3,4})x(\d{3,4})/);
  if (match) return parseInt(match[1]) * parseInt(match[2]);
  return 0;
}

// --- API Routes ---

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

  try {
    // Run all strategies in parallel for speed
    const [embedImages, jsonImages, mainImages, oembedImages] =
      await Promise.all([
        fetchFromEmbed(shortcode),
        fetchFromJsonEndpoint(shortcode),
        fetchFromMainPage(shortcode),
        fetchFromOembed(shortcode),
      ]);

    // Merge all results
    const allImages = [
      ...new Set([
        ...jsonImages,
        ...embedImages,
        ...mainImages,
        ...oembedImages,
      ]),
    ];

    if (allImages.length === 0) {
      return res.status(404).json({
        error:
          "No images found. The post may be private, a video-only post, or Instagram may be blocking the request.",
      });
    }

    // Deduplicate similar URLs (different resolutions of same image)
    const images = deduplicateImages(allImages);

    console.log(
      `Found ${images.length} unique images for ${shortcode} (embed: ${embedImages.length}, json: ${jsonImages.length}, main: ${mainImages.length}, oembed: ${oembedImages.length})`
    );

    res.json({ images });
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
    const response = await fetchUrl(url);
    const contentType = response.headers["content-type"] || "image/jpeg";
    res.set("Content-Type", contentType);
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
