import { useCallback, useState } from "react";

/** A failure belongs to the requested resource, including responsive candidates, not the component. */
export function useImageFailure(src?: string | null, srcSet?: string) {
  const identity = JSON.stringify([src, srcSet]);
  const [state, setState] = useState({ identity, failed: false });
  if (state.identity !== identity) setState({ identity, failed: false });
  const onError = useCallback(() => setState({ identity, failed: true }), [identity]);
  const onLoad = useCallback(() => setState({ identity, failed: false }), [identity]);
  // SSR images can finish before React installs its event handlers.
  const ref = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth === 0) onError();
  }, [onError]);
  return { failed: state.identity === identity && state.failed, ref, onError, onLoad };
}
