import * as React from 'react';
import { loadTracking, startTracking, tracking } from './analytics.web';

type Loaded = Awaited<ReturnType<typeof loadTracking>>;

/** The screen capture PostHogProvider runs on native, beside the web app tree. */
function ScreenTracking({ loaded }: { loaded: Loaded }) {
  loaded.useNavigationTracker(undefined, undefined, loaded.tracking ?? undefined);
  return null;
}

/** Web starts analytics after the first screen draws and tracks screens beside the app tree. */
export function TrackingRoot({ children, drawn }: { children: React.ReactNode; drawn: boolean }) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  React.useEffect(() => {
    if (!tracking || !drawn) return;
    startTracking();
    let active = true;
    void loadTracking()
      .then((next) => {
        if (active) setLoaded(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [drawn]);
  return (
    <>
      {children}
      {loaded?.tracking && <ScreenTracking loaded={loaded} />}
    </>
  );
}
