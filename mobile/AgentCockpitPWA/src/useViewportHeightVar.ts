import { useEffect } from 'react';

export function useViewportHeightVar() {
  useEffect(() => {
    const root = document.documentElement;
    let rafID = 0;
    let focusTimer: number | undefined;
    let lastViewportMetrics = '';

    const update = () => {
      const viewport = window.visualViewport;
      const height = Math.max(1, Math.round(viewport?.height || window.innerHeight));
      const width = Math.max(1, Math.round(viewport?.width || window.innerWidth));
      const top = Math.round(viewport?.offsetTop || 0);
      const left = Math.round(viewport?.offsetLeft || 0);
      const metrics = `${height}:${width}:${top}:${left}`;
      if (metrics !== lastViewportMetrics) {
        root.style.setProperty('--app-height', `${height}px`);
        root.style.setProperty('--app-width', `${width}px`);
        root.style.setProperty('--app-top', `${top}px`);
        root.style.setProperty('--app-left', `${left}px`);
        lastViewportMetrics = metrics;
      }
      if (root.scrollLeft !== 0) root.scrollLeft = 0;
      if (root.scrollTop !== 0) root.scrollTop = 0;
      if (document.body.scrollLeft !== 0) document.body.scrollLeft = 0;
      if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    const scheduleUpdate = () => {
      if (rafID) {
        window.cancelAnimationFrame(rafID);
      }
      rafID = window.requestAnimationFrame(() => {
        rafID = 0;
        update();
      });
    };

    const scheduleFocusUpdate = () => {
      scheduleUpdate();
      if (focusTimer !== undefined) {
        window.clearTimeout(focusTimer);
      }
      focusTimer = window.setTimeout(scheduleUpdate, 120);
    };

    update();
    window.addEventListener('scroll', scheduleUpdate);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);
    window.visualViewport?.addEventListener('resize', scheduleUpdate);
    window.visualViewport?.addEventListener('scroll', scheduleUpdate);
    document.addEventListener('focusin', scheduleFocusUpdate);
    document.addEventListener('focusout', scheduleFocusUpdate);
    return () => {
      if (rafID) {
        window.cancelAnimationFrame(rafID);
      }
      if (focusTimer !== undefined) {
        window.clearTimeout(focusTimer);
      }
      window.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
      window.visualViewport?.removeEventListener('resize', scheduleUpdate);
      window.visualViewport?.removeEventListener('scroll', scheduleUpdate);
      document.removeEventListener('focusin', scheduleFocusUpdate);
      document.removeEventListener('focusout', scheduleFocusUpdate);
    };
  }, []);
}
