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

let currentImages = [];
let lightboxIndex = 0;

// --- Form Submit ---
urlForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  setLoading(true);
  hideError();
  results.classList.add("hidden");

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
  }
});

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
    img.alt = `Post image ${index + 1}`;
    img.loading = "lazy";
    img.draggable = true;

    // Enable drag-and-drop as a file
    img.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/uri-list", proxyUrl);
      e.dataTransfer.setData("text/plain", proxyUrl);
      e.dataTransfer.effectAllowed = "copy";
    });

    const dragHint = document.createElement("div");
    dragHint.className = "drag-hint";
    dragHint.textContent = "Drag to use";

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const viewBtn = document.createElement("button");
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openLightbox(index);
    });

    const dlBtn = document.createElement("button");
    dlBtn.textContent = "Download";
    dlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadImage(proxyUrl, index);
    });

    actions.appendChild(viewBtn);
    actions.appendChild(dlBtn);

    card.appendChild(img);
    card.appendChild(dragHint);
    card.appendChild(actions);

    // Click card to open lightbox
    card.addEventListener("click", () => openLightbox(index));

    imageGrid.appendChild(card);
  });

  results.classList.remove("hidden");
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

// Keyboard navigation for lightbox
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
  fetchBtn.disabled = loading;
  btnText.textContent = loading ? "Fetching..." : "Fetch Images";
  btnSpinner.classList.toggle("hidden", !loading);
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
  } catch {
    // Fallback: focus the input so user can Ctrl+V manually
    urlInput.value = "";
    urlInput.focus();
  }
});
