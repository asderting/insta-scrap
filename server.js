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
 * Fetch a URL and follow redirects, returning the final response body.
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
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          ...headers,
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return resolve(fetchUrl(res.headers.location, headers, maxRedirects - 1));
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
 * Extract image URLs from Instagram post page HTML.
 * Instagram embeds image data in multiple ways — we try several strategies.
 */
function extractImages(html, postUrl) {
  const images = new Set();

  // Strategy 1: Look for og:image meta tags (always present, at least the first image)
  const ogImageRegex =
    /<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/gi;
  let match;
  while ((match = ogImageRegex.exec(html)) !== null) {
    images.add(match[1]);
  }

  // Also check reversed attribute order
  const ogImageRegex2 =
    /<meta\s+content="([^"]+)"\s+(?:property|name)="og:image"/gi;
  while ((match = ogImageRegex2.exec(html)) !== null) {
    images.add(match[1]);
  }

  // Strategy 2: Look in JSON-LD structured data
  const jsonLdRegex =
    /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data.image) {
        const imgs = Array.isArray(data.image) ? data.image : [data.image];
        for (const img of imgs) {
          if (typeof img === "string") images.add(img);
          else if (img.url) images.add(img.url);
        }
      }
      // Check for ImageObject in associatedMedia
      if (data.associatedMedia) {
        const media = Array.isArray(data.associatedMedia)
          ? data.associatedMedia
          : [data.associatedMedia];
        for (const m of media) {
          if (m.url) images.add(m.url);
          if (m.thumbnailUrl) images.add(m.thumbnailUrl);
        }
      }
    } catch {}
  }

  // Strategy 3: Parse the shared data JSON embedded in the page
  const sharedDataRegex =
    /window\._sharedData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i;
  const sharedDataMatch = sharedDataRegex.exec(html);
  if (sharedDataMatch) {
    try {
      const sharedData = JSON.parse(sharedDataMatch[1]);
      extractFromSharedData(sharedData, images);
    } catch {}
  }

  // Strategy 4: Look for additional data JSON
  const additionalDataRegex =
    /window\.__additionalDataLoaded\s*\(\s*['"][^'"]*['"]\s*,\s*(\{[\s\S]*?\})\s*\)\s*;/i;
  const additionalMatch = additionalDataRegex.exec(html);
  if (additionalMatch) {
    try {
      const additionalData = JSON.parse(additionalMatch[1]);
      extractFromSharedData(additionalData, images);
    } catch {}
  }

  // Strategy 5: Look for high-res image URLs in any script or data attribute
  const highResRegex =
    /"(?:display_url|display_src|thumbnail_src)"\s*:\s*"(https?:[^"]+)"/gi;
  while ((match = highResRegex.exec(html)) !== null) {
    try {
      const url = JSON.parse(`"${match[1]}"`); // decode unicode escapes
      images.add(url);
    } catch {
      images.add(match[1]);
    }
  }

  // Strategy 6: Find image candidates in generic img tags with Instagram CDN
  const imgTagRegex =
    /<img[^>]+src="(https:\/\/(?:scontent|instagram)[^"]+)"/gi;
  while ((match = imgTagRegex.exec(html)) !== null) {
    const src = match[1];
    // Filter out tiny icons/avatars (profile pics are usually small)
    if (!src.includes("150x150") && !src.includes("s150x150")) {
      images.add(src);
    }
  }

  return [...images];
}

function extractFromSharedData(data, images) {
  // Navigate the shared data structure to find media
  try {
    const postPage =
      data?.entry_data?.PostPage || data?.entry_data?.postPage;
    if (postPage) {
      for (const page of postPage) {
        const media = page?.graphql?.shortcode_media || page?.media;
        if (media) extractFromMedia(media, images);
      }
    }

    // Direct items structure
    if (data?.items) {
      for (const item of data.items) {
        if (item.image_versions2) {
          for (const candidate of item.image_versions2.candidates || []) {
            if (candidate.url) images.add(candidate.url);
          }
        }
        if (item.carousel_media) {
          for (const cm of item.carousel_media) {
            if (cm.image_versions2) {
              for (const candidate of cm.image_versions2.candidates || []) {
                if (candidate.url) images.add(candidate.url);
              }
            }
          }
        }
      }
    }
  } catch {}
}

function extractFromMedia(media, images) {
  if (media.display_url) images.add(media.display_url);
  if (media.display_src) images.add(media.display_src);
  if (media.thumbnail_src) images.add(media.thumbnail_src);

  // Carousel (multiple images)
  if (media.edge_sidecar_to_children) {
    for (const edge of media.edge_sidecar_to_children.edges || []) {
      const node = edge.node;
      if (node) {
        if (node.display_url) images.add(node.display_url);
        if (node.display_src) images.add(node.display_src);
      }
    }
  }
}

// --- API Routes ---

/**
 * POST /api/fetch-images
 * Body: { url: "https://www.instagram.com/p/XXXXX/" }
 * Returns: { images: ["url1", "url2", ...] }
 */
app.post("/api/fetch-images", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  // Validate it looks like an Instagram URL
  const instaRegex =
    /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+/i;
  if (!instaRegex.test(url)) {
    return res.status(400).json({
      error:
        "Invalid Instagram URL. Please provide a link like: https://www.instagram.com/p/XXXXX/",
    });
  }

  try {
    // Ensure the URL ends with a slash for consistency
    let fetchUrl_ = url.replace(/\/?$/, "/");

    const response = await fetchUrl(fetchUrl_);

    if (response.status !== 200) {
      return res.status(502).json({
        error: `Instagram returned status ${response.status}. The post may be private or unavailable.`,
      });
    }

    const html = response.body.toString("utf-8");
    const images = extractImages(html, url);

    if (images.length === 0) {
      return res.status(404).json({
        error:
          "No images found. The post may be private, a video-only post, or Instagram may be blocking the request.",
      });
    }

    res.json({ images });
  } catch (err) {
    console.error("Fetch error:", err.message);
    res.status(500).json({ error: `Failed to fetch post: ${err.message}` });
  }
});

/**
 * GET /api/proxy-image?url=...
 * Proxies an image from Instagram CDN to avoid CORS issues
 * and enable drag-and-drop / download from the browser.
 */
app.get("/api/proxy-image", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "URL parameter is required" });
  }

  // Only allow proxying from Instagram/Facebook CDN domains
  try {
    const parsed = new URL(url);
    const allowedHosts = [
      "scontent.cdninstagram.com",
      "instagram.com",
      "cdninstagram.com",
    ];
    const isAllowed = allowedHosts.some(
      (host) =>
        parsed.hostname === host || parsed.hostname.endsWith("." + host)
    );
    if (!isAllowed) {
      return res
        .status(403)
        .json({ error: "Only Instagram CDN URLs are allowed" });
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
