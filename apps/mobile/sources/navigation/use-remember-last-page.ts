import { useEffect } from 'react';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { rememberLastPage } from './last-page';

export function useRememberLastPage(): void {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const encoded = JSON.stringify(params);
  useEffect(() => {
    let current = true;
    void rememberLastPage(pathname, JSON.parse(encoded), () => current);
    return () => { current = false; };
  }, [pathname, encoded]);
}
