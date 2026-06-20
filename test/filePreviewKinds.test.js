const { previewKind } = require('../web/AgentCockpitWeb/src/filePreviewKinds.js');

describe('desktop file preview classification', () => {
  test('treats Astro files as editable text previews', () => {
    expect(previewKind('src/pages/index.astro', 1024)).toBe('text');
  });
});
