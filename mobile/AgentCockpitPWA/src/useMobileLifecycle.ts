import { useEffect, useRef } from 'react';

export function useVisibleStreamResume(resume: () => void) {
  const resumeRef = useRef(resume);
  resumeRef.current = resume;

  useEffect(() => {
    const resumeVisibleStream = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      resumeRef.current();
    };
    window.addEventListener('focus', resumeVisibleStream);
    window.addEventListener('online', resumeVisibleStream);
    document.addEventListener('visibilitychange', resumeVisibleStream);
    return () => {
      window.removeEventListener('focus', resumeVisibleStream);
      window.removeEventListener('online', resumeVisibleStream);
      document.removeEventListener('visibilitychange', resumeVisibleStream);
    };
  }, []);
}

export function useVisibleIntervalRefresh(enabled: boolean, refresh: () => void, intervalMs: number) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const refreshLatest = () => refreshRef.current();
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshLatest();
      }
    };
    const timer = window.setInterval(refreshLatest, intervalMs);
    window.addEventListener('focus', refreshLatest);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshLatest);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [enabled, intervalMs]);
}
