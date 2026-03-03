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
function fetchUrl(url, extraHeaders = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));

    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "https:" ? https : http;

    const defaultHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
    };

    const headers = { ...defaultHeaders, ...extraHeaders };

    const req = transport.get(url, { headers }, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(
          fetchUrl(redirectUrl, extraHeaders, maxRedirects - 1)
        );
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
    });
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
 * Clean up an extracted URL: decode escapes, fix HTML entities, validate.
 */
function sanitizeUrl(rawUrl) {
  let url = rawUrl;
  // Decode unicode escapes
  url = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  // Decode HTML entities
  url = url.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  // Remove backslash-escaped slashes (JSON-in-HTML)
  url = url.replace(/\\\//g, "/");
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

/**
 * Check if a URL is likely a post image (not avatar, icon, etc).
 */
function isPostImage(url) {
  if (!url) return false;
  // Must be from Instagram/Facebook CDN
  if (!url.includes("cdninstagram") && !url.includes("fbcdn")) return false;
  // Skip profile pics and tiny thumbnails
  if (url.includes("s150x150")) return false;
  if (url.includes("s100x100")) return false;
  if (url.includes("s50x50")) return false;
  if (url.includes("44x44")) return false;
  if (url.includes("profile_pic")) return false;
  return true;
}

/**
 * Fetch the embed page and extract images.
 * The embed endpoint is designed for third-party embedding — less restricted.
 */
async function fetchFromEmbed(shortcode) {
  const images = [];
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

  try {
    const response = await fetchUrl(embedUrl, {
      Referer: "https://www.instagram.com/",
    });
    if (response.status !== 200) return [];

    const html = response.body.toString("utf-8");

    // The embed page has a main post image — look for the EmbeddedMediaImage class
    // or the main <img> in the media container
    let match;

    // Look for class="EmbeddedMediaImage" which is the main post image
    const embeddedImgRegex =
      /class="EmbeddedMediaImage"[^>]*src="([^"]+)"/gi;
    while ((match = embeddedImgRegex.exec(html)) !== null) {
      const url = sanitizeUrl(match[1]);
      if (url && isPostImage(url)) images.push(url);
    }

    // Also reversed attribute order
    const embeddedImgRegex2 =
      /src="([^"]+)"[^>]*class="EmbeddedMediaImage"/gi;
    while ((match = embeddedImgRegex2.exec(html)) !== null) {
      const url = sanitizeUrl(match[1]);
      if (url && isPostImage(url)) images.push(url);
    }

    // Look for display_url in embedded script data (most reliable for the actual image)
    const displayUrlRegex =
      /"display_url"\s*:\s*"(https?:[^"]+)"/gi;
    while ((match = displayUrlRegex.exec(html)) !== null) {
      try {
        const url = sanitizeUrl(JSON.parse(`"${match[1]}"`));
        if (url && isPostImage(url)) images.push(url);
      } catch {
        const url = sanitizeUrl(match[1]);
        if (url && isPostImage(url)) images.push(url);
      }
    }

    // If we found nothing yet, look for the main img tag in the embed
    // (the embed usually has just one or a few <img> tags for the post)
    if (images.length === 0) {
      const imgRegex =
        /<img[^>]+src="(https:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]+)"/gi;
      while ((match = imgRegex.exec(html)) !== null) {
        const url = sanitizeUrl(match[1]);
        if (url && isPostImage(url)) images.push(url);
      }
    }
  } catch (err) {
    console.error("Embed fetch error:", err.message);
  }

  return images;
}

/**
 * Use the ?__a=1&__d=dis JSON endpoint (returns structured data when not blocked).
 */
async function fetchFromJsonEndpoint(shortcode) {
  const images = [];
  const jsonUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;

  try {
    const response = await fetchUrl(jsonUrl, {
      "X-IG-App-ID": "936619743392459",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `https://www.instagram.com/p/${shortcode}/`,
      Accept: "application/json",
    });
    if (response.status !== 200) return [];

    let data;
    try {
      data = JSON.parse(response.body.toString("utf-8"));
    } catch {
      return [];
    }

    // items[] format (newer API)
    if (data?.items) {
      for (const item of data.items) {
        if (item.image_versions2?.candidates) {
          const best = item.image_versions2.candidates.reduce((a, b) =>
            (a.width || 0) > (b.width || 0) ? a : b
          );
          if (best?.url) {
            const url = sanitizeUrl(best.url);
            if (url) images.push(url);
          }
        }
        if (item.carousel_media) {
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
        }
      }
    }

    // graphql format
    const media = data?.graphql?.shortcode_media;
    if (media) {
      if (media.display_url) {
        const url = sanitizeUrl(media.display_url);
        if (url) images.push(url);
      }
      if (media.edge_sidecar_to_children?.edges) {
        for (const edge of media.edge_sidecar_to_children.edges) {
          if (edge.node?.display_url) {
            const url = sanitizeUrl(edge.node.display_url);
            if (url) images.push(url);
          }
        }
      }
    }
  } catch (err) {
    console.error("JSON endpoint error:", err.message);
  }

  return images;
}

/**
 * Use Instagram's oEmbed API (always works for public posts, returns 1 thumbnail).
 */
async function fetchFromOembed(shortcode) {
  const images = [];
  const postUrl = `https://www.instagram.com/p/${shortcode}/`;
  const oembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(postUrl)}&maxwidth=1080`;

  try {
    const response = await fetchUrl(oembedUrl, {
      Accept: "application/json",
    });
    if (response.status !== 200) return [];

    const data = JSON.parse(response.body.toString("utf-8"));
    if (data.thumbnail_url) {
      const url = sanitizeUrl(data.thumbnail_url);
      if (url) images.push(url);
    }
  } catch (err) {
    console.error("oEmbed error:", err.message);
  }

  return images;
}

/**
 * Verify a URL actually returns image data (not HTML or empty).
 */
async function verifyImage(url) {
  try {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    return new Promise((resolve) => {
      const req = transport.request(
        url,
        {
          method: "HEAD",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Referer: "https://www.instagram.com/",
            Accept: "image/*,*/*;q=0.8",
          },
        },
        (res) => {
          const ct = res.headers["content-type"] || "";
          const cl = parseInt(res.headers["content-length"] || "0", 10);
          res.resume(); // drain the response
          // Valid if: 200 OK, content-type is image, and size > 5KB (not a placeholder)
          resolve(
            res.statusCode === 200 &&
            ct.startsWith("image/") &&
            (cl === 0 || cl > 5000) // content-length 0 means unknown, that's OK
          );
        }
      );
      req.on("error", () => resolve(false));
      req.setTimeout(8000, () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  } catch {
    return false;
  }
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
    // Run all strategies in parallel
    const [embedImages, jsonImages, oembedImages] = await Promise.all([
      fetchFromEmbed(shortcode),
      fetchFromJsonEndpoint(shortcode),
      fetchFromOembed(shortcode),
    ]);

    console.log(
      `Raw results for ${shortcode}: embed=${embedImages.length}, json=${jsonImages.length}, oembed=${oembedImages.length}`
    );

    // Merge and deduplicate
    const seen = new Set();
    const uniqueImages = [];
    // Prioritize JSON (highest quality) > embed > oembed
    for (const img of [...jsonImages, ...embedImages, ...oembedImages]) {
      if (!seen.has(img)) {
        seen.add(img);
        uniqueImages.push(img);
      }
    }

    if (uniqueImages.length === 0) {
      return res.status(404).json({
        error:
          "No images found. The post may be private, a video-only post, or Instagram may be blocking the request.",
      });
    }

    // Verify images actually load (HEAD request) — filter out broken ones
    const verifyResults = await Promise.all(
      uniqueImages.map(async (imgUrl) => {
        const valid = await verifyImage(imgUrl);
        if (!valid) console.log(`  Filtered out (invalid): ${imgUrl.substring(0, 80)}...`);
        return { url: imgUrl, valid };
      })
    );

    const validImages = verifyResults
      .filter((r) => r.valid)
      .map((r) => r.url);

    console.log(
      `Verified: ${validImages.length}/${uniqueImages.length} images valid for ${shortcode}`
    );

    if (validImages.length === 0) {
      // If verification filtered everything, return unverified as fallback
      // (HEAD might be blocked while GET works)
      console.log("All images failed HEAD check, returning unverified as fallback");
      return res.json({ images: uniqueImages.slice(0, 10) });
    }

    res.json({ images: validImages });
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
    const response = await fetchUrl(url, {
      Referer: "https://www.instagram.com/",
      Origin: "https://www.instagram.com",
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    });

    const contentType = response.headers["content-type"] || "image/jpeg";

    // If the CDN returned HTML or a tiny response, it's not an image
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
