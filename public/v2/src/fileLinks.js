(function(root, factory){
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FileLinkUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function(){
  function decodePathish(value){
    try { return decodeURIComponent(value); } catch { return value; }
  }

  function trimTrailingSlash(value){
    return String(value || '').replace(/\/+$/, '') || '/';
  }

  function stripQueryAndHash(value){
    const hash = value.indexOf('#');
    const noHash = hash >= 0 ? value.slice(0, hash) : value;
    const query = noHash.indexOf('?');
    return query >= 0 ? noHash.slice(0, query) : noHash;
  }

  function splitLineSuffix(filePath){
    const value = String(filePath || '');
    const columnMatch = value.match(/^(.*):([1-9]\d*):([1-9]\d*)$/);
    if (columnMatch) {
      return {
        filePath: columnMatch[1],
        line: Number(columnMatch[2]),
        column: Number(columnMatch[3]),
      };
    }
    const match = value.match(/^(.*):([1-9]\d*)$/);
    if (!match) return { filePath, line: null, column: null };
    return {
      filePath: match[1],
      line: Number(match[2]),
      column: null,
    };
  }

  function isHttpLike(value){
    return /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^file:/i.test(value);
  }

  function pathFromHref(rawHref){
    if (!rawHref || typeof rawHref !== 'string') return null;
    const href = rawHref.trim();
    if (!href || href[0] === '#' || isHttpLike(href)) return null;

    if (/^file:/i.test(href)) {
      try {
        return decodePathish(stripQueryAndHash(new URL(href).pathname));
      } catch {
        return null;
      }
    }

    if (href.startsWith('//')) return null;
    if (!href.startsWith('/')) return null;
    return decodePathish(stripQueryAndHash(href));
  }

  function hasParentTraversal(filePath){
    return String(filePath || '').split('/').some(part => part === '..');
  }

  function resolveLocalFileHref(rawHref, workspacePath){
    const workspaceRoot = trimTrailingSlash(workspacePath);
    const hrefPath = pathFromHref(rawHref);
    if (!hrefPath || hasParentTraversal(hrefPath)) return null;
    const parsed = splitLineSuffix(hrefPath);
    if (!parsed.filePath || !parsed.filePath.startsWith('/')) return null;

    const filePath = trimTrailingSlash(parsed.filePath);
    const inWorkspace = filePath === workspaceRoot || filePath.startsWith(workspaceRoot + '/');
    if (!inWorkspace) return null;
    return {
      filePath,
      line: parsed.line,
      column: parsed.column,
    };
  }

  function resolveConversationArtifactHref(rawHref, convId){
    const id = String(convId || '').trim();
    if (!id) return null;
    const hrefPath = pathFromHref(rawHref);
    if (!hrefPath || hasParentTraversal(hrefPath)) return null;
    const parsed = splitLineSuffix(hrefPath);
    if (!parsed.filePath || !parsed.filePath.startsWith('/')) return null;

    const marker = '/data/chat/artifacts/' + id + '/';
    const markerIndex = parsed.filePath.indexOf(marker);
    if (markerIndex < 0) return null;

    const filename = parsed.filePath.slice(markerIndex + marker.length);
    if (!filename || filename.includes('/') || filename.includes('\\')) return null;

    return {
      filePath: parsed.filePath,
      filename,
      line: parsed.line,
      column: parsed.column,
    };
  }

  return {
    resolveLocalFileHref,
    resolveConversationArtifactHref,
    _private: {
      pathFromHref,
      splitLineSuffix,
      trimTrailingSlash,
    },
  };
});
