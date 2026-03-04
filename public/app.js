const urlForm = document.getElementById("url-form");
const urlInput = document.getElementById("url-input");
const fetchBtn = document.getElementById("fetch-btn");
const btnText = fetchBtn.querySelector(".btn-text");
const btnSpinner = fetchBtn.querySelector(".btn-spinner");
const errorMsg = document.getElementById("error-msg");
const results = document.getElementById("results");
const imageCount = document.getElementById("image-count");
const imageGrid = document.getElementById("image-grid");
const downloadAllBtn = document.getElementById("download-all-btn");
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxPrev = document.getElementById("lightbox-prev");
const lightboxNext = document.getElementById("lightbox-next");
const lightboxCounter = document.getElementById("lightbox-counter");
const lightboxDownload = document.getElementById("lightbox-download");
const loadingSkeleton = document.getElementById("loading-skeleton");
const toast = document.getElementById("toast");

let currentImages = [];
let lightboxIndex = 0;
let isFetching = false;

// --- Instagram URL detection ---
const instaRegex = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+/i;

function isInstagramUrl(text) {
  return instaRegex.test(text.trim());
}

// --- Auto-fetch on paste ---
urlInput.addEventListener("paste", (e) => {
  // Use setTimeout so the input value is updated after paste
  setTimeout(() => {
    const text = urlInput.value.trim();
    if (isInstagramUrl(text) && !isFetching) {
      fetchImages(text);
    }
  }, 50);
});

// --- Form Submit ---
urlForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url || isFetching) return;
  fetchImages(url);
});

async function fetchImages(url) {
  if (isFetching) return;

  setLoading(true);
  hideError();
  results.classList.add("hidden");
  loadingSkeleton.classList.remove("hidden");

  try {
    const res = await fetch("/api/fetch-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || "Something went wrong.");
      return;
    }

    currentImages = data.images;
    renderImages(currentImages);
  } catch (err) {
    showError("Network error. Please check your connection and try again.");
  } finally {
    setLoading(false);
    loadingSkeleton.classList.add("hidden");
  }
}

// --- Render Images ---
function renderImages(images) {
  imageGrid.innerHTML = "";
  imageCount.textContent = `${images.length} image${images.length !== 1 ? "s" : ""} found`;

  images.forEach((originalUrl, index) => {
    const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(originalUrl)}`;

    const card = document.createElement("div");
    card.className = "image-card";

    const img = document.createElement("img");
    img.src = proxyUrl;
    img.alt = `Image ${index + 1}`;
    img.loading = "lazy";
    img.draggable = true;

    // Hide card if the image fails to load
    img.addEventListener("error", () => {
      card.remove();
      currentImages = currentImages.filter((_, i) => i !== index);
      updateImageCount();
    });

    // Click image to open lightbox
    img.addEventListener("click", () => openLightbox(index));

    // Drag-and-drop
    img.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/uri-list", proxyUrl);
      e.dataTransfer.setData("text/plain", proxyUrl);
      e.dataTransfer.effectAllowed = "copy";
    });

    // Overlay
    const overlay = document.createElement("div");
    overlay.className = "card-overlay";

    // Badge (image number)
    const badge = document.createElement("div");
    badge.className = "card-badge";
    badge.textContent = `${index + 1} / ${images.length}`;

    // Actions
    const actions = document.createElement("div");
    actions.className = "card-actions";

    const dlBtn = document.createElement("button");
    dlBtn.className = "card-btn-download";
    dlBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download`;
    dlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadImage(proxyUrl, index);
    });

    const viewBtn = document.createElement("button");
    viewBtn.className = "card-btn-view";
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openLightbox(index);
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "card-btn-copy";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyToClipboard(originalUrl);
    });

    actions.appendChild(dlBtn);
    actions.appendChild(viewBtn);
    actions.appendChild(copyBtn);

    overlay.appendChild(badge);
    overlay.appendChild(actions);

    card.appendChild(img);
    card.appendChild(overlay);
    imageGrid.appendChild(card);
  });

  results.classList.remove("hidden");
}

// --- Copy to clipboard ---
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(
    () => showToast("Link copied to clipboard"),
    () => showToast("Failed to copy")
  );
}

// --- Toast ---
let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  // Force reflow for animation
  toast.offsetHeight;
  toast.classList.add("show");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.classList.add("hidden"), 300);
  }, 2000);
}

// --- Download ---
function downloadImage(url, index) {
  const a = document.createElement("a");
  a.href = url;
  a.download = `instagram-image-${index + 1}.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

downloadAllBtn.addEventListener("click", () => {
  currentImages.forEach((originalUrl, index) => {
    const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(originalUrl)}`;
    setTimeout(() => downloadImage(proxyUrl, index), index * 300);
  });
  showToast(`Downloading ${currentImages.length} images...`);
});

// --- Lightbox ---
function openLightbox(index) {
  lightboxIndex = index;
  updateLightbox();
  lightbox.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  lightbox.classList.add("hidden");
  document.body.style.overflow = "";
}

function updateLightbox() {
  const originalUrl = currentImages[lightboxIndex];
  const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(originalUrl)}`;
  lightboxImg.src = proxyUrl;
  lightboxCounter.textContent = `${lightboxIndex + 1} / ${currentImages.length}`;

  lightboxPrev.style.visibility = lightboxIndex > 0 ? "visible" : "hidden";
  lightboxNext.style.visibility =
    lightboxIndex < currentImages.length - 1 ? "visible" : "hidden";
}

lightboxClose.addEventListener("click", closeLightbox);

lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) closeLightbox();
});

lightboxPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  if (lightboxIndex > 0) {
    lightboxIndex--;
    updateLightbox();
  }
});

lightboxNext.addEventListener("click", (e) => {
  e.stopPropagation();
  if (lightboxIndex < currentImages.length - 1) {
    lightboxIndex++;
    updateLightbox();
  }
});

lightboxDownload.addEventListener("click", (e) => {
  e.stopPropagation();
  const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(currentImages[lightboxIndex])}`;
  downloadImage(proxyUrl, lightboxIndex);
});

// Keyboard nav
document.addEventListener("keydown", (e) => {
  if (lightbox.classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft" && lightboxIndex > 0) {
    lightboxIndex--;
    updateLightbox();
  }
  if (e.key === "ArrowRight" && lightboxIndex < currentImages.length - 1) {
    lightboxIndex++;
    updateLightbox();
  }
});

// --- UI Helpers ---
function setLoading(loading) {
  isFetching = loading;
  fetchBtn.disabled = loading;
  btnText.textContent = loading ? "Fetching..." : "Download";
  btnSpinner.classList.toggle("hidden", !loading);
}

function updateImageCount() {
  const cards = imageGrid.querySelectorAll(".image-card");
  if (cards.length === 0) {
    results.classList.add("hidden");
    showError("All images failed to load. Instagram may be blocking requests.");
  } else {
    imageCount.textContent = `${cards.length} image${cards.length !== 1 ? "s" : ""} loaded`;
  }
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove("hidden");
}

function hideError() {
  errorMsg.classList.add("hidden");
}

// Paste button
const pasteBtn = document.getElementById("paste-btn");
pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text;
    urlInput.focus();
    // Auto-fetch if it's an Instagram URL
    if (isInstagramUrl(text) && !isFetching) {
      fetchImages(text);
    }
  } catch {
    urlInput.value = "";
    urlInput.focus();
  }
});

// --- Session panel ---
const sessionToggle = document.getElementById("session-toggle");
const sessionForm = document.getElementById("session-form");
const sessionInput = document.getElementById("session-input");
const sessionSave = document.getElementById("session-save");
const sessionClear = document.getElementById("session-clear");
const sessionIndicator = document.getElementById("session-indicator");

sessionToggle.addEventListener("click", () => {
  sessionForm.classList.toggle("hidden");
});

function setSessionIndicator(active) {
  sessionIndicator.className = active
    ? "indicator indicator-on"
    : "indicator indicator-off";
}

sessionSave.addEventListener("click", async () => {
  const sessionId = sessionInput.value.trim();
  if (!sessionId) return;
  try {
    const res = await fetch("/api/set-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    if (data.hasSession) {
      setSessionIndicator(true);
      sessionInput.value = "";
      sessionForm.classList.add("hidden");
      showToast("Session saved — carousel posts enabled");
    }
  } catch {}
});

sessionClear.addEventListener("click", async () => {
  try {
    await fetch("/api/set-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "" }),
    });
    setSessionIndicator(false);
    sessionInput.value = "";
    showToast("Session cleared");
  } catch {}
});

// Check session status on load
(async () => {
  try {
    const res = await fetch("/api/session-status");
    const data = await res.json();
    setSessionIndicator(data.hasSession);
  } catch {}
})();
