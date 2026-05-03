/**
 * @jest-environment jsdom
 */

import fs from 'fs';
import path from 'path';

function loadSynthesisAtlas() {
  const src = fs.readFileSync(path.join(__dirname, '../public/v2/src/synthesisAtlas.js'), 'utf8');
  new Function(src).call(window);
  return (window as any).SynthesisAtlas._test;
}

function buildAtlas() {
  const src = fs.readFileSync(path.join(__dirname, '../public/v2/src/synthesisAtlas.js'), 'utf8');
  new Function(src).call(window);
  return (window as any).SynthesisAtlas.buildAtlas;
}

describe('SynthesisAtlas helpers', () => {
  beforeEach(() => {
    delete (window as any).SynthesisAtlas;
  });

  test('buildModel filters invalid connections and de-duplicates undirected pairs', () => {
    const helpers = loadSynthesisAtlas();
    const model = helpers.buildModel(
      [
        { topicId: 'a', title: 'Alpha' },
        { topicId: 'b', title: 'Beta' },
        { topicId: 'c', title: 'Gamma' },
      ],
      [
        { sourceTopic: 'a', targetTopic: 'b', relationship: 'supports', confidence: 'extracted' },
        { sourceTopic: 'b', targetTopic: 'a', relationship: 'reverse duplicate', confidence: 'inferred' },
        { sourceTopic: 'a', targetTopic: 'missing', relationship: 'ignored', confidence: 'inferred' },
        { sourceTopic: 'c', targetTopic: 'c', relationship: 'self', confidence: 'speculative' },
      ],
    );

    expect(model.topics.map((topic: any) => topic.topicId)).toEqual(['a', 'b', 'c']);
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({ sourceTopic: 'a', targetTopic: 'b', relationship: 'supports' });
    expect(model.degree.get('a')).toBe(1);
    expect(model.degree.get('c')).toBe(0);
  });

  test('buildAtlas separates areas joined by bridge-like edges', () => {
    const atlas = buildAtlas()(
      [
        { topicId: 'auth-login', title: 'Login Flow', entryCount: 4 },
        { topicId: 'auth-session', title: 'Session Tokens', entryCount: 3 },
        { topicId: 'billing-plan', title: 'Billing Plan', entryCount: 5 },
        { topicId: 'billing-invoice', title: 'Invoice Sync', entryCount: 2 },
      ],
      [
        { sourceTopic: 'auth-login', targetTopic: 'auth-session', confidence: 'extracted', relationship: 'same area' },
        { sourceTopic: 'billing-plan', targetTopic: 'billing-invoice', confidence: 'extracted', relationship: 'same area' },
        { sourceTopic: 'auth-session', targetTopic: 'billing-plan', confidence: 'inferred', relationship: 'account boundary' },
      ],
    );

    expect(atlas.clusters).toHaveLength(2);
    expect(atlas.clusters.map((cluster: any) => cluster.topicIds.sort())).toEqual(
      expect.arrayContaining([
        ['auth-login', 'auth-session'],
        ['billing-invoice', 'billing-plan'],
      ]),
    );
    expect(atlas.bridges).toHaveLength(1);
    expect(atlas.bridges[0]).toMatchObject({ relationship: 'account boundary', count: 1 });
  });

  test('buildAtlas treats god-node star graphs as bridge plus one uncategorized area', () => {
    const atlas = buildAtlas()(
      [
        { topicId: 'hub', title: 'Everything', entryCount: 40, isGodNode: true },
        ...Array.from({ length: 8 }, (_, i) => ({ topicId: `leaf-${i}`, title: `Leaf Topic ${i}`, entryCount: 1 })),
      ],
      Array.from({ length: 8 }, (_, i) => ({
        sourceTopic: 'hub',
        targetTopic: `leaf-${i}`,
        confidence: 'inferred',
        relationship: 'mentions',
      })),
    );

    expect(atlas.hubs).toEqual(['hub']);
    expect(atlas.clusters.length).toBeGreaterThan(1);
    expect(atlas.clusters[0]).toMatchObject({ clusterId: 'bridge-topics', type: 'bridge', topicIds: ['hub'] });
    expect(atlas.clusters.filter((cluster: any) => cluster.type === 'loose')).toHaveLength(1);
    expect(atlas.clusters.find((cluster: any) => cluster.type === 'loose')).toMatchObject({
      title: 'Uncategorized / Review',
      topicIds: Array.from({ length: 8 }, (_, i) => `leaf-${i}`),
    });
    expect(atlas.bridges.length).toBeGreaterThan(0);
  });

  test('buildAtlas returns deterministic area and bridge summaries', () => {
    const topics = [
      { topicId: 'a', title: 'Alpha', entryCount: 2 },
      { topicId: 'b', title: 'Beta', entryCount: 1 },
      { topicId: 'c', title: 'Gamma', entryCount: 1 },
    ];
    const connections = [
      { sourceTopic: 'a', targetTopic: 'b', confidence: 'extracted' },
      { sourceTopic: 'b', targetTopic: 'c', confidence: 'inferred' },
    ];

    const first = buildAtlas()(topics, connections);
    delete (window as any).SynthesisAtlas;
    const second = buildAtlas()(topics, connections);

    expect(first.clusters.map((cluster: any) => ({
      clusterId: cluster.clusterId,
      title: cluster.title,
      representativeTopicIds: cluster.representativeTopics.map((topic: any) => topic.topicId),
      bridgeIds: cluster.bridges.map((bridge: any) => bridge.bridgeId),
    }))).toEqual(second.clusters.map((cluster: any) => ({
      clusterId: cluster.clusterId,
      title: cluster.title,
      representativeTopicIds: cluster.representativeTopics.map((topic: any) => topic.topicId),
      bridgeIds: cluster.bridges.map((bridge: any) => bridge.bridgeId),
    })));
    expect(first.bridges.map((bridge: any) => bridge.bridgeId)).toEqual(second.bridges.map((bridge: any) => bridge.bridgeId));
  });
});
