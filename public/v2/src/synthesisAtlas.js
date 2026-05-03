/* global window */

(function(){
  const STOP_WORDS = new Set([
    'about', 'after', 'agent', 'agents', 'also', 'and', 'are', 'base', 'between',
    'browser', 'can', 'code', 'data', 'document', 'documents', 'each', 'entry',
    'file', 'files', 'from', 'has', 'have', 'into', 'knowledge', 'more', 'page',
    'pages', 'that', 'the', 'their', 'this', 'through', 'topic', 'topics', 'use',
    'uses', 'using', 'when', 'with', 'work', 'workspace',
  ]);

  const CONFIDENCE_WEIGHT = {
    extracted: 1.3,
    inferred: 1,
    speculative: 0.65,
    default: 0.85,
  };
  const ACRONYMS = new Set(['ai', 'api', 'aws', 'bmw', 'cli', 'crm', 'css', 'db', 'html', 'http', 'kb', 'llm', 'mcp', 'pdf', 'pptx', 'sdk', 'ui', 'url', 'ws']);

  function safeText(value){
    return String(value == null ? '' : value);
  }

  function normalizeTopic(topic){
    const topicId = safeText(topic && topic.topicId).trim();
    return {
      topicId,
      title: safeText(topic && topic.title).trim() || topicId,
      summary: safeText(topic && topic.summary).trim(),
      entryCount: Number(topic && topic.entryCount) || 0,
      connectionCount: Number(topic && topic.connectionCount) || 0,
      isGodNode: !!(topic && topic.isGodNode),
    };
  }

  function normalizeConnection(connection){
    const sourceTopic = safeText(connection && connection.sourceTopic).trim();
    const targetTopic = safeText(connection && connection.targetTopic).trim();
    return {
      sourceTopic,
      targetTopic,
      relationship: safeText(connection && connection.relationship).trim(),
      confidence: safeText(connection && connection.confidence).trim().toLowerCase() || 'default',
    };
  }

  function edgeKey(source, target){
    return source < target ? `${source}::${target}` : `${target}::${source}`;
  }

  function buildModel(topicsInput, connectionsInput){
    const topics = (Array.isArray(topicsInput) ? topicsInput : [])
      .map(normalizeTopic)
      .filter((topic) => topic.topicId);
    const topicIds = new Set(topics.map((topic) => topic.topicId));
    const topicsById = new Map(topics.map((topic) => [topic.topicId, topic]));
    const adjacency = new Map(topics.map((topic) => [topic.topicId, new Set()]));
    const degree = new Map(topics.map((topic) => [topic.topicId, 0]));
    const edges = [];
    const seen = new Set();

    for (const raw of Array.isArray(connectionsInput) ? connectionsInput : []) {
      const connection = normalizeConnection(raw);
      if (!connection.sourceTopic || !connection.targetTopic) continue;
      if (connection.sourceTopic === connection.targetTopic) continue;
      if (!topicIds.has(connection.sourceTopic) || !topicIds.has(connection.targetTopic)) continue;
      const key = edgeKey(connection.sourceTopic, connection.targetTopic);
      if (seen.has(key)) continue;
      seen.add(key);
      const edge = { ...connection, edgeId: key };
      edges.push(edge);
      adjacency.get(edge.sourceTopic).add(edge.targetTopic);
      adjacency.get(edge.targetTopic).add(edge.sourceTopic);
      degree.set(edge.sourceTopic, (degree.get(edge.sourceTopic) || 0) + 1);
      degree.set(edge.targetTopic, (degree.get(edge.targetTopic) || 0) + 1);
    }

    return { topics, topicsById, edges, adjacency, degree };
  }

  function topicWeight(topic, model){
    const degree = model.degree.get(topic.topicId) || 0;
    return Math.max(1, topic.entryCount) * 2 + degree * 3 + (topic.isGodNode ? 8 : 0);
  }

  function compareTopics(model){
    return (a, b) => {
      const ta = typeof a === 'string' ? model.topicsById.get(a) : a;
      const tb = typeof b === 'string' ? model.topicsById.get(b) : b;
      const wa = ta ? topicWeight(ta, model) : 0;
      const wb = tb ? topicWeight(tb, model) : 0;
      if (wb !== wa) return wb - wa;
      const titleSort = safeText(ta && ta.title).localeCompare(safeText(tb && tb.title));
      return titleSort || safeText(ta && ta.topicId).localeCompare(safeText(tb && tb.topicId));
    };
  }

  function detectHubTopics(model){
    const hubs = new Set();
    const avgDegree = model.topics.length ? (model.edges.length * 2) / model.topics.length : 0;
    const threshold = Math.max(6, Math.ceil(Math.sqrt(Math.max(1, model.topics.length)) * 1.4), avgDegree * 2.5);
    for (const topic of model.topics) {
      const degree = model.degree.get(topic.topicId) || 0;
      if (topic.isGodNode || degree >= threshold) hubs.add(topic.topicId);
    }
    return hubs;
  }

  function sharedNeighborCount(source, target, model){
    const sourceNeighbors = model.adjacency.get(source) || new Set();
    const targetNeighbors = model.adjacency.get(target) || new Set();
    let count = 0;
    for (const neighbor of sourceNeighbors) {
      if (neighbor !== target && targetNeighbors.has(neighbor)) count += 1;
    }
    return count;
  }

  function shouldKeepClusterEdge(edge, model, hubs){
    if (hubs.has(edge.sourceTopic) || hubs.has(edge.targetTopic)) return false;
    const sourceDegree = model.degree.get(edge.sourceTopic) || 0;
    const targetDegree = model.degree.get(edge.targetTopic) || 0;
    if (sourceDegree <= 1 || targetDegree <= 1) return true;
    if (sharedNeighborCount(edge.sourceTopic, edge.targetTopic, model) > 0) return true;
    return edge.confidence === 'extracted' && Math.min(sourceDegree, targetDegree) <= 2;
  }

  function tokenize(text){
    return safeText(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
  }

  function titleCase(value){
    return safeText(value)
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => ACRONYMS.has(part.toLowerCase()) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function deriveClusterTitle(topics, fallback){
    if (!topics.length) return fallback;
    const counts = new Map();
    for (const topic of topics) {
      const seen = new Set(tokenize(`${topic.title} ${topic.summary || ''}`));
      for (const token of seen) counts.set(token, (counts.get(token) || 0) + 1);
    }
    const tokens = Array.from(counts.entries())
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([token]) => token);
    if (tokens.length) return `${titleCase(tokens.join(' + '))} Area`;
    return topics[0].title || fallback;
  }

  function clusterSummary(topics){
    const topSummary = topics.find((topic) => topic.summary);
    return topSummary && topSummary.summary ? topSummary.summary : '';
  }

  function componentIds(seed, graph, seen, sortIds){
    const queue = [seed];
    const ids = [];
    seen.add(seed);
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i];
      ids.push(id);
      const neighbors = Array.from(graph.get(id) || []).sort(sortIds);
      for (const neighbor of neighbors) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    ids.sort(sortIds);
    return ids;
  }

  function makeCluster(id, type, topicIds, model, title){
    const topics = topicIds.map((topicId) => model.topicsById.get(topicId)).filter(Boolean).sort(compareTopics(model));
    const entryCount = topics.reduce((sum, topic) => sum + (topic.entryCount || 0), 0);
    const connectionCount = topics.reduce((sum, topic) => sum + (model.degree.get(topic.topicId) || 0), 0);
    return {
      clusterId: id,
      type,
      title: title || deriveClusterTitle(topics, type === 'loose' ? 'Loose Topics' : 'Topic Area'),
      summary: clusterSummary(topics),
      topicIds: topics.map((topic) => topic.topicId),
      topics,
      representativeTopics: topics.slice(0, 6),
      entryCount,
      connectionCount,
      weight: entryCount * 2 + connectionCount,
      tone: 0,
      bridges: [],
    };
  }

  function buildClusters(model){
    const hubs = detectHubTopics(model);
    const sortIds = compareTopics(model);
    const clusterGraph = new Map(model.topics.map((topic) => [topic.topicId, new Set()]));

    for (const edge of model.edges) {
      if (!shouldKeepClusterEdge(edge, model, hubs)) continue;
      clusterGraph.get(edge.sourceTopic).add(edge.targetTopic);
      clusterGraph.get(edge.targetTopic).add(edge.sourceTopic);
    }

    const seen = new Set();
    const clusters = [];
    const loose = [];

    const nonHubIds = model.topics
      .map((topic) => topic.topicId)
      .filter((topicId) => !hubs.has(topicId))
      .sort(sortIds);

    for (const topicId of nonHubIds) {
      if (seen.has(topicId)) continue;
      const ids = componentIds(topicId, clusterGraph, seen, sortIds);
      if (ids.length >= 2) clusters.push(makeCluster(`area-${clusters.length + 1}`, 'area', ids, model));
      else loose.push(ids[0]);
    }

    if (hubs.size) {
      const hubIds = Array.from(hubs).sort(sortIds);
      clusters.unshift(makeCluster('bridge-topics', 'bridge', hubIds, model, hubIds.length === 1 ? 'Bridge Topic' : 'Bridge Topics'));
    }

    if (loose.length) {
      clusters.push(makeCluster('uncategorized', 'loose', loose.sort(sortIds), model, 'Uncategorized / Review'));
    }

    if (!clusters.length && model.topics.length) {
      clusters.push(makeCluster('area-1', 'area', model.topics.map((topic) => topic.topicId), model));
    }

    clusters.sort((a, b) => {
      if (a.type === 'bridge' && b.type !== 'bridge') return -1;
      if (b.type === 'bridge' && a.type !== 'bridge') return 1;
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.title.localeCompare(b.title);
    });
    clusters.forEach((cluster, index) => {
      cluster.tone = index % 8;
      cluster.clusterId = cluster.type === 'bridge' ? cluster.clusterId : `cluster-${index + 1}`;
    });
    return { clusters, hubs };
  }

  function buildBridges(model, clusters){
    const topicCluster = new Map();
    clusters.forEach((cluster) => {
      cluster.topicIds.forEach((topicId) => topicCluster.set(topicId, cluster.clusterId));
    });

    const bridgeMap = new Map();
    for (const edge of model.edges) {
      const sourceClusterId = topicCluster.get(edge.sourceTopic);
      const targetClusterId = topicCluster.get(edge.targetTopic);
      if (!sourceClusterId || !targetClusterId || sourceClusterId === targetClusterId) continue;
      const key = sourceClusterId < targetClusterId ? `${sourceClusterId}::${targetClusterId}` : `${targetClusterId}::${sourceClusterId}`;
      const existing = bridgeMap.get(key) || {
        bridgeId: key,
        sourceClusterId,
        targetClusterId,
        weight: 0,
        relationships: new Map(),
        topicIds: new Set(),
        edges: [],
      };
      existing.weight += CONFIDENCE_WEIGHT[edge.confidence] || CONFIDENCE_WEIGHT.default;
      if (edge.relationship) existing.relationships.set(edge.relationship, (existing.relationships.get(edge.relationship) || 0) + 1);
      existing.topicIds.add(edge.sourceTopic);
      existing.topicIds.add(edge.targetTopic);
      existing.edges.push(edge);
      bridgeMap.set(key, existing);
    }

    return Array.from(bridgeMap.values()).map((bridge) => {
      const relationships = Array.from(bridge.relationships.entries()).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
      return {
        ...bridge,
        topicIds: Array.from(bridge.topicIds),
        relationship: relationships.length ? relationships[0][0] : 'related',
        count: bridge.edges.length,
        weight: Math.round(bridge.weight * 100) / 100,
      };
    }).sort((a, b) => (b.weight - a.weight) || a.bridgeId.localeCompare(b.bridgeId));
  }

  function attachBridgeSummaries(clusters, bridges){
    const clusterById = new Map(clusters.map((cluster) => [cluster.clusterId, cluster]));
    for (const bridge of bridges) {
      const source = clusterById.get(bridge.sourceClusterId);
      const target = clusterById.get(bridge.targetClusterId);
      if (!source || !target) continue;
      source.bridges.push({ ...bridge, otherClusterId: target.clusterId, otherTitle: target.title });
      target.bridges.push({ ...bridge, otherClusterId: source.clusterId, otherTitle: source.title });
    }
    clusters.forEach((cluster) => {
      cluster.bridges.sort((a, b) => (b.weight - a.weight) || a.otherTitle.localeCompare(b.otherTitle));
    });
  }

  function buildAtlas(topicsInput, connectionsInput){
    const model = buildModel(topicsInput, connectionsInput);
    const clusterResult = buildClusters(model);
    const bridges = buildBridges(model, clusterResult.clusters);
    attachBridgeSummaries(clusterResult.clusters, bridges);
    return {
      clusters: clusterResult.clusters,
      bridges,
      model: {
        topics: model.topics,
        edges: model.edges,
        degree: model.degree,
      },
      hubs: Array.from(clusterResult.hubs),
    };
  }

  window.SynthesisAtlas = {
    buildAtlas,
    _test: {
      buildModel,
      buildClusters,
      buildBridges,
      detectHubTopics,
      edgeKey,
      normalizeConnection,
      normalizeTopic,
      shouldKeepClusterEdge,
    },
  };
})();
