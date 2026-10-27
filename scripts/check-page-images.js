// Run in the current browser page with: agent-browser eval --stdin < scripts/check-page-images.js
// Only inspects already requested images in/above the viewport. Scroll naturally and run again.
(async () => {
  const images = [...document.images].filter((image) => {
    const box = image.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.top < innerHeight && box.bottom > 0;
  });
  const results = await Promise.all(images.map(async (image) => {
    const source = image.currentSrc || image.src;
    const url = new URL(source, location.href);
    const media = url.pathname === "/api/img-proxy";
    let decoded = false;
    let timeout;
    try {
      await Promise.race([image.decode(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("timeout")), 10000); })]);
      decoded = image.naturalWidth > 0;
    } catch {} finally { clearTimeout(timeout); }
    return { kind: media ? "proxied-image" : "other-image", mode: media ? url.searchParams.get("mode") : null,
      decoded, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight,
      // Never return signed source URLs or source authentication queries.
      location: { top: Math.round(image.getBoundingClientRect().top), left: Math.round(image.getBoundingClientRect().left) } };
  }));
  const fallbacks = [...document.querySelectorAll("[data-image-fallback]")].filter((element) => {
    const box = element.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0;
  }).map((element) => ({ kind: element.getAttribute("data-image-fallback"), text: element.textContent }));
  return { path: location.pathname, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, images: results, fallbacks,
    decoded: results.filter((result) => result.decoded).length, failed: results.filter((result) => !result.decoded).length };
})()
