import React, { useState } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { MediaThumbs } from "../../apps/web/app/features/feed/parts";
import { MediaGallery } from "../../apps/web/app/features/item/MediaGallery";
import { SourceAvatar } from "../../apps/web/app/components/ui/SourceAvatar";
import { useImageFailure } from "../../apps/web/app/lib/use-image-failure";
const good = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="red"/></svg>');
const bad = "/missing-image.png";
function EarlyImage() {
  const { failed, ...state } = useImageFailure(bad);
  return failed ? <span>早期失败已识别</span> : <img {...state} src={bad} alt="early" />;
}
function App() {
  const [recovered, setRecovered] = useState(false);
  const media = [{ kind: "image" as const, url: good, srcSet: recovered ? `${good} 1x` : `${bad} 1x`, alt: "responsive", width: 24, height: 16 }];
  return <><button onClick={() => setRecovered(!recovered)}>切换图片资源</button>
    <section id="thumb"><MediaThumbs media={media} /></section>
    <section id="gallery"><MediaGallery media={media} postUrl="/original" /></section>
    <section id="avatar"><SourceAvatar name="测试" avatarUrl={good} avatarSrcSet={recovered ? `${good} 1x` : `${bad} 1x`} /></section>
    <section id="healthy"><MediaThumbs media={[{ kind: "video", url: good, width: 24, height: 16 }]} /></section>
  </>;
}
const early = document.querySelector<HTMLImageElement>("#early img")!;
if (!early.complete) await new Promise((resolve) => { early.onload = resolve; early.onerror = resolve; });
hydrateRoot(document.getElementById("early")!, <EarlyImage />);
createRoot(document.getElementById("root")!).render(<App />);
